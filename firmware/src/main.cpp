// ── HealthMonitor ESP32 Firmware ─────────────────────────────────────────────
// Event-driven: esp_timer samples ADC at 250Hz into a working buffer.
// When a batch is complete it swaps to a ready buffer and sets batchReady.
// loop() posts via ThingsBoard Gateway API so data routes to the child node.
//
// Gateway telemetry format:  POST /api/v1/{gatewayToken}/telemetry
//   {"NodeX": [{"ts": T, "values": {"ecg": v, "ppg": v}}, ...]}
//
// First boot: no config in NVS → starts "HealthMonitor-Setup" AP and serves
//   a captive portal to collect WiFi credentials, gateway token, and node name.
//   After save the device restarts and connects normally.
// ─────────────────────────────────────────────────────────────────────────────

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_timer.h>
#include <time.h>
#include <math.h>

// ── Compile-time constants ────────────────────────────────────────────────────

const char* TB_HOST   = "c7.hust-2slab.org";
const bool  USE_HTTPS = true;

#define SAMPLE_RATE_HZ      250
#define SAMPLE_INTERVAL_US  (1000000 / SAMPLE_RATE_HZ)
#define SAMPLE_INTERVAL_MS  (1000 / SAMPLE_RATE_HZ)
#define BATCH_SIZE          250
#define VITAL_INTERVAL_MS   15000
#define PAYLOAD_BUF_SIZE    20480
#define PHASE_OFFSET        0   // Node2→67, Node3→133

// ── Runtime config (loaded from NVS) ─────────────────────────────────────────

static char wifiSsid[64]      = "";
static char wifiPass[64]      = "";
static char gatewayToken[64]  = "";
static char nodeName[32]      = "";

static Preferences prefs;

// ── Buffers ───────────────────────────────────────────────────────────────────

static int16_t ecgWork[BATCH_SIZE], ppgWork[BATCH_SIZE];
static int16_t ecgReady[BATCH_SIZE], ppgReady[BATCH_SIZE];
static volatile unsigned long long readyTs = 0;
static volatile bool batchReady = false;
static int workIdx = 0;

static unsigned long lastVitalMs = 0;
static char payload[PAYLOAD_BUF_SIZE];

// ── Helpers ───────────────────────────────────────────────────────────────────

static unsigned long long epochMs() {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  if (tv.tv_sec < 1000000000L) return 0;
  return (unsigned long long)tv.tv_sec * 1000ULL + tv.tv_usec / 1000ULL;
}

static String tbUrl(const String& path) {
  return String(USE_HTTPS ? "https" : "http") + "://" + TB_HOST + path;
}

// ── NVS ───────────────────────────────────────────────────────────────────────

static bool loadConfig() {
  prefs.begin("hm", true);
  String ssid  = prefs.getString("wifi_ssid", "");
  String pass  = prefs.getString("wifi_pass", "");
  String gwtok = prefs.getString("gw_token",  "");
  String node  = prefs.getString("node_name", "");
  prefs.end();
  if (ssid.length() == 0 || gwtok.length() == 0 || node.length() == 0) return false;
  ssid.toCharArray(wifiSsid,     sizeof(wifiSsid));
  pass.toCharArray(wifiPass,     sizeof(wifiPass));
  gwtok.toCharArray(gatewayToken, sizeof(gatewayToken));
  node.toCharArray(nodeName,     sizeof(nodeName));
  return true;
}

// ── Captive portal ────────────────────────────────────────────────────────────

