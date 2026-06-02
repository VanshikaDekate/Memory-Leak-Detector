#include "mleak.h"
#include <stdint.h>

#if defined(MLEAK_PLATFORM_STM32_HAL) || defined(MLEAK_PLATFORM_ESP32) || defined(MLEAK_PLATFORM_NONE)
static void mleakWrite(const char* text) {

#if defined(MLEAK_PLATFORM_STM32_HAL)
  if(mleak_uart != NULL) {

    HAL_UART_Transmit(mleak_uart, (uint8_t*)text, strlen(text), HAL_MAX_DELAY);
  }
#elif defined(MLEAK_PLATFORM_ESP32)
  fputs(text, stdout);
#else
  fputs(text, stdout);
#endif
}

void mleakPrint(const char* value) {

  mleakWrite(value);
}

void mleakPrint(int value) {

  char buffer[16];
  snprintf(buffer, sizeof(buffer), "%d", value);
  mleakWrite(buffer);
}

void mleakPrint(unsigned int value) {

  char buffer[16];
  snprintf(buffer, sizeof(buffer), "%u", value);
  mleakWrite(buffer);
}

void mleakPrint(unsigned long value) {

  char buffer[24];
  snprintf(buffer, sizeof(buffer), "%lu", value);
  mleakWrite(buffer);
}

void mleakPrintFloat(float value, int digits) {

  char format[8];
  char buffer[24];
  snprintf(format, sizeof(format), "%%.%df", digits);
  snprintf(buffer, sizeof(buffer), format, value);
  mleakWrite(buffer);
}

void mleakPrintHex(uintptr_t value) {

  char buffer[24];
  snprintf(buffer, sizeof(buffer), "%lx", (unsigned long)value);
  mleakWrite(buffer);
}

unsigned long mleakMicros() {

#if defined(MLEAK_PLATFORM_STM32_HAL)
  return HAL_GetTick() * 1000UL;
#elif defined(MLEAK_PLATFORM_ESP32)
  return (unsigned long)esp_timer_get_time();
#else
  return 0;
#endif
}
#endif

#if defined(MLEAK_PLATFORM_STM32_HAL)
UART_HandleTypeDef* mleak_uart __attribute__((weak)) = NULL;
#endif

#ifdef __cplusplus
extern "C" {
#endif

extern void* __real_malloc(size_t size);
extern void* __real_realloc(void* ptr, size_t newSize);
extern void  __real_free(void* ptr);

#ifdef __cplusplus
}
#endif

MemoryRecord records[MLEAK_MAX_RECORDS];

struct HotspotRecord {
  uintptr_t callerAddress;
  int allocations;
  unsigned long bytesAllocated;
};

HotspotRecord hotspots[MLEAK_MAX_RECORDS];
int recordIndex = 0;
int hotspotCount = 0;
int reallocCalls = 0;
int reallocFailures = 0;
int reallocMoves = 0;
unsigned long totalAllocatedBytes = 0;
unsigned long totalFreedBytes = 0;
int activeAllocations = 0;
int largestAllocation = 0;

static int findAvailableRecordSlot() {

  for(int i = 0; i < recordIndex; i++) {

    if(records[i].address == NULL && records[i].freed) {

      return i;
    }
  }

  if(recordIndex < MLEAK_MAX_RECORDS) {

    return recordIndex;
  }

  return -1;
}

static void commitRecordSlot(int slot) {

  if(slot == recordIndex && recordIndex < MLEAK_MAX_RECORDS) {

    recordIndex++;
  }
}

static void recordAllocationHotspot(uintptr_t callerAddress, size_t size) {

  for(int i = 0; i < hotspotCount; i++) {

    if(hotspots[i].callerAddress == callerAddress) {

      hotspots[i].allocations++;
      hotspots[i].bytesAllocated += (unsigned long)size;

      return;
    }
  }

  if(hotspotCount < MLEAK_MAX_RECORDS) {

    hotspots[hotspotCount].callerAddress = callerAddress;
    hotspots[hotspotCount].allocations = 1;
    hotspots[hotspotCount].bytesAllocated = (unsigned long)size;
    hotspotCount++;
  }
}

