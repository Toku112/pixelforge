#include "support/graph/TestTypes.h"

#include "core/commands/GraphCommands.h"
#include "core/graph/NodeOp.h"
#include "core/graph/Param.h"

#include <cstddef>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>

namespace pf::testing {
namespace {

class NothingOp final : public graph::NodeOp {
public:
    [[nodiscard]] graph::OutputInfo info(const graph::NodeContext& /*node*/, int /*proxyScale*/,
                                         std::span<const graph::OutputInfo> /*inputs*/) const override {
        return {};
    }
    void render(const graph::RenderContext& /*context*/) const override {}
};

std::shared_ptr<const graph::NodeDef> makeType(std::string typeId, std::string label, std::size_t inputs,
                                               bool hasOutput) {
    using namespace graph;
    NodeDef def{.typeId = std::move(typeId),
                .label = std::move(label),
                .category = "Test",
                .hasOutput = hasOutput,
                .params = {floatParam("gain", "Gain", 1.0, 0.0, 10.0, 0.0, 4.0),
                           colorParam("tint", "Tint", {1.0, 1.0, 1.0, 1.0}), intParam("steps", "Steps", 4, 1, 64),
                           boolParam("invert", "Invert", false),
                           enumParam("mode", "Mode",
                                     {{.id = "a", .label = "A"}, {.id = "b", .label = "B"}, {.id = "c", .label = "C"}}),
                           vector2Param("offset", "Offset", {0.0, 0.0}), stringParam("layer", "Layer"),
                           fileParam("file", "File")},
                .op = std::make_shared<const NothingOp>()};
    for (std::size_t i = 0; i < inputs; ++i) {
        def.inputs.push_back({.id = "in" + std::to_string(i), .label = std::to_string(i)});
    }
    return std::make_shared<const NodeDef>(std::move(def));
}

std::string nameOf(const graph::Graph& graph, std::optional<graph::NodeId> id) {
    return id ? graph.node(*id).name() : std::string("(none)");
}

} // namespace

graph::NodeRegistry testNodeTypes() {
    graph::NodeRegistry registry;
    registry.add(makeType("Source", "Source", 0, true));
    registry.add(makeType("Grade", "Light Grade", 1, true));
    registry.add(makeType("Merge", "Merge", 2, true));
    registry.add(makeType("Sink", "Sink", 1, false));
    return registry;
}

commands::CommandRegistry builtinCommands() {
    commands::CommandRegistry registry;
    commands::registerBuiltinCommands(registry);
    return registry;
}

graph::NodeId nodeId(const graph::Graph& graph, std::string_view name) {
    const std::optional<graph::NodeId> id = graph.findNode(name);
    if (!id) {
        throw std::out_of_range("no node named " + std::string(name));
    }
    return *id;
}

const graph::Node& nodeNamed(const graph::Graph& graph, std::string_view name) {
    return graph.node(nodeId(graph, name));
}

::testing::AssertionResult sameGraph(const graph::Graph& expected, const graph::Graph& actual) {
    if (expected.nodeCount() != actual.nodeCount()) {
        return ::testing::AssertionFailure()
               << expected.nodeCount() << " nodes expected, " << actual.nodeCount() << " found";
    }
    for (const graph::NodeId id : expected.nodeIds()) {
        const graph::Node& a = expected.node(id);
        const std::optional<graph::NodeId> match = actual.findNode(a.name());
        if (!match) {
            return ::testing::AssertionFailure() << "no node named " << a.name();
        }
        const graph::Node& b = actual.node(*match);
        if (a.def().typeId != b.def().typeId) {
            return ::testing::AssertionFailure() << a.name() << ": type " << b.def().typeId;
        }
        for (std::size_t p = 0; p < a.paramCount(); ++p) {
            if (!(a.paramState(p) == b.paramState(p))) {
                return ::testing::AssertionFailure() << a.name() << ": parameter " << a.def().params[p].id << " is "
                                                     << graph::toString(b.paramState(p).value) << ", expected "
                                                     << graph::toString(a.paramState(p).value) << " (or animation)";
            }
        }
        for (std::size_t i = 0; i < a.inputs().size(); ++i) {
            if (nameOf(expected, a.input(i)) != nameOf(actual, b.input(i))) {
                return ::testing::AssertionFailure()
                       << a.name() << ": input " << i << " is " << nameOf(actual, b.input(i)) << ", expected "
                       << nameOf(expected, a.input(i));
            }
        }
        if (a.isBypassed() != b.isBypassed() || !(a.position() == b.position())) {
            return ::testing::AssertionFailure() << a.name() << ": bypass or position differs";
        }
    }
    return ::testing::AssertionSuccess();
}

} // namespace pf::testing
