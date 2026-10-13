#pragma once

// The frames of each frame pattern, listed once and listed again when the folder changes (docs/specs/sequences.md
// §5): asking costs one look at the folder's modification time, not a listing. Shared by every Read node; any
// thread, never the UI thread.

#include "io/sequence/FramePattern.h"
#include "io/sequence/Sequence.h"

#include <cstddef>
#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <string>

namespace pf::io {

class SequenceIndex {
public:
    // Keeps the listings of up to `capacity` patterns (the least recently asked go first).
    explicit SequenceIndex(std::size_t capacity = 64) : m_capacity(capacity) {}

    // The files of `pattern` (without stamps): the last listing while the folder's modification time is the same,
    // else a new one; `relist` forces a new one. Throws FileError when the folder cannot be listed.
    [[nodiscard]] std::shared_ptr<const Sequence> get(const FramePattern& pattern, bool relist = false) const;
    // Forgets every listing (Reload).
    void clear();
    // Folder listings made so far (tests and statistics).
    [[nodiscard]] std::uint64_t listings() const;

private:
    struct Entry {
        std::string key; // the pattern's text, padding included
        FileStamp folder;
        std::shared_ptr<const Sequence> sequence;
    };

    std::size_t m_capacity;
    mutable std::mutex m_mutex;
    mutable std::list<Entry> m_entries; // most recently asked first
    mutable std::uint64_t m_listings = 0;
};

} // namespace pf::io
