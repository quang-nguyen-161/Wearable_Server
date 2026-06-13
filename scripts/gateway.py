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
import socket
import struct
import time
import queue
import threading
from urllib.parse import urlparse
import urllib.request

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

# Resolve env files relative to this script's own directory, so it works no
# matter where the gateway is launched from (e.g. Code Runner / Ctrl+Alt+N
# launches from the workspace root, not scripts/). The shared config lives in
# health-monitor/.env.local (one level up); scripts/.env.local is optional.
_HERE = os.path.dirname(os.path.abspath(__file__))
load_env(os.path.join(_HERE, '.env.local'))
load_env(os.path.join(_HERE, '..', '.env.local'))

# ── Config ────────────────────────────────────────────────────────────
BROKER_URL          = os.environ.get('TB_MQTT_BROKER', 'mqtt://103.116.39.179:1883')
BROKER_URL_FALLBACK = os.environ.get('TB_MQTT_BROKER_FALLBACK', 'mqtt://localhost:1883')
ACCESS_TOKEN          = os.environ.get('TB_GATEWAY_ACCESS_TOKEN', '2Mm6LaNzXrqK7nZD6pe4')
ACCESS_TOKEN_FALLBACK = os.environ.get('TB_GATEWAY_ACCESS_TOKEN_FALLBACK', ACCESS_TOKEN)
NODE_LIST_ENV = os.environ.get('NODE_LIST', '')          # "Node1:e5:..,Node2:aa:.."
TB_NODE_NAME  = os.environ.get('TB_NODE_NAME', 'Node1')  # legacy single-node
BLE_ADDRESS   = os.environ.get('BLE_ADDRESS',  'e5:39:e6:e4:d1:e8')

# REST API discovery — finds devices whose name contains "node" (case-insensitive),
# same convention as pages/api/devices.js, so nodes added via the dashboard's
# "+ Node" button are picked up automatically without editing NODE_LIST.
TB_REST_URL_PRIMARY  = os.environ.get('TB_REST_URL_PRIMARY', 'https://c7.hust-2slab.org')
TB_REST_URL_FALLBACK = os.environ.get('TB_REST_URL_FALLBACK', os.environ.get('TB_BASE_URL', 'http://localhost:9090'))
TB_USERNAME  = os.environ.get('TB_USERNAME', 'tenant@thingsboard.org')
TB_PASSWORD  = os.environ.get('TB_PASSWORD', 'tenant')
TB_DEVICE_ID = os.environ.get('TB_DEVICE_ID', '')  # gateway's own device id — excluded from discovery

SERVICE_UUID        = "6e401400-b5a3-f393-e0a9-e50e24dcca9e"
CHARACTERISTIC_UUID = "6e401401-b5a3-f393-e0a9-e50e24dcca9e"
RX_CHAR_UUID        = "6e401402-b5a3-f393-e0a9-e50e24dcca9e"

PACKET_SAMPLES    = 50       # ECG: 50 × int16 LE = 100 bytes (default batch)
VITALS_SIZE       = 5        # Vitals: [hrEcg u8][hrPpg u8][spo2 u8][temp u16 LE x10]
PUBLISH_CHUNK     = 100      # max samples per MQTT message; mirrors BLE max payload — only batches >100 split
ADDR_WAIT_TIMEOUT_S = 10  # how long to wait for ThingsBoard's bleAddress before falling back to config

_parsed_primary  = urlparse(BROKER_URL)
_parsed_fallback = urlparse(BROKER_URL_FALLBACK)
MQTT_HOST_PRIMARY  = _parsed_primary.hostname or '103.116.39.179'
MQTT_PORT_PRIMARY  = _parsed_primary.port or 1883
MQTT_HOST_FALLBACK = _parsed_fallback.hostname or 'localhost'
MQTT_PORT_FALLBACK = _parsed_fallback.port or 1883

# Resolved at runtime by _select_broker(): old c7-2slab server first, localhost if unreachable
MQTT_HOST    = MQTT_HOST_PRIMARY
MQTT_PORT    = MQTT_PORT_PRIMARY
MQTT_TOKEN   = ACCESS_TOKEN
TB_REST_URL  = TB_REST_URL_PRIMARY


def _select_broker():
    """Probe the primary (old c7-2slab) MQTT broker; fall back to localhost if unreachable."""
    global MQTT_HOST, MQTT_PORT, MQTT_TOKEN, TB_REST_URL
    try:
        with socket.create_connection((MQTT_HOST_PRIMARY, MQTT_PORT_PRIMARY), timeout=2.0):
            MQTT_HOST, MQTT_PORT, MQTT_TOKEN = MQTT_HOST_PRIMARY, MQTT_PORT_PRIMARY, ACCESS_TOKEN
            TB_REST_URL = TB_REST_URL_PRIMARY
            print(f'[MQTT] Using primary broker {MQTT_HOST}:{MQTT_PORT}')
            return
    except OSError:
        pass
    MQTT_HOST, MQTT_PORT, MQTT_TOKEN = MQTT_HOST_FALLBACK, MQTT_PORT_FALLBACK, ACCESS_TOKEN_FALLBACK
    TB_REST_URL = TB_REST_URL_FALLBACK
    print(f'[MQTT] Primary broker {MQTT_HOST_PRIMARY}:{MQTT_PORT_PRIMARY} unreachable — '
          f'falling back to {MQTT_HOST}:{MQTT_PORT}')

MQTT_TOPIC      = 'v1/gateway/telemetry'
ATTR_REQ_TOPIC  = 'v1/gateway/attributes/request'
ATTR_RESP_TOPIC = 'v1/gateway/attributes/response'
ATTR_PUSH_TOPIC = 'v1/gateway/attributes'

