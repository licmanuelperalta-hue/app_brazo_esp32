#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>

const char* ssid = "visionai";
const char* password = "12345678";

WebServer server(80);
WebSocketsServer webSocket = WebSocketsServer(81);

#define EMG_PIN 34
#define SERVO_COUNT 5

int servoPins[SERVO_COUNT] = {13, 12, 14, 27, 26};
Servo servos[SERVO_COUNT];

int servoAngles[SERVO_COUNT] = {0, 0, 0, 0, 0};
int targetAngles[SERVO_COUNT] = {0, 0, 0, 0, 0};

struct EMGConfig {
  bool enabled = false;
  int targetServo = 0;
  int lowThreshold = 650;
  int highThreshold = 2200;
  int openAngle = 90;
  int closeAngle = 0;
} emgConfig;

struct SystemState {
  String mode = "manual";
  bool safetyStopped = false;
  unsigned long lastCommandTime = 0;
} systemState;

unsigned long lastTelemetryTime = 0;
const int TELEMETRY_INTERVAL = 50;
int emgRaw = 0;
int emgLevel = 0;

void sendTelemetry(uint8_t num);

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client %u disconnected\n", num);
      break;
    case WStype_CONNECTED: {
      IPAddress ip = webSocket.remoteIP(num);
      Serial.printf("[WS] Client %u connected from %s\n", num, ip.toString().c_str());
      sendTelemetry(num);
      break;
    }
    case WStype_TEXT: {
      handleWebSocketCommand(num, (char*)payload);
      break;
    }
  }
}

void handleWebSocketCommand(uint8_t num, const char* payload) {
  StaticJsonDocument<1024> doc;
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("[WS] JSON parse error: %s\n", error.c_str());
    return;
  }

  if (doc["type"] == "control") {
    systemState.mode = doc["mode"] | "manual";
    systemState.safetyStopped = doc["safety"]["stopped"] | false;
    systemState.lastCommandTime = millis();

    if (!systemState.safetyStopped) {
      JsonArray servosArray = doc["servos"];
      for (JsonObject servoObj : servosArray) {
        int id = servoObj["id"].as<int>() - 1;
        if (id >= 0 && id < SERVO_COUNT) {
          int angle = servoObj["angle"].as<int>();
          targetAngles[id] = constrain(angle, 0, 180);
        }
      }
    } else {
      for (int i = 0; i < SERVO_COUNT; i++) {
        targetAngles[i] = servoAngles[i];
      }
    }

    JsonObject emgObj = doc["emg"];
    emgConfig.enabled = emgObj["enabled"] | false;
    emgConfig.targetServo = constrain((emgObj["targetServo"] | 1) - 1, 0, SERVO_COUNT - 1);
    emgConfig.lowThreshold = constrain(emgObj["thresholdLow"] | 650, 0, 4095);
    emgConfig.highThreshold = constrain(emgObj["thresholdHigh"] | 2200, 0, 4095);
    emgConfig.openAngle = constrain(emgObj["openAngle"] | 90, 0, 180);
    emgConfig.closeAngle = constrain(emgObj["closeAngle"] | 0, 0, 180);

    Serial.printf("[WS] Mode: %s, Safety: %s, EMG: %s, Target: %d\n",
      systemState.mode.c_str(),
      systemState.safetyStopped ? "STOPPED" : "ACTIVE",
      emgConfig.enabled ? "ON" : "OFF",
      emgConfig.targetServo);
  }
}

void sendTelemetry(uint8_t num = 255) {
  StaticJsonDocument<512> doc;
  doc["emgRaw"] = emgRaw;
  doc["emgLevel"] = emgLevel;
  
  JsonArray servosArray = doc.createNestedArray("servos");
  for (int i = 0; i < SERVO_COUNT; i++) {
    servosArray.add(servoAngles[i]);
  }

  String output;
  serializeJson(doc, output);
  
  if (num == 255) {
    webSocket.broadcastTXT(output);
  } else {
    webSocket.sendTXT(num, output);
  }
}

void setupWiFi() {
  WiFi.softAP(ssid, password);
  IPAddress IP = WiFi.softAPIP();
  Serial.print("[WiFi] AP IP address: ");
  Serial.println(IP);
}

void setupServos() {
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  
  for (int i = 0; i < SERVO_COUNT; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(servoPins[i], 500, 2500);
    servos[i].write(servoAngles[i]);
    delay(50);
  }
  Serial.println("[Servos] 5 servos inicializados");
}

void updateServos() {
  for (int i = 0; i < SERVO_COUNT; i++) {
    if (servoAngles[i] != targetAngles[i]) {
      int diff = targetAngles[i] - servoAngles[i];
      int step = (diff > 0) ? 2 : -2;
      if (abs(diff) < 2) step = diff;
      servoAngles[i] += step;
      servos[i].write(servoAngles[i]);
    }
  }
}

void processEMG() {
  if (!emgConfig.enabled) return;
  if (systemState.mode != "emg") return;
  if (systemState.safetyStopped) return;

  int target = emgConfig.targetServo;
  int angle;
  
  if (emgRaw <= emgConfig.lowThreshold) {
    angle = emgConfig.openAngle;
  } else if (emgRaw >= emgConfig.highThreshold) {
    angle = emgConfig.closeAngle;
  } else {
    float ratio = float(emgRaw - emgConfig.lowThreshold) / 
                  float(emgConfig.highThreshold - emgConfig.lowThreshold);
    angle = emgConfig.openAngle + ratio * (emgConfig.closeAngle - emgConfig.openAngle);
  }
  
  targetAngles[target] = constrain(angle, 0, 180);
}

void readEMG() {
  emgRaw = analogRead(EMG_PIN);
  emgLevel = map(constrain(emgRaw, 0, 4095), 0, 4095, 0, 100);
}

void setup() {
  Serial.begin(115200);
  delay(100);
  
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  
  setupWiFi();
  setupServos();
  
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  
  server.on("/", HTTP_GET, []() {
    server.send(200, "text/plain", "VisionAI Hand Prosthesis - WebSocket at ws://192.168.4.1:81");
  });
  server.begin();
  
  Serial.println("[System] Listo - Conecta a 'visionai' (12345678)");
  Serial.println("[System] WebSocket: ws://192.168.4.1:81");
}

void loop() {
  webSocket.loop();
  server.handleClient();
  
  readEMG();
  processEMG();
  updateServos();
  
  unsigned long now = millis();
  if (now - lastTelemetryTime >= TELEMETRY_INTERVAL) {
    sendTelemetry();
    lastTelemetryTime = now;
  }
  
  if (systemState.safetyStopped && (now - systemState.lastCommandTime > 5000)) {
    // Safety timeout - keep stopped
  }
  
  delay(5);
}