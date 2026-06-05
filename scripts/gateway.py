"""
gateway.py — Multi-node BLE ECG gateway: nRF52832 -> ThingsBoard via MQTT

Connects to one or more nRF52832 BLE nodes concurrently.
Each node runs its own BLE worker thread; all share one MQTT connection.

Config (env vars or .env.local):
  TB_MQTT_BROKER          mqtt://103.116.39.179:1883
  TB_GATEWAY_ACCESS_TOKEN 4o51ajerynq34mtosc26

  # Multi-node (preferred): "NodeName:BLE_ADDR" pairs, comma-separated
  NODE_LIST               Node1:e5:39:e6:e4:d1:e8,Node2:aa:bb:cc:dd:ee:ff

  # Single-node fallback (legacy):
  TB_NODE_NAME            Node1
  BLE_ADDRESS             e5:39:e6:e4:d1:e8

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
NODE_LIST_ENV = os.environ.get('NODE_LIST', '')          # "Node1:e5:..,Node2:aa:.."
TB_NODE_NAME  = os.environ.get('TB_NODE_NAME', 'Node1')  # legacy single-node
BLE_ADDRESS   = os.environ.get('BLE_ADDRESS',  'e5:39:e6:e4:d1:e8')

SERVICE_UUID        = "6e401400-b5a3-f393-e0a9-e50e24dcca9e"
CHARACTERISTIC_UUID = "6e401401-b5a3-f393-e0a9-e50e24dcca9e"
RX_CHAR_UUID        = "6e401402-b5a3-f393-e0a9-e50e24dcca9e"

PACKET_SAMPLES    = 50
NO_DATA_TIMEOUT_S = 6

_parsed   = urlparse(BROKER_URL)
MQTT_HOST = _parsed.hostname or '103.116.39.179'
MQTT_PORT = _parsed.port or 1883

MQTT_TOPIC      = 'v1/gateway/telemetry'
ATTR_REQ_TOPIC  = 'v1/gateway/attributes/request'
ATTR_RESP_TOPIC = 'v1/gateway/attributes/response'
ATTR_PUSH_TOPIC = 'v1/gateway/attributes'

CMD_ACK     = 0xA0   # gateway→node on connect:  [0xA0][addr_b2..b5][node_id]  6 bytes
CMD_ECG_CFG = 0xCF   # ECG config:               [0xCF][node_id][fLo][fHi][iLo][iHi]  6 bytes
CMD_THR     = 0xCE   # vital thresholds:         [0xCE][node_id][7×uint8]              9 bytes

THRESHOLD_KEYS = [
    'ppgHr_warnMin', 'ppgHr_warnMax',
    'ecgHr_warnMin', 'ecgHr_warnMax',
    'spo2_warnMin',
    'temp_warnMin',  'temp_warnMax',
]
ALL_SHARED_KEYS = ['bleAddress'] + THRESHOLD_KEYS

_DEFAULT_THRESHOLDS = {
    'ppgHr_warnMin': 50,
    'ppgHr_warnMax': 120,
    'ecgHr_warnMin': 50,
    'ecgHr_warnMax': 120,
    'spo2_warnMin':  90,
    'temp_warnMin':  35,
    'temp_warnMax':  38,
}


# ── Node state ────────────────────────────────────────────────────────

class NodeState:
    """All mutable per-node state, shared between the MQTT thread and the node's BLE worker."""

    def __init__(self, name: str, ble_address: str, node_id: int):
        self.name         = name
        self.node_id      = node_id          # uint8, assigned at startup, sent in every cmd
        self._addr        = ble_address.lower()
        self._addr_lock   = threading.Lock()
        self.addr_changed = threading.Event()
        self.cmd_q        = queue.Queue(maxsize=10)  # outbound BLE write payloads
        self.thresholds   = dict(_DEFAULT_THRESHOLDS)
        self._thr_lock    = threading.Lock()

    def get_address(self) -> str:
        with self._addr_lock:
            return self._addr

    def set_address(self, addr: str):
        addr = addr.strip().lower()
        if not addr:
            return
        with self._addr_lock:
            if addr != self._addr:
                print(f'[TB]  {self.name}: BLE address {self._addr} → {addr}')
                self._addr = addr
                self.addr_changed.set()

    def update_thresholds(self, updates: dict) -> bool:
        changed = False
        with self._thr_lock:
            for k, v in updates.items():
                if k in self.thresholds:
                    try:
                        new = int(float(v))
                        if new != self.thresholds[k]:
                            self.thresholds[k] = new
                            changed = True
                    except (TypeError, ValueError):
                        pass
        return changed

    def build_ack_payload(self) -> bytes:
        """[CMD_ACK][last 4 bytes of BLE MAC][node_id] — 6 bytes."""
        addr_bytes = bytes(int(b, 16) for b in self.get_address().split(':'))
        return struct.pack('<6B', CMD_ACK, *addr_bytes[2:], self.node_id)

    def build_threshold_payload(self) -> bytes | None:
        """[CMD_THR][node_id][7×uint8] — 9 bytes."""
        with self._thr_lock:
            t = self.thresholds.copy()
        try:
            return struct.pack('<9B',
                CMD_THR, self.node_id,
                t['ppgHr_warnMin'], t['ppgHr_warnMax'],
                t['ecgHr_warnMin'], t['ecgHr_warnMax'],
                t['spo2_warnMin'],
                t['temp_warnMin'],  t['temp_warnMax'],
            )
        except Exception as e:
            print(f'[THR] {self.name}: payload build error: {e}')
            return None

    def enqueue_thresholds(self):
        p = self.build_threshold_payload()
        if p:
            try:
                self.cmd_q.put_nowait(p)
            except queue.Full:
                pass  # BLE thread is busy; it will use current values next write