CMD_ECG_CFG   = 0xCF   # ECG config:      [0xCF][fLo][fHi][iLo][iHi]              5 bytes
CMD_THR       = 0xCE   # vital thresholds:[0xCE][18×uint8 PPG/ECG/SpO2][6×uint16LE temp×10]  31 bytes
CMD_PPG_CFG   = 0xCD   # PPG config:      [0xCD][fLo][fHi][redMa][irMa]           5 bytes
CMD_VITAL_CFG = 0xCC   # Vital interval:  [0xCC][intervalLo][intervalHi]           3 bytes
CMD_MODE_CFG  = 0xCB   # Mode config:     [0xCB][mode][periodSecLo][periodSecHi][capSecLo][capSecHi][ecgEnabled]  7 bytes
CMD_NAME_CFG  = 0xC9   # Patient name:    [0xC9][len][name bytes...]            2-17 bytes

THRESHOLD_KEYS = [
    'ppgHr_normalMin', 'ppgHr_normalMax', 'ppgHr_warnMin', 'ppgHr_warnMax', 'ppgHr_dangerMin', 'ppgHr_dangerMax',
    'ecgHr_normalMin', 'ecgHr_normalMax', 'ecgHr_warnMin', 'ecgHr_warnMax', 'ecgHr_dangerMin', 'ecgHr_dangerMax',
    'spo2_normalMin',  'spo2_normalMax',  'spo2_warnMin',  'spo2_warnMax',  'spo2_dangerMin',  'spo2_dangerMax',
    'temp_normalMin',  'temp_normalMax',  'temp_warnMin',  'temp_warnMax',  'temp_dangerMin',  'temp_dangerMax',
]
# Temperature keys are stored ×10 (uint16) to preserve 0.1°C resolution
TEMP_KEYS = frozenset(k for k in THRESHOLD_KEYS if k.startswith('temp_'))
ECG_CFG_KEYS   = ['ecgSampleFreq', 'ecgPacketInterval']
PPG_CFG_KEYS   = ['ppgSampleFreq', 'ppgRedLedMa', 'ppgIrLedMa']
VITAL_CFG_KEYS = ['vitalInterval']
MODE_CFG_KEYS  = ['deviceMode', 'periodicInterval', 'captureWindow', 'showEcg']
ALL_SHARED_KEYS = (['bleAddress'] + THRESHOLD_KEYS
                   + ECG_CFG_KEYS + PPG_CFG_KEYS + VITAL_CFG_KEYS + MODE_CFG_KEYS)

_DEFAULT_THRESHOLDS = {
    'ppgHr_normalMin': 60,  'ppgHr_normalMax': 100,
    'ppgHr_warnMin':   50,  'ppgHr_warnMax':   120,
    'ppgHr_dangerMin': 40,  'ppgHr_dangerMax': 130,
    'ecgHr_normalMin': 60,  'ecgHr_normalMax': 100,
    'ecgHr_warnMin':   50,  'ecgHr_warnMax':   120,
    'ecgHr_dangerMin': 40,  'ecgHr_dangerMax': 130,
    'spo2_normalMin':  95,  'spo2_normalMax':  100,
    'spo2_warnMin':    90,  'spo2_warnMax':    100,
    'spo2_dangerMin':  88,  'spo2_dangerMax':  100,
    # stored ×10 to preserve 0.1°C resolution in uint16
    'temp_normalMin':  361, 'temp_normalMax':  372,
    'temp_warnMin':    355, 'temp_warnMax':    385,
    'temp_dangerMin':  350, 'temp_dangerMax':  395,
}

_DEFAULT_ECG_CFG = {
    'ecgSampleFreq':     250,
    'ecgPacketInterval': 200,   # 200 ms → 50 samples/pkt @ 250 Hz (matches firmware default)
}

_DEFAULT_PPG_CFG = {
    'ppgSampleFreq': 100,
    'ppgRedLedMa':   6,
    'ppgIrLedMa':    6,
}

_DEFAULT_VITAL_CFG = {
    'vitalInterval': 1000,
}

_DEFAULT_MODE_CFG = {
    'deviceMode':       0,   # 0 CONTINUOUS / 1 PERIODIC / 2 ECG
    'periodicInterval': 10,  # s — PERIODIC wake-to-wake interval (node clamps 5–60)
    'captureWindow':    5,   # s — PERIODIC measurement window (node clamps 5…interval)
    'showEcg':          1,   # 1 = stream ECG batches alongside vitals, 0 = no ECG batches
}


# ── Node state ────────────────────────────────────────────────────────

