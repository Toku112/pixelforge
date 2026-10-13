#pragma once

// How EXR channel names become the engine's channel names (docs/specs/exr-reading.md §3, FORMAT_NOTES §22.2):
// multi-part files, views and name clashes. Pure functions, internal to io/exr.

#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace pf::io::exr {

// The view a channel of a single-part multi-view file belongs to, by OpenEXR's rule: a name without a dot belongs to
// the default view (views[0]); otherwise the next-to-last part of the name is its view if it is one of `views`, and
// the channel belongs to no view ("") if it is not. "" when `views` is empty.
[[nodiscard]] std::string viewOfChannel(std::string_view channel, std::span<const std::string> views);

// The name without the view part: "diffuse.left.R" → "diffuse.R", "left.Z" → "Z"; unchanged when the next-to-last
// part is not `view` (and for names without a dot).
[[nodiscard]] std::string withoutView(std::string_view channel, std::string_view view);

// The name with the view just before the channel: "R" → "right.R", "diffuse.R" → "diffuse.right.R".
[[nodiscard]] std::string withView(std::string_view channel, std::string_view view);

// One channel as stored in one part of a file.
struct StoredChannel {
    std::size_t part = 0;
    std::string partName;   // the part's name ("" if it has none)
    std::string partView;   // the part's "view" attribute (multi-part files; "" if it has none)
    std::string storedName; // the channel's name in the part
};

// What a stored channel is called in the engine, or why it is left out.
struct ChannelNaming {
    std::string name; // empty: left out (see `note`)
    std::string view; // "" for the default view and for channels of no view
    std::string note; // plain-language note when the channel was renamed or left out
};

// Names every channel of a file. `views` are the file's views (default first; empty if none); `multiPart` tells which
// of OpenEXR's two ways of storing views the file uses. Result i belongs to channels[i]. Earlier channels win clashes.
[[nodiscard]] std::vector<ChannelNaming> nameChannels(std::span<const StoredChannel> channels,
                                                      std::span<const std::string> views, bool multiPart);

} // namespace pf::io::exr
