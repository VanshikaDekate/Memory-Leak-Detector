void setup() {
    Serial.begin(115200);
}

void loop() {
    emitLeakEvent(64, "HIGH", 0x1234);
    emitFragmentationEvent(72, "MEDIUM");
    emitBenchmarkEvent(128, 46);
    emitHotspotEvent("malloc", 12);
    emitOverheadEvent(8, 96);

    delay(1000);
}

void emitLeakEvent(uint16_t size, const char severity[], uint16_t caller) {
    Serial.print(F("{\"event\":\"LEAK\",\"size\":"));
    Serial.print(size);
    Serial.print(F(",\"severity\":\""));
    printJsonText(severity);
    Serial.print(F("\",\"caller\":\"0x"));
    Serial.print(caller, HEX);
    Serial.println(F("\"}"));
}

void emitFragmentationEvent(uint8_t percent, const char severity[]) {
    Serial.print(F("{\"event\":\"FRAGMENTATION\",\"percent\":"));
    Serial.print(percent);
    Serial.print(F(",\"severity\":\""));
    printJsonText(severity);
    Serial.println(F("\"}"));
}

void emitBenchmarkEvent(uint16_t bytes, uint16_t microsTaken) {
    Serial.print(F("{\"event\":\"BENCHMARK\",\"bytes\":"));
    Serial.print(bytes);
    Serial.print(F(",\"micros\":"));
    Serial.print(microsTaken);
    Serial.println(F("}"));
}

void emitHotspotEvent(const char caller[], uint16_t hits) {
    Serial.print(F("{\"event\":\"HOTSPOT\",\"caller\":\""));
    printJsonText(caller);
    Serial.print(F("\",\"hits\":"));
    Serial.print(hits);
    Serial.println(F("}"));
}

void emitOverheadEvent(uint16_t bytes, uint16_t totalBytes) {
    Serial.print(F("{\"event\":\"OVERHEAD\",\"bytes\":"));
    Serial.print(bytes);
    Serial.print(F(",\"total\":"));
    Serial.print(totalBytes);
    Serial.println(F("}"));
}

void printJsonText(const char text[]) {
    while(*text) {
        if(*text == '"' || *text == '\\') {
            Serial.print('\\');
        }

        Serial.print(*text);
        text++;
    }
}
