// ── HealthMonitor ESP32 Firmware ─────────────────────────────────────────────
// Event-driven: esp_timer samples ADC at 250Hz into a working buffer.
// When a batch is complete it swaps to a ready buffer and sets batchReady.
// loop() posts the batch directly to ThingsBoard using the device's own token.
//
// First boot: no WiFi credentials in NVS → starts "HealthMonitor-Setup" AP
//   and serves a captive portal form to collect WiFi + TB config.
//   After save the device restarts and connects normally.
//
// Token acquisition (first boot after config) mirrors ingest.js resolveDevice:
//   1. POST /api/auth/login            → admin JWT
//   2. GET  /api/tenant/devices        → find device by name (or create it)
//   3. GET  /api/device/{id}/credentials → access token
//   Token persisted in NVS; subsequent boots skip all three calls.
//
// No FreeRTOS tasks or semaphores — the timer drives everything.
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

// ── Compile-time defaults (overridden by captive portal / NVS) ────────────────

const char* TB_HOST   = "c7.hust-2slab.org";
const bool  USE_HTTPS = true;

#define SAMPLE_RATE_HZ      250
#define SAMPLE_INTERVAL_US  (1000000 / SAMPLE_RATE_HZ)
#define SAMPLE_INTERVAL_MS  (1000 / SAMPLE_RATE_HZ)
#define BATCH_SIZE          250
#define VITAL_INTERVAL_MS   15000
#define PAYLOAD_BUF_SIZE    20480

// ── Runtime config — loaded from NVS, filled by captive portal ───────────────

static char wifiSsid[64]   = "";
static char wifiPass[64]   = "";
static char nodeName[32]   = "";
static char tbAdminUser[64] = "";
static char tbAdminPass[64] = "";

// ── Runtime state ─────────────────────────────────────────────────────────────

static char   deviceToken[64] = "";
static String adminJwt        = "";
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
  String node = prefs.getString("node_name", "");
  String user = prefs.getString("tb_user",   "");
  String tpas = prefs.getString("tb_pass",   "");
  prefs.end();
  if (ssid.length() == 0) return false;
  ssid.toCharArray(wifiSsid,    sizeof(wifiSsid));
  pass.toCharArray(wifiPass,    sizeof(wifiPass));
  node.toCharArray(nodeName,    sizeof(nodeName));
  user.toCharArray(tbAdminUser, sizeof(tbAdminUser));
  tpas.toCharArray(tbAdminPass, sizeof(tbAdminPass));
  return true;
}

static bool loadTokenFromNVS() {
  prefs.begin("hm", true);
  String t = prefs.getString("token", "");
  prefs.end();
  if (t.length() == 0) return false;
  t.toCharArray(deviceToken, sizeof(deviceToken));
  return true;
}