class NodeState:
    """All mutable per-node state, shared between the MQTT thread and the node's BLE worker."""

    def __init__(self, name: str, ble_address: str):
        self.name         = name
        self._addr        = ble_address.lower()
        self._addr_lock   = threading.Lock()
        self.addr_changed = threading.Event()
        self.addr_ready   = threading.Event()  # set once server has supplied bleAddress (or wait times out)
        # One slot per command type: latest value always wins, no overflow possible.
        self._pending_cmds = {}            # cmd_byte -> payload bytes
        self._pending_lock = threading.Lock()
        self.ble_connected  = False        # set by node_worker; lets ATTR_RESP enqueue live
        self.thresholds   = dict(_DEFAULT_THRESHOLDS)
        self._thr_lock    = threading.Lock()
        self.ecg_cfg      = dict(_DEFAULT_ECG_CFG)
        self._ecg_lock    = threading.Lock()
        self.ppg_cfg      = dict(_DEFAULT_PPG_CFG)
        self._ppg_lock    = threading.Lock()
        self.vital_cfg    = dict(_DEFAULT_VITAL_CFG)
        self._vital_lock  = threading.Lock()
        self.mode_cfg     = dict(_DEFAULT_MODE_CFG)
        self._mode_lock   = threading.Lock()
        self.patient_name = ''
        self._name_lock   = threading.Lock()

    def get_address(self) -> str:
        with self._addr_lock:
            return self._addr

    def set_address(self, addr: str):
        addr = addr.strip().lower()
        if not addr:
            return
        with self._addr_lock:
            if addr != self._addr:
                print(f'[TB]  {self.name}: BLE address {self._addr} -> {addr}')
                self._addr = addr
                self.addr_changed.set()
        self.addr_ready.set()

    def update_thresholds(self, updates: dict) -> bool:
        changed = False
        with self._thr_lock:
            for k, v in updates.items():
                if k in self.thresholds:
                    try:
                        new = round(float(v) * 10) if k in TEMP_KEYS else int(float(v))
                        if new != self.thresholds[k]:
                            self.thresholds[k] = new
                            changed = True
                    except (TypeError, ValueError):
                        pass
        return changed

    def build_threshold_payload(self) -> bytes | None:
        """31 bytes: [CMD_THR][18×uint8 PPG/ECG/SpO2][6×uint16LE temp×10]"""
        with self._thr_lock:
            t = self.thresholds.copy()
        try:
            return struct.pack('<B18B6H',
                CMD_THR,
                t['ppgHr_normalMin'], t['ppgHr_normalMax'],
                t['ppgHr_warnMin'],   t['ppgHr_warnMax'],
                t['ppgHr_dangerMin'], t['ppgHr_dangerMax'],
                t['ecgHr_normalMin'], t['ecgHr_normalMax'],
                t['ecgHr_warnMin'],   t['ecgHr_warnMax'],
                t['ecgHr_dangerMin'], t['ecgHr_dangerMax'],
                t['spo2_normalMin'],  t['spo2_normalMax'],
                t['spo2_warnMin'],    t['spo2_warnMax'],
                t['spo2_dangerMin'],  t['spo2_dangerMax'],
                t['temp_normalMin'],  t['temp_normalMax'],
                t['temp_warnMin'],    t['temp_warnMax'],
                t['temp_dangerMin'],  t['temp_dangerMax'],
            )
        except Exception as e:
            print(f'[THR] {self.name}: payload build error: {e}')
            return None

    def enqueue_thresholds(self):
        p = self.build_threshold_payload()
        if p:
            with self._pending_lock:
                self._pending_cmds[CMD_THR] = p

    def update_ecg_cfg(self, updates: dict) -> bool:
        changed = False
        with self._ecg_lock:
            for k, v in updates.items():
                if k in self.ecg_cfg:
                    try:
                        new = int(float(v))
                        if new != self.ecg_cfg[k]:
                            self.ecg_cfg[k] = new
                            changed = True
                    except (TypeError, ValueError):
                        pass
        return changed

    def build_ecg_cfg_payload(self) -> bytes | None:
        """[CMD_ECG_CFG][freq_lo][freq_hi][interval_lo][interval_hi] — 5 bytes."""
        with self._ecg_lock:
            cfg = self.ecg_cfg.copy()
        try:
            return struct.pack('<B2H',
                CMD_ECG_CFG,
                cfg['ecgSampleFreq'],
                cfg['ecgPacketInterval'],
            )
        except Exception as e:
            print(f'[ECG] {self.name}: payload build error: {e}')
            return None

    def enqueue_ecg_cfg(self):
        p = self.build_ecg_cfg_payload()
        if p:
            with self._pending_lock:
                self._pending_cmds[CMD_ECG_CFG] = p

    def update_ppg_cfg(self, updates: dict) -> bool:
        changed = False
        with self._ppg_lock:
            for k, v in updates.items():
                if k in self.ppg_cfg:
                    try:
                        new = int(float(v))
                        if new != self.ppg_cfg[k]:
                            self.ppg_cfg[k] = new
                            changed = True
                    except (TypeError, ValueError):
                        pass
        return changed

    def build_ppg_cfg_payload(self) -> bytes | None:
        """[CMD_PPG_CFG][sampleFreqLo][sampleFreqHi][redMa][irMa] — 5 bytes."""
        with self._ppg_lock:
            cfg = self.ppg_cfg.copy()
        try:
            return struct.pack('<BH2B',
                CMD_PPG_CFG,
                cfg['ppgSampleFreq'],
                cfg['ppgRedLedMa'],
                cfg['ppgIrLedMa'],
            )
        except Exception as e:
            print(f'[PPG] {self.name}: payload build error: {e}')
            return None

    def enqueue_ppg_cfg(self):
        p = self.build_ppg_cfg_payload()
        if p:
            with self._pending_lock:
                self._pending_cmds[CMD_PPG_CFG] = p

    def update_vital_cfg(self, updates: dict) -> bool:
        changed = False
        with self._vital_lock:
            for k, v in updates.items():
                if k in self.vital_cfg:
                    try:
                        new = int(float(v))
                        if new != self.vital_cfg[k]:
                            self.vital_cfg[k] = new
                            changed = True
                    except (TypeError, ValueError):
                        pass
        return changed

    def build_vital_cfg_payload(self) -> bytes | None:
        """[CMD_VITAL_CFG][intervalLo][intervalHi] — 3 bytes."""
        with self._vital_lock:
            cfg = self.vital_cfg.copy()
        try:
            return struct.pack('<BH',
                CMD_VITAL_CFG,
                cfg['vitalInterval'],
            )
        except Exception as e:
            print(f'[VIT] {self.name}: payload build error: {e}')
            return None

    def enqueue_vital_cfg(self):
        p = self.build_vital_cfg_payload()
        if p:
            with self._pending_lock:
                self._pending_cmds[CMD_VITAL_CFG] = p

    def update_mode_cfg(self, updates: dict) -> bool:
        changed = False
        with self._mode_lock:
            for k, v in updates.items():
                if k in self.mode_cfg:
                    try:
                        new = int(float(v))
                        if new != self.mode_cfg[k]:
                            self.mode_cfg[k] = new
                            changed = True
                    except (TypeError, ValueError):
                        pass
        return changed

    def build_mode_cfg_payload(self) -> bytes | None:
        """[CMD_MODE_CFG][mode][periodSec u16 LE][captureSec u16 LE][ecgEnabled] — 7 bytes."""
        with self._mode_lock:
            cfg = self.mode_cfg.copy()
        try:
            return struct.pack('<BBHHB',
                CMD_MODE_CFG,
                cfg['deviceMode'] & 0xFF,
                cfg['periodicInterval'],
                cfg['captureWindow'],
                1 if cfg['showEcg'] else 0,
            )
        except Exception as e:
            print(f'[MOD] {self.name}: payload build error: {e}')
            return None

    def enqueue_mode_cfg(self):
        p = self.build_mode_cfg_payload()
        if p:
            with self._pending_lock:
                self._pending_cmds[CMD_MODE_CFG] = p

    def set_patient_name(self, name: str) -> bool:
        """Update patient name; returns True if it changed.

        Full names can exceed the 15-char LCD field, so only the first and
        last words are kept, e.g. "Nguyen Thanh Chien" -> "Chien Nguyen".
        """
        parts = (name or '').strip().split()
        if len(parts) >= 2:
            name = f'{parts[-1]} {parts[0]}'
        else:
            name = parts[0] if parts else ''
        name = name[:15]
        with self._name_lock:
            if name != self.patient_name:
                self.patient_name = name
                return True
            return False

    def build_name_cfg_payload(self) -> bytes | None:
        """[CMD_NAME_CFG][len][name bytes...] — 2-17 bytes."""
        with self._name_lock:
            name = self.patient_name
        if not name:
            return None
        name_bytes = name.encode('utf-8')[:15]
        try:
            return struct.pack('<BB', CMD_NAME_CFG, len(name_bytes)) + name_bytes
        except Exception as e:
            print(f'[NAME] {self.name}: payload build error: {e}')
            return None

    def enqueue_name_cfg(self):
        p = self.build_name_cfg_payload()
        if p:
            with self._pending_lock:
                self._pending_cmds[CMD_NAME_CFG] = p

    def drain_pending(self) -> list:
        """Pop and return all pending (cmd_byte, payload) pairs. Thread-safe."""
        with self._pending_lock:
            cmds = list(self._pending_cmds.items())
            self._pending_cmds.clear()
        return cmds