void* __wrap_malloc(size_t size) {

  void* caller = __builtin_return_address(0);
  uintptr_t callerAddress = (uintptr_t)caller;
  int recordSlot = findAvailableRecordSlot();

  if(recordSlot < 0) {

    MLEAK_PRINTLN("mleak: table full, not tracking");

    return __real_malloc(size);
  }

  void* ptr = __real_malloc(size);

  if(ptr == NULL) {

    return NULL;
  }

  records[recordSlot].address = ptr;
  records[recordSlot].freedAddress = NULL;
  records[recordSlot].size = (int)size;
  records[recordSlot].freed = false;
  records[recordSlot].callerAddress = callerAddress;
  records[recordSlot].callCount++;
  records[recordSlot].reallocCount = 0;
  records[recordSlot].grewByRealloc = false;

  totalAllocatedBytes += (unsigned long)size;
  activeAllocations++;
  recordAllocationHotspot(callerAddress, size);

  if((int)size > largestAllocation) {

    largestAllocation = (int)size;
  }

  commitRecordSlot(recordSlot);

  return ptr;
}

void* __wrap_realloc(void* ptr, size_t newSize) {

  void* caller = __builtin_return_address(0);
  uintptr_t callerAddress = (uintptr_t)caller;
  int recordSlot = -1;
  int oldSize = 0;

  reallocCalls++;

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(ptr != NULL && records[i].address == ptr && !records[i].freed) {

      recordSlot = i;
      oldSize = records[i].size;

      break;
    }
  }

  void* newPtr = __real_realloc(ptr, newSize);

  if(newPtr == NULL) {

    reallocFailures++;

    return NULL;
  }

  if(recordSlot >= 0) {

    if(newPtr != ptr) reallocMoves++;

    if((int)newSize > oldSize) {

      totalAllocatedBytes += (unsigned long)((int)newSize - oldSize);
    }
    else if((int)newSize < oldSize) {

      totalFreedBytes += (unsigned long)(oldSize - (int)newSize);
    }

    records[recordSlot].address = newPtr;
    records[recordSlot].freedAddress = NULL;
    records[recordSlot].size = (int)newSize;
    records[recordSlot].freed = false;
    records[recordSlot].reallocCount++;

    if((int)newSize > oldSize) {

      records[recordSlot].grewByRealloc = true;
    }

    if((int)newSize > largestAllocation) {

      largestAllocation = (int)newSize;
    }

    recordAllocationHotspot(callerAddress, newSize);

    return newPtr;
  }

  recordSlot = findAvailableRecordSlot();

  if(recordSlot < 0) {

    MLEAK_PRINTLN("mleak: table full, not tracking");

    return newPtr;
  }

  records[recordSlot].address = newPtr;
  records[recordSlot].freedAddress = NULL;
  records[recordSlot].size = (int)newSize;
  records[recordSlot].freed = false;
  records[recordSlot].callerAddress = callerAddress;
  records[recordSlot].callCount++;
  records[recordSlot].reallocCount = 1;
  records[recordSlot].grewByRealloc = false;

  totalAllocatedBytes += (unsigned long)newSize;
  activeAllocations++;
  recordAllocationHotspot(callerAddress, newSize);

  if((int)newSize > largestAllocation) {

    largestAllocation = (int)newSize;
  }

  commitRecordSlot(recordSlot);

  return newPtr;
}

void __wrap_free(void* ptr) {

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(ptr != NULL && records[i].address == ptr && !records[i].freed) {

      records[i].freed = true;

      records[i].freedAddress = ptr;

      records[i].address = NULL;

      totalFreedBytes += (unsigned long)records[i].size;

      if(activeAllocations > 0) {

        activeAllocations--;
      }

      __real_free(ptr);

      return;
    }
  }

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(ptr != NULL && records[i].freedAddress == ptr && records[i].freed) {

      MLEAK_PRINTLN("[DOUBLE FREE DETECTED]");

      MLEAK_PRINT("Address: ");

      MLEAK_PRINT_HEX(ptr);

      MLEAK_PRINT("Size: ");

      MLEAK_PRINTLN(records[i].size);

      MLEAK_PRINT("Caller: ");

      MLEAK_PRINT_HEX(records[i].callerAddress);

      return;
    }
  }

  __real_free(ptr);
}

typedef enum {
  LEAK_UNKNOWN = 0,
  LEAK_INIT,
  LEAK_CACHE,
  LEAK_GROWING
} LeakType;