static const char PORTAL_HTML[] = R"html(
<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HealthMonitor Setup</title>
<style>
  *{box-sizing:border-box}
  body{font-family:sans-serif;background:#f0f2f5;margin:0;padding:24px}
  .card{background:#fff;max-width:420px;margin:0 auto;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.1)}
  h2{margin:0 0 6px;color:#1a1a2e;font-size:20px}
  p{margin:0 0 22px;color:#888;font-size:13px}
  label{display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:5px}
  input,select{display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:16px;outline:none;background:#fff}
  input:focus,select:focus{border-color:#2196F3}
  hr{border:none;border-top:1px solid #eee;margin:18px 0}
  button{width:100%;padding:13px;background:#2196F3;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
  button:hover{background:#1976D2}
  small{color:#aaa;font-size:12px;display:block;margin-top:-12px;margin-bottom:16px}
</style></head><body>
<div class="card">
  <h2>HealthMonitor Setup</h2>
  <p>Configure WiFi and ThingsBoard gateway credentials.</p>
  <form method="POST" action="/save">
    <label>WiFi Network (SSID)</label>
    <input name="ssid" placeholder="Your WiFi name" required>
    <label>WiFi Password</label>
    <input name="pass" type="password" placeholder="Leave blank if open network">
    <hr>
    <label>Gateway Access Token</label>
    <input name="gwtok" placeholder="Paste from wearable_dev_gateway" required>
    <small>TB → Devices → wearable_dev_gateway → Copy Access Token</small>
    <label>Node Name</label>
    <input name="node" placeholder="Node1" required>
    <small>Must match the device name in ThingsBoard (Node1, Node2, …)</small>
    <button type="submit">Save &amp; Connect</button>
  </form>
</div>
</body></html>
)html";

static void startConfigPortal() {
  Serial.println("[Portal] Starting AP: HealthMonitor-Setup");
  WiFi.softAP("HealthMonitor-Setup");
  IPAddress apIP = WiFi.softAPIP();
  Serial.printf("[Portal] Open http://%s\n", apIP.toString().c_str());

  DNSServer dns;
  dns.start(53, "*", apIP);

  WebServer server(80);

  server.on("/", HTTP_GET, [&]() {
    server.send(200, "text/html", PORTAL_HTML);
  });

  server.on("/save", HTTP_POST, [&]() {
    String ssid  = server.arg("ssid");
    String pass  = server.arg("pass");
    String gwtok = server.arg("gwtok");
    String node  = server.arg("node");

    prefs.begin("hm", false);
    prefs.putString("wifi_ssid", ssid);
    prefs.putString("wifi_pass", pass);
    prefs.putString("gw_token",  gwtok);
    prefs.putString("node_name", node);
    prefs.end();

    server.send(200, "text/html",
      "<html><body style='font-family:sans-serif;max-width:420px;margin:40px auto;padding:24px'>"
      "<h2 style='color:#4CAF50'>Saved!</h2>"
      "<p>Connecting to <b>" + ssid + "</b> as node <b>" + node + "</b>.</p>"
      "<p>Device is restarting&hellip;</p></body></html>");
    delay(1500);
    ESP.restart();
  });

  server.onNotFound([&]() {
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
  });

  server.begin();
  Serial.println("[Portal] Waiting for configuration...");
  while (true) {
    dns.processNextRequest();
    server.handleClient();
  }
}

// ── WiFi + NTP ────────────────────────────────────────────────────────────────

static void setupWiFi() {
  WiFi.begin(wifiSsid, wifiPass);
  Serial.printf("WiFi connecting to %s", wifiSsid);
  for (int i = 0; i < 40; i++) {
    if (WiFi.status() == WL_CONNECTED) break;
    delay(500); Serial.print(".");
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n[WiFi] Failed — clearing credentials, restarting to portal");
    prefs.begin("hm", false);
    prefs.remove("wifi_ssid");
    prefs.remove("wifi_pass");
    prefs.end();
    delay(500);
    ESP.restart();
  }
  Serial.printf("\nWiFi OK — %s\n", WiFi.localIP().toString().c_str());

  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("NTP sync");
  for (int i = 0; i < 20; i++) {
    if (epochMs() > 0) { Serial.println(" OK"); return; }
    delay(500); Serial.print(".");
  }
  Serial.println(" (skipped)");
}

// ── POST to gateway telemetry API ─────────────────────────────────────────────

static void postToGateway(int len) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, tbUrl("/api/v1/" + String(gatewayToken) + "/telemetry"));
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t*)payload, len);
  http.end();
  if (code == 401) {
    Serial.println("[TB] 401 — invalid gateway token, restarting to portal");
    prefs.begin("hm", false);
    prefs.remove("gw_token");
    prefs.end();
    delay(500);
    ESP.restart();
  }
  if (code > 0) {
    if (code >= 300) Serial.printf("[TB] %d\n", code);
  } else {
    Serial.printf("[TB] error: %s\n", http.errorToString(code).c_str());
  }
}

// ── Publish waveform batch ────────────────────────────────────────────────────
// Gateway format: {"NodeX": [{"ts": T, "values": {"ecg": v, "ppg": v}}, ...]}

static void publishWaveform() {
  unsigned long long batchTs = readyTs > 0 ? readyTs : epochMs();
  int pos = 0;
  pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "{\"%s\":[", nodeName);
  for (int i = 0; i < BATCH_SIZE; i++) {
    unsigned long long ts =
      batchTs - (unsigned long long)(BATCH_SIZE - 1 - i) * SAMPLE_INTERVAL_MS;
    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
      "%s{\"ts\":%llu,\"values\":{\"ecg\":%d,\"ppg\":%d}}",
      i > 0 ? "," : "", ts, ecgReady[i], ppgReady[i]);
  }
  pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "]}");
  postToGateway(pos);
  Serial.printf("[%s] wave %d bytes\n", nodeName, pos);
}

// ── Publish vitals ────────────────────────────────────────────────────────────
// Gateway format: {"NodeX": [{"ts": T, "values": {vitals}}]}

static void publishVitals(float ecgHr, float ppgHr, float spo2, float temp) {
  unsigned long long ts = epochMs();
  int pos;
  if (ts > 0) {
    pos = snprintf(payload, PAYLOAD_BUF_SIZE,
      "{\"%s\":[{\"ts\":%llu,\"values\":"
      "{\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,\"spo2\":%.1f,\"temperature\":%.1f}}]}",
      nodeName, ts, ecgHr, ppgHr, spo2, temp);
  } else {
    pos = snprintf(payload, PAYLOAD_BUF_SIZE,
      "{\"%s\":[{\"values\":"
      "{\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,\"spo2\":%.1f,\"temperature\":%.1f}}]}",
      nodeName, ecgHr, ppgHr, spo2, temp);
  }
  postToGateway(pos);
  Serial.printf("[%s] vitals ECG-HR:%.1f PPG-HR:%.1f SpO2:%.1f Temp:%.1f\n",
                nodeName, ecgHr, ppgHr, spo2, temp);
}

// ── Demo signal generators ────────────────────────────────────────────────────

static uint32_t sampleCount = 0;

static int16_t ecgDemo(uint32_t idx) {
  float phase = (float)((idx + PHASE_OFFSET) % 200) / 200.0f;
  float d     = (phase - 0.5f) * 20.0f;
  float v     = 2000.0f * expf(-(d * d)) + (float)(rand() % 40 - 20);
  return (int16_t)constrain((int)(2048.0f + v), 0, 4095);
}

static int16_t ppgDemo(uint32_t idx) {
  float phase = (float)((idx + PHASE_OFFSET) % 200) / 200.0f;
  float v     = 800.0f * sinf(2.0f * (float)M_PI * phase) + (float)(rand() % 20 - 10);
  return (int16_t)constrain((int)(2048.0f + v), 0, 4095);
}

// ── 250Hz sample timer ────────────────────────────────────────────────────────

static void onSampleTimer(void*) {
  ecgWork[workIdx] = ecgDemo(sampleCount);
  ppgWork[workIdx] = ppgDemo(sampleCount);
  sampleCount++;
  if (++workIdx < BATCH_SIZE) return;
  workIdx = 0;

  if (batchReady) return;
  memcpy(ecgReady, ecgWork, BATCH_SIZE * sizeof(int16_t));
  memcpy(ppgReady, ppgWork, BATCH_SIZE * sizeof(int16_t));
  readyTs    = epochMs();
  batchReady = true;
}

// ── Signal processing stubs ───────────────────────────────────────────────────

static float computeEcgHR(int16_t* buf, int n)  { (void)buf; (void)n; return 72.0f; }
static float computePpgHR(int16_t* buf, int n)  { (void)buf; (void)n; return 71.0f; }
static float computeSpO2(int16_t* buf, int n)   { (void)buf; (void)n; return 98.5f; }
static float readTemperature()                   { return 36.6f; }

// ── setup / loop ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);

  if (!loadConfig()) {
    Serial.println("[Setup] No config — starting captive portal");
    startConfigPortal();  // never returns; restarts after save
  }
  Serial.printf("[Setup] Node: %s  WiFi: %s\n", nodeName, wifiSsid);

  setupWiFi();

  esp_timer_create_args_t args = {};
  args.callback = onSampleTimer;
  args.name     = "sample";
  esp_timer_handle_t timer;
  esp_timer_create(&args, &timer);
  esp_timer_start_periodic(timer, SAMPLE_INTERVAL_US);

  Serial.printf("Ready — [%s] 250Hz via gateway\n", nodeName);
}

void loop() {
  if (batchReady) {
    publishWaveform();
    batchReady = false;
  }

  unsigned long nowMs = millis();
  if (nowMs - lastVitalMs >= VITAL_INTERVAL_MS) {
    lastVitalMs = nowMs;
    publishVitals(
      computeEcgHR(ecgReady, BATCH_SIZE),
      computePpgHR(ppgReady, BATCH_SIZE),
      computeSpO2(ppgReady, BATCH_SIZE),
      readTemperature()
    );
  }
}