def _discover_node_names() -> list[str]:
    """Query ThingsBoard for tenant devices whose name contains "node"
    (case-insensitive) — same convention as pages/api/devices.js. Lets nodes
    created via the dashboard's "+ Node" button be picked up automatically.
    Returns [] on any failure (best-effort; NODE_LIST / legacy config still apply).
    """
    try:
        # The c7-2slab reverse proxy 403s requests with the default
        # "Python-urllib" User-Agent — send a browser-like one.
        login_req = urllib.request.Request(
            f'{TB_REST_URL}/api/auth/login',
            data=json.dumps({'username': TB_USERNAME, 'password': TB_PASSWORD}).encode(),
            method='POST',
            headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'},
        )
        with urllib.request.urlopen(login_req, timeout=8) as resp:
            token = json.loads(resp.read())['token']

        devices_req = urllib.request.Request(
            f'{TB_REST_URL}/api/tenant/devices?pageSize=100&page=0',
            headers={'X-Authorization': f'Bearer {token}', 'User-Agent': 'Mozilla/5.0'},
        )
        with urllib.request.urlopen(devices_req, timeout=8) as resp:
            data = json.loads(resp.read())

        names = []
        for d in data.get('data', []):
            if TB_DEVICE_ID and d.get('id', {}).get('id') == TB_DEVICE_ID:
                continue
            name = d.get('name', '')
            if 'node' in name.lower():
                names.append(name)
        return names
    except Exception as e:
        print(f'[TB]  Node discovery via {TB_REST_URL} failed: {e}')
        return []


def _parse_node_list() -> dict[str, NodeState]:
    """Build {name: NodeState} from NODE_LIST env / legacy single-node vars,
    plus any "node" devices discovered on ThingsBoard that aren't listed yet.
    """
    nodes: dict[str, NodeState] = {}
    if NODE_LIST_ENV:
        for entry in NODE_LIST_ENV.split(','):
            entry = entry.strip()
            if not entry:
                continue
            # "NodeName:BLE_ADDR" — split on first colon only; MAC has its own colons
            sep = entry.index(':')
            name = entry[:sep].strip()
            addr = entry[sep + 1:].strip()
            if name and addr:
                nodes[name] = NodeState(name, addr)

    for name in _discover_node_names():
        if name not in nodes:
            nodes[name] = NodeState(name, '00:00:00:00:00:00')
            print(f'[TB]  Discovered node from dashboard: {name}')

    if not nodes:
        nodes[TB_NODE_NAME] = NodeState(TB_NODE_NAME, BLE_ADDRESS)
    return nodes


PATIENT_NAME_POLL_S = 30  # how often to re-check ThingsBoard's patientName (SERVER_SCOPE attr)


