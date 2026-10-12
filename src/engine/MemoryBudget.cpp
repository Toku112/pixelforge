#include "engine/MemoryBudget.h"

#include "engine/SystemMemory.h"

#include <algorithm>
#include <utility>

namespace pf::engine {

std::size_t MemoryBudget::defaultLimit() {
    const std::size_t physical = physicalMemoryBytes();
    if (physical == 0) {
        return std::size_t{4} << 30;
    }
    return static_cast<std::size_t>(static_cast<double>(physical) * defaultShare);
}

MemoryBudget::MemoryBudget(std::size_t limit, UsageProbe probe) : m_limit(limit), m_probe(std::move(probe)) {}

MemoryBudget::~MemoryBudget() = default;

void MemoryBudget::setLimit(std::size_t bytes) {
    m_limit.store(bytes, std::memory_order_relaxed);
    enforce();
}

std::size_t MemoryBudget::usage() const {
    if (m_probe) {
        return m_probe();
    }
    const std::scoped_lock lock(m_mutex);
    return usageLocked();
}

std::size_t MemoryBudget::usageLocked() const {
    if (m_probe) {
        return m_probe();
    }
    std::size_t total = 0;
    for (const MemoryConsumer* consumer : m_consumers) {
        total += consumer->consumerBytes();
    }
    return total;
}

void MemoryBudget::add(MemoryConsumer& consumer) {
    const std::scoped_lock lock(m_mutex);
    m_consumers.push_back(&consumer);
}

void MemoryBudget::remove(MemoryConsumer& consumer) {
    const std::scoped_lock lock(m_mutex);
    std::erase(m_consumers, &consumer);
}

std::size_t MemoryBudget::enforce() {
    const std::scoped_lock lock(m_mutex);
    std::size_t evicted = 0;
    while (usageLocked() > limit()) {
        MemoryConsumer* victim = nullptr;
        std::uint64_t oldest = 0;
        for (MemoryConsumer* consumer : m_consumers) {
            const std::optional<std::uint64_t> candidate = consumer->evictionCandidate();
            if (candidate && (victim == nullptr || *candidate < oldest)) {
                victim = consumer;
                oldest = *candidate;
            }
        }
        if (victim == nullptr || !victim->evictOne()) {
            break; // nothing left to evict
        }
        ++evicted;
    }
    m_evictions.fetch_add(evicted, std::memory_order_relaxed);
    return evicted;
}

MemoryBudgetStats MemoryBudget::stats() const {
    const std::scoped_lock lock(m_mutex);
    MemoryBudgetStats result{
        .limit = limit(), .usage = usageLocked(), .evictions = m_evictions.load(), .consumers = {}};
    for (const MemoryConsumer* consumer : m_consumers) {
        result.consumers.push_back({.name = consumer->consumerName(),
                                    .bytes = consumer->consumerBytes(),
                                    .entries = consumer->consumerEntries()});
    }
    return result;
}

} // namespace pf::engine
