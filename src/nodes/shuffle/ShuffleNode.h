#pragma once

// Shuffle (docs/specs/node-graph.md §6): copies one layer (render pass) of the input into a layer of the output — by
// default the main RGBA layer — choosing where each of red, green, blue and alpha comes from. Every other channel
// passes through. No pixels are copied: output tiles share the input's.

#include "core/graph/NodeDef.h"
#include "core/image/ChannelSet.h"

#include <array>
#include <memory>
#include <string>
#include <string_view>

namespace pf::nodes {

inline constexpr std::string_view shuffleTypeId = "Shuffle";

// Where one output channel comes from.
struct ShuffleSource {
    enum class Kind : std::uint8_t {
        Keep,    // left as it is in the input (or absent)
        Zero,    // constant 0
        One,     // constant 1
        Channel, // the input channel `channel` (0 when the input does not have it)
    };
    Kind kind = Kind::Keep;
    std::string channel;

    friend bool operator==(const ShuffleSource&, const ShuffleSource&) = default;
};

// The routing for the output's red, green, blue and alpha: `outputs` holds the four output channel names, `sources`
// where each comes from. `choices` are the red/green/blue/alpha parameters: "" (automatic), "0", "1", or a channel
// suffix of `inLayer`. `inputChannels` are the channels the input has.
struct ShuffleRouting {
    std::array<std::string, 4> outputs;
    std::array<ShuffleSource, 4> sources;
};
[[nodiscard]] ShuffleRouting shuffleRouting(const image::ChannelSet& inputChannels, const std::string& inLayer,
                                            const std::string& outLayer, const std::array<std::string, 4>& choices);

[[nodiscard]] std::shared_ptr<const graph::NodeDef> makeShuffleNodeDef();

} // namespace pf::nodes