def _parse_node_list() -> dict[str, NodeState]:
    """Build {name: NodeState} from NODE_LIST env or legacy single-node vars.
    node_id is assigned by position (0-based) and is stable as long as NODE_LIST order is stable."""
    nodes: dict[str, NodeState] = {}
    if NODE_LIST_ENV:
        for idx, entry in enumerate(NODE_LIST_ENV.split(',')):
            entry = entry.strip()
            if not entry:
                continue
            # "NodeName:BLE_ADDR" — split on first colon only; MAC has its own colons
            sep = entry.index(':')
            name = entry[:sep].strip()
            addr = entry[sep + 1:].strip()
            if name and addr:
                nodes[name] = NodeState(name, addr, node_id=idx)
    if not nodes:
        nodes[TB_NODE_NAME] = NodeState(TB_NODE_NAME, BLE_ADDRESS, node_id=0)
    return nodes


# ── Shared publish queue (MQTT publish thread) ────────────────────────
# Items: (node_name, samples_list)
publish_q = queue.Queue(maxsize=100)

mqtt_connected        = threading.Event()
mqtt                  = None
_attr_req_id          = 0
_pending_attr_req_key  = {}   # req_id -> attribute key
_pending_attr_req_node = {}   # req_id -> node name

# Filled by _parse_node_list() before MQTT setup
nodes: dict[str, NodeState] = {}


def _request_all_attrs(client):
    global _attr_req_id
    for node_name in nodes:
        for key in ALL_SHARED_KEYS:
            _attr_req_id += 1
            _pending_attr_req_key[_attr_req_id]  = key
            _pending_attr_req_node[_attr_req_id] = node_name
            payload = json.dumps({"id": _attr_req_id, "device": node_name,
                                  "client": False, "key": key})
            client.publish(ATTR_REQ_TOPIC, payload)
    print(f'[TB]  Requested shared attrs for {len(nodes)} node(s): {list(nodes)}')


def mqtt_on_message(client, userdata, msg):
    try:
        data  = json.loads(msg.payload.decode())
        topic = msg.topic

        if topic == ATTR_RESP_TOPIC:
            req_id    = data.get('id')
            value     = data.get('value')
            key       = _pending_attr_req_key.pop(req_id, None)
            node_name = _pending_attr_req_node.pop(req_id, None)
            if key is None or value is None or node_name is None:
                return
            node = nodes.get(node_name)
            if node is None:
                return
            if key == 'bleAddress':
                node.set_address(str(value))
            elif key in THRESHOLD_KEYS:
                if node.update_thresholds({key: value}):
                    node.enqueue_thresholds()

        elif topic == ATTR_PUSH_TOPIC:
            # {"device": "Node1", "data": {"bleAddress": "..", "ppgHr_warnMin": 50, ...}}
            node_name = data.get('device')
            node = nodes.get(node_name)
            if node is None:
                return
            updates = data.get('data', {})

            if 'bleAddress' in updates:
                node.set_address(str(updates['bleAddress']))

            thr_updates = {k: v for k, v in updates.items() if k in THRESHOLD_KEYS}
            if thr_updates and node.update_thresholds(thr_updates):
                node.enqueue_thresholds()
                print(f'[TB]  {node_name}: threshold update queued → BLE write')

    except Exception as e:
        print(f'[MQTT] Message parse error: {e}')


def mqtt_on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f'[MQTT] Connected to {MQTT_HOST}:{MQTT_PORT}')
        client.subscribe(ATTR_RESP_TOPIC)
        client.subscribe(ATTR_PUSH_TOPIC)
        mqtt_connected.set()
        _request_all_attrs(client)
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
        node_name, node_id, samples = item
        batch_num += 1
        ts      = int(time.time() * 1000)
        payload = {
            node_name: [{
                'ts':     ts,
                'values': {'ecg_batch': json.dumps(samples), 'node_id': node_id},
            }]
        }
        if mqtt_connected.is_set():
            result = mqtt.publish(MQTT_TOPIC, json.dumps(payload), qos=0)
            if batch_num % 25 == 0:
                print(f'[MQTT] {node_name} batch #{batch_num} (mid={result.mid})')
        else:
            print(f'[MQTT] Not connected — dropping {node_name} batch #{batch_num}')
        publish_q.task_done()


# ── BLE helpers ───────────────────────────────────────────────────────

