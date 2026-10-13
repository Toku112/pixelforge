#include "core/image/ChannelSet.h"

#include <algorithm>
#include <array>
#include <iterator>
#include <stdexcept>

namespace pf::image {
namespace {

// Suffixes with a fixed place inside a layer; every other suffix follows them in byte order. Lower-case r, g, b, a
// (Cycles' Cryptomatte layers) follow R, G, B, A.
constexpr std::array<std::string_view, 14> rankedSuffixes{"R", "G", "B", "A", "r", "g", "b",
                                                          "a", "X", "Y", "Z", "W", "U", "V"};

std::size_t suffixRank(std::string_view suffix) {
    for (std::size_t rank = 0; rank < rankedSuffixes.size(); ++rank) {
        if (rankedSuffixes[rank] == suffix) {
            return rank;
        }
    }
    return rankedSuffixes.size();
}

bool channelLess(std::string_view a, std::string_view b) {
    return compareChannels(a, b) == std::strong_ordering::less;
}

void requireName(std::string_view name) {
    if (name.empty()) {
        throw std::invalid_argument("channel names must not be empty");
    }
}

} // namespace

std::string_view layerOf(std::string_view channel) {
    const std::size_t dot = channel.rfind('.');
    return dot == std::string_view::npos ? std::string_view{} : channel.substr(0, dot);
}

std::string_view suffixOf(std::string_view channel) {
    const std::size_t dot = channel.rfind('.');
    return dot == std::string_view::npos ? channel : channel.substr(dot + 1);
}

std::strong_ordering compareChannels(std::string_view a, std::string_view b) {
    if (const auto byLayer = layerOf(a) <=> layerOf(b); byLayer != std::strong_ordering::equal) {
        return byLayer;
    }
    const std::string_view suffixA = suffixOf(a);
    const std::string_view suffixB = suffixOf(b);
    if (const auto byRank = suffixRank(suffixA) <=> suffixRank(suffixB); byRank != std::strong_ordering::equal) {
        return byRank;
    }
    return suffixA <=> suffixB;
}

ChannelSet::ChannelSet(std::initializer_list<std::string_view> names) {
    for (const std::string_view name : names) {
        insert(name);
    }
}

ChannelSet::ChannelSet(const std::vector<std::string>& names) {
    for (const std::string& name : names) {
        insert(name);
    }
}

bool ChannelSet::contains(std::string_view name) const {
    return indexOf(name).has_value();
}

std::optional<std::size_t> ChannelSet::indexOf(std::string_view name) const {
    const auto found = std::ranges::lower_bound(m_names, name, channelLess);
    if (found == m_names.end() || *found != name) {
        return std::nullopt;
    }
    return static_cast<std::size_t>(std::distance(m_names.begin(), found));
}

bool ChannelSet::insert(std::string_view name) {
    requireName(name);
    const auto at = std::ranges::lower_bound(m_names, name, channelLess);
    if (at != m_names.end() && *at == name) {
        return false;
    }
    m_names.emplace(at, name);
    return true;
}

bool ChannelSet::erase(std::string_view name) {
    const std::optional<std::size_t> index = indexOf(name);
    if (!index) {
        return false;
    }
    m_names.erase(m_names.begin() + static_cast<std::ptrdiff_t>(*index));
    return true;
}

std::vector<std::string> ChannelSet::layers() const {
    std::vector<std::string> result;
    for (const std::string& name : m_names) {
        const std::string_view layer = layerOf(name);
        // Channels are sorted by layer first, so equal layers are neighbours.
        if (result.empty() || result.back() != layer) {
            result.emplace_back(layer);
        }
    }
    return result;
}

ChannelSet ChannelSet::inLayer(std::string_view layer) const {
    ChannelSet result;
    for (const std::string& name : m_names) {
        if (layerOf(name) == layer) {
            result.m_names.push_back(name); // already in canonical order
        }
    }
    return result;
}

ChannelSet unite(const ChannelSet& a, const ChannelSet& b) {
    ChannelSet result = a;
    for (const std::string& name : b) {
        result.insert(name);
    }
    return result;
}

ChannelSet intersect(const ChannelSet& a, const ChannelSet& b) {
    ChannelSet result;
    for (const std::string& name : a) {
        if (b.contains(name)) {
            result.insert(name);
        }
    }
    return result;
}

ChannelSet subtract(const ChannelSet& a, const ChannelSet& b) {
    ChannelSet result;
    for (const std::string& name : a) {
        if (!b.contains(name)) {
            result.insert(name);
        }
    }
    return result;
}

} // namespace pf::image
