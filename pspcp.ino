#include "mleak.h"

void setup() {

  Serial.begin(115200);

  unsigned long t1, t2, t3, t4;

  t1 = micros();
  void* p1 = malloc(100);
  t2 = micros();

  t3 = micros();
  void* p2 = malloc(100);
  t4 = micros();

  Serial.print("Raw malloc: ");
  Serial.print(t2 - t1);
  Serial.println(" us");
  Serial.print("myMalloc:  ");
  Serial.print(t4 - t3);
  Serial.println(" us");
  Serial.print("Overhead:  ");
  Serial.print((t4 - t3) - (t2 - t1));
  Serial.println(" us");

  free(p1);
  free(p2);

  int* data1;
  int* data2;
  int* data3;

  data1 = (int*) malloc(100);

  data2 = (int*) malloc(50);

  data3 = (int*) malloc(25);

  free(data2);

  checkLeaks();
}

void loop() {

  delay(5000);

  checkLeaks();
}
