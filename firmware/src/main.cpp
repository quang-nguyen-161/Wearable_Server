// ── HealthMonitor ESP32 Firmware ─────────────────────────────────────────────
// Event-driven: esp_timer samples ADC at 250Hz into a working buffer.
// When a batch is complete it sets batchReady; loop() publishes it via MQTT.
//
// First boot — captive portal (AP "HealthMonitor-Setup"):
//   Enter WiFi SSID/pass + ThingsBoard admin email/password.
//   After saving the device restarts, connects, and auto-discovers nodes.
//
// Node discovery (every 10s):
//   Fetches all TB devices whose name contains "node" (case-insensitive).
//   TB gateway API auto-creates leaf devices on first publish.
//
// Telemetry: MQTT gateway API (v1/gateway/telemetry, port 1883).
// Admin API (node discovery): HTTPS via WiFiClientSecure → c7.hust-2slab.org (Cloudflare).
// ─────────────────────────────────────────────────────────────────────────────

#include <Arduino.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <esp_timer.h>
#include <WiFiClientSecure.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <time.h>
#include <math.h>

// ── Compile-time constants ────────────────────────────────────────────────────

const char* TB_HOST = "103.116.39.179";

#define TB_MQTT_PORT          1883
#define TB_GATEWAY_TOKEN      "4o51ajerynq34mtosc26"
#define MQTT_BUF_SIZE         2048

#define SAMPLE_RATE_HZ        250
#define SAMPLE_INTERVAL_US    (1000000 / SAMPLE_RATE_HZ)
#define SAMPLE_INTERVAL_MS    (1000 / SAMPLE_RATE_HZ)
#define BATCH_SIZE            50      // 50 samples × 4ms = 200ms per batch
#define VITAL_INTERVAL_MS     5000
#define NODE_SYNC_INTERVAL_MS 10000
#define PAYLOAD_BUF_SIZE      4096
#define MAX_NODES             16

// ── Runtime config ────────────────────────────────────────────────────────────

static char wifiSsid[64]    = "";
static char wifiPass[64]    = "";
static char tbAdminUser[64] = "";
static char tbAdminPass[64] = "";

// ── Node registry ─────────────────────────────────────────────────────────────

static String            nodeNames[MAX_NODES];
static int               nodeCount = 0;
static SemaphoreHandle_t nodeMutex;

// Per-node vital state — lazy-initialised on first publishVitals call.
// Default bases match test-direct-stream.js (Node1, Node4, Node6 order).
static float nodeHr[MAX_NODES]   = {};
static float nodeSpo2[MAX_NODES] = {};
static float nodeTemp[MAX_NODES] = {};

static const float kHrDef[]   = {67.0f, 75.0f, 65.0f};
static const float kSpo2Def[] = {98.3f, 98.1f, 97.8f};
static const float kTempDef[] = {36.4f, 36.8f, 36.4f};
static const int   kNDef      = 3;

static void initNodeVitals(int n) {
  nodeHr[n]   = n < kNDef ? kHrDef[n]   : 72.0f + n * 2.0f;
  nodeSpo2[n] = n < kNDef ? kSpo2Def[n] : 98.5f - n * 0.2f;
  nodeTemp[n] = n < kNDef ? kTempDef[n] : 36.6f + n * 0.1f;
}

static float frand() {
  return ((float)(rand() % 1000) - 500.0f) / 500.0f;  // -1.0 to 1.0
}

// ── Runtime state ─────────────────────────────────────────────────────────────

static String      adminJwt = "";
static Preferences prefs;

// ── Admin HTTPS client (node discovery only) ──────────────────────────────────

static WiFiClientSecure adminClient;

// ── MQTT client (all telemetry) ───────────────────────────────────────────────

static WiFiClient   mqttNetClient;
static PubSubClient mqttClient(mqttNetClient);

// ── ECG sampling buffers ───────────────────────────────────────────────────────

static int16_t ecgWork[BATCH_SIZE];
static volatile unsigned long long readyTs          = 0;
static volatile uint32_t           readySampleCount = 0;
static volatile bool               batchReady       = false;
static int workIdx = 0;

static unsigned long lastVitalMs = 0;
static char          payload[PAYLOAD_BUF_SIZE];

