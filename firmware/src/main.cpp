// ── HealthMonitor ESP32 Firmware ─────────────────────────────────────────────
// Event-driven: esp_timer samples ADC at 250Hz into a working buffer.
// When a batch is complete it swaps to a ready buffer and sets batchReady.
// loop() posts demo data to ALL tracked nodes and syncs the node list every 10s.
//
// First boot — captive portal (AP "HealthMonitor-Setup"):
//   Enter WiFi SSID/pass + ThingsBoard admin email/password.
//   After saving the device restarts, connects, and auto-discovers nodes.
//
// Node discovery (every 10s):
//   Fetches all TB devices whose name contains "node" (case-insensitive).
//   New nodes  → resolve access token → store in NVS.
//   Gone nodes → remove token from NVS.
//
// Telemetry: one HTTPS POST per node per batch (flat array format).
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

#define SAMPLE_RATE_HZ       250
#define SAMPLE_INTERVAL_US   (1000000 / SAMPLE_RATE_HZ)
#define SAMPLE_INTERVAL_MS   (1000 / SAMPLE_RATE_HZ)
#define BATCH_SIZE           250
#define VITAL_INTERVAL_MS    15000
#define NODE_SYNC_INTERVAL_MS 10000
#define PAYLOAD_BUF_SIZE     20480
#define MAX_NODES            16

// ── Runtime config ────────────────────────────────────────────────────────────

static char wifiSsid[64]    = "";
static char wifiPass[64]    = "";
static char tbAdminUser[64] = "";
static char tbAdminPass[64] = "";

// ── Node registry ─────────────────────────────────────────────────────────────

static String nodeNames[MAX_NODES];
static char   nodeToks[MAX_NODES][64];
static int    nodeCount = 0;

// ── Runtime state ─────────────────────────────────────────────────────────────

static String adminJwt = "";
static Preferences prefs;

// ── Buffers ───────────────────────────────────────────────────────────────────

static int16_t ecgWork[BATCH_SIZE], ppgWork[BATCH_SIZE];
static volatile unsigned long long readyTs          = 0;
static volatile uint32_t           readySampleCount = 0;
static volatile bool               batchReady       = false;
static int workIdx = 0;

static unsigned long lastVitalMs    = 0;
static unsigned long lastNodeSyncMs = 0;
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
// Node tokens stored as: n_count (int), n_0/n_1/… (names), t_0/t_1/… (tokens)

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
    char nk[8], tk[8];
    snprintf(nk, sizeof(nk), "n_%d", i);
    snprintf(tk, sizeof(tk), "t_%d", i);
    String name = prefs.getString(nk, "");
    String tok  = prefs.getString(tk, "");
    if (name.length() && tok.length()) {
      nodeNames[nodeCount] = name;
      tok.toCharArray(nodeToks[nodeCount], 64);
      nodeCount++;
    }
  }
  prefs.end();
  Serial.printf("[Nodes] %d node(s) loaded from NVS\n", nodeCount);
}

static void saveNodesToNVS() {
  prefs.begin("hm", false);
  prefs.putInt("n_count", nodeCount);
  for (int i = 0; i < nodeCount; i++) {
    char nk[8], tk[8];
    snprintf(nk, sizeof(nk), "n_%d", i);
    snprintf(tk, sizeof(tk), "t_%d", i);
    prefs.putString(nk, nodeNames[i]);
    prefs.putString(tk, nodeToks[i]);
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

    // Try connecting to WiFi
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

    // Save config and restart
    prefs.begin("hm", false);
    prefs.putString("wifi_ssid", pSsid);
    prefs.putString("wifi_pass", pPass);
    prefs.putString("tb_user",   pUser);
    prefs.putString("tb_pass",   pPass2);
    prefs.putInt("n_count", 0);  // clear stale node list
    prefs.end();

    // Serve success page then restart
    // (can't serve after loop ends — we need to call handleClient once more)
    pError = "__ok__:" + pSsid;  // sentinel to trigger success page on GET /
    // The meta-refresh from the POST already points back to / — it will show ok
    delay(2000);
    ESP.restart();
  }
}

