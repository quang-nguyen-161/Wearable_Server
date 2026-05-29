// ── HealthMonitor ESP32 Firmware ─────────────────────────────────────────────
// Dual-protocol streaming (mirrors scripts/test-http-stream.js):
//   ECG/PPG raw waveforms → HTTPS POST /api/telemetry/ingest (100Hz, 50-sample batches)
//   HR / SpO2 / Temperature → MQTT gateway API (every 15s)
// ─────────────────────────────────────────────────────────────────────────────

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

// ── Configuration — fill in before flashing ───────────────────────────────────

const char* WIFI_SSID     = "YOUR_SSID";
const char* WIFI_PASSWORD = "YOUR_PASSWORD";

// HTTPS ingest endpoint — your deployed Next.js app
const char* INGEST_URL    = "https://your-app.vercel.app/api/telemetry/ingest";

// ThingsBoard MQTT gateway
const char* MQTT_HOST      = "mqtt.thingsboard.cloud";
const int   MQTT_PORT      = 1883;
const char* GATEWAY_TOKEN  = "YOUR_GATEWAY_ACCESS_TOKEN";  // wearable gateway device token
const char* GATEWAY_TOPIC  = "v1/gateway/telemetry";

// Node identity — must match the device name in ThingsBoard
const char* NODE_NAME = "Node1";

// Sampling — 100Hz, 50 samples = 500ms of data per batch
#define SAMPLE_RATE_HZ      100
#define SAMPLE_INTERVAL_US  (1000000 / SAMPLE_RATE_HZ)  // 10000 µs = 10ms per sample
#define BATCH_SIZE          50
#define VITAL_INTERVAL_MS   15000

// ADC pins
#define ECG_PIN  34
#define PPG_PIN  35

// ── Global state ──────────────────────────────────────────────────────────────

WiFiClient   mqttWifi;
PubSubClient mqtt(mqttWifi);

// Double-buffered: loop() fills ecgBuf/ppgBuf while httpsTask() sends ecgSend/ppgSend
int16_t ecgBuf[BATCH_SIZE];
int16_t ppgBuf[BATCH_SIZE];
int16_t ecgSend[BATCH_SIZE];
int16_t ppgSend[BATCH_SIZE];
unsigned long batchTsSend = 0;  // epoch ms snapshot at copy time

volatile int  bufIdx       = 0;
unsigned long lastVitalMs  = 0;
unsigned long lastSampleUs = 0;

SemaphoreHandle_t sendSem;  // signals httpsTask that a batch is ready

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns epoch milliseconds if NTP synced, otherwise 0 (server will use Date.now())
unsigned long long epochMs() {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  if (tv.tv_sec < 1000000000L) return 0;  // NTP not yet synced
  return (unsigned long long)tv.tv_sec * 1000ULL + tv.tv_usec / 1000ULL;
}

// ── WiFi + NTP ────────────────────────────────────────────────────────────────

void setupWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi OK — IP: %s\n", WiFi.localIP().toString().c_str());

  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("NTP sync");
  for (int i = 0; i < 20; i++) {
    if (epochMs() > 0) { Serial.println(" OK"); return; }
    delay(500);
    Serial.print(".");
  }
  Serial.println(" (no sync — server will timestamp batches)");
}

// ── MQTT gateway ──────────────────────────────────────────────────────────────

void connectMQTT() {
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  String clientId = "esp32-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  int retries = 0;
  while (!mqtt.connected() && retries < 5) {
    Serial.print("MQTT connecting...");
    if (mqtt.connect(clientId.c_str(), GATEWAY_TOKEN, "")) {
      Serial.println(" connected");
    } else {
      Serial.printf(" failed (rc=%d), retry in 2s\n", mqtt.state());
      delay(2000);
      retries++;
    }
  }
}

// ── HTTPS batch sender (runs on FreeRTOS task — blocking is fine here) ────────

void sendRawBatch() {
  // Ingest API expects ecg_batch / ppg_batch as JSON-stringified arrays
  StaticJsonDocument<400> ecgDoc;
  JsonArray ecgArr = ecgDoc.to<JsonArray>();
  StaticJsonDocument<400> ppgDoc;
  JsonArray ppgArr = ppgDoc.to<JsonArray>();
  for (int i = 0; i < BATCH_SIZE; i++) {
    ecgArr.add(ecgSend[i]);
    ppgArr.add(ppgSend[i]);
  }
  char ecgStr[300], ppgStr[300];
  serializeJson(ecgDoc, ecgStr, sizeof(ecgStr));
  serializeJson(ppgDoc, ppgStr, sizeof(ppgStr));

  StaticJsonDocument<800> body;
  body["deviceName"] = NODE_NAME;
  if (batchTsSend > 0) body["ts"] = batchTsSend;  // omit if NTP not synced
  body["ecg_batch"]  = ecgStr;
  body["ppg_batch"]  = ppgStr;
  char payload[800];
  serializeJson(body, payload, sizeof(payload));

  WiFiClientSecure httpsTls;
  httpsTls.setInsecure();
  HTTPClient http;
  http.begin(httpsTls, INGEST_URL);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(payload);
  if (code > 0) {
    Serial.printf("[%s] HTTPS %d\n", NODE_NAME, code);
  } else {
    Serial.printf("[%s] HTTPS failed: %s\n", NODE_NAME, http.errorToString(code).c_str());
  }
  http.end();
}