static void saveTokenToNVS(const char* token) {
  prefs.begin("hm", false);
  prefs.putString("token", token);
  prefs.end();
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
  input{display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:16px;outline:none}
  input:focus{border-color:#2196F3}
  hr{border:none;border-top:1px solid #eee;margin:18px 0}
  button{width:100%;padding:13px;background:#2196F3;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
  button:hover{background:#1976D2}
</style></head><body>
<div class="card">
  <h2>HealthMonitor Setup</h2>
  <p>Configure WiFi and ThingsBoard credentials.</p>
  <form method="POST" action="/save">
    <label>WiFi Network (SSID)</label>
    <input name="ssid" placeholder="Your WiFi name" required>
    <label>WiFi Password</label>
    <input name="pass" type="password" placeholder="Leave blank if open network">
    <hr>
    <label>Node Name</label>
    <input name="node" value="Node1" placeholder="Node1">
    <label>ThingsBoard Admin Email</label>
    <input name="tbuser" placeholder="tenant@thingsboard.org" required>
    <label>ThingsBoard Admin Password</label>
    <input name="tbpass" type="password" placeholder="tenant" required>
    <button type="submit">Save &amp; Connect</button>
  </form>
</div>
</body></html>
)html";

static void startConfigPortal() {
  Serial.println("[Portal] Starting AP: HealthMonitor-Setup");
  WiFi.softAP("HealthMonitor-Setup");
  IPAddress apIP = WiFi.softAPIP();
  Serial.printf("[Portal] Open http://%s in your browser\n", apIP.toString().c_str());

  DNSServer dns;
  dns.start(53, "*", apIP);

  WebServer server(80);

  server.on("/", HTTP_GET, [&]() {
    server.send(200, "text/html", PORTAL_HTML);
  });

  server.on("/save", HTTP_POST, [&]() {
    String ssid   = server.arg("ssid");
    String pass   = server.arg("pass");
    String node   = server.arg("node");
    String tbuser = server.arg("tbuser");
    String tbpass = server.arg("tbpass");
    if (node.length() == 0) node = "Node1";

    prefs.begin("hm", false);
    prefs.putString("wifi_ssid", ssid);
    prefs.putString("wifi_pass", pass);
    prefs.putString("node_name", node);
    prefs.putString("tb_user",   tbuser);
    prefs.putString("tb_pass",   tbpass);
    prefs.remove("token");  // clear any stale device token
    prefs.end();

    String html = String(
      "<html><body style='font-family:sans-serif;max-width:420px;margin:40px auto;padding:24px'>"
      "<h2 style='color:#4CAF50'>Saved!</h2>"
      "<p>Connecting to <b>") + ssid + "</b> as node <b>" + node + "</b>.</p>"
      "<p>Device is restarting&hellip;</p></body></html>";
    server.send(200, "text/html", html);
    delay(1500);
    ESP.restart();
  });

  // Redirect any unknown path back to the form (captive portal detection)
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

// ── TB admin API helpers ──────────────────────────────────────────────────────

static int tbGet(const String& path, String& out) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, tbUrl(path));
  http.addHeader("X-Authorization", "Bearer " + adminJwt);
  int code = http.GET();
  out = http.getString();
  http.end();
  return code;
}

static int tbPost(const String& path, const String& body, String& out) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, tbUrl(path));
  http.addHeader("Content-Type", "application/json");
  if (adminJwt.length()) http.addHeader("X-Authorization", "Bearer " + adminJwt);
  int code = http.POST(body);
  out = http.getString();
  http.end();
  return code;
}

// ── resolveDeviceToken ────────────────────────────────────────────────────────

static bool resolveDeviceToken() {
  String resp;

  Serial.println("[Auth] logging in...");
  char loginBody[192];
  snprintf(loginBody, sizeof(loginBody),
    "{\"username\":\"%s\",\"password\":\"%s\"}", tbAdminUser, tbAdminPass);
  int code = tbPost("/api/auth/login", loginBody, resp);
  Serial.printf("[Auth] login %d\n", code);
  if (code != 200) return false;
  adminJwt = jsonStr(resp, "token");
  if (adminJwt.length() == 0) { Serial.println("[Auth] no token in response"); return false; }

  Serial.printf("[Auth] looking up %s...\n", nodeName);
  code = tbGet("/api/tenant/devices?pageSize=100&page=0", resp);
  if (code != 200) return false;

  String deviceId;
  int search = 0;
  while (true) {
    int namePos = resp.indexOf("\"name\":\"" + String(nodeName) + "\"", search);
    if (namePos < 0) break;
    int idPos = resp.lastIndexOf("\"id\":{\"id\":\"", namePos);
    if (idPos >= 0) {
      idPos += 12;
      int idEnd = resp.indexOf("\"", idPos);
      deviceId = resp.substring(idPos, idEnd);
    }
    break;
  }

  if (deviceId.length() == 0) {
    Serial.printf("[Auth] creating device %s...\n", nodeName);
    char createBody[128];
    snprintf(createBody, sizeof(createBody), "{\"name\":\"%s\",\"type\":\"default\"}", nodeName);
    code = tbPost("/api/device", createBody, resp);
    if (code != 200) return false;
    int inner = resp.indexOf("\"id\":{\"id\":\"");
    if (inner >= 0) {
      inner += 12;
      deviceId = resp.substring(inner, resp.indexOf("\"", inner));
    }
  }
  Serial.printf("[Auth] device id: %s\n", deviceId.c_str());

  code = tbGet("/api/device/" + deviceId + "/credentials", resp);
  if (code != 200) return false;

  String token = jsonStr(resp, "credentialsId");
  if (token.length() == 0) { Serial.println("[Auth] credentialsId missing"); return false; }

  token.toCharArray(deviceToken, sizeof(deviceToken));
  saveTokenToNVS(deviceToken);
  Serial.printf("[Auth] token cached: %s\n", deviceToken);
  return true;
}

// ── Demo signal generators ────────────────────────────────────────────────────
// ECG: Gaussian spike  2048 + 2000·exp(-((phase-0.5)·20)²) + noise±20
// PPG: sine wave       2048 + 800·sin(2π·phase)            + noise±10
// Period = 200 samples = 0.8 s at 250 Hz → 75 BPM

#define PHASE_OFFSET  0   // Node2→67, Node3→133

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

// ── WiFi + NTP ────────────────────────────────────────────────────────────────

static void setupWiFi() {
  WiFi.begin(wifiSsid, wifiPass);
  Serial.printf("WiFi connecting to %s", wifiSsid);
  for (int i = 0; i < 40; i++) {       // 20 s timeout
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

// ── POST telemetry ────────────────────────────────────────────────────────────

static void postToTB(int len) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, tbUrl("/api/v1/" + String(deviceToken) + "/telemetry"));
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t*)payload, len);
  http.end();
  if (code == 401) {
    Serial.println("[TB] 401 — stale token, clearing NVS and re-resolving...");
    prefs.begin("hm", false);
    prefs.remove("token");
    prefs.end();
    deviceToken[0] = '\0';
    while (!resolveDeviceToken()) { Serial.println("retrying in 5s..."); delay(5000); }
    return;
  }
  if (code > 0) {
    if (code >= 300) Serial.printf("[TB] %d\n", code);
  } else {
    Serial.printf("[TB] error: %s\n", http.errorToString(code).c_str());
  }
}

