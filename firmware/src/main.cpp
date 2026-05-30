// ── HealthMonitor ESP32 Firmware ─────────────────────────────────────────────
// Event-driven: esp_timer samples ADC at 250Hz into a working buffer.
// When a batch is complete it swaps to a ready buffer and sets batchReady.
// loop() posts the batch directly to ThingsBoard's gateway HTTP API —
// each of the 250 samples gets its own timestamp (4ms apart).
// No FreeRTOS tasks or semaphores — the timer drives everything.
// ─────────────────────────────────────────────────────────────────────────────

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_timer.h>
#include <time.h>

// ── Configuration ─────────────────────────────────────────────────────────────

const char* WIFI_SSID   = "Xuaaan";
const char* WIFI_PASSWORD = "88888888";

const char* TB_HOST       = "c7.hust-2slab.org";
const char* DEVICE_TOKEN  = "YOUR_NODE1_ACCESS_TOKEN";  // Devices → Node1 → Manage credentials
const bool  USE_HTTPS     = true;

const char* NODE_NAME   = "Node1";

#define SAMPLE_RATE_HZ      250
#define SAMPLE_INTERVAL_US  (1000000 / SAMPLE_RATE_HZ)  // 4000 µs
#define SAMPLE_INTERVAL_MS  (1000 / SAMPLE_RATE_HZ)     // 4 ms
#define BATCH_SIZE          250
#define VITAL_INTERVAL_MS   15000

#define ECG_PIN  34
#define PPG_PIN  35

// 250 samples × ~55 chars each + wrapper ≈ 14 KB; 20 KB gives safe headroom
#define PAYLOAD_BUF_SIZE  20480

// ── Buffers ───────────────────────────────────────────────────────────────────
// onSampleTimer fills ecgWork/ppgWork. When BATCH_SIZE samples are collected
// and batchReady is false, it copies to ecgReady/ppgReady and sets batchReady.
// loop() reads ecgReady/ppgReady only while batchReady is true, so the timer
// never touches those buffers during a POST.

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

// ── 250Hz sample timer ────────────────────────────────────────────────────────

static void onSampleTimer(void*) {
  ecgWork[workIdx] = (int16_t)analogRead(ECG_PIN);
  ppgWork[workIdx] = (int16_t)analogRead(PPG_PIN);
  if (++workIdx < BATCH_SIZE) return;
  workIdx = 0;

  if (batchReady) return;  // loop() still posting — drop this batch
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
  Serial.println(" (skipped — server will use receive time)");
}

// ── POST directly to Node1's own telemetry endpoint ──────────────────────────
// Same approach as Next.js ingest.js: use the device's own access token.
// URL: POST /api/v1/{DEVICE_TOKEN}/telemetry

static void postToTB(int len) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(USE_HTTPS ? "https" : "http")
             + "://" + TB_HOST + "/api/v1/" + DEVICE_TOKEN + "/telemetry";
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t*)payload, len);
  if (code > 0) {
    if (code >= 300) Serial.printf("[TB] %d: %s\n", code, http.getString().c_str());
  } else {
    Serial.printf("[TB] error: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}

// ── Publish waveform batch ────────────────────────────────────────────────────
// Sends 250 per-sample entries; sample[i].ts = batchTs - (249-i)*4ms

static void publishWaveform() {
  unsigned long long batchTs = readyTs > 0 ? readyTs : epochMs();
  int pos = 0;

  pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos, "[");

  for (int i = 0; i < BATCH_SIZE; i++) {
    unsigned long long sampleTs =
      batchTs - (unsigned long long)(BATCH_SIZE - 1 - i) * SAMPLE_INTERVAL_MS;
    pos += snprintf(payload + pos, PAYLOAD_BUF_SIZE - pos,
      "%s{\"ts\":%llu,\"values\":{\"ecg\":%d,\"ppg\":%d}}",
      i > 0 ? "," : "", sampleTs, ecgReady[i], ppgReady[i]);
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

  esp_timer_create_args_t args = {};
  args.callback = onSampleTimer;
  args.name     = "sample";
  esp_timer_handle_t timer;
  esp_timer_create(&args, &timer);
  esp_timer_start_periodic(timer, SAMPLE_INTERVAL_US);

  Serial.printf("Ready — [%s] 250Hz → TB gateway\n", NODE_NAME);
}

void loop() {
  // ── Waveform batch ready ────────────────────────────────────────────────────
  if (batchReady) {
    publishWaveform();
    batchReady = false;
  }

  // ── Vitals every 15s ────────────────────────────────────────────────────────
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
