#include "io/Metadata.h"

#include <algorithm>

namespace pf::io {

const MetadataEntry* MetadataGroup::find(std::string_view entryName) const {
    const auto found = std::ranges::find(entries, entryName, &MetadataEntry::name);
    return found == entries.end() ? nullptr : &*found;
}

} // namespace pf::io