// ── TB admin API helpers ──────────────────────────────────────────────────────

static bool ensureJwt() {
  if (adminJwt.length()) return true;
  String resp;
  char body[256];
  snprintf(body, sizeof(body),
    "{\"username\":\"%s\",\"password\":\"%s\"}", tbAdminUser, tbAdminPass);
  WiFiClientSecure cl; cl.setInsecure();
  HTTPClient http;
  http.begin(cl, tbUrl("/api/auth/login"));
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  resp = http.getString();
  http.end();
  if (code != 200) { Serial.printf("[Auth] login failed %d\n", code); return false; }
  adminJwt = jsonStr(resp, "token");
  return adminJwt.length() > 0;
}

static int tbGet(const String& path, String& out) {
  WiFiClientSecure cl; cl.setInsecure();
  HTTPClient http;
  http.begin(cl, tbUrl(path));
  http.addHeader("X-Authorization", "Bearer " + adminJwt);
  int code = http.GET();
  out = http.getString();
  http.end();
  if (code == 401) adminJwt = "";  // JWT expired — will re-login on next ensureJwt()
  return code;
}

static int tbPost(const String& path, const String& body, String& out) {
  WiFiClientSecure cl; cl.setInsecure();
  HTTPClient http;
  http.begin(cl, tbUrl(path));
  http.addHeader("Content-Type", "application/json");
  if (adminJwt.length()) http.addHeader("X-Authorization", "Bearer " + adminJwt);
  int code = http.POST(body);
  out = http.getString();
  http.end();
  return code;
}

// ── Resolve one node's device token via admin API ─────────────────────────────

static bool resolveNodeToken(const String& name, char* outTok) {
  String deviceId;
  String resp;

  // Look up device by name directly (avoids JSON field-order sensitivity)
  String encoded = name;
  encoded.replace(" ", "%20");
  int code = tbGet("/api/tenant/device?deviceName=" + encoded, resp);
  if (code == 200) {
    int inner = resp.indexOf("\"id\":{\"id\":\"");
    if (inner >= 0) {
      inner += 12;
      deviceId = resp.substring(inner, resp.indexOf("\"", inner));
    }
  }

  // Create device if it doesn't exist yet
  if (deviceId.length() == 0) {
    Serial.printf("[Auth] creating %s...\n", name.c_str());
    char body[128];
    snprintf(body, sizeof(body), "{\"name\":\"%s\",\"type\":\"default\"}", name.c_str());
    String createResp;
    code = tbPost("/api/device", body, createResp);
    if (code != 200) { Serial.printf("[Auth] create failed %d\n", code); return false; }
    int inner = createResp.indexOf("\"id\":{\"id\":\"");
    if (inner < 0) return false;
    inner += 12;
    deviceId = createResp.substring(inner, createResp.indexOf("\"", inner));
  }

  if (deviceId.length() == 0) return false;

  // Fetch credentials
  String credResp;
  code = tbGet("/api/device/" + deviceId + "/credentials", credResp);
  if (code != 200) return false;

  String tok = jsonStr(credResp, "credentialsId");
  if (tok.length() == 0) return false;
  tok.toCharArray(outTok, 64);
  Serial.printf("[Auth] resolved %s → %s\n", name.c_str(), outTok);
  return true;
}

// ── Sync node registry with ThingsBoard ───────────────────────────────────────