def _patient_name_poller(nodes: dict[str, 'NodeState']):
    """Periodically pull each node's `patientName` SERVER_SCOPE attribute from
    ThingsBoard via REST (not available over the gateway MQTT attribute API,
    which only covers SHARED/CLIENT scope) and push CMD_NAME_CFG when changed.
    """
    while True:
        try:
            login_req = urllib.request.Request(
                f'{TB_REST_URL}/api/auth/login',
                data=json.dumps({'username': TB_USERNAME, 'password': TB_PASSWORD}).encode(),
                method='POST',
                headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'},
            )
            with urllib.request.urlopen(login_req, timeout=8) as resp:
                token = json.loads(resp.read())['token']

            devices_req = urllib.request.Request(
                f'{TB_REST_URL}/api/tenant/devices?pageSize=100&page=0',
                headers={'X-Authorization': f'Bearer {token}', 'User-Agent': 'Mozilla/5.0'},
            )
            with urllib.request.urlopen(devices_req, timeout=8) as resp:
                data = json.loads(resp.read())

            name_to_id = {d.get('name', ''): d.get('id', {}).get('id') for d in data.get('data', [])}

            for node_name, node in nodes.items():
                device_id = name_to_id.get(node_name)
                if not device_id:
                    continue
                attr_req = urllib.request.Request(
                    f'{TB_REST_URL}/api/plugins/telemetry/DEVICE/{device_id}/values/attributes/SERVER_SCOPE?keys=patientName',
                    headers={'X-Authorization': f'Bearer {token}', 'User-Agent': 'Mozilla/5.0'},
                )
                with urllib.request.urlopen(attr_req, timeout=8) as resp:
                    attrs = json.loads(resp.read())

                patient_name = next((a.get('value') for a in attrs if a.get('key') == 'patientName'), None)
                if patient_name is not None and node.set_patient_name(str(patient_name)):
                    print(f'[TB]  {node_name}: patientName -> "{patient_name}"')
                    if node.ble_connected:
                        node.enqueue_name_cfg()
        except Exception as e:
            print(f'[TB]  patientName poll failed: {e}')

        time.sleep(PATIENT_NAME_POLL_S)


# ── Shared publish queue (MQTT publish thread) ────────────────────────
# Items: ('ecg', node_name, samples_list) | ('vitals', node_name, (ecg_hr, ppg_hr, spo2, temp))
publish_q = queue.Queue(maxsize=100)

mqtt_connected        = threading.Event()
mqtt                  = None
_attr_req_id          = 0
_pending_attr_req_key  = {}   # req_id -> attribute key
_pending_attr_req_node = {}   # req_id -> node name
_attrs_requested       = set()  # node names already pulled once (avoid re-burst on reconnect)

# Filled by _parse_node_list() before MQTT setup
nodes: dict[str, NodeState] = {}


# ── REST-based 'connected' SERVER_SCOPE attribute ───────────────────────
# TB's built-in active/lastConnectTime/lastDisconnectTime tracking for
# gateway sub-devices is unreliable (active can stay stuck true, and
# connect/disconnect timestamps can arrive out of order). Instead, the
# gateway sets its own 'connected' SERVER_SCOPE attribute directly via the
# REST API (tenant-authenticated) — this is the single source of truth for
# whether the gateway currently has a live BLE link to the node.

_tb_rest_cache = {'token': None, 'expiry': 0.0, 'device_ids': {}}


