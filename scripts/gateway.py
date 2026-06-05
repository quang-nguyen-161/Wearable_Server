"""
gateway.py — BLE ECG gateway: nRF52832 -> ThingsBoard via MQTT

Receives 50-sample int16_t BLE notifications (100 bytes, every 200ms at 250Hz)
from an nRF52832 node and publishes them to ThingsBoard as ecg_batch
using the gateway MQTT API.

Topic:  v1/gateway/telemetry
Auth:   TB_GATEWAY_ACCESS_TOKEN as MQTT username (no password)
Format: { "NodeName": [{ "ts": epochMs, "values": { "ecg_batch": "[v0,v1,...]" } }] }

Config (env vars or .env.local):
  TB_MQTT_BROKER  mqtt://103.116.39.179:1883
  TB_GATEWAY_ACCESS_TOKEN  4o51ajerynq34mtosc26
  TB_NODE_NAME    Node1               (ThingsBoard device name for this BLE node)
  BLE_ADDRESS     e5:39:e6:e4:d1:e8   (nRF52832 MAC address)

Install deps: pip install paho-mqtt simplepyble
"""

import os
import json
import struct
import time
import queue
import threading
from urllib.parse import urlparse

import simplepyble
import paho.mqtt.client as mqtt_client


# ── Load .env.local ───────────────────────────────────────────────────
def load_env(path):
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                eq = line.find('=')
                if eq < 0:
                    continue
                k, v = line[:eq].strip(), line[eq + 1:].strip()
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass

load_env('.env.local')
load_env('../.env.local')

# ── Config ────────────────────────────────────────────────────────────
BROKER_URL   = os.environ.get('TB_MQTT_BROKER', 'mqtt://103.116.39.179:1883')
ACCESS_TOKEN = os.environ.get('TB_GATEWAY_ACCESS_TOKEN', '')
TB_NODE_NAME = os.environ.get('TB_NODE_NAME', 'Node1')
BLE_ADDRESS  = os.environ.get('BLE_ADDRESS', 'e5:39:e6:e4:d1:e8')

SERVICE_UUID        = "6e401400-b5a3-f393-e0a9-e50e24dcca9e"
CHARACTERISTIC_UUID = "6e401401-b5a3-f393-e0a9-e50e24dcca9e"

PACKET_SAMPLES    = 50       # int16_t samples per BLE notification = 100 bytes
NO_DATA_TIMEOUT_S = 6        # seconds without a packet before reconnecting

_parsed     = urlparse(BROKER_URL)
MQTT_HOST   = _parsed.hostname or '103.116.39.179'
MQTT_PORT   = _parsed.port or 1883
MQTT_TOPIC       = 'v1/gateway/telemetry'
ATTR_REQ_TOPIC   = 'v1/gateway/attributes/request'
ATTR_RESP_TOPIC  = 'v1/gateway/attributes/response'
ATTR_PUSH_TOPIC  = 'v1/gateway/attributes'


# ── BLE address — thread-safe, updated from ThingsBoard ───────────────
_ble_addr_lock    = threading.Lock()
_current_ble_addr = BLE_ADDRESS
ble_addr_changed  = threading.Event()

def get_ble_address():
    with _ble_addr_lock:
        return _current_ble_addr

def set_ble_address(addr):
    global _current_ble_addr
    addr = addr.strip().lower()
    if not addr:
        return
    with _ble_addr_lock:
        if addr != _current_ble_addr:
            print(f'[TB] BLE address updated: {_current_ble_addr} → {addr}')
            _current_ble_addr = addr
            ble_addr_changed.set()


# ── MQTT publish queue (background thread) ────────────────────────────
# Queue holds lists of int16 samples; worker serialises and publishes.
publish_q = queue.Queue(maxsize=50)   # ~10s of backlog at 200ms/batch

mqtt_connected = threading.Event()
mqtt           = None
_attr_req_id   = 0


def _request_ble_address(client):
    global _attr_req_id
    _attr_req_id += 1
    payload = json.dumps({"id": _attr_req_id, "device": TB_NODE_NAME,
                          "client": False, "key": "bleAddress"})
    client.publish(ATTR_REQ_TOPIC, payload)
    print(f'[TB] Requested bleAddress for {TB_NODE_NAME}')


def mqtt_on_message(client, userdata, msg):
    try:
        data  = json.loads(msg.payload.decode())
        topic = msg.topic
        if topic == ATTR_RESP_TOPIC:
            # Response to our attribute request: {"id":1,"device":"Node1","value":"xx:xx:.."}
            addr = data.get('value')
            if addr:
                set_ble_address(addr)
        elif topic == ATTR_PUSH_TOPIC:
            # Push when SHARED_SCOPE attribute changes: {"device":"Node1","data":{"bleAddress":"xx:..}}
            if data.get('device') == TB_NODE_NAME:
                addr = data.get('data', {}).get('bleAddress')
                if addr:
                    set_ble_address(addr)
    except Exception as e:
        print(f'[MQTT] Message parse error: {e}')


def mqtt_on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f'[MQTT] Connected to {MQTT_HOST}:{MQTT_PORT}')
        client.subscribe(ATTR_RESP_TOPIC)
        client.subscribe(ATTR_PUSH_TOPIC)
        mqtt_connected.set()
        _request_ble_address(client)
    else:
        print(f'[MQTT] Connection failed rc={rc}')