static void syncNodes() {
  if (!ensureJwt()) return;

  String resp;
  int code = tbGet("/api/tenant/devices?pageSize=100&page=0", resp);
  if (code != 200) { Serial.printf("[Sync] devices fetch %d\n", code); return; }

  // Collect TB device names that contain "node"
  String tbNames[MAX_NODES];
  int tbCount = 0;
  int pos = 0;
  while (tbCount < MAX_NODES) {
    int np = resp.indexOf("\"name\":\"", pos);
    if (np < 0) break;
    np += 8;
    int ne = resp.indexOf("\"", np);
    String name = resp.substring(np, ne);
    String lower = name; lower.toLowerCase();
    if (lower.indexOf("node") >= 0) tbNames[tbCount++] = name;
    pos = ne + 1;
  }

  // Remove nodes no longer in TB
  for (int i = nodeCount - 1; i >= 0; i--) {
    bool found = false;
    for (int j = 0; j < tbCount; j++) {
      if (nodeNames[i] == tbNames[j]) { found = true; break; }
    }
    if (!found) {
      Serial.printf("[Sync] removed: %s\n", nodeNames[i].c_str());
      for (int k = i; k < nodeCount - 1; k++) {
        nodeNames[k] = nodeNames[k + 1];
        memcpy(nodeToks[k], nodeToks[k + 1], 64);
      }
      nodeCount--;
    }
  }

  // Add new nodes
  bool changed = false;
  for (int i = 0; i < tbCount; i++) {
    bool known = false;
    for (int j = 0; j < nodeCount; j++) {
      if (nodeNames[j] == tbNames[i]) { known = true; break; }
    }
    if (!known && nodeCount < MAX_NODES) {
      char tok[64] = "";
      if (resolveNodeToken(tbNames[i], tok)) {
        nodeNames[nodeCount] = tbNames[i];
        memcpy(nodeToks[nodeCount], tok, 64);
        nodeCount++;
        changed = true;
        Serial.printf("[Sync] added: %s\n", tbNames[i].c_str());
      }
    }
  }

  if (changed || tbCount != nodeCount) saveNodesToNVS();
  Serial.printf("[Sync] %d node(s) active\n", nodeCount);
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

// ── POST telemetry to a specific node token ───────────────────────────────────

static void postToNode(int nodeIdx, int len) {
  WiFiClientSecure cl; cl.setInsecure();
  HTTPClient http;
  http.begin(cl, tbUrl("/api/v1/" + String(nodeToks[nodeIdx]) + "/telemetry"));
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t*)payload, len);
  http.end();
  if (code == 401) {
    Serial.printf("[TB] 401 for %s — will re-resolve on next sync\n", nodeNames[nodeIdx].c_str());
    // Clear token so syncNodes() re-resolves it
    nodeToks[nodeIdx][0] = '\0';
    saveNodesToNVS();
  } else if (code > 0 && code >= 300) {
    Serial.printf("[TB] %s → %d\n", nodeNames[nodeIdx].c_str(), code);
  } else if (code < 0) {
    Serial.printf("[TB] %s error: %s\n", nodeNames[nodeIdx].c_str(), HTTPClient::errorToString(code).c_str());
  }
}

// ── Demo signal generators (phase-offset per node) ───────────────────────────
// ECG: Gaussian spike  2048 + 2000·exp(-((phase-0.5)·20)²) + noise±20
// PPG: sine wave       2048 + 800·sin(2π·phase)            + noise±10
// Period = 200 samples = 0.8 s at 250 Hz → 75 BPM
// Phase stagger between nodes: 67 samples (same as test-http-stream.js)

static int16_t ecgAt(uint32_t idx, int phaseOff) {
  float phase = (float)((idx + phaseOff) % 200) / 200.0f;
  float d = (phase - 0.5f) * 20.0f;
  float v = 2000.0f * expf(-(d * d)) + (float)(rand() % 40 - 20);
  return (int16_t)constrain((int)(2048.0f + v), 0, 4095);
}

static int16_t ppgAt(uint32_t idx, int phaseOff) {
  float phase = (float)((idx + phaseOff) % 200) / 200.0f;
  float v = 800.0f * sinf(2.0f * (float)M_PI * phase) + (float)(rand() % 20 - 10);
  return (int16_t)constrain((int)(2048.0f + v), 0, 4095);
}