typedef enum {
  SEVERITY_LOW = 0,
  SEVERITY_MEDIUM,
  SEVERITY_HIGH,
  SEVERITY_CRITICAL
} LeakSeverity;

LeakType classifyLeak(uintptr_t callerAddress) {

  int count = 0;
  int growing = 0;
  int lastSize = 0;

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(records[i].callerAddress == callerAddress && !records[i].freed) {

      if(records[i].grewByRealloc) growing = 1;

      if(records[i].size > lastSize && count > 0) growing = 1;

      lastSize = records[i].size;

      count++;
    }
  }

  if(count > 0 && growing) return LEAK_GROWING;
  if(count == 1) return LEAK_INIT;
  if(count > 1 && !growing) return LEAK_CACHE;

  return LEAK_UNKNOWN;
}

static int allocationFrequency(uintptr_t callerAddress) {

  for(int i = 0; i < hotspotCount; i++) {

    if(hotspots[i].callerAddress == callerAddress) {

      return hotspots[i].allocations;
    }
  }

  return 1;
}

static LeakSeverity scoreLeakSeverity(int recordSlot) {

  int score = 0;
  int activeBytes = 0;
  int largestActive = 0;
  int activeCount = 0;
  int size = records[recordSlot].size;
  int frequency = allocationFrequency(records[recordSlot].callerAddress);

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(records[i].address != NULL && records[i].freed == false) {

      activeBytes += records[i].size;
      activeCount++;

      if(records[i].size > largestActive) {

        largestActive = records[i].size;
      }
    }
  }

  if(size >= 256) score += 3;
  else if(size >= 128) score += 2;
  else if(size >= 32) score += 1;

  if(frequency >= 10) score += 3;
  else if(frequency >= 5) score += 2;
  else if(frequency >= 2) score += 1;

  if(records[recordSlot].address != NULL && records[recordSlot].freed == false) {

    score += 1;
  }

  if(records[recordSlot].reallocCount > 0 || records[recordSlot].grewByRealloc) {

    score += 1;
  }

  if(activeBytes > 0 && activeCount > 1 && size < largestActive) {

    int fragmentationContribution = (size * 100) / activeBytes;

    if(fragmentationContribution >= 25) score += 2;
    else if(fragmentationContribution >= 10) score += 1;
  }

  if(score >= 7) return SEVERITY_CRITICAL;
  if(score >= 5) return SEVERITY_HIGH;
  if(score >= 3) return SEVERITY_MEDIUM;

  return SEVERITY_LOW;
}

static const char* severityToString(LeakSeverity severity) {

  switch(severity) {

    case SEVERITY_CRITICAL:
      return "CRITICAL";
    case SEVERITY_HIGH:
      return "HIGH";
    case SEVERITY_MEDIUM:
      return "MEDIUM";
    case SEVERITY_LOW:
    default:
      return "LOW";
  }
}

void checkLeaks() {

  int totalLeak = 0;

  MLEAK_PRINTLN("===== MEMORY REPORT =====");

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(records[i].address != NULL && records[i].freed == false) {

      MLEAK_PRINT("Leak Detected: ");

      MLEAK_PRINT(records[i].size);

      MLEAK_PRINTLN(" bytes");

      MLEAK_PRINT("Address: ");

      MLEAK_PRINT_HEX(records[i].address);

      LeakType t = classifyLeak(records[i].callerAddress);

      const char* typeStr =
        t == LEAK_INIT    ? "Init leak"       :
        t == LEAK_CACHE   ? "Forgotten cache" :
        t == LEAK_GROWING ? "Growing buffer"  : "Unknown";

      MLEAK_PRINT("Type: ");

      MLEAK_PRINTLN(typeStr);

      MLEAK_PRINT("Severity: ");

      MLEAK_PRINTLN(severityToString(scoreLeakSeverity(i)));

      if(records[i].reallocCount > 0) {

        MLEAK_PRINT("Realloc count: ");

        MLEAK_PRINTLN(records[i].reallocCount);
      }

      MLEAK_PRINTLN("------------------");

      totalLeak += records[i].size;
    }
  }

  MLEAK_PRINT("Total Memory Leaked: ");

  MLEAK_PRINT(totalLeak);

  MLEAK_PRINTLN(" bytes");

  MLEAK_PRINT("Realloc calls: ");

  MLEAK_PRINTLN(reallocCalls);

  MLEAK_PRINT("Realloc failures: ");

  MLEAK_PRINTLN(reallocFailures);

  MLEAK_PRINT("Realloc moved blocks: ");

  MLEAK_PRINTLN(reallocMoves);
}