// ── Helpers ───────────────────────────────────────────────────────────────────

static unsigned long long epochMs() {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  if (tv.tv_sec < 1000000000L) return 0;
  return (unsigned long long)tv.tv_sec * 1000ULL + tv.tv_usec / 1000ULL;
}

static const char* TB_ADMIN_HOST = "c7.hust-2slab.org";

static String tbUrl(const String& path) {
  return String("https://") + TB_ADMIN_HOST + path;
}

static String jsonStr(const String& json, const String& key) {
  String needle = "\"" + key + "\":\"";
  int s = json.indexOf(needle);
  if (s < 0) return "";
  s += needle.length();
  int e = json.indexOf("\"", s);
  return e > s ? json.substring(s, e) : "";
}

// ── NVS ───────────────────────────────────────────────────────────────────────

static bool loadConfig() {
  prefs.begin("hm", true);
  String ssid = prefs.getString("wifi_ssid", "");
  String pass = prefs.getString("wifi_pass", "");
  String user = prefs.getString("tb_user",   "");
  String tpas = prefs.getString("tb_pass",   "");
  prefs.end();
  if (ssid.length() == 0 || user.length() == 0) return false;
  ssid.toCharArray(wifiSsid,    sizeof(wifiSsid));
  pass.toCharArray(wifiPass,    sizeof(wifiPass));
  user.toCharArray(tbAdminUser, sizeof(tbAdminUser));
  tpas.toCharArray(tbAdminPass, sizeof(tbAdminPass));
  return true;
}

static void loadNodesFromNVS() {
  prefs.begin("hm", true);
  int cnt = prefs.getInt("n_count", 0);
  nodeCount = 0;
  for (int i = 0; i < cnt && nodeCount < MAX_NODES; i++) {
    char nk[8];
    snprintf(nk, sizeof(nk), "n_%d", i);
    String name = prefs.getString(nk, "");
    if (name.length()) nodeNames[nodeCount++] = name;
  }
  prefs.end();
  Serial.printf("[Nodes] %d node(s) loaded from NVS\n", nodeCount);
}

static void saveNodesToNVS() {
  prefs.begin("hm", false);
  prefs.putInt("n_count", nodeCount);
  for (int i = 0; i < nodeCount; i++) {
    char nk[8];
    snprintf(nk, sizeof(nk), "n_%d", i);
    prefs.putString(nk, nodeNames[i]);
  }
  prefs.end();
}

// ── Captive portal ────────────────────────────────────────────────────────────