_scan_lock = threading.Lock()   # only one thread may call adapter.scan_for() at a time


def wait_for_bluetooth():
    while not simplepyble.Adapter.bluetooth_enabled():
        print('[BLE] Bluetooth not enabled — waiting...')
        time.sleep(5)


def ble_connect_node(adapter, node: NodeState):
    wait_for_bluetooth()
    while True:
        if node.addr_changed.is_set():
            node.addr_changed.clear()
        target = node.get_address()
        print(f'[BLE] {node.name}: scanning for {target}...')
        with _scan_lock:
            adapter.scan_for(3000)
            results = adapter.scan_get_results()
        for p in results:
            if p.address().lower() == target.lower():
                print(f'[BLE] {node.name}: found [{p.address()}] — connecting')
                p.connect()
                return p
        print(f'[BLE] {node.name}: not found, retrying...')
        time.sleep(1)


# ── Per-node BLE worker thread ────────────────────────────────────────

def node_worker(node: NodeState, adapter):
    local_batch_count = 0
    last_rx_ts        = 0.0

    def on_notify(data: bytes):
        nonlocal local_batch_count, last_rx_ts
        last_rx_ts = time.time()
        if len(data) < PACKET_SAMPLES * 2:
            return
        samples = list(struct.unpack_from(f'<{PACKET_SAMPLES}h', data))
        local_batch_count += 1
        try:
            publish_q.put_nowait((node.name, node.node_id, samples))
        except queue.Full:
            print(f'[BLE] {node.name}: publish queue full — dropping batch')
        if local_batch_count % 25 == 0:
            print(f'[BLE] {node.name}: batch #{local_batch_count}')

    while True:
        node.addr_changed.clear()
        try:
            peripheral = ble_connect_node(adapter, node)
            last_rx_ts = time.time()
            peripheral.notify(SERVICE_UUID, CHARACTERISTIC_UUID, on_notify)
            print(f'[BLE] {node.name}: streaming ECG from {node.get_address()}')

            # 1. ACK — assign the node its ID so it can validate future commands
            try:
                peripheral.write_request(SERVICE_UUID, RX_CHAR_UUID, node.build_ack_payload())
                print(f'[BLE] {node.name}: ACK sent (node_id={node.node_id})')
            except Exception as e:
                print(f'[BLE] {node.name}: ACK write error: {e}')

            # 2. Push current thresholds immediately after ACK
            p = node.build_threshold_payload()
            if p:
                try:
                    peripheral.write_request(SERVICE_UUID, RX_CHAR_UUID, p)
                    print(f'[BLE] {node.name}: initial thresholds sent')
                except Exception as e:
                    print(f'[BLE] {node.name}: initial threshold write error: {e}')

            while True:
                time.sleep(2)

                # Drain any pending BLE write commands queued by the MQTT thread
                while not node.cmd_q.empty():
                    try:
                        cmd_payload = node.cmd_q.get_nowait()
                        peripheral.write_request(SERVICE_UUID, RX_CHAR_UUID, cmd_payload)
                        label = 'thresholds' if cmd_payload[0] == CMD_THR else 'config'
                        print(f'[BLE] {node.name}: {label} written')
                    except queue.Empty:
                        break
                    except Exception as e:
                        print(f'[BLE] {node.name}: write error: {e}')
                        break

                if node.addr_changed.is_set():
                    print(f'[BLE] {node.name}: address changed → reconnecting')
                    break
                if time.time() - last_rx_ts > NO_DATA_TIMEOUT_S:
                    print(f'[BLE] {node.name}: no data for {NO_DATA_TIMEOUT_S}s — reconnecting')
                    break

        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f'[BLE] {node.name}: {e} — retry in 5s')
            time.sleep(5)


# ── Main ──────────────────────────────────────────────────────────────

def main():
    global nodes

    if not ACCESS_TOKEN:
        print('ERROR: TB_GATEWAY_ACCESS_TOKEN must be set in .env.local')
        return

    nodes = _parse_node_list()

    print('=' * 49)
    print(f'  BLE ECG Gateway -> ThingsBoard  ({len(nodes)} node(s))')
    print('=' * 49)
    print(f'Broker -> {MQTT_HOST}:{MQTT_PORT}')
    for n in nodes.values():
        print(f'  {n.name} -> {n.get_address()}')
    print()

    mqtt_setup()
    threading.Thread(target=publish_worker, daemon=True).start()

    adapters = simplepyble.Adapter.get_adapters()
    if not adapters:
        print('No BLE adapters found')
        return
    adapter = adapters[0]

    worker_threads = []
    for node in nodes.values():
        t = threading.Thread(target=node_worker, args=(node, adapter),
                             name=f'ble-{node.name}', daemon=True)
        t.start()
        worker_threads.append(t)

    try:
        for t in worker_threads:
            t.join()
    except KeyboardInterrupt:
        print('\nStopping...')

    publish_q.put(None)
    mqtt.loop_stop()
    mqtt.disconnect()
    print('Done.')


if __name__ == '__main__':
    main()
