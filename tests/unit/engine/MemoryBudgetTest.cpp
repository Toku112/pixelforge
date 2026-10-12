// The memory budget and LRU caches (engine/MemoryBudget.h, engine/LruCache.h).

#include "engine/MemoryBudget.h"

#include "engine/LruCache.h"
#include "engine/SystemMemory.h"

#include <gtest/gtest.h>

#include <atomic>
#include <cstddef>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace pf::engine {
namespace {

using Cache = LruCache<int, std::string>;

std::shared_ptr<const std::string> value(const std::string& text) {
    return std::make_shared<const std::string>(text);
}

TEST(SystemMemory, ReportsInstalledMemory) {
    EXPECT_GT(physicalMemoryBytes(), std::size_t{512} << 20); // every machine we support has more than 512 MB
}

TEST(MemoryBudget, DefaultIsSixtyPercentOfPhysicalMemory) {
    const auto expected = static_cast<std::size_t>(static_cast<double>(physicalMemoryBytes()) * 0.6);
    EXPECT_EQ(MemoryBudget::defaultLimit(), expected);
    EXPECT_EQ(MemoryBudget().limit(), expected);
}

TEST(MemoryBudget, TicksIncrease) {
    MemoryBudget budget(100);
    const std::uint64_t a = budget.nextTick();
    const std::uint64_t b = budget.nextTick();
    EXPECT_LT(a, b);
}

TEST(LruCache, FindsWhatWasInsertedAndCountsHitsAndMisses) {
    MemoryBudget budget(1000);
    Cache cache("results", budget);
    EXPECT_EQ(cache.find(1), nullptr);
    cache.insert(1, value("one"), 10);
    cache.insert(2, value("two"), 20);
    ASSERT_NE(cache.find(1), nullptr);
    EXPECT_EQ(*cache.find(1), "one");
    EXPECT_TRUE(cache.contains(2));
    EXPECT_FALSE(cache.contains(3));

    const CacheStats stats = cache.stats();
    EXPECT_EQ(stats.entries, 2U);
    EXPECT_EQ(stats.bytes, 30U);
    EXPECT_EQ(stats.hits, 2U);
    EXPECT_EQ(stats.misses, 1U);
    EXPECT_EQ(budget.usage(), 30U); // no probe: the caches' own byte counts
}

TEST(LruCache, InsertingAnExistingKeyReplacesTheValue) {
    MemoryBudget budget(1000);
    Cache cache("results", budget);
    cache.insert(1, value("old"), 100);
    cache.insert(1, value("new"), 40);
    EXPECT_EQ(*cache.find(1), "new");
    EXPECT_EQ(cache.stats().entries, 1U);
    EXPECT_EQ(cache.stats().bytes, 40U);
}

TEST(LruCache, EraseAndClear) {
    MemoryBudget budget(1000);
    Cache cache("results", budget);
    cache.insert(1, value("a"), 1);
    cache.insert(2, value("b"), 2);
    EXPECT_TRUE(cache.erase(1));
    EXPECT_FALSE(cache.erase(1));
    EXPECT_EQ(cache.stats().bytes, 2U);
    cache.clear();
    EXPECT_EQ(cache.stats().entries, 0U);
    EXPECT_EQ(cache.stats().bytes, 0U);
    EXPECT_EQ(budget.usage(), 0U);
}

TEST(LruCache, EvictsTheLeastRecentlyUsedEntry) {
    MemoryBudget budget(300);
    Cache cache("results", budget);
    cache.insert(1, value("a"), 100);
    cache.insert(2, value("b"), 100);
    cache.insert(3, value("c"), 100);
    (void)cache.find(1); // 1 is now more recent than 2
    cache.insert(4, value("d"), 100);
    EXPECT_TRUE(cache.contains(1));
    EXPECT_FALSE(cache.contains(2));
    EXPECT_TRUE(cache.contains(3));
    EXPECT_TRUE(cache.contains(4));
    EXPECT_EQ(cache.stats().evictions, 1U);
    EXPECT_EQ(budget.usage(), 300U);
}

TEST(LruCache, EvictionComparesAcrossCaches) {
    MemoryBudget budget(200);
    Cache nodes("node results", budget);
    Cache frames("frames", budget);
    nodes.insert(1, value("oldest"), 100);
    frames.insert(1, value("middle"), 100);
    (void)nodes.find(1); // the node result is now the most recent
    frames.insert(2, value("newest"), 100);
    EXPECT_TRUE(nodes.contains(1));
    EXPECT_FALSE(frames.contains(1));
    EXPECT_TRUE(frames.contains(2));

    const MemoryBudgetStats stats = budget.stats();
    EXPECT_EQ(stats.limit, 200U);
    EXPECT_EQ(stats.usage, 200U);
    EXPECT_EQ(stats.evictions, 1U);
    ASSERT_EQ(stats.consumers.size(), 2U);
    EXPECT_EQ(stats.consumers[0].name, "node results");
    EXPECT_EQ(stats.consumers[0].entries, 1U);
    EXPECT_EQ(stats.consumers[1].name, "frames");
    EXPECT_EQ(stats.consumers[1].bytes, 100U);
}

TEST(LruCache, AnEntryLargerThanTheLimitIsNotKept) {
    MemoryBudget budget(100);
    Cache cache("results", budget);
    cache.insert(1, value("small"), 50);
    cache.insert(2, value("huge"), 500);
    EXPECT_EQ(cache.stats().entries, 0U);
    EXPECT_EQ(budget.usage(), 0U);
}

TEST(LruCache, LoweringTheLimitEvictsAtOnce) {
    MemoryBudget budget(1000);
    Cache cache("results", budget);
    for (int i = 0; i < 10; ++i) {
        cache.insert(i, value(std::to_string(i)), 100);
    }
    budget.setLimit(350);
    EXPECT_EQ(cache.stats().entries, 3U);
    EXPECT_TRUE(cache.contains(9));
    EXPECT_TRUE(cache.contains(7));
    EXPECT_FALSE(cache.contains(6));
}

TEST(LruCache, AnEvictedValueStaysValidForItsHolders) {
    MemoryBudget budget(100);
    Cache cache("results", budget);
    cache.insert(1, value("on screen"), 100);
    const std::shared_ptr<const std::string> shown = cache.find(1);
    cache.insert(2, value("next"), 100);
    EXPECT_FALSE(cache.contains(1));
    EXPECT_EQ(*shown, "on screen");
}

TEST(MemoryBudget, WhenEvictingFreesNothingTheCachesEmpty) {
    // The probe stands for the tile memory in use. These entries share their tiles with images held elsewhere, so
    // evicting them frees nothing: the budget evicts them all, then stops.
    std::atomic<std::size_t> used{600};
    MemoryBudget budget(1000, [&used] { return used.load(); });
    Cache cache("results", budget);
    cache.insert(1, value("a"), 300);
    cache.insert(2, value("b"), 300);
    cache.insert(3, value("c"), 300);
    EXPECT_EQ(cache.stats().entries, 3U);
    EXPECT_EQ(budget.usage(), 600U); // the probe, not the caches' byte counts

    budget.setLimit(400);
    EXPECT_EQ(cache.stats().entries, 0U);
    EXPECT_EQ(budget.usage(), 600U);
    used = 300;
    EXPECT_EQ(budget.enforce(), 0U); // under the limit: nothing to do
}

TEST(MemoryBudget, EvictionStopsAsSoonAsUsageFits) {
    // Each eviction frees 100 bytes of real memory.
    std::atomic<std::size_t> used{0};
    MemoryBudget budget(1000, [&used] { return used.load(); });
    struct Counted {
        std::atomic<std::size_t>* used;
        explicit Counted(std::atomic<std::size_t>* u) : used(u) { *used += 100; }
        ~Counted() { *used -= 100; }
        Counted(const Counted&) = delete;
        Counted(Counted&&) = delete;
        Counted& operator=(const Counted&) = delete;
        Counted& operator=(Counted&&) = delete;
    };
    LruCache<int, Counted> cache("results", budget);
    for (int i = 0; i < 8; ++i) {
        cache.insert(i, std::make_shared<const Counted>(&used), 100);
    }
    EXPECT_EQ(used, 800U);
    budget.setLimit(500);
    EXPECT_EQ(used, 500U);
    EXPECT_EQ(cache.stats().entries, 5U);
    EXPECT_FALSE(cache.contains(2));
    EXPECT_TRUE(cache.contains(3));
}

TEST(MemoryBudget, ACacheLeavesTheBudgetWhenDestroyed) {
    MemoryBudget budget(1000);
    {
        Cache cache("results", budget);
        cache.insert(1, value("a"), 10);
        EXPECT_EQ(budget.stats().consumers.size(), 1U);
    }
    EXPECT_TRUE(budget.stats().consumers.empty());
    EXPECT_EQ(budget.usage(), 0U);
}

TEST(LruCache, ManyThreadsInsertAndFind) {
    MemoryBudget budget(5000);
    Cache a("a", budget);
    Cache b("b", budget);
    std::vector<std::thread> threads;
    threads.reserve(8);
    for (int t = 0; t < 8; ++t) {
        threads.emplace_back([&, t] {
            Cache& cache = (t % 2 == 0) ? a : b;
            for (int i = 0; i < 2000; ++i) {
                const int key = (i * 7 + t) % 300;
                if (const auto found = cache.find(key)) {
                    EXPECT_EQ(*found, std::to_string(key));
                } else {
                    cache.insert(key, value(std::to_string(key)), 100);
                }
            }
        });
    }
    for (std::thread& thread : threads) {
        thread.join();
    }
    EXPECT_LE(budget.usage(), 5000U);
    const CacheStats sa = a.stats();
    const CacheStats sb = b.stats();
    EXPECT_EQ(sa.bytes + sb.bytes, budget.usage());
    EXPECT_EQ(sa.hits + sa.misses + sb.hits + sb.misses, 8U * 2000U);
}

} // namespace
} // namespace pf::engine
