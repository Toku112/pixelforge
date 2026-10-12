#pragma once

// Named channels (FORMAT_NOTES §19.2). Images carry any number of channels named as in OpenEXR: "R", "A", "Z",
// "diffuse_direct.R", "ViewLayer.Combined.R", "CryptoObject00.G". Everything before the last dot is the channel's
// layer ("diffuse_direct"), the rest its suffix ("R"); a name without a dot belongs to the unnamed main layer.

#include <compare>
#include <cstddef>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace pf::image {

// "diffuse_direct" for "diffuse_direct.R", "ViewLayer.Combined" for "ViewLayer.Combined.R", "" for "R".
[[nodiscard]] std::string_view layerOf(std::string_view channel);

// "R" for "diffuse_direct.R" and for "R".
[[nodiscard]] std::string_view suffixOf(std::string_view channel);

// The canonical channel order: by layer name (the main layer first), then within a layer R, G, B, A, then X, Y, Z,
// W, then U, V, then every other suffix in byte order. Gives RGBA-like groups their natural order in lists and makes
// channel sets (and everything hashed from them) independent of the order channels arrived in.
[[nodiscard]] std::strong_ordering compareChannels(std::string_view a, std::string_view b);

// An ordered set of channel names, kept in the canonical order. Names are case-sensitive and must not be empty.
class ChannelSet {
public:
    using const_iterator = std::vector<std::string>::const_iterator;

    ChannelSet() = default;
    // Throws std::invalid_argument for an empty name; duplicates are kept once.
    ChannelSet(std::initializer_list<std::string_view> names);
    explicit ChannelSet(const std::vector<std::string>& names);

    [[nodiscard]] std::size_t size() const { return m_names.size(); }
    [[nodiscard]] bool empty() const { return m_names.empty(); }
    [[nodiscard]] const_iterator begin() const { return m_names.begin(); }
    [[nodiscard]] const_iterator end() const { return m_names.end(); }
    [[nodiscard]] const std::string& operator[](std::size_t index) const { return m_names[index]; }
    [[nodiscard]] const std::vector<std::string>& names() const { return m_names; }

    [[nodiscard]] bool contains(std::string_view name) const;

    // Position of `name` in the canonical order, if present.
    [[nodiscard]] std::optional<std::size_t> indexOf(std::string_view name) const;

    // Adds `name`; returns false when it was present. Throws std::invalid_argument for an empty name.
    bool insert(std::string_view name);

    // Removes `name`; returns false when it was absent.
    bool erase(std::string_view name);

    // The distinct layer names, in canonical order ("" for the main layer).
    [[nodiscard]] std::vector<std::string> layers() const;

    // The channels of one layer ("" = the main layer).
    [[nodiscard]] ChannelSet inLayer(std::string_view layer) const;

    friend bool operator==(const ChannelSet&, const ChannelSet&) = default;

private:
    std::vector<std::string> m_names; // sorted by compareChannels, no duplicates
};

[[nodiscard]] ChannelSet unite(const ChannelSet& a, const ChannelSet& b);
[[nodiscard]] ChannelSet intersect(const ChannelSet& a, const ChannelSet& b);
[[nodiscard]] ChannelSet subtract(const ChannelSet& a, const ChannelSet& b); // channels of a that are not in b

} // namespace pf::image
