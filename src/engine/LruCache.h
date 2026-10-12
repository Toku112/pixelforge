#pragma once

// A thread-safe cache of computed values (node results, decoded frames) whose memory counts against the memory
// budget (MemoryBudget.h). Looking a value up marks it as just used; when the budget is over its limit it evicts the
// entries used longest ago, comparing across all caches. Values are shared, immutable and reference counted: an
// evicted value stays valid for whoever still holds it.

#include "engine/MemoryBudget.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

namespace pf::engine {

struct CacheStats {
    std::size_t entries = 0;
    std::size_t bytes = 0;
    std::uint64_t hits = 0;
    std::uint64_t misses = 0;
    std::uint64_t evictions = 0;
};

template <class Key, class Value, class Hash = std::hash<Key>>
class LruCache final : public MemoryConsumer {
public:
    // Registers with `budget`, which must outlive the cache.
    LruCache(std::string name, MemoryBudget& budget) : m_name(std::move(name)), m_budget(budget) {
        m_budget.add(*this);
    }
    ~LruCache() override { m_budget.remove(*this); }
    LruCache(const LruCache&) = delete;
    LruCache(LruCache&&) = delete;
    LruCache& operator=(const LruCache&) = delete;
    LruCache& operator=(LruCache&&) = delete;

    // The value stored for `key`, now marked as just used; null when there is none.
    [[nodiscard]] std::shared_ptr<const Value> find(const Key& key) {
        const std::scoped_lock lock(m_mutex);
        const auto found = m_index.find(key);
        if (found == m_index.end()) {
            ++m_misses;
            return nullptr;
        }
        ++m_hits;
        const auto entry = found->second;
        entry->tick = m_budget.nextTick();
        m_entries.splice(m_entries.begin(), m_entries, entry); // most recent first
        return entry->value;
    }

    // Stores `value` for `key`, replacing an older value, then lets the budget evict what is over the limit (this
    // entry last, as it is the most recently used). `bytes` is the memory the value holds, for statistics.
    void insert(const Key& key, std::shared_ptr<const Value> value, std::size_t bytes) {
        std::shared_ptr<const Value> replaced; // released after unlocking
        {
            const std::scoped_lock lock(m_mutex);
            const auto found = m_index.find(key);
            if (found != m_index.end()) {
                replaced = std::move(found->second->value);
                m_bytes -= found->second->bytes;
                m_entries.erase(found->second);
                m_index.erase(found);
            }
            m_entries.push_front({.key = key, .value = std::move(value), .bytes = bytes, .tick = m_budget.nextTick()});
            m_index.emplace(key, m_entries.begin());
            m_bytes += bytes;
        }
        replaced.reset();
        m_budget.enforce();
    }

    // Removes the entry for `key`; false when there was none.
    bool erase(const Key& key) {
        std::shared_ptr<const Value> removed;
        const std::scoped_lock lock(m_mutex);
        const auto found = m_index.find(key);
        if (found == m_index.end()) {
            return false;
        }
        removed = takeLocked(found->second);
        return true;
    }

    void clear() {
        std::list<Entry> removed;
        {
            const std::scoped_lock lock(m_mutex);
            removed.swap(m_entries);
            m_index.clear();
            m_bytes = 0;
        }
    }

    [[nodiscard]] bool contains(const Key& key) const {
        const std::scoped_lock lock(m_mutex);
        return m_index.contains(key);
    }

    [[nodiscard]] CacheStats stats() const {
        const std::scoped_lock lock(m_mutex);
        return {.entries = m_entries.size(),
                .bytes = m_bytes,
                .hits = m_hits,
                .misses = m_misses,
                .evictions = m_evictions};
    }

    // ---- MemoryConsumer
    [[nodiscard]] std::string consumerName() const override { return m_name; }
    [[nodiscard]] std::size_t consumerBytes() const override {
        const std::scoped_lock lock(m_mutex);
        return m_bytes;
    }
    [[nodiscard]] std::size_t consumerEntries() const override {
        const std::scoped_lock lock(m_mutex);
        return m_entries.size();
    }
    [[nodiscard]] std::optional<std::uint64_t> evictionCandidate() const override {
        const std::scoped_lock lock(m_mutex);
        if (m_entries.empty()) {
            return std::nullopt;
        }
        return m_entries.back().tick;
    }
    bool evictOne() override {
        std::shared_ptr<const Value> evicted; // released after unlocking: freeing a big image takes a moment
        {
            const std::scoped_lock lock(m_mutex);
            if (m_entries.empty()) {
                return false;
            }
            evicted = takeLocked(std::prev(m_entries.end()));
            ++m_evictions;
        }
        return true;
    }

private:
    struct Entry {
        Key key;
        std::shared_ptr<const Value> value;
        std::size_t bytes = 0;
        std::uint64_t tick = 0;
    };
    using EntryList = std::list<Entry>; // most recently used first

    // Removes an entry and hands its value to the caller, who releases it after unlocking.
    std::shared_ptr<const Value> takeLocked(typename EntryList::iterator entry) {
        std::shared_ptr<const Value> value = std::move(entry->value);
        m_bytes -= entry->bytes;
        m_index.erase(entry->key);
        m_entries.erase(entry);
        return value;
    }

    const std::string m_name;
    MemoryBudget& m_budget;

    mutable std::mutex m_mutex;
    EntryList m_entries;
    std::unordered_map<Key, typename EntryList::iterator, Hash> m_index;
    std::size_t m_bytes = 0;
    std::uint64_t m_hits = 0;
    std::uint64_t m_misses = 0;
    std::uint64_t m_evictions = 0;
};

} // namespace pf::engine
