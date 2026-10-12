#include "nodes/viewer/ViewerNode.h"

#include "core/graph/NodeOp.h"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace pf::nodes {
namespace {

class ViewerOp final : public graph::NodeOp {
public:
    // The viewer always shows one of its inputs as it is.
    [[nodiscard]] std::optional<std::size_t> passThroughInput(const graph::NodeContext& node) const override {
        return static_cast<std::size_t>(node.params().getInt("activeInput"));
    }

    // Never called: the evaluator follows passThroughInput().
    [[nodiscard]] graph::OutputInfo info(const graph::NodeContext& /*node*/, int /*proxyScale*/,
                                         std::span<const graph::OutputInfo> /*inputs*/) const override {
        return {};
    }
    void render(const graph::RenderContext& /*context*/) const override {}
};

graph::ParamDef displaySetting(graph::ParamDef def) {
    def.affectsPixels = false;
    return def;
}

} // namespace

std::shared_ptr<const graph::NodeDef> makeViewerNodeDef() {
    std::vector<graph::PortDef> inputs;
    for (std::size_t i = 0; i < viewerInputCount; ++i) {
        const std::string key = std::to_string((i + 1) % 10); // 1, 2, …, 9, 0
        inputs.push_back({.id = "input" + key, .label = key});
    }
    return std::make_shared<const graph::NodeDef>(graph::NodeDef{
        .typeId = std::string(viewerTypeId),
        .version = 1,
        .label = "Viewer",
        .category = "Viewer",
        .inputs = std::move(inputs),
        .hasOutput = false,
        .params = {graph::intParam("activeInput", "Active Input", 0, 0,
                                   static_cast<std::int64_t>(viewerInputCount) - 1),
                   displaySetting(graph::floatParam("exposure", "Exposure", 0.0, -20.0, 20.0, -10.0, 10.0)),
                   displaySetting(graph::floatParam("gamma", "Gamma", 1.0, 0.01, 10.0, 0.2, 5.0)),
                   displaySetting(graph::stringParam("layer", "Layer")),
                   displaySetting(graph::enumParam("channel", "Channel",
                                                   {{.id = "rgb", .label = "RGB"},
                                                    {.id = "red", .label = "Red"},
                                                    {.id = "green", .label = "Green"},
                                                    {.id = "blue", .label = "Blue"},
                                                    {.id = "alpha", .label = "Alpha"},
                                                    {.id = "luminance", .label = "Luminance"}})),
                   displaySetting(graph::stringParam("display", "Display")),
                   displaySetting(graph::stringParam("view", "View"))},
        .op = std::make_shared<const ViewerOp>(),
    });
}

} // namespace pf::nodes