def _tb_rest_token() -> str:
    cache = _tb_rest_cache
    if cache['token'] and time.time() < cache['expiry']:
        return cache['token']
    req = urllib.request.Request(
        f'{TB_REST_URL}/api/auth/login',
        data=json.dumps({'username': TB_USERNAME, 'password': TB_PASSWORD}).encode(),
        method='POST',
        headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        token = json.loads(resp.read())['token']
    cache['token'] = token
    cache['expiry'] = time.time() + 2 * 60 * 60
    return token


def _tb_device_id(node_name: str, token: str) -> str | None:
    cache = _tb_rest_cache['device_ids']
    if node_name in cache:
        return cache[node_name]
    req = urllib.request.Request(
        f'{TB_REST_URL}/api/tenant/devices?pageSize=100&page=0',
        headers={'X-Authorization': f'Bearer {token}', 'User-Agent': 'Mozilla/5.0'},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read())
    for d in data.get('data', []):
        cache[d.get('name', '')] = d.get('id', {}).get('id')
    return cache.get(node_name)


def _set_connected_attr(node_name: str, connected: bool):
    """Set the 'connected' SERVER_SCOPE attribute for a node via REST. Runs
    synchronously — call from a background thread to avoid blocking BLE/MQTT.
    """
    try:
        token = _tb_rest_token()
        device_id = _tb_device_id(node_name, token)
        if not device_id:
            print(f'[TB]  {node_name}: REST attr update skipped (device id not found)')
            return
        req = urllib.request.Request(
            f'{TB_REST_URL}/api/plugins/telemetry/DEVICE/{device_id}/attributes/SERVER_SCOPE',
            data=json.dumps({'connected': connected}).encode(),
            method='POST',
            headers={'Content-Type': 'application/json', 'X-Authorization': f'Bearer {token}', 'User-Agent': 'Mozilla/5.0'},
        )
        urllib.request.urlopen(req, timeout=8).read()
    except Exception as e:
        print(f'[TB]  {node_name}: failed to set connected={connected}: {e}')


def _set_connected_attr_async(node_name: str, connected: bool):
    threading.Thread(target=_set_connected_attr, args=(node_name, connected), daemon=True).start()


def _connect_all_devices(client):
    """Register every node's session with the TB gateway so attribute
    request/response routing (bleAddress, thresholds, ...) works — this has
    to happen before BLE ever connects. Immediately follow with 'disconnect'
    for any node whose BLE link isn't up yet, so TB doesn't report it as
    active/online until the gateway actually connects to it over BLE.
    """
    for node_name in nodes:
        client.publish('v1/gateway/connect', json.dumps({"device": node_name, "type": "default"}))
    print(f'[TB]  Announced connect for {len(nodes)} node(s): {list(nodes)}')
    for node_name, node in nodes.items():
        if not node.ble_connected:
            client.publish('v1/gateway/disconnect', json.dumps({"device": node_name}))
        _set_connected_attr_async(node_name, node.ble_connected)


def _announce_ble_connect(node_name: str):
    """Mark a node active in ThingsBoard once its BLE link is actually up."""
    if mqtt_connected.is_set():
        mqtt.publish('v1/gateway/connect', json.dumps({"device": node_name, "type": "default"}))
        _set_connected_attr_async(node_name, True)
        print(f'[TB]  {node_name}: connect announced (active)')


def _announce_ble_disconnect(node_name: str):
    """Mark a node inactive in ThingsBoard once its BLE link drops."""
    if mqtt_connected.is_set():
        mqtt.publish('v1/gateway/disconnect', json.dumps({"device": node_name}))
        _set_connected_attr_async(node_name, False)
        print(f'[TB]  {node_name}: disconnect announced (inactive)')


def _request_all_attrs(client):
    """Pull every shared attribute once per node (first connect only).

    ThingsBoard disconnects the gateway (rc=7 / CONN_LOST) if it sees a burst
    of ~30 publishes per node right after connecting — it looks like a rate-
    limit trip. Since `nodes` survives MQTT reconnects, we only need the full
    pull the very first time; afterward ATTR_PUSH_TOPIC delivers any changes.
    """
    global _attr_req_id
    pending = [n for n in nodes if n not in _attrs_requested]
    if not pending:
        return
    for node_name in pending:
        for key in ALL_SHARED_KEYS:
            _attr_req_id += 1
            _pending_attr_req_key[_attr_req_id]  = key
            _pending_attr_req_node[_attr_req_id] = node_name
            payload = json.dumps({"id": _attr_req_id, "device": node_name,
                                  "client": False, "key": key})
            client.publish(ATTR_REQ_TOPIC, payload)
        _attrs_requested.add(node_name)
    print(f'[TB]  Requested shared attrs for {len(pending)} node(s): {pending}')


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
            print(f'[TB]  {node_name}: attr response {key}={value}')
            if key == 'bleAddress':
                node.set_address(str(value))
            elif key in THRESHOLD_KEYS:
                # Update state; if already connected, enqueue so the live device gets it.
                # _pending_cmds deduplicates: many threshold keys arriving → one CMD_THR slot.
                if node.update_thresholds({key: value}) and node.ble_connected:
                    node.enqueue_thresholds()
            elif key in ECG_CFG_KEYS:
                if node.update_ecg_cfg({key: value}) and node.ble_connected:
                    node.enqueue_ecg_cfg()
            elif key in PPG_CFG_KEYS:
                if node.update_ppg_cfg({key: value}) and node.ble_connected:
                    node.enqueue_ppg_cfg()
            elif key in VITAL_CFG_KEYS:
                if node.update_vital_cfg({key: value}) and node.ble_connected:
                    node.enqueue_vital_cfg()
            elif key in MODE_CFG_KEYS:
                if node.update_mode_cfg({key: value}) and node.ble_connected:
                    node.enqueue_mode_cfg()

        elif topic == ATTR_PUSH_TOPIC:
            # {"device": "Node1", "data": {"bleAddress": "..", "ppgHr_warnMin": 50, ...}}
            node_name = data.get('device')
            print(f'[TB]  attr push for device={node_name!r}: {data}')
            node = nodes.get(node_name)
            if node is None:
                print(f'[TB]  attr push: unknown device {node_name!r} — known: {list(nodes)}')
                return
            updates = data.get('data', {})

            if 'bleAddress' in updates:
                node.set_address(str(updates['bleAddress']))

            thr_updates = {k: v for k, v in updates.items() if k in THRESHOLD_KEYS}
            if thr_updates and node.update_thresholds(thr_updates):
                node.enqueue_thresholds()
                print(f'[TB]  {node_name}: thresholds changed {thr_updates} -> CMD_THR queued')

            ecg_updates = {k: v for k, v in updates.items() if k in ECG_CFG_KEYS}
            if ecg_updates and node.update_ecg_cfg(ecg_updates):
                node.enqueue_ecg_cfg()
                print(f'[TB]  {node_name}: ECG config changed {ecg_updates} -> CMD_ECG_CFG queued')

            ppg_updates = {k: v for k, v in updates.items() if k in PPG_CFG_KEYS}
            if ppg_updates and node.update_ppg_cfg(ppg_updates):
                node.enqueue_ppg_cfg()
                print(f'[TB]  {node_name}: PPG config changed {ppg_updates} -> CMD_PPG_CFG queued')

            vital_updates = {k: v for k, v in updates.items() if k in VITAL_CFG_KEYS}
            if vital_updates and node.update_vital_cfg(vital_updates):
                node.enqueue_vital_cfg()
                print(f'[TB]  {node_name}: vital config changed {vital_updates} -> CMD_VITAL_CFG queued')

            mode_updates = {k: v for k, v in updates.items() if k in MODE_CFG_KEYS}
            if mode_updates and node.update_mode_cfg(mode_updates):
                node.enqueue_mode_cfg()
                print(f'[TB]  {node_name}: mode config changed {mode_updates} -> CMD_MODE_CFG queued')

    except Exception as e:
        print(f'[MQTT] Message parse error: {e}')


def mqtt_on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f'[MQTT] Connected to {MQTT_HOST}:{MQTT_PORT}')
        client.subscribe(ATTR_RESP_TOPIC)
        client.subscribe(ATTR_PUSH_TOPIC)
        mqtt_connected.set()
        _connect_all_devices(client)
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
    mqtt.username_pw_set(MQTT_TOKEN, '')
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
        pkt_type = item[0]
        ts = int(time.time() * 1000)

        if pkt_type == 'ecg':
            _, node_name, samples = item
            batch_num += 1
            if not mqtt_connected.is_set():
                print(f'[MQTT] Not connected — dropping {node_name} ECG batch #{batch_num}')
            else:
                # Split into chunks of PUBLISH_CHUNK samples; offset ts by 1 ms per chunk
                # so ThingsBoard preserves ordering when multiple messages land at once
                for ci, offset in enumerate(range(0, len(samples), PUBLISH_CHUNK)):
                    chunk = samples[offset:offset + PUBLISH_CHUNK]
                    chunk_payload = {
                        node_name: [{
                            'ts':     ts + ci,
                            'values': {'ecg_batch': json.dumps(chunk)},
                        }]
                    }
                    result = mqtt.publish(MQTT_TOPIC, json.dumps(chunk_payload), qos=0)
                if batch_num % 25 == 0:
                    n_chunks = (len(samples) + PUBLISH_CHUNK - 1) // PUBLISH_CHUNK
                    print(f'[MQTT] {node_name} ECG batch #{batch_num} '
                          f'({len(samples)} samples, {n_chunks} msg(s))')

        elif pkt_type == 'vitals':
            _, node_name, (ecg_hr, ppg_hr, spo2, temp) = item
            # 0 = sensor absent / reading not ready (firmware validity flag) →
            # omit the key so ThingsBoard never stores it and the dashboard shows "__".
            # hr and spo2 come from uint8_t fields in firmware — publish as integers.
            values = {}
            if ecg_hr > 0: values['ecgHeartRate'] = int(round(ecg_hr))
            if ppg_hr > 0: values['ppgHeartRate'] = int(round(ppg_hr))
            if spo2   > 0: values['spo2']         = int(round(spo2))
            if temp   > 0: values['temperature']  = round(temp, 1)
            if not values:
                publish_q.task_done()
                continue
            payload = { node_name: [{ 'ts': ts, 'values': values }] }
            if mqtt_connected.is_set():
                mqtt.publish(MQTT_TOPIC, json.dumps(payload), qos=0)
                print(f'[MQTT] {node_name} vitals {values}')
            else:
                print(f'[MQTT] Not connected — dropping {node_name} vitals')

        publish_q.task_done()


