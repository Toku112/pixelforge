#include "io/exr/ExrNaming.h"

#include <algorithm>
#include <unordered_set>
#include <utility>

namespace pf::io::exr {
namespace {

// Where the next-to-last part of a name starts and ends ([begin, end)), if the name has at least one dot.
struct Span {
    std::size_t begin = 0;
    std::size_t end = 0;
};

bool penultimate(std::string_view channel, Span& span) {
    const std::size_t last = channel.rfind('.');
    if (last == std::string_view::npos) {
        return false;
    }
    const std::size_t before = last == 0 ? std::string_view::npos : channel.rfind('.', last - 1);
    span.begin = before == std::string_view::npos ? 0 : before + 1;
    span.end = last;
    return true;
}

std::string inQuotes(std::string_view text) {
    return "'" + std::string(text) + "'";
}

} // namespace

std::string viewOfChannel(std::string_view channel, std::span<const std::string> views) {
    if (views.empty()) {
        return {};
    }
    Span span;
    if (!penultimate(channel, span)) {
        return views.front();
    }
    const std::string_view candidate = channel.substr(span.begin, span.end - span.begin);
    const bool isView = std::ranges::find(views, candidate) != views.end();
    return isView ? std::string(candidate) : std::string();
}

std::string withoutView(std::string_view channel, std::string_view view) {
    Span span;
    if (!penultimate(channel, span) || channel.substr(span.begin, span.end - span.begin) != view) {
        return std::string(channel);
    }
    if (span.begin == 0) {
        return std::string(channel.substr(span.end + 1)); // "left.Z" → "Z"
    }
    return std::string(channel.substr(0, span.begin - 1)) + std::string(channel.substr(span.end)); // "diffuse" + ".R"
}

std::string withView(std::string_view channel, std::string_view view) {
    const std::size_t last = channel.rfind('.');
    if (last == std::string_view::npos) {
        return std::string(view) + "." + std::string(channel);
    }
    return std::string(channel.substr(0, last)) + "." + std::string(view) + std::string(channel.substr(last));
}

std::vector<ChannelNaming> nameChannels(std::span<const StoredChannel> channels, std::span<const std::string> views,
                                        bool multiPart) {
    std::vector<ChannelNaming> result;
    result.reserve(channels.size());
    std::unordered_set<std::string> taken;
    for (const StoredChannel& channel : channels) {
        ChannelNaming naming;
        if (!multiPart && !views.empty()) {
            const std::string view = viewOfChannel(channel.storedName, views);
            if (view == views.front()) {
                naming.name = withoutView(channel.storedName, view);
            } else {
                naming.name = channel.storedName;
                naming.view = view;
            }
        } else if (multiPart && !views.empty() && !channel.partView.empty() && channel.partView != views.front()) {
            naming.name = withView(channel.storedName, channel.partView);
            naming.view = channel.partView;
        } else {
            naming.name = channel.storedName;
        }

        const std::string where =
            multiPart ? " of part " + inQuotes(channel.partName.empty() ? "#" + std::to_string(channel.part + 1)
                                                                        : channel.partName)
                      : "";
        if (naming.name.empty()) {
            naming.note = "a channel" + where + " has no name and is left out";
        } else if (taken.contains(naming.name)) {
            const std::string clash = naming.name;
            naming.name.clear();
            if (multiPart && !channel.partName.empty() && !taken.contains(channel.partName + "." + clash)) {
                naming.name = channel.partName + "." + clash;
                naming.note = "channel " + inQuotes(channel.storedName) + where + " is shown as " +
                              inQuotes(naming.name) + ": an earlier part has a channel named " + inQuotes(clash);
            } else {
                naming.note = "channel " + inQuotes(channel.storedName) + where +
                              " is left out: another channel is named " + inQuotes(clash);
            }
        }
        if (!naming.name.empty()) {
            taken.insert(naming.name);
        }
        result.push_back(std::move(naming));
    }
    return result;
}

} // namespace pf::io::exr