static const char PAGE1_HTML[] = R"html(
<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HealthMonitor Setup</title>
<style>
  *{box-sizing:border-box}
  body{font-family:sans-serif;background:#f0f2f5;margin:0;padding:24px}
  .card{background:#fff;max-width:420px;margin:0 auto;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.1)}
  h2{margin:0 0 4px;color:#1a1a2e;font-size:20px}
  .sub{color:#888;font-size:13px;margin:0 0 22px}
  label{display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:5px}
  input{display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:16px;outline:none}
  input:focus{border-color:#2196F3}
  hr{border:none;border-top:1px solid #eee;margin:18px 0}
  .err{background:#fff0f0;color:#c62828;border:1px solid #ffcdd2;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  button{width:100%;padding:13px;background:#2196F3;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
  button:hover{background:#1976D2}
</style></head><body>
<div class="card">
  <h2>HealthMonitor Setup</h2>
  <p class="sub">Nodes are discovered automatically from ThingsBoard.</p>
  %%ERROR%%
  <form method="POST" action="/save">
    <label>WiFi Network (SSID)</label>
    <input name="ssid" placeholder="Your WiFi name" required>
    <label>WiFi Password</label>
    <input name="pass" type="password" placeholder="Leave blank if open network">
    <hr>
    <label>ThingsBoard Admin Email</label>
    <input name="tbuser" placeholder="tenant@thingsboard.org" required>
    <label>ThingsBoard Admin Password</label>
    <input name="tbpass" type="password" placeholder="tenant" required>
    <button type="submit">Save &amp; Connect</button>
  </form>
</div></body></html>
)html";

static void startConfigPortal() {
  Serial.println("[Portal] Starting AP: HealthMonitor-Setup");
  WiFi.mode(WIFI_AP);
  WiFi.softAP("HealthMonitor-Setup");
  IPAddress apIP = WiFi.softAPIP();
  Serial.printf("[Portal] Open http://%s\n", apIP.toString().c_str());

  DNSServer dns;
  dns.start(53, "*", apIP);
  WebServer server(80);

  String pError = "";
  bool   pNeedsSave = false;
  String pSsid, pPass, pUser, pPass2;

  server.on("/", HTTP_GET, [&]() {
    String html = PAGE1_HTML;
    html.replace("%%ERROR%%", pError.length()
      ? "<div class='err'>" + pError + "</div>" : "");
    pError = "";
    server.send(200, "text/html", html);
  });

  server.on("/save", HTTP_POST, [&]() {
    pSsid  = server.arg("ssid");
    pPass  = server.arg("pass");
    pUser  = server.arg("tbuser");
    pPass2 = server.arg("tbpass");
    pNeedsSave = true;
    server.send(200, "text/html",
      "<html><head><meta charset='utf-8'>"
      "<meta http-equiv='refresh' content='2;url=/'></head>"
      "<body style='font-family:sans-serif;max-width:420px;margin:40px auto;padding:24px;text-align:center'>"
      "<h3 style='color:#555'>Verifying WiFi&hellip;</h3>"
      "<p style='color:#aaa'>Please wait.</p></body></html>");
  });

  server.onNotFound([&]() {
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
  });

  server.begin();

  while (true) {
    dns.processNextRequest();
    server.handleClient();

    if (!pNeedsSave) continue;
    pNeedsSave = false;

    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP("HealthMonitor-Setup");
    WiFi.begin(pSsid.c_str(), pPass.c_str());
    bool ok = false;
    for (int i = 0; i < 30; i++) {
      if (WiFi.status() == WL_CONNECTED) { ok = true; break; }
      delay(500);
    }
    WiFi.mode(WIFI_AP);
    WiFi.softAP("HealthMonitor-Setup");

    if (!ok) {
      pError = "Could not connect to '" + pSsid + "'. Check the SSID and password.";
      continue;
    }

    prefs.begin("hm", false);
    prefs.putString("wifi_ssid", pSsid);
    prefs.putString("wifi_pass", pPass);
    prefs.putString("tb_user",   pUser);
    prefs.putString("tb_pass",   pPass2);
    prefs.putInt("n_count", 0);
    prefs.end();

    pError = "__ok__:" + pSsid;
    delay(2000);
    ESP.restart();
  }
}

// ── TB admin API helpers (node discovery only) ────────────────────────────────

static bool ensureJwt() {
  if (adminJwt.length()) return true;
  String resp;
  char body[256];
  snprintf(body, sizeof(body),
    "{\"username\":\"%s\",\"password\":\"%s\"}", tbAdminUser, tbAdminPass);
  adminClient.setInsecure();
  HTTPClient http;
  http.begin(adminClient, tbUrl("/api/auth/login"));
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  resp = http.getString();
  http.end();
  if (code != 200) { Serial.printf("[Auth] login failed %d\n", code); return false; }
  adminJwt = jsonStr(resp, "token");
  return adminJwt.length() > 0;
}

static int tbGet(const String& path, String& out) {
  adminClient.setInsecure();
  HTTPClient http;
  http.begin(adminClient, tbUrl(path));
  http.addHeader("X-Authorization", "Bearer " + adminJwt);
  int code = http.GET();
  out = http.getString();
  http.end();
  if (code == 401) adminJwt = "";
  return code;
}

// ── Sync node registry with ThingsBoard ───────────────────────────────────────

static void syncNodes() {
  if (!ensureJwt()) return;

  String resp;
  int code = tbGet("/api/tenant/devices?pageSize=100&page=0", resp);
  if (code != 200) { Serial.printf("[Sync] devices fetch %d\n", code); return; }

  String newNames[MAX_NODES];
  int newCount = 0;
  int pos = 0;
  while (newCount < MAX_NODES) {
    int np = resp.indexOf("\"name\":\"", pos);
    if (np < 0) break;
    np += 8;
    int ne = resp.indexOf("\"", np);
    String name = resp.substring(np, ne);
    String lower = name; lower.toLowerCase();
    if (lower.indexOf("node") >= 0) newNames[newCount++] = name;
    pos = ne + 1;
  }

  xSemaphoreTake(nodeMutex, portMAX_DELAY);
  bool changed = (newCount != nodeCount);
  for (int i = 0; i < newCount && !changed; i++)
    if (nodeNames[i] != newNames[i]) changed = true;
  if (changed) {
    nodeCount = newCount;
    for (int i = 0; i < nodeCount; i++) nodeNames[i] = newNames[i];
  }
  xSemaphoreGive(nodeMutex);

  if (changed) saveNodesToNVS();

  Serial.printf("[Sync] %d node(s):", newCount);
  for (int i = 0; i < newCount; i++) Serial.printf(" %s", newNames[i].c_str());
  Serial.println();
}

// Runs on Core 0 — HTTPS never blocks the ECG publish loop on Core 1.
static void nodeSyncTask(void*) {
  for (;;) {
    syncNodes();
    vTaskDelay(pdMS_TO_TICKS(NODE_SYNC_INTERVAL_MS));
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

// ── MQTT ──────────────────────────────────────────────────────────────────────

static bool mqttConnect() {
  if (mqttClient.connected()) return true;
  char clientId[32];
  snprintf(clientId, sizeof(clientId), "esp32_%08X", (uint32_t)ESP.getEfuseMac());
  bool ok = mqttClient.connect(clientId, TB_GATEWAY_TOKEN, NULL);
  if (ok) Serial.println("[MQTT] Connected");
  else    Serial.printf("[MQTT] Failed rc=%d — retry in 5s\n", mqttClient.state());
  return ok;
}

// ── Demo signal generators ─────────────────────────────────────────────────────
// ECG: Gaussian QRS spike, 75 BPM (period = 200 samples at 250Hz)
// Phase offset = n * 67 samples to stagger nodes

static int16_t ecgAt(uint32_t idx, int phaseOff) {
  float phase = (float)((idx + phaseOff) % 200) / 200.0f;
  float d = (phase - 0.5f) * 20.0f;
  float v = 2000.0f * expf(-(d * d)) + (float)(rand() % 40 - 20);
  return (int16_t)constrain((int)(2048.0f + v), 0, 4095);
}

// ── 250Hz sample timer ─────────────────────────────────────────────────────────

static uint32_t sampleCount = 0;

static void onSampleTimer(void*) {
  ecgWork[workIdx] = ecgAt(sampleCount, 0);
  sampleCount++;
  if (++workIdx < BATCH_SIZE) return;
  workIdx = 0;

  if (batchReady) return;
  readyTs          = epochMs();
  readySampleCount = sampleCount;
  batchReady       = true;
}

// ── Publish ECG waveform for all nodes ────────────────────────────────────────
// Gateway format: {"NodeName":[{"ts":epoch,"values":{"ecg_batch":"[v0,v1,...]"}}]}
// One publish per node; phase offset = node index * 67 samples.

static void publishWaveform() {
  if (nodeCount == 0 || !mqttConnect()) return;

  uint32_t           baseIdx = readySampleCount - BATCH_SIZE;
  unsigned long long ts      = readyTs > 0 ? readyTs : epochMs();

  xSemaphoreTake(nodeMutex, portMAX_DELAY);
  int    snap = nodeCount;
  String snapNames[MAX_NODES];
  for (int i = 0; i < snap; i++) snapNames[i] = nodeNames[i];
  xSemaphoreGive(nodeMutex);

  for (int n = 0; n < snap; n++) {
    int phaseOff = n * 67;
    int pos = 0;

    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "{\"");
    for (unsigned int c = 0; c < snapNames[n].length() && pos < PAYLOAD_BUF_SIZE - 2; c++)
      payload[pos++] = snapNames[n][c];
    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
      "\":[{\"ts\":%llu,\"values\":{\"ecg_batch\":\"[", ts);

    for (int i = 0; i < BATCH_SIZE && pos < PAYLOAD_BUF_SIZE - 20; i++) {
      if (i > 0) payload[pos++] = ',';
      pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
        "%d", ecgAt(baseIdx + i, phaseOff));
    }
    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "]\"}}]}");

    bool ok = mqttClient.publish("v1/gateway/telemetry", (uint8_t*)payload, pos);
    Serial.printf("[%s] wave %s %d bytes\n", snapNames[n].c_str(), ok ? "OK" : "FAIL", pos);
  }
}

// ── Publish vitals for all nodes ───────────────────────────────────────────────
// Gateway format: {"Node1":[{...}],"Node2":[{...}],...}

static void publishVitals() {
  xSemaphoreTake(nodeMutex, portMAX_DELAY);
  int    snap = nodeCount;
  String snapNames[MAX_NODES];
  for (int i = 0; i < snap; i++) snapNames[i] = nodeNames[i];
  xSemaphoreGive(nodeMutex);

  if (snap == 0 || !mqttConnect()) return;

  unsigned long long ts = epochMs();
  int pos = snprintf(payload, PAYLOAD_BUF_SIZE, "{");

  for (int n = 0; n < snap; n++) {
    // Lazy-init on first call, then random walk (mirrors test-direct-stream.js)
    if (nodeHr[n] == 0.0f) initNodeVitals(n);
    nodeHr[n]   = constrain(nodeHr[n]   + frand() * 1.0f,   50.0f, 110.0f);
    nodeSpo2[n] = constrain(nodeSpo2[n] + frand() * 0.15f,  93.0f, 100.0f);
    nodeTemp[n] = constrain(nodeTemp[n] + frand() * 0.05f, 36.0f,  37.8f);
    float ppgHr = nodeHr[n] - 1.0f + frand() * 0.5f;

    if (n > 0) payload[pos++] = ',';
    payload[pos++] = '"';
    for (unsigned int c = 0; c < snapNames[n].length() && pos < PAYLOAD_BUF_SIZE - 2; c++)
      payload[pos++] = snapNames[n][c];

    if (ts > 0) {
      pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
        "\":[{\"ts\":%llu,\"values\":"
        "{\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,\"spo2\":%.1f,\"temperature\":%.1f}}]",
        ts, nodeHr[n], ppgHr, nodeSpo2[n], nodeTemp[n]);
    } else {
      pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
        "\":[{\"values\":"
        "{\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,\"spo2\":%.1f,\"temperature\":%.1f}}]",
        nodeHr[n], ppgHr, nodeSpo2[n], nodeTemp[n]);
    }
    Serial.printf("[%s] vitals ECG-HR:%.1f PPG-HR:%.1f SpO2:%.1f\n",
      snapNames[n].c_str(), nodeHr[n], ppgHr, nodeSpo2[n]);
  }
  payload[pos++] = '}';

  bool ok = mqttClient.publish("v1/gateway/telemetry", (uint8_t*)payload, pos);
  if (!ok) Serial.println("[Vitals] Publish FAILED");
}

// ── setup / loop ──────────────────────────────────────────────────────────────

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);  // suppress brownout on WiFi startup
  Serial.begin(115200);
  esp_log_level_set("ssl_client",       ESP_LOG_NONE);

  if (!loadConfig()) {
    Serial.println("[Setup] No config — starting captive portal");
    startConfigPortal();
  }
  Serial.printf("[Setup] WiFi: %s  TB: %s\n", wifiSsid, tbAdminUser);

  setupWiFi();
  loadNodesFromNVS();

  mqttClient.setServer(TB_HOST, TB_MQTT_PORT);
  mqttClient.setBufferSize(MQTT_BUF_SIZE);

  nodeMutex = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(nodeSyncTask, "nodeSync", 8192, NULL, 1, NULL, 0);

  mqttConnect();

  esp_timer_create_args_t args = {};
  args.callback = onSampleTimer;
  args.name     = "sample";
  esp_timer_handle_t timer;
  esp_timer_create(&args, &timer);
  esp_timer_start_periodic(timer, SAMPLE_INTERVAL_US);

  Serial.printf("Ready — %d node(s) @ %dHz\n", nodeCount, SAMPLE_RATE_HZ);
}

void loop() {
  mqttClient.loop();

  if (batchReady) {
    publishWaveform();
    batchReady = false;
  }

  unsigned long nowMs = millis();

  if (nowMs - lastVitalMs >= VITAL_INTERVAL_MS) {
    lastVitalMs = nowMs;
    publishVitals();
  }

}