def mqtt_on_disconnect(client, userdata, rc):
    mqtt_connected.clear()
    if rc != 0:
        print(f'[MQTT] Unexpected disconnect rc={rc} — reconnecting...')


def mqtt_setup():
    global mqtt
    mqtt = mqtt_client.Client(client_id=f'gateway-{int(time.time())}',
                               protocol=mqtt_client.MQTTv311)
    mqtt.username_pw_set(ACCESS_TOKEN, '')
    mqtt.on_connect    = mqtt_on_connect
    mqtt.on_disconnect = mqtt_on_disconnect
    mqtt.on_message    = mqtt_on_message
    mqtt.connect_async(MQTT_HOST, MQTT_PORT, keepalive=30)
    mqtt.loop_start()


def publish_worker():
    mqtt_connected.wait(timeout=15)
    batch_num = 0
    while True:
        item = publish_q.get()
        if item is None:
            break
        batch_num += 1
        ts      = int(time.time() * 1000)
        payload = {
            TB_NODE_NAME: [{
                'ts':     ts,
                'values': {'ecg_batch': json.dumps(item)},
            }]
        }
        if mqtt_connected.is_set():
            result = mqtt.publish(MQTT_TOPIC, json.dumps(payload), qos=0)
            if batch_num % 25 == 0:   # log every 5s
                print(f'[MQTT] Batch #{batch_num} published (mid={result.mid})')
        else:
            print(f'[MQTT] Not connected — dropping batch #{batch_num}')
        publish_q.task_done()


# ── BLE notification handler ──────────────────────────────────────────
batch_count = 0
last_rx_ts  = 0.0


def on_notify(data: bytes):
    global batch_count, last_rx_ts
    last_rx_ts = time.time()

    if len(data) < PACKET_SAMPLES * 2:
        print(f'[BLE] Short packet: {len(data)} bytes (expected {PACKET_SAMPLES * 2})')
        return

    samples = list(struct.unpack_from(f'<{PACKET_SAMPLES}h', data))
    batch_count += 1

    try:
        publish_q.put_nowait(samples)
    except queue.Full:
        print('[BLE] Publish queue full — dropping batch')

    if batch_count % 25 == 0:
        print(f'[BLE] Batch #{batch_count} | samples {samples[0]}…{samples[-1]}')


# ── BLE connect ───────────────────────────────────────────────────────
def wait_for_bluetooth():
    while not simplepyble.Adapter.bluetooth_enabled():
        print('[BLE] Bluetooth not enabled — waiting...')
        time.sleep(5)
    print('[BLE] Bluetooth ready')


def ble_connect(adapter):
    wait_for_bluetooth()
    target = get_ble_address()
    print(f'Scanning for {target}...')
    while True:
        if ble_addr_changed.is_set():
            # Address updated while scanning — restart with new address
            target = get_ble_address()
            ble_addr_changed.clear()
            print(f'Scanning for updated address {target}...')
        adapter.scan_for(3000)
        for p in adapter.scan_get_results():
            if p.address().lower() == target.lower():
                print(f'Found {p.identifier()} [{p.address()}] — connecting...')
                p.connect()
                return p
        print('Not found, retrying...')
        time.sleep(1)


# ── Main ──────────────────────────────────────────────────────────────
def main():
    if not ACCESS_TOKEN:
        print('ERROR: TB_GATEWAY_ACCESS_TOKEN must be set in .env.local')
        return

    print('=' * 49)
    print('  BLE ECG Gateway -> ThingsBoard (MQTT)')
    print('=' * 49)
    print(f'Broker -> {MQTT_HOST}:{MQTT_PORT}')
    print(f'Node   -> {TB_NODE_NAME}  |  BLE -> {get_ble_address()} (may be overridden by TB attribute)')
    print(f'ECG    -> {PACKET_SAMPLES} samples/packet, 200ms interval\n')

    mqtt_setup()
    threading.Thread(target=publish_worker, daemon=True).start()

    adapters = simplepyble.Adapter.get_adapters()
    if not adapters:
        print('No BLE adapters found')
        return
    adapter = adapters[0]

    peripheral = None
    try:
        while True:
            ble_addr_changed.clear()
            try:
                peripheral = ble_connect(adapter)
                global last_rx_ts
                last_rx_ts = time.time()
                peripheral.notify(SERVICE_UUID, CHARACTERISTIC_UUID, on_notify)
                print(f'Streaming ECG ({get_ble_address()}) to ThingsBoard via MQTT. Ctrl+C to stop.\n')

                while True:
                    time.sleep(2)
                    if ble_addr_changed.is_set():
                        print(f'[BLE] BLE address changed — reconnecting to {get_ble_address()}...')
                        break
                    if time.time() - last_rx_ts > NO_DATA_TIMEOUT_S:
                        print(f'[BLE] No data for {NO_DATA_TIMEOUT_S}s — reconnecting...')
                        break

            except KeyboardInterrupt:
                raise
            except Exception as e:
                print(f'[BLE] {e} — retrying in 5s...')
                time.sleep(5)

    except KeyboardInterrupt:
        print('\nStopping...')

    publish_q.put(None)
    try:
        peripheral.unsubscribe(SERVICE_UUID, CHARACTERISTIC_UUID)
        peripheral.disconnect()
    except Exception:
        pass
    mqtt.loop_stop()
    mqtt.disconnect()
    print('Done.')


if __name__ == '__main__':
    main()