// ── 250Hz sample timer ────────────────────────────────────────────────────────

static uint32_t sampleCount = 0;

static void onSampleTimer(void*) {
  // Only need to store one channel for the timer tick; per-node signals
  // are computed on-the-fly in publishWaveform using readySampleCount.
  ecgWork[workIdx] = ecgAt(sampleCount, 0);
  ppgWork[workIdx] = ecgAt(sampleCount, 0);  // unused; kept for symmetry
  sampleCount++;
  if (++workIdx < BATCH_SIZE) return;
  workIdx = 0;

  if (batchReady) return;
  readyTs          = epochMs();
  readySampleCount = sampleCount;
  batchReady       = true;
}

// ── Publish waveform for all nodes ───────────────────────────────────────────

static void publishWaveform() {
  unsigned long long batchTs = readyTs > 0 ? readyTs : epochMs();
  uint32_t           baseIdx = readySampleCount - BATCH_SIZE;

  for (int n = 0; n < nodeCount; n++) {
    if (nodeToks[n][0] == '\0') continue;  // token invalid — skip until re-resolved

    int phaseOff = n * 67;
    int pos = 0;
    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "[");
    for (int i = 0; i < BATCH_SIZE; i++) {
      unsigned long long ts =
        batchTs - (unsigned long long)(BATCH_SIZE - 1 - i) * SAMPLE_INTERVAL_MS;
      pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
        "%s{\"ts\":%llu,\"values\":{\"ecg\":%d,\"ppg\":%d}}",
        i > 0 ? "," : "", ts,
        ecgAt(baseIdx + i, phaseOff),
        ppgAt(baseIdx + i, phaseOff));
    }
    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "]");
    postToNode(n, pos);
    Serial.printf("[%s] wave %d bytes\n", nodeNames[n].c_str(), pos);
  }
}

// ── Publish vitals for all nodes ──────────────────────────────────────────────

static void publishVitals() {
  unsigned long long ts = epochMs();
  for (int n = 0; n < nodeCount; n++) {
    if (nodeToks[n][0] == '\0') continue;
    // Slight per-node variation in vitals
    float ecgHr = 72.0f + n * 3.0f;
    float ppgHr = 71.0f + n * 3.0f;
    float spo2  = 98.5f - n * 0.3f;
    float temp  = 36.6f + n * 0.1f;
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
    postToNode(n, pos);
    Serial.printf("[%s] vitals ECG-HR:%.1f SpO2:%.1f\n", nodeNames[n].c_str(), ecgHr, spo2);
  }
}

// ── setup / loop ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);

  if (!loadConfig()) {
    Serial.println("[Setup] No config — starting captive portal");
    startConfigPortal();  // never returns; restarts after save
  }
  Serial.printf("[Setup] WiFi: %s  TB: %s\n", wifiSsid, tbAdminUser);

  setupWiFi();
  loadNodesFromNVS();

  // Initial node sync (blocking — ensures we have tokens before starting timer)
  Serial.println("[Setup] Initial node sync...");
  syncNodes();
  lastNodeSyncMs = millis();

  esp_timer_create_args_t args = {};
  args.callback = onSampleTimer;
  args.name     = "sample";
  esp_timer_handle_t timer;
  esp_timer_create(&args, &timer);
  esp_timer_start_periodic(timer, SAMPLE_INTERVAL_US);

  Serial.printf("Ready — %d node(s) @ 250Hz\n", nodeCount);
}

void loop() {
  if (batchReady) {
    publishWaveform();
    batchReady = false;
  }

  unsigned long nowMs = millis();

  if (nowMs - lastVitalMs >= VITAL_INTERVAL_MS) {
    lastVitalMs = nowMs;
    publishVitals();
  }

  if (nowMs - lastNodeSyncMs >= NODE_SYNC_INTERVAL_MS) {
    lastNodeSyncMs = nowMs;
    syncNodes();
  }
}
