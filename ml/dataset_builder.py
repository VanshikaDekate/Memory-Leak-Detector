import csv
import random

NUM_SAMPLES = 500

with open("ml/memory_metrics.csv", "w", newline="") as f:
    writer = csv.writer(f)

    writer.writerow([
        "allocSize",
        "allocFrequency",
        "reallocCount",
        "grewByRealloc",
        "activeAllocations",
        "largestAllocation",
        "totalAllocatedBytes",
        "totalFreedBytes",
        "fragmentationPercent",
        "label"
    ])

    for _ in range(NUM_SAMPLES):

        alloc_size = random.randint(8, 512)
        alloc_frequency = random.randint(1, 15)
        realloc_count = random.randint(0, 10)
        grew_by_realloc = random.randint(0, 1)
        active_allocations = random.randint(1, 20)

        largest_allocation = max(
            alloc_size,
            random.randint(alloc_size, 1024)
        )

        total_allocated = random.randint(
            alloc_size,
            10000
        )

        total_freed = random.randint(
            0,
            total_allocated
        )

        fragmentation = random.uniform(0, 100)

        if (
            realloc_count > 5
            and grew_by_realloc
            and fragmentation > 40
        ):
            label = "GROWING_LEAK"

        elif (
            alloc_frequency > 8
            and fragmentation > 25
        ):
            label = "CACHE_LEAK"

        elif fragmentation > 60:
            label = "FRAGMENTED"

        else:
            label = "NORMAL"

        writer.writerow([
            alloc_size,
            alloc_frequency,
            realloc_count,
            grew_by_realloc,
            active_allocations,
            largest_allocation,
            total_allocated,
            total_freed,
            round(fragmentation, 2),
            label
        ])

print("Generated 500 samples")