void printOverhead() {

  int tableBytes = sizeof(records);
  int totalSRAM = 2048;
  float pct = (tableBytes * 100.0) / totalSRAM;

  MLEAK_PRINT("mleak-rt RAM overhead: ");
  MLEAK_PRINT(tableBytes);
  MLEAK_PRINT(" bytes (");
  MLEAK_PRINT_FLOAT(pct, 1);
  MLEAK_PRINTLN("% of SRAM)");
}

void printFragmentationReport() {

  unsigned long activeBytes = 0;
  int largestActive = 0;
  float fragmentation = 0.0;

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(records[i].address != NULL && records[i].freed == false) {

      activeBytes += (unsigned long)records[i].size;

      if(records[i].size > largestActive) {

        largestActive = records[i].size;
      }
    }
  }

  if(activeBytes > 0 && largestActive > 0) {

    fragmentation = ((activeBytes - largestActive) * 100.0) / activeBytes;
  }

  MLEAK_PRINTLN("===== FRAGMENTATION REPORT =====");

  MLEAK_PRINT("Total Allocated: ");
  MLEAK_PRINTLN(totalAllocatedBytes);

  MLEAK_PRINT("Total Freed: ");
  MLEAK_PRINTLN(totalFreedBytes);

  MLEAK_PRINT("Active Allocations: ");
  MLEAK_PRINTLN(activeAllocations);

  MLEAK_PRINT("Largest Allocation: ");
  MLEAK_PRINTLN(largestAllocation);

  MLEAK_PRINT("Estimated Fragmentation: ");
  MLEAK_PRINT_FLOAT(fragmentation, 1);
  MLEAK_PRINTLN("%");
}

void runBenchmarks() {

  const int iterations = 100;
  const size_t benchSize = 16;
  unsigned long rawTotal = 0;
  unsigned long wrappedTotal = 0;
  unsigned long t1;
  unsigned long t2;
  MemoryRecord savedRecords[MLEAK_MAX_RECORDS];
  HotspotRecord savedHotspots[MLEAK_MAX_RECORDS];
  int savedRecordIndex = recordIndex;
  int savedHotspotCount = hotspotCount;
  int savedReallocCalls = reallocCalls;
  int savedReallocFailures = reallocFailures;
  int savedReallocMoves = reallocMoves;
  unsigned long savedTotalAllocatedBytes = totalAllocatedBytes;
  unsigned long savedTotalFreedBytes = totalFreedBytes;
  int savedActiveAllocations = activeAllocations;
  int savedLargestAllocation = largestAllocation;

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    savedRecords[i] = records[i];
    savedHotspots[i] = hotspots[i];
  }

  for(int i = 0; i < iterations; i++) {

    t1 = MLEAK_MICROS();
    void* ptr = __real_malloc(benchSize);
    __real_free(ptr);
    t2 = MLEAK_MICROS();

    rawTotal += t2 - t1;
  }

  for(int i = 0; i < iterations; i++) {

    t1 = MLEAK_MICROS();
    void* ptr = __wrap_malloc(benchSize);
    __wrap_free(ptr);
    t2 = MLEAK_MICROS();

    wrappedTotal += t2 - t1;
  }

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    records[i] = savedRecords[i];
    hotspots[i] = savedHotspots[i];
  }

  recordIndex = savedRecordIndex;
  hotspotCount = savedHotspotCount;
  reallocCalls = savedReallocCalls;
  reallocFailures = savedReallocFailures;
  reallocMoves = savedReallocMoves;
  totalAllocatedBytes = savedTotalAllocatedBytes;
  totalFreedBytes = savedTotalFreedBytes;
  activeAllocations = savedActiveAllocations;
  largestAllocation = savedLargestAllocation;

  float rawAvg = rawTotal / (float)iterations;
  float wrappedAvg = wrappedTotal / (float)iterations;
  float overheadPct = 0.0;

  if(rawAvg > 0.0) {

    overheadPct = ((wrappedAvg - rawAvg) * 100.0) / rawAvg;
  }

  MLEAK_PRINTLN("===== BENCHMARK REPORT =====");

  MLEAK_PRINT("Raw malloc avg: ");
  MLEAK_PRINT_FLOAT(rawAvg, 2);
  MLEAK_PRINTLN(" us");

  MLEAK_PRINT("Wrapped malloc avg: ");
  MLEAK_PRINT_FLOAT(wrappedAvg, 2);
  MLEAK_PRINTLN(" us");

  MLEAK_PRINT("Overhead percentage: ");
  MLEAK_PRINT_FLOAT(overheadPct, 1);
  MLEAK_PRINTLN("%");

  MLEAK_PRINT("Tracking RAM usage: ");
  MLEAK_PRINT((int)sizeof(records));
  MLEAK_PRINTLN(" bytes");

  MLEAK_PRINT("Max tracked allocations: ");
  MLEAK_PRINTLN(MLEAK_MAX_RECORDS);
}

