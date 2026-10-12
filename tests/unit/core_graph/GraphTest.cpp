// Node types, nodes and the graph (core/graph/NodeDef.h, Node.h, Graph.h): registration, names, connections, loops,
// parameter values and animation, and copies that share nodes.

#include "core/graph/Graph.h"

#include "core/graph/NodeDef.h"
#include "core/graph/NodeOp.h"

#include <gtest/gtest.h>

#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace pf::graph {
namespace {

class NothingOp final : public NodeOp {
public:
    [[nodiscard]] OutputInfo info(const NodeContext& /*node*/, int /*proxyScale*/,
                                  std::span<const OutputInfo> /*inputs*/) const override {
        return {};
    }
    void render(const RenderContext& /*context*/) const override {}
};

std::shared_ptr<const NodeDef> makeType(std::string typeId, std::string label, std::size_t inputs = 1,
                                        bool hasOutput = true) {
    NodeDef def{.typeId = std::move(typeId),
                .label = std::move(label),
                .category = "Test",
                .hasOutput = hasOutput,
                .params = {floatParam("gain", "Gain", 1.0, 0.0, 10.0, 0.0, 4.0),
                           colorParam("tint", "Tint", {1.0, 1.0, 1.0, 1.0}), intParam("steps", "Steps", 4, 1, 64),
                           boolParam("invert", "Invert", false),
                           enumParam("mode", "Mode", {{.id = "a", .label = "A"}, {.id = "b", .label = "B"}}),
                           stringParam("layer", "Layer")},
                .op = std::make_shared<const NothingOp>()};
    for (std::size_t i = 0; i < inputs; ++i) {
        def.inputs.push_back({.id = "in" + std::to_string(i), .label = std::to_string(i)});
    }
    return std::make_shared<const NodeDef>(std::move(def));
}

TEST(NodeRegistry, RegistersValidTypesOnce) {
    NodeRegistry registry;
    registry.add(makeType("Grade", "Grade"));
    registry.add(makeType("Blur", "Blur"));
    EXPECT_EQ(registry.find("Grade")->label, "Grade");
    EXPECT_EQ(registry.find("Missing"), nullptr);
    ASSERT_EQ(registry.types().size(), 2U);
    EXPECT_EQ(registry.types()[0]->typeId, "Blur");
    EXPECT_THROW(registry.add(makeType("Grade", "Grade again")), std::invalid_argument);
    EXPECT_THROW(registry.add(makeType("Not valid", "Bad")), std::invalid_argument);
    EXPECT_THROW(registry.add(nullptr), std::invalid_argument);

    NodeDef noOp = *makeType("NoOp", "No op");
    noOp.op.reset();
    EXPECT_THROW(registry.add(std::make_shared<const NodeDef>(noOp)), std::invalid_argument);
    NodeDef repeatedInput = *makeType("Twice", "Twice", 2);
    repeatedInput.inputs[1].id = repeatedInput.inputs[0].id;
    EXPECT_THROW(registry.add(std::make_shared<const NodeDef>(repeatedInput)), std::invalid_argument);
}

TEST(Graph, NewNodesGetUniqueNamesAndDefaults) {
    Graph graph;
    const auto type = makeType("Grade", "Light Grade");
    const NodeId a = graph.addNode(type);
    const NodeId b = graph.addNode(type);
    EXPECT_EQ(graph.node(a).name(), "LightGrade1");
    EXPECT_EQ(graph.node(b).name(), "LightGrade2");
    EXPECT_NE(a, b);
    EXPECT_EQ(graph.findNode("LightGrade2"), b);
    EXPECT_EQ(graph.node(a).valueAt(graph.node(a).paramIndex("gain"), 0.0), ParamValue{1.0});
    EXPECT_EQ(graph.nodeIds(), (std::vector<NodeId>{a, b}));

    EXPECT_THROW((void)graph.addNode(type, "LightGrade1"), GraphError);
    EXPECT_THROW((void)graph.addNode(type, "has space"), GraphError);
    graph.renameNode(a, "Key");
    EXPECT_EQ(graph.node(a).name(), "Key");
    EXPECT_THROW(graph.renameNode(b, "Key"), GraphError);
    graph.renameNode(a, "Key"); // its own name is fine

    // Ids are never reused.
    graph.removeNode(b);
    EXPECT_GT(graph.addNode(type).value, b.value);
}

TEST(Graph, ConnectionsReplaceAndDisconnect) {
    Graph graph;
    const auto type = makeType("Merge", "Merge", 2);
    const NodeId a = graph.addNode(type);
    const NodeId b = graph.addNode(type);
    const NodeId c = graph.addNode(type);
    graph.connect(a, c, 0);
    graph.connect(b, c, 1);
    EXPECT_EQ(graph.node(c).input(0), a);
    EXPECT_EQ(graph.node(c).input(1), b);
    graph.connect(b, c, 0); // replaces a
    EXPECT_EQ(graph.node(c).input(0), b);
    EXPECT_EQ(graph.outputsOf(b), (std::vector<Connection>{{.source = b, .target = c, .input = 0},
                                                           {.source = b, .target = c, .input = 1}}));
    graph.disconnect(c, 1);
    EXPECT_FALSE(graph.node(c).input(1).has_value());
    EXPECT_THROW(graph.connect(a, c, 2), std::out_of_range);
    EXPECT_THROW(graph.connect(a, NodeId{999}, 0), std::out_of_range);

    // Removing a node removes the connections from it.
    graph.removeNode(b);
    EXPECT_FALSE(graph.node(c).input(0).has_value());
}

TEST(Graph, LoopsAreRefused) {
    Graph graph;
    const auto type = makeType("Grade", "Grade");
    const NodeId a = graph.addNode(type);
    const NodeId b = graph.addNode(type);
    const NodeId c = graph.addNode(type);
    graph.connect(a, b, 0);
    graph.connect(b, c, 0);
    EXPECT_TRUE(graph.wouldCreateLoop(c, a));
    EXPECT_TRUE(graph.wouldCreateLoop(a, a));
    EXPECT_FALSE(graph.wouldCreateLoop(a, c));
    EXPECT_THROW(graph.connect(c, a, 0), GraphError);
    EXPECT_THROW(graph.connect(a, a, 0), GraphError);
    EXPECT_FALSE(graph.node(a).input(0).has_value());
}

TEST(Graph, NodesWithoutOutputCannotFeedOthers) {
    Graph graph;
    const NodeId viewer = graph.addNode(makeType("View", "View", 1, false));
    const NodeId grade = graph.addNode(makeType("Grade", "Grade"));
    EXPECT_THROW(graph.connect(viewer, grade, 0), GraphError);
    graph.connect(grade, viewer, 0);
}

TEST(Graph, StaticValuesAreNormalized) {
    Graph graph;
    const NodeId n = graph.addNode(makeType("Grade", "Grade"));
    graph.setValue(n, "gain", 99.0);
    EXPECT_EQ(graph.node(n).valueAt(graph.node(n).paramIndex("gain"), 0.0), ParamValue{10.0});
    graph.setValue(n, "layer", std::string("diffuse"));
    EXPECT_EQ(graph.node(n).valuesAt(0.0).getString("layer"), "diffuse");
    EXPECT_THROW(graph.setValue(n, "gain", std::string("x")), std::invalid_argument);
    EXPECT_THROW(graph.setValue(n, "missing", 1.0), std::out_of_range);
}

TEST(Graph, ComponentsAnimateOnTheirOwn) {
    Graph graph;
    const NodeId n = graph.addNode(makeType("Grade", "Grade"));
    const std::size_t tint = graph.node(n).paramIndex("tint");
    graph.setValue(n, "tint", Rgba{0.5, 0.5, 0.5, 1.0});
    graph.setKey(n, "tint", 0, {.frame = 0.0, .value = 0.0});
    graph.setKey(n, "tint", 0, {.frame = 10.0, .value = 1.0});
    EXPECT_TRUE(graph.node(n).paramState(tint).isAnimated());
    EXPECT_EQ(graph.node(n).valueAt(tint, 5.0), (ParamValue{Rgba{0.5, 0.5, 0.5, 1.0}}));
    EXPECT_EQ(graph.node(n).valueAt(tint, 2.5), (ParamValue{Rgba{0.25, 0.5, 0.5, 1.0}}));

    // A panel edit on an animated parameter keys every component at that frame.
    graph.setValueAt(n, "tint", 20.0, Rgba{2.0, 0.0, 0.0, 1.0});
    EXPECT_EQ(graph.node(n).valueAt(tint, 20.0), (ParamValue{Rgba{2.0, 0.0, 0.0, 1.0}}));
    EXPECT_EQ(graph.node(n).valueAt(tint, 15.0), (ParamValue{Rgba{1.5, 0.0, 0.0, 1.0}}));

    // Ending the animation keeps the value of the frame it ended at.
    graph.removeAnimation(n, "tint", 15.0);
    EXPECT_FALSE(graph.node(n).paramState(tint).isAnimated());
    EXPECT_EQ(graph.node(n).valueAt(tint, 0.0), (ParamValue{Rgba{1.5, 0.0, 0.0, 1.0}}));
}

TEST(Graph, NotAnimatedValuesAreStatic) {
    Graph graph;
    const NodeId n = graph.addNode(makeType("Grade", "Grade"));
    graph.setValueAt(n, "gain", 12.0, 2.0);
    const std::size_t gain = graph.node(n).paramIndex("gain");
    EXPECT_FALSE(graph.node(n).paramState(gain).isAnimated());
    EXPECT_EQ(graph.node(n).valueAt(gain, -100.0), ParamValue{2.0});
}

TEST(Graph, IntBoolAndEnumAnimation) {
    Graph graph;
    const NodeId n = graph.addNode(makeType("Grade", "Grade"));
    graph.setKey(n, "steps", 0, {.frame = 0.0, .value = 1.0});
    graph.setKey(n, "steps", 0, {.frame = 10.0, .value = 11.0});
    const Node* node = &graph.node(n); // edits replace the node: look it up again after each
    EXPECT_EQ(node->valueAt(node->paramIndex("steps"), 4.4), ParamValue{std::int64_t{5}}); // 5.4 → 5
    EXPECT_EQ(node->valueAt(node->paramIndex("steps"), 4.6), ParamValue{std::int64_t{6}});

    // Bool and enum keys switch at the key, whatever type was asked for.
    graph.setKey(n, "invert", 0, {.frame = 0.0, .value = 0.0, .interpolation = anim::Interpolation::Linear});
    graph.setKey(n, "invert", 0, {.frame = 10.0, .value = 1.0, .interpolation = anim::Interpolation::Linear});
    node = &graph.node(n);
    EXPECT_EQ(node->valueAt(node->paramIndex("invert"), 9.9), ParamValue{false});
    EXPECT_EQ(node->valueAt(node->paramIndex("invert"), 10.0), ParamValue{true});
    EXPECT_EQ(node->paramState(node->paramIndex("invert")).curves[0].keys()[0].interpolation,
              anim::Interpolation::Constant);

    // Key values beyond the limits are clamped; text cannot be animated.
    graph.setKey(n, "gain", 0, {.frame = 0.0, .value = 50.0});
    node = &graph.node(n);
    EXPECT_EQ(node->valueAt(node->paramIndex("gain"), 0.0), ParamValue{10.0});
    EXPECT_THROW(graph.setKey(n, "layer", 0, {.frame = 0.0, .value = 1.0}), std::invalid_argument);
    EXPECT_THROW(graph.setKey(n, "tint", 4, {.frame = 0.0, .value = 1.0}), std::out_of_range);
}

TEST(Graph, RemovingTheLastKeyEndsTheAnimation) {
    Graph graph;
    const NodeId n = graph.addNode(makeType("Grade", "Grade"));
    graph.setKey(n, "gain", 0, {.frame = 3.0, .value = 2.0});
    EXPECT_FALSE(graph.removeKey(n, "gain", 0, 4.0));
    EXPECT_TRUE(graph.removeKey(n, "gain", 0, 3.0));
    const Node& node = graph.node(n);
    EXPECT_FALSE(node.paramState(node.paramIndex("gain")).isAnimated());
    EXPECT_THROW(graph.setExtrapolation(n, "gain", anim::Extrapolation::Linear, anim::Extrapolation::Linear),
                 std::invalid_argument);
}

TEST(Graph, ExtrapolationAppliesToEveryComponent) {
    Graph graph;
    const NodeId n = graph.addNode(makeType("Grade", "Grade"));
    graph.setKey(n, "gain", 0, {.frame = 0.0, .value = 1.0});
    graph.setKey(n, "gain", 0, {.frame = 1.0, .value = 2.0});
    graph.setExtrapolation(n, "gain", anim::Extrapolation::Constant, anim::Extrapolation::Linear);
    const Node& node = graph.node(n);
    EXPECT_EQ(node.valueAt(node.paramIndex("gain"), 3.0), ParamValue{4.0});
    EXPECT_EQ(node.valueAt(node.paramIndex("gain"), -3.0), ParamValue{1.0});
}

TEST(Graph, CopiesShareNodesUntilEdited) {
    Graph graph;
    const auto type = makeType("Grade", "Grade");
    const NodeId a = graph.addNode(type);
    const NodeId b = graph.addNode(type);
    const Graph copy = graph;
    EXPECT_EQ(copy.nodePointer(a), graph.nodePointer(a));

    graph.setValue(a, "gain", 3.0);
    graph.setBypassed(b, true);
    EXPECT_NE(copy.nodePointer(a), graph.nodePointer(a));
    EXPECT_EQ(copy.node(a).valueAt(copy.node(a).paramIndex("gain"), 0.0), ParamValue{1.0});
    EXPECT_FALSE(copy.node(b).isBypassed());
    EXPECT_TRUE(graph.node(b).isBypassed());

    // A node held by earlier work stays as it was.
    const std::shared_ptr<const Node> held = graph.nodePointer(a);
    graph.removeNode(a);
    EXPECT_EQ(held->valueAt(held->paramIndex("gain"), 0.0), ParamValue{3.0});
    EXPECT_FALSE(graph.contains(a));
    EXPECT_TRUE(copy.contains(a));
}

TEST(Hasher, IsTheSameOnEveryPlatform) {
    // Fixed values: a change here changes every cache key (and, later, disk cache file names).
    EXPECT_EQ(Hasher{}.finish(), 0xE9E0033E3BADAF36ULL);
    EXPECT_EQ(Hasher{}.addUnsigned(1).finish(), 0x6E82623341842792ULL);
    EXPECT_EQ(Hasher{}.addText("ViewLayer.Combined.R").addNumber(0.18).addInteger(-7).addBool(true).finish(),
              0xAF57A8297A7E985AULL);
}

TEST(Hasher, OrderAndContentMatter) {
    EXPECT_NE(Hasher{}.addUnsigned(1).addUnsigned(2).finish(), Hasher{}.addUnsigned(2).addUnsigned(1).finish());
    EXPECT_NE(Hasher{}.addText("ab").addText("c").finish(), Hasher{}.addText("a").addText("bc").finish());
    EXPECT_NE(Hasher{}.addText("").finish(), Hasher{}.finish());
    EXPECT_EQ(Hasher{}.addNumber(0.0).finish(), Hasher{}.addNumber(-0.0).finish());
    EXPECT_EQ(Hasher{}.addNumber(std::numeric_limits<double>::quiet_NaN()).finish(),
              Hasher{}.addNumber(-std::numeric_limits<double>::quiet_NaN()).finish());
    EXPECT_NE(Hasher{}.addText("12345678").finish(), Hasher{}.addText("123456789").finish());
}

} // namespace
} // namespace pf::graph
