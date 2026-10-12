#include "nodes/shuffle/ShuffleNode.h"

#include "core/graph/NodeOp.h"

#include <optional>
#include <utility>

namespace pf::nodes {
namespace {

using graph::NodeContext;
using graph::OutputInfo;
using image::ChannelSet;
using image::Image;
using image::TileCoord;

constexpr std::array<std::string_view, 4> rgbaSuffixes{"R", "G", "B", "A"};
constexpr std::array<std::string_view, 4> choiceIds{"red", "green", "blue", "alpha"};

// "diffuse.R" for ("diffuse", "R"); "R" for ("", "R").
std::string qualified(const std::string& layer, std::string_view suffix) {
    return layer.empty() ? std::string(suffix) : layer + "." + std::string(suffix);
}

// An explicit choice: "0", "1" or a channel suffix of the input layer.
ShuffleSource chosenSource(const std::string& choice, const std::string& inLayer) {
    if (choice == "0") {
        return {.kind = ShuffleSource::Kind::Zero, .channel = {}};
    }
    if (choice == "1") {
        return {.kind = ShuffleSource::Kind::One, .channel = {}};
    }
    return {.kind = ShuffleSource::Kind::Channel, .channel = qualified(inLayer, choice)};
}

// The automatic source of output channel k (0–3 = R, G, B, A) from the input layer's channels.
ShuffleSource automaticSource(std::size_t k, const ChannelSet& layer, const ChannelSet& colour,
                              const std::string& alpha) {
    if (k == 3) { // the layer's own alpha, else left alone
        return layer.contains(alpha) ? ShuffleSource{.kind = ShuffleSource::Kind::Channel, .channel = alpha}
                                     : ShuffleSource{};
    }
    if (colour.empty()) {
        return {};
    }
    if (colour.size() == 1) { // a single pass (depth, a matte) shows as grey
        return {.kind = ShuffleSource::Kind::Channel, .channel = colour[0]};
    }
    return k < colour.size() ? ShuffleSource{.kind = ShuffleSource::Kind::Channel, .channel = colour[k]}
                             : ShuffleSource{.kind = ShuffleSource::Kind::Zero, .channel = {}};
}

ShuffleRouting routingOf(const graph::ParamValues& params, const ChannelSet& inputChannels) {
    std::array<std::string, 4> choices;
    for (std::size_t k = 0; k < choices.size(); ++k) {
        choices[k] = params.getString(choiceIds[k]);
    }
    return shuffleRouting(inputChannels, params.getString("inLayer"), params.getString("outLayer"), choices);
}

// The routed source of output channel `channel`, if the routing changes it.
const ShuffleSource* routedSource(const ShuffleRouting& routing, std::string_view channel) {
    for (std::size_t k = 0; k < routing.outputs.size(); ++k) {
        if (routing.outputs[k] == channel && routing.sources[k].kind != ShuffleSource::Kind::Keep) {
            return &routing.sources[k];
        }
    }
    return nullptr;
}

class ShuffleOp final : public graph::NodeOp {
public:
    [[nodiscard]] OutputInfo info(const NodeContext& node, int /*proxyScale*/,
                                  std::span<const OutputInfo> inputs) const override {
        if (!node.isConnected(0)) {
            return {};
        }
        OutputInfo info = inputs[0];
        const ShuffleRouting routing = routingOf(node.params(), inputs[0].channels);
        for (std::size_t k = 0; k < routing.outputs.size(); ++k) {
            if (routing.sources[k].kind != ShuffleSource::Kind::Keep) {
                info.channels.insert(routing.outputs[k]);
            }
        }
        return info;
    }

    [[nodiscard]] graph::InputRequest inputRequest(const graph::RegionContext& context,
                                                   std::size_t /*index*/) const override {
        const ChannelSet& available = context.inputInfo(0).channels;
        const ShuffleRouting routing = routingOf(context.params(), available);
        graph::InputRequest request{.frame = context.frame(), .region = context.region(), .channels = {}};
        for (const std::string& channel : context.channels()) {
            const ShuffleSource* source = routedSource(routing, channel);
            const std::string& needed = source == nullptr ? channel : source->channel;
            if (source != nullptr && source->kind != ShuffleSource::Kind::Channel) {
                continue;
            }
            if (available.contains(needed)) {
                request.channels.insert(needed);
            }
        }
        return request;
    }

    void render(const graph::RenderContext& context) const override {
        const ShuffleRouting routing = routingOf(context.params(), context.inputInfo(0).channels);
        const Image& input = context.input(0);
        Image& output = context.output();
        context.forEachTile([&](TileCoord tile) {
            for (const std::string& channel : context.channels()) {
                const std::size_t to = output.channelIndex(channel);
                const ShuffleSource* source = routedSource(routing, channel);
                const bool constant = source != nullptr && source->kind != ShuffleSource::Kind::Channel;
                const std::optional<std::size_t> from =
                    constant ? std::nullopt : input.channels().indexOf(source == nullptr ? channel : source->channel);
                if (from) {
                    output.copyTile(to, tile, input, *from);
                } else {
                    // A constant, or a named channel the input does not have (which reads as 0).
                    const bool one = source != nullptr && source->kind == ShuffleSource::Kind::One;
                    output.setTileConstant(to, tile, one ? 1.0F : 0.0F);
                }
            }
        });
    }
};

} // namespace

ShuffleRouting shuffleRouting(const ChannelSet& inputChannels, const std::string& inLayer, const std::string& outLayer,
                              const std::array<std::string, 4>& choices) {
    const ChannelSet layer = inputChannels.inLayer(inLayer);
    const std::string alpha = qualified(inLayer, "A");
    ChannelSet colour = layer;
    colour.erase(alpha);

    ShuffleRouting routing;
    for (std::size_t k = 0; k < routing.outputs.size(); ++k) {
        routing.outputs[k] = qualified(outLayer, rgbaSuffixes[k]);
        const std::string& choice = choices[k];
        routing.sources[k] = choice.empty() ? automaticSource(k, layer, colour, alpha) : chosenSource(choice, inLayer);
    }
    return routing;
}

std::shared_ptr<const graph::NodeDef> makeShuffleNodeDef() {
    return std::make_shared<const graph::NodeDef>(graph::NodeDef{
        .typeId = std::string(shuffleTypeId),
        .version = 1,
        .label = "Shuffle",
        .category = "Channel",
        .inputs = {{.id = "source", .label = "Source"}},
        .hasOutput = true,
        .params = {graph::stringParam("inLayer", "In Layer"), graph::stringParam("outLayer", "Out Layer"),
                   graph::stringParam("red", "Red"), graph::stringParam("green", "Green"),
                   graph::stringParam("blue", "Blue"), graph::stringParam("alpha", "Alpha")},
        .op = std::make_shared<const ShuffleOp>(),
    });
}

} // namespace pf::nodes
