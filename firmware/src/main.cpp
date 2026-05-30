// ── HealthMonitor ESP32 Firmware ─────────────────────────────────────────────
// Event-driven: esp_timer samples ADC at 250Hz into a working buffer.
// When a batch is complete it swaps to a ready buffer and sets batchReady.
// loop() posts the batch directly to ThingsBoard using the device's own token.
//
// Token acquisition (first boot only) mirrors Next.js ingest.js / resolveDevice:
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
#include <Preferences.h>
#include <esp_timer.h>
#include <time.h>
#include <math.h>

// ── Configuration ─────────────────────────────────────────────────────────────

const char* WIFI_SSID     = "Xuaaan";
const char* WIFI_PASSWORD = "88888888";

const char* TB_HOST       = "c7.hust-2slab.org";
const bool  USE_HTTPS     = true;

const char* NODE_NAME     = "Node1";

// TB admin credentials — same as TB_USERNAME / TB_PASSWORD in .env.local
const char* TB_ADMIN_USER = "tenant@thingsboard.org";
const char* TB_ADMIN_PASS = "tenant";

#define SAMPLE_RATE_HZ      250
#define SAMPLE_INTERVAL_US  (1000000 / SAMPLE_RATE_HZ)  // 4000 µs
#define SAMPLE_INTERVAL_MS  (1000 / SAMPLE_RATE_HZ)     // 4 ms
#define BATCH_SIZE          250
#define VITAL_INTERVAL_MS   15000

#define PAYLOAD_BUF_SIZE  20480

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

// Extract the value of a JSON string field: "key":"VALUE" → VALUE
static String jsonStr(const String& json, const String& key) {
  String needle = "\"" + key + "\":\"";
  int s = json.indexOf(needle);
  if (s < 0) return "";
  s += needle.length();
  int e = json.indexOf("\"", s);
  return e > s ? json.substring(s, e) : "";
}

// ── NVS token persistence ─────────────────────────────────────────────────────

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

// ── TB admin API helpers ──────────────────────────────────────────────────────
// Each call creates a fresh WiFiClientSecure — reusing a static instance across
// calls leaves the TLS session in a bad state and causes connection refused.

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

// ── resolveDeviceToken — mirrors ingest.js resolveDevice() ───────────────────

static bool resolveDeviceToken() {
  String resp;

  // 1. Login → admin JWT
  Serial.println("[Auth] logging in...");
  char loginBody[128];
  snprintf(loginBody, sizeof(loginBody),
    "{\"username\":\"%s\",\"password\":\"%s\"}", TB_ADMIN_USER, TB_ADMIN_PASS);
  int code = tbPost("/api/auth/login", loginBody, resp);
  Serial.printf("[Auth] login %d: %s\n", code, resp.c_str());
  if (code != 200) return false;
  adminJwt = jsonStr(resp, "token");
  if (adminJwt.length() == 0) { Serial.println("[Auth] no token in response"); return false; }

  // 2. Find device by name
  Serial.printf("[Auth] looking up %s...\n", NODE_NAME);
  code = tbGet("/api/tenant/devices?pageSize=100&page=0", resp);
  Serial.printf("[Auth] devices %d\n", code);
  if (code != 200) return false;

  // Scan the device list for an exact name match, grab its ID
  String deviceId;
  int search = 0;
  while (true) {
    int namePos = resp.indexOf("\"name\":\"" + String(NODE_NAME) + "\"", search);
    if (namePos < 0) break;
    // The device object starts before this; "id":{"id":"UUID"} appears near the start
    int idPos = resp.lastIndexOf("\"id\":{\"id\":\"", namePos);
    if (idPos >= 0) {
      idPos += 12;
      int idEnd = resp.indexOf("\"", idPos);
      deviceId = resp.substring(idPos, idEnd);
    }
    break;
  }

  // 3. Create the device if not found
  if (deviceId.length() == 0) {
    Serial.printf("[Auth] creating device %s...\n", NODE_NAME);
    char createBody[128];
    snprintf(createBody, sizeof(createBody), "{\"name\":\"%s\",\"type\":\"default\"}", NODE_NAME);
    code = tbPost("/api/device", createBody, resp);
    Serial.printf("[Auth] create %d: %s\n", code, resp.c_str());
    if (code != 200) return false;
    deviceId = jsonStr(resp, "id");   // first "id" field in the response object
    // The device object has "id":{"id":"UUID",...} — parse inner id
    int inner = resp.indexOf("\"id\":{\"id\":\"");
    if (inner >= 0) {
      inner += 12;
      deviceId = resp.substring(inner, resp.indexOf("\"", inner));
    }
  }
  Serial.printf("[Auth] device id: %s\n", deviceId.c_str());

  // 4. Fetch the device's own access token
  code = tbGet("/api/device/" + deviceId + "/credentials", resp);
  Serial.printf("[Auth] credentials %d: %s\n", code, resp.c_str());
  if (code != 200) return false;

  String token = jsonStr(resp, "credentialsId");
  if (token.length() == 0) { Serial.println("[Auth] credentialsId missing"); return false; }

  token.toCharArray(deviceToken, sizeof(deviceToken));
  saveTokenToNVS(deviceToken);
  Serial.printf("[Auth] token cached: %s\n", deviceToken);
  return true;
}

// ── Demo signal generators — mirrors test-http-stream.js ─────────────────────
// ECG: single Gaussian spike,  2048 + 2000·exp(-((phase-0.5)·20)²) + noise±20
// PPG: sine wave,              2048 + 800·sin(2π·phase)            + noise±10
// Period = 200 samples (= 0.8 s at 250 Hz → 75 BPM).
// PHASE_OFFSET staggers nodes: Node1=0, Node2=67, Node3=133 (same as the script).

#define PHASE_OFFSET  0   // change per node: Node2→67, Node3→133

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
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
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
  Serial.printf("[%s] wave %d bytes\n", NODE_NAME, pos);
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
                NODE_NAME, ecgHr, ppgHr, spo2, temp);
}

// ── Signal processing — replace with real algorithms ─────────────────────────

static float computeEcgHR(int16_t* buf, int n)  { (void)buf; (void)n; return 72.0f; }
static float computePpgHR(int16_t* buf, int n)  { (void)buf; (void)n; return 71.0f; }
static float computeSpO2(int16_t* buf, int n)   { (void)buf; (void)n; return 98.5f; }
static float readTemperature()                   { return 36.6f; }

// ── setup / loop ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  setupWiFi();

  if (loadTokenFromNVS()) {
    Serial.printf("[%s] token loaded from NVS: %s\n", NODE_NAME, deviceToken);
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

  Serial.printf("Ready — [%s] 250Hz\n", NODE_NAME);
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
