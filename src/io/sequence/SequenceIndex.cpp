#include "io/sequence/SequenceIndex.h"

#include "io/FileStamp.h"

#include <utility>

namespace pf::io {

std::shared_ptr<const Sequence> SequenceIndex::get(const FramePattern& pattern, bool relist) const {
    const std::string key = pattern.text();
    // The stamp is taken before listing: a file added during the listing changes the folder's time again, so the
    // next call lists once more instead of keeping a listing that may have missed it.
    const FileStamp folder = folderStamp(pattern.folder().empty() ? std::filesystem::path(".") : pattern.folder());
    if (!relist && folder.exists) {
        const std::scoped_lock lock(m_mutex);
        for (auto entry = m_entries.begin(); entry != m_entries.end(); ++entry) {
            if (entry->key == key && entry->folder == folder) {
                m_entries.splice(m_entries.begin(), m_entries, entry);
                return entry->sequence;
            }
        }
    }
    auto sequence = std::make_shared<const Sequence>(scanSequence(pattern));
    const std::scoped_lock lock(m_mutex);
    ++m_listings;
    std::erase_if(m_entries, [&](const Entry& entry) { return entry.key == key; });
    m_entries.push_front({.key = key, .folder = folder, .sequence = sequence});
    if (m_entries.size() > m_capacity) {
        m_entries.pop_back();
    }
    return sequence;
}

void SequenceIndex::clear() {
    const std::scoped_lock lock(m_mutex);
    m_entries.clear();
}

std::uint64_t SequenceIndex::listings() const {
    const std::scoped_lock lock(m_mutex);
    return m_listings;
}

} // namespace pf::io
