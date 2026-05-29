#ifndef MLEAK_H
#define MLEAK_H

#include <stddef.h>
#include <stdint.h>

#if defined(ARDUINO)
  #include <Arduino.h>
  #define MLEAK_PLATFORM_ARDUINO 1
#elif defined(ESP_PLATFORM)
  #define MLEAK_PLATFORM_ESP32 1
  #include <stdio.h>
  #include "esp_timer.h"
#elif defined(STM32F0xx) || defined(STM32F1xx) || defined(STM32F2xx) || \
      defined(STM32F3xx) || defined(STM32F4xx) || defined(STM32F7xx) || \
      defined(STM32G0xx) || defined(STM32G4xx) || defined(STM32H7xx) || \
      defined(STM32L0xx) || defined(STM32L1xx) || defined(STM32L4xx) || \
      defined(STM32L5xx) || defined(STM32U5xx) || defined(STM32WBxx) || \
      defined(STM32WLxx)
  #define MLEAK_PLATFORM_STM32_HAL 1
  #if defined(STM32F0xx)
    #include "stm32f0xx_hal.h"
  #elif defined(STM32F1xx)
    #include "stm32f1xx_hal.h"
  #elif defined(STM32F2xx)
    #include "stm32f2xx_hal.h"
  #elif defined(STM32F3xx)
    #include "stm32f3xx_hal.h"
  #elif defined(STM32F4xx)
    #include "stm32f4xx_hal.h"
  #elif defined(STM32F7xx)
    #include "stm32f7xx_hal.h"
  #elif defined(STM32G0xx)
    #include "stm32g0xx_hal.h"
  #elif defined(STM32G4xx)
    #include "stm32g4xx_hal.h"
  #elif defined(STM32H7xx)
    #include "stm32h7xx_hal.h"
  #elif defined(STM32L0xx)
    #include "stm32l0xx_hal.h"
  #elif defined(STM32L1xx)
    #include "stm32l1xx_hal.h"
  #elif defined(STM32L4xx)
    #include "stm32l4xx_hal.h"
  #elif defined(STM32L5xx)
    #include "stm32l5xx_hal.h"
  #elif defined(STM32U5xx)
    #include "stm32u5xx_hal.h"
  #elif defined(STM32WBxx)
    #include "stm32wbxx_hal.h"
  #elif defined(STM32WLxx)
    #include "stm32wlxx_hal.h"
  #endif
  #include <stdio.h>
  #include <string.h>
  extern UART_HandleTypeDef* mleak_uart;
#else
  #define MLEAK_PLATFORM_NONE 1
  #include <stdio.h>
#endif

#if !defined(__cplusplus)
  #include <stdbool.h>
#endif

#define MLEAK_MAX_RECORDS 10

#if defined(MLEAK_PLATFORM_STM32_HAL) || defined(MLEAK_PLATFORM_ESP32) || defined(MLEAK_PLATFORM_NONE)
void mleakPrint(const char* value);
void mleakPrint(int value);
void mleakPrint(unsigned int value);
void mleakPrint(unsigned long value);
void mleakPrintFloat(float value, int digits);
void mleakPrintHex(uintptr_t value);
unsigned long mleakMicros();
#endif

#if defined(MLEAK_PLATFORM_ARDUINO)
  #define MLEAK_PRINT(x) Serial.print(x)
  #define MLEAK_PRINTLN(x) Serial.println(x)
  #define MLEAK_PRINT_HEX(x) Serial.println((unsigned int)(x), HEX)
  #define MLEAK_PRINT_FLOAT(x, digits) Serial.print((x), (digits))
  #define MLEAK_MICROS() micros()
#elif defined(MLEAK_PLATFORM_STM32_HAL) || defined(MLEAK_PLATFORM_ESP32)
  #define MLEAK_PRINT(x) mleakPrint(x)
  #define MLEAK_PRINTLN(x) do { mleakPrint(x); mleakPrint("\r\n"); } while(0)
  #define MLEAK_PRINT_HEX(x) do { mleakPrintHex((uintptr_t)(x)); mleakPrint("\r\n"); } while(0)
  #define MLEAK_PRINT_FLOAT(x, digits) mleakPrintFloat((x), (digits))
  #define MLEAK_MICROS() mleakMicros()
#else
  #define MLEAK_PRINT(x) mleakPrint(x)
  #define MLEAK_PRINTLN(x) do { mleakPrint(x); mleakPrint("\n"); } while(0)
  #define MLEAK_PRINT_HEX(x) do { mleakPrintHex((uintptr_t)(x)); mleakPrint("\n"); } while(0)
  #define MLEAK_PRINT_FLOAT(x, digits) mleakPrintFloat((x), (digits))
  #define MLEAK_MICROS() mleakMicros()
#endif

typedef struct MemoryRecord {
  void* address;
  void* freedAddress;
  int size;
  bool freed;
  uintptr_t callerAddress;
  int callCount;
  int reallocCount;
  bool grewByRealloc;
} MemoryRecord;

#ifdef __cplusplus
extern "C" {
#endif

void* __wrap_malloc(size_t size);

void* __wrap_realloc(void* ptr, size_t newSize);

void __wrap_free(void* ptr);

#define myMalloc(s)  __wrap_malloc(s)
#define myFree(p)    __wrap_free(p)

void checkLeaks();

void printOverhead();

void printFragmentationReport();

void runBenchmarks();

void printAllocationHotspots();

#ifdef __cplusplus
}
#endif

#endif