// ── Publish waveform batch ────────────────────────────────────────────────────

static void publishWaveform() {
  unsigned long long batchTs = readyTs > 0 ? readyTs : epochMs();
  int pos = 0;
  pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "[");
  for (int i = 0; i < BATCH_SIZE; i++) {
    unsigned long long ts =
      batchTs - (unsigned long long)(BATCH_SIZE - 1 - i) * SAMPLE_INTERVAL_MS;
    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
      "%s{\"ts\":%llu,\"values\":{\"ecg\":%d,\"ppg\":%d}}",
      i > 0 ? "," : "", ts, ecgReady[i], ppgReady[i]);
  }
  pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "]");
  postToTB(pos);
  Serial.printf("[%s] wave %d bytes\n", nodeName, pos);
}

// ── Publish vitals ────────────────────────────────────────────────────────────

static void publishVitals(float ecgHr, float ppgHr, float spo2, float temp) {
  unsigned long long ts = epochMs();
  int pos;
  if (ts > 0) {
    pos = snprintf(payload, PAYLOAD_BUF_SIZE,
      "[{\"ts\":%llu,\"values\":"
      "{\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,\"spo2\":%.1f,\"temperature\":%.1f}}]",
      ts, ecgHr, ppgHr, spo2, temp);
  } else {
    pos = snprintf(payload, PAYLOAD_BUF_SIZE,
      "[{\"values\":"
      "{\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,\"spo2\":%.1f,\"temperature\":%.1f}}]",
      ecgHr, ppgHr, spo2, temp);
  }
  postToTB(pos);
  Serial.printf("[%s] vitals ECG-HR:%.1f PPG-HR:%.1f SpO2:%.1f Temp:%.1f\n",
                nodeName, ecgHr, ppgHr, spo2, temp);
}

// ── Signal processing stubs ───────────────────────────────────────────────────

static float computeEcgHR(int16_t* buf, int n)  { (void)buf; (void)n; return 72.0f; }
static float computePpgHR(int16_t* buf, int n)  { (void)buf; (void)n; return 71.0f; }
static float computeSpO2(int16_t* buf, int n)   { (void)buf; (void)n; return 98.5f; }
static float readTemperature()                   { return 36.6f; }

// ── setup / loop ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);

  // Load config; if no WiFi SSID saved → captive portal (blocks until configured)
  if (!loadConfig()) {
    Serial.println("[Setup] No config found — starting captive portal");
    startConfigPortal();  // never returns; restarts after save
  }
  Serial.printf("[Setup] Node: %s  WiFi: %s\n", nodeName, wifiSsid);

  setupWiFi();

  if (loadTokenFromNVS()) {
    Serial.printf("[%s] token loaded from NVS: %s\n", nodeName, deviceToken);
  } else {
    while (!resolveDeviceToken()) {
      Serial.println("retrying in 5s...");
      delay(5000);
    }
  }

  esp_timer_create_args_t args = {};
  args.callback = onSampleTimer;
  args.name     = "sample";
  esp_timer_handle_t timer;
  esp_timer_create(&args, &timer);
  esp_timer_start_periodic(timer, SAMPLE_INTERVAL_US);

  Serial.printf("Ready — [%s] 250Hz\n", nodeName);
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