void printAllocationHotspots() {

  int order[MLEAK_MAX_RECORDS];

  for(int i = 0; i < hotspotCount; i++) {

    order[i] = i;
  }

  for(int i = 0; i < hotspotCount - 1; i++) {

    int best = i;

    for(int j = i + 1; j < hotspotCount; j++) {

      if(hotspots[order[j]].allocations > hotspots[order[best]].allocations) {

        best = j;
      }
    }

    if(best != i) {

      int tmp = order[i];
      order[i] = order[best];
      order[best] = tmp;
    }
  }

  MLEAK_PRINTLN("===== ALLOCATION HOTSPOTS =====");

  for(int i = 0; i < hotspotCount; i++) {

    int slot = order[i];

    MLEAK_PRINT("Caller: ");
    MLEAK_PRINT_HEX(hotspots[slot].callerAddress);

    MLEAK_PRINT("Allocations: ");
    MLEAK_PRINTLN(hotspots[slot].allocations);

    MLEAK_PRINT("Bytes Allocated: ");
    MLEAK_PRINTLN(hotspots[slot].bytesAllocated);

    MLEAK_PRINTLN("------------------");
  }
}

void printMLFeatures() {

  unsigned long activeBytes = 0;
  int largestActive = 0;
  float fragmentationPercent = 0.0;
  int printed = 0;

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(records[i].address != NULL && records[i].freed == false) {

      activeBytes += (unsigned long)records[i].size;

      if(records[i].size > largestActive) {

        largestActive = records[i].size;
      }
    }
  }

  if(activeBytes > 0 && largestActive > 0) {

    fragmentationPercent = ((activeBytes - largestActive) * 100.0) / activeBytes;
  }

  for(int i = 0; i < MLEAK_MAX_RECORDS; i++) {

    if(records[i].address != NULL && records[i].freed == false) {

      MLEAK_PRINT("ML,");
      MLEAK_PRINT(records[i].size);
      MLEAK_PRINT(",");
      MLEAK_PRINT(allocationFrequency(records[i].callerAddress));
      MLEAK_PRINT(",");
      MLEAK_PRINT(records[i].reallocCount);
      MLEAK_PRINT(",");
      MLEAK_PRINT(records[i].grewByRealloc ? 1 : 0);
      MLEAK_PRINT(",");
      MLEAK_PRINT(activeAllocations);
      MLEAK_PRINT(",");
      MLEAK_PRINT(largestAllocation);
      MLEAK_PRINT(",");
      MLEAK_PRINT(totalAllocatedBytes);
      MLEAK_PRINT(",");
      MLEAK_PRINT(totalFreedBytes);
      MLEAK_PRINT(",");
      MLEAK_PRINT_FLOAT(fragmentationPercent, 1);
      MLEAK_PRINTLN("");

      printed++;
    }
  }

  if(printed == 0) {

    MLEAK_PRINT("ML,0,0,0,0,");
    MLEAK_PRINT(activeAllocations);
    MLEAK_PRINT(",");
    MLEAK_PRINT(largestAllocation);
    MLEAK_PRINT(",");
    MLEAK_PRINT(totalAllocatedBytes);
    MLEAK_PRINT(",");
    MLEAK_PRINT(totalFreedBytes);
    MLEAK_PRINT(",");
    MLEAK_PRINT_FLOAT(fragmentationPercent, 1);
    MLEAK_PRINTLN("");
  }
}