# ── BLE helpers ───────────────────────────────────────────────────────

_scan_lock      = threading.Lock()   # only one thread may call adapter.scan_for() at a time
_scan_cache     = {}                 # address(lower) -> peripheral, from the last scan
_scan_cache_ts  = 0.0                # monotonic-ish wall time of the last scan
SCAN_CACHE_TTL_S = 5.0               # reuse a scan this fresh instead of re-scanning


def wait_for_bluetooth():
    while not simplepyble.Adapter.bluetooth_enabled():
        print('[BLE] Bluetooth not enabled — waiting...')
        time.sleep(5)


def _find_peripheral(adapter, target: str):
    """Return the peripheral whose address matches `target`, or None.

    A single scan discovers *all* nearby nodes at once and caches them by
    address. Concurrent node workers share that one scan: whoever scans first
    populates the cache, and every other node looks up its own address in the
    same results instead of running its own redundant scan. This is what lets a
    newly added node (e.g. Node4) be found from the same sweep as Node1.

    Offline nodes keep getting scanned too — a node can only come online *after*
    the gateway connects, so an absent address just isn't in the cache yet. Once
    the cache goes stale (TTL) the next worker triggers a fresh sweep, which
    again covers every node in range, online or not.
    """
    global _scan_cache, _scan_cache_ts
    target = target.lower()
    with _scan_lock:
        # Trust a recent sweep for *every* node, present or not: it already
        # covered all devices in range, so an offline node is simply absent.
        # Re-scan only once the cache goes stale, so multiple offline workers
        # share one sweep instead of each running its own back-to-back scan.
        if (time.time() - _scan_cache_ts) < SCAN_CACHE_TTL_S:
            return _scan_cache.get(target)
        adapter.scan_for(3000)
        _scan_cache = {p.address().lower(): p for p in adapter.scan_get_results()}
        _scan_cache_ts = time.time()
        return _scan_cache.get(target)


def ble_connect_node(adapter, node: NodeState):
    wait_for_bluetooth()
    while True:
        if node.addr_changed.is_set():
            node.addr_changed.clear()
        target = node.get_address()
        print(f'[BLE] {node.name}: scanning for {target}...')
        p = _find_peripheral(adapter, target)
        if p is not None:
            print(f'[BLE] {node.name}: found [{p.address()}] - connecting')
            p.connect()
            # Windows BLE (WinRT) discovers GATT services asynchronously
            # after connect() returns; calling notify()/write too soon
            # throws E_ILLEGAL_METHOD_CALL or "Service ... not found".
            # Poll until our service actually shows up instead of a fixed
            # guess-delay — much more robust against slow discovery.
            for _ in range(20):  # up to ~10 s
                try:
                    if any(s.uuid().lower() == SERVICE_UUID.lower()
                           for s in p.services()):
                        return p
                except Exception:
                    pass
                time.sleep(0.5)
            print(f'[BLE] {node.name}: service not discovered after connect — disconnecting')
            p.disconnect()
        else:
            print(f'[BLE] {node.name}: not found, retrying...')
        time.sleep(1)


# ── BLE write helper ─────────────────────────────────────────────────

_CMD_LABEL = {
    CMD_THR:       'thresholds',
    CMD_ECG_CFG:   'ECG config',
    CMD_PPG_CFG:   'PPG config',
    CMD_VITAL_CFG: 'vital config',
    CMD_MODE_CFG:  'mode config',
    CMD_NAME_CFG:  'patient name',
}