void httpsTask(void* pvParams) {
  for (;;) {
    if (xSemaphoreTake(sendSem, portMAX_DELAY) == pdTRUE) {
      sendRawBatch();
    }
  }
}

// ── MQTT vital sender — TB gateway format ─────────────────────────────────────

void sendVitals(float hr, float spo2, float temp) {
  if (!mqtt.connected()) connectMQTT();

  // TB gateway telemetry format: { "NodeName": [{ ts, values: { ... } }] }
  StaticJsonDocument<300> doc;
  JsonArray  nodeArr = doc.createNestedArray(NODE_NAME);
  JsonObject entry   = nodeArr.createNestedObject();
  unsigned long long ts = epochMs();
  if (ts > 0) entry["ts"] = ts;
  JsonObject values  = entry.createNestedObject("values");
  values["heartRate"]   = round(hr   * 10.0) / 10.0;
  values["spo2"]        = round(spo2 * 10.0) / 10.0;
  values["temperature"] = round(temp * 10.0) / 10.0;

  char payload[300];
  serializeJson(doc, payload, sizeof(payload));

  bool ok = mqtt.publish(GATEWAY_TOPIC, payload);
  Serial.printf("[%s] Vitals %s → HR:%.1f SpO2:%.1f Temp:%.1f\n",
                NODE_NAME, ok ? "sent" : "FAILED", hr, spo2, temp);
}

// ── Signal processing — replace with your real algorithms ────────────────────

float computeHR(int16_t* ecgData, int n) {
  // TODO: implement Pan-Tompkins QRS detection or equivalent
  (void)ecgData; (void)n;
  return 72.0;
}

float computeSpO2(int16_t* ppgData, int n) {
  // TODO: implement R-ratio AC/DC calculation from red + IR channels
  (void)ppgData; (void)n;
  return 98.5;
}

float readTemperature() {
  // TODO: read from your temperature sensor (DS18B20, LM35, MAX30205, etc.)
  return 36.6;
}

// ── setup / loop ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  setupWiFi();

  sendSem = xSemaphoreCreateBinary();
  // Stack 8192 bytes — HTTPS + TLS + ArduinoJson need the headroom
  xTaskCreate(httpsTask, "https_send", 8192, NULL, 1, NULL);

  connectMQTT();
  Serial.printf("Ready — [%s] ECG/PPG via HTTPS + vitals via MQTT gateway\n", NODE_NAME);
}

void loop() {
  unsigned long nowUs = micros();

  // ── Precise 100Hz sampling using micros() ───────────────────────────────
  // Never use delay() here — it blocks mqtt.loop()
  if (nowUs - lastSampleUs >= SAMPLE_INTERVAL_US) {
    lastSampleUs = nowUs;
    if (bufIdx < BATCH_SIZE) {
      ecgBuf[bufIdx] = (int16_t)analogRead(ECG_PIN);
      ppgBuf[bufIdx] = (int16_t)analogRead(PPG_PIN);
      bufIdx++;
    }
  }

  // ── Copy full batch to send buffer and signal HTTPS task ────────────────
  if (bufIdx >= BATCH_SIZE) {
    memcpy(ecgSend, ecgBuf, sizeof(ecgBuf));
    memcpy(ppgSend, ppgBuf, sizeof(ppgBuf));
    batchTsSend = epochMs();
    bufIdx = 0;
    xSemaphoreGive(sendSem);
  }

  // ── Send vitals via MQTT gateway every 15 seconds ───────────────────────
  unsigned long nowMs = millis();
  if (nowMs - lastVitalMs >= VITAL_INTERVAL_MS) {
    sendVitals(
      computeHR(ecgBuf, BATCH_SIZE),
      computeSpO2(ppgBuf, BATCH_SIZE),
      readTemperature()
    );
    lastVitalMs = nowMs;
  }

  mqtt.loop();  // MQTT keepalive — never skip
}
