#pragma once

// The memory budget (CLAUDE.md §3.5, D-074): one limit — by default 60 % of physical memory, set in Preferences >
// Performance — shared by everything that caches images (node results, playback frames, decoded files).
//
// The budget measures real memory through a usage probe; the engine's probe is the bytes of every tile that exists
// (TilePool), which counts a tile shared by several images once and also counts images being worked on. When usage is
// over the limit, enforce() evicts cached entries — always the least recently used one over all caches — until usage
// is back under the limit or nothing is left to evict. Entries still held elsewhere (the frame on screen) free no
// memory when evicted, so when the work in progress alone is over the limit, the caches end up empty.
//
// Each cache is a MemoryConsumer; entries carry ticks from the budget's clock (nextTick()), so "least recently used"
// is comparable across caches. A cache with its own eviction order (playback keeps frames near the playhead) reports
// a tick that reflects that order.
//
// All functions may run on any number of threads at once. Lock order: the budget's lock is taken before a consumer's;
// a consumer must not call the budget while holding its own lock.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace pf::engine {

class MemoryConsumer {
public:
    MemoryConsumer() = default;
    virtual ~MemoryConsumer() = default;
    MemoryConsumer(const MemoryConsumer&) = delete;
    MemoryConsumer(MemoryConsumer&&) = delete;
    MemoryConsumer& operator=(const MemoryConsumer&) = delete;
    MemoryConsumer& operator=(MemoryConsumer&&) = delete;

    // For statistics.
    [[nodiscard]] virtual std::string consumerName() const = 0;
    [[nodiscard]] virtual std::size_t consumerBytes() const = 0;
    [[nodiscard]] virtual std::size_t consumerEntries() const = 0;
    // The tick of the entry this consumer would evict next (smaller = evicted sooner), or nothing when it is empty.
    [[nodiscard]] virtual std::optional<std::uint64_t> evictionCandidate() const = 0;
    // Evicts that entry; false when there was none.
    virtual bool evictOne() = 0;
};

struct ConsumerStats {
    std::string name;
    std::size_t bytes = 0;
    std::size_t entries = 0;
};

struct MemoryBudgetStats {
    std::size_t limit = 0;
    std::size_t usage = 0;
    std::uint64_t evictions = 0;
    std::vector<ConsumerStats> consumers; // in registration order
};

class MemoryBudget {
public:
    using UsageProbe = std::function<std::size_t()>;

    // Share of physical memory used by default (CLAUDE.md §3.5).
    static constexpr double defaultShare = 0.6;
    // defaultShare of physical memory; 4 GiB when the system does not report it.
    [[nodiscard]] static std::size_t defaultLimit();

    // Without a probe, usage is the sum of the consumers' own byte counts.
    explicit MemoryBudget(std::size_t limit = defaultLimit(), UsageProbe probe = {});
    ~MemoryBudget();
    MemoryBudget(const MemoryBudget&) = delete;
    MemoryBudget(MemoryBudget&&) = delete;
    MemoryBudget& operator=(const MemoryBudget&) = delete;
    MemoryBudget& operator=(MemoryBudget&&) = delete;

    [[nodiscard]] std::size_t limit() const { return m_limit.load(std::memory_order_relaxed); }
    // Enforced at once.
    void setLimit(std::size_t bytes);
    [[nodiscard]] std::size_t usage() const;

    // The use clock shared by all consumers: every call returns a larger value.
    [[nodiscard]] std::uint64_t nextTick() { return m_clock.fetch_add(1, std::memory_order_relaxed) + 1; }

    // Consumers register for their whole lifetime. remove() waits for a running enforce() to finish, so after it
    // returns the budget no longer calls the consumer.
    void add(MemoryConsumer& consumer);
    void remove(MemoryConsumer& consumer);

    // Evicts least recently used entries until usage() <= limit() or nothing is left; returns how many.
    std::size_t enforce();

    [[nodiscard]] MemoryBudgetStats stats() const;

private:
    [[nodiscard]] std::size_t usageLocked() const;

    std::atomic<std::size_t> m_limit;
    UsageProbe m_probe;
    std::atomic<std::uint64_t> m_clock{0};
    std::atomic<std::uint64_t> m_evictions{0};

    mutable std::mutex m_mutex;
    std::vector<MemoryConsumer*> m_consumers; // m_mutex
};

} // namespace pf::engine