def _ble_write_pending(node: NodeState, peripheral) -> bool:
    """Drain and send all pending commands. Returns False if a write fails."""
    for cmd_byte, payload in node.drain_pending():
        try:
            peripheral.write_request(SERVICE_UUID, RX_CHAR_UUID, payload)
            print(f'[BLE] {node.name}: {_CMD_LABEL.get(cmd_byte, "cmd")} written')
        except Exception as e:
            print(f'[BLE] {node.name}: write error ({_CMD_LABEL.get(cmd_byte, "cmd")}): {e}')
            return False
    return True


# ── Per-node BLE worker thread ────────────────────────────────────────

def node_worker(node: NodeState, adapter):
    local_batch_count = 0

    def on_notify(data: bytes):
        nonlocal local_batch_count
        if len(data) == VITALS_SIZE:
            # Vitals: [hrEcg u8][hrPpg u8][spo2 u8][temp u16 LE x10] = 5 bytes
            ecg_hr, ppg_hr, spo2, temp_x10 = struct.unpack_from('<3BH', data)
            temp = temp_x10 / 10.0
            try:
                publish_q.put_nowait(('vitals', node.name, (ecg_hr, ppg_hr, spo2, temp)))
            except queue.Full:
                print(f'[BLE] {node.name}: publish queue full — dropping vitals')
        elif len(data) >= 2 and len(data) % 2 == 0:
            # ECG: N × int16 LE — batch size is dynamic (ecgSampleFreq × ecgPacketInterval / 1000)
            n_samples = len(data) // 2
            samples = list(struct.unpack_from(f'<{n_samples}h', data))
            local_batch_count += 1
            try:
                publish_q.put_nowait(('ecg', node.name, samples))
            except queue.Full:
                print(f'[BLE] {node.name}: publish queue full — dropping ECG batch')
            if local_batch_count % 25 == 0:
                print(f'[BLE] {node.name}: ECG batch #{local_batch_count} ({n_samples} samples)')
        else:
            print(f'[BLE] {node.name}: unexpected notify len={len(data)}')

    while True:
        node.addr_changed.clear()
        peripheral = None
        disconnected_evt = threading.Event()
        try:
            peripheral = ble_connect_node(adapter, node)
            peripheral.set_callback_on_disconnected(disconnected_evt.set)
            peripheral.notify(SERVICE_UUID, CHARACTERISTIC_UUID, on_notify)
            print(f'[BLE] {node.name}: streaming ECG from {node.get_address()}')

            # Enqueue full config so the node always starts with ThingsBoard values.
            # _pending_cmds has one slot per command type — no overflow possible.
            node.enqueue_thresholds()
            node.enqueue_ecg_cfg()
            node.enqueue_ppg_cfg()
            node.enqueue_vital_cfg()
            node.enqueue_mode_cfg()
            node.enqueue_name_cfg()

            # Mark connected BEFORE draining so any ATTR_RESP that arrives
            # concurrently will also enqueue into _pending_cmds (deduped).
            node.ble_connected = True
            _announce_ble_connect(node.name)
            _ble_write_pending(node, peripheral)

            while True:
                time.sleep(2)
                _ble_write_pending(node, peripheral)

                if node.addr_changed.is_set():
                    print(f'[BLE] {node.name}: address changed -> reconnecting')
                    break
                if disconnected_evt.is_set():
                    print(f'[BLE] {node.name}: disconnected — reconnecting')
                    break

        except KeyboardInterrupt:
            if node.ble_connected:
                node.ble_connected = False
                _announce_ble_disconnect(node.name)
            raise
        except Exception as e:
            print(f'[BLE] {node.name}: {e} — retry in 5s')
            time.sleep(5)
        finally:
            if node.ble_connected:
                node.ble_connected = False
                _announce_ble_disconnect(node.name)
            # Tear down the link explicitly. Without this, a "no data"/addr-change
            # break (or an exception after connect) leaves the peripheral's BLE
            # connection slot occupied — the node's softdevice still thinks it's
            # connected, so every subsequent connect() attempt silently fails and
            # the gateway loops "scanning... not found" forever.
            if peripheral is not None:
                try:
                    peripheral.disconnect()
                except Exception:
                    pass


# ── Main ──────────────────────────────────────────────────────────────

def main():
    global nodes

    if not ACCESS_TOKEN:
        print('ERROR: TB_GATEWAY_ACCESS_TOKEN must be set in .env.local')
        return

    _select_broker()  # also picks the matching REST URL for node discovery below
    nodes = _parse_node_list()

    print('=' * 49)
    print(f'  BLE ECG Gateway -> ThingsBoard  ({len(nodes)} node(s))')
    print('=' * 49)
    for n in nodes.values():
        print(f'  {n.name} -> {n.get_address()}')
    print()

    mqtt_setup()
    threading.Thread(target=publish_worker, daemon=True).start()
    threading.Thread(target=_patient_name_poller, args=(nodes,), daemon=True).start()

    # Connect to the server first: wait for MQTT, then for each node's
    # bleAddress attribute response/push, before touching the BLE adapter at
    # all — the real BLE addresses live on ThingsBoard, not in local config.
    print('[MQTT] Connecting to ThingsBoard before starting BLE...')
    if mqtt_connected.wait(timeout=15):
        print('[MQTT] Connected — fetching BLE addresses from server...')
        for node in nodes.values():
            if node.addr_ready.wait(timeout=ADDR_WAIT_TIMEOUT_S):
                print(f'[BLE] {node.name}: address from server -> {node.get_address()}')
            else:
                print(f'[BLE] {node.name}: no server response — using configured address {node.get_address()}')
    else:
        print('[MQTT] Connection timeout — using configured BLE addresses')

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
