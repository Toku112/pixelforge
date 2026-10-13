// Command descriptors and the graph commands (core/commands/Command.h, GraphCommands.h, docs/specs/commands-
// history.md §2–3): what each command does, its label, its JSON form, its errors, and replays with renamed nodes.

#include "core/commands/GraphCommands.h"

#include "core/commands/Command.h"
#include "core/graph/Graph.h"
#include "core/graph/ParamJson.h"
#include "support/graph/TestTypes.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace pf::commands {
namespace {

using graph::Graph;
using graph::NodeId;

class GraphCommandsTest : public ::testing::Test {
protected:
    // Performs `descriptor` on `graph`, keeping the result.
    Performed run(Descriptor descriptor, NameMap* names = nullptr) {
        const Context context(m_registry, m_types, names);
        Performed performed = perform(m_graph, std::move(descriptor), context);
        m_graph = performed.graph;
        return performed;
    }

    NodeId id(std::string_view name) const { return testing::nodeId(m_graph, name); }

    // Running `descriptor` fails with `message` and leaves the graph as it was.
    void expectError(Descriptor descriptor, const std::string& message) {
        const Graph before = m_graph;
        try {
            (void)run(std::move(descriptor));
            ADD_FAILURE() << "no error, expected: " << message;
        } catch (const CommandError& error) {
            EXPECT_EQ(std::string(error.what()), message);
        }
        EXPECT_TRUE(testing::sameGraph(before, m_graph));
    }

    graph::NodeRegistry m_types = testing::testNodeTypes();
    CommandRegistry m_registry = testing::builtinCommands();
    Graph m_graph;
};

TEST_F(GraphCommandsTest, RegistryRefusesBadOrRepeatedCommands) {
    EXPECT_NE(m_registry.find("graph.setValue"), nullptr);
    EXPECT_EQ(m_registry.find("graph.nothing"), nullptr);
    EXPECT_EQ(m_registry.names().size(), 13U);
    const auto perform = [](Graph&, json::Object&, const Context&) { return std::string("x"); };
    // True when the registry takes a command type with this name.
    const auto accepts = [&](const char* name, bool withPerform = true) {
        try {
            m_registry.add({.name = name, .perform = withPerform ? perform : CommandType{}.perform, .continues = {}});
            return true;
        } catch (const std::invalid_argument&) {
            return false;
        }
    };
    EXPECT_FALSE(accepts("graph.setValue"));
    for (const char* bad : {"", ".x", "x.", "a..b", "1a", "a.1b", "has space"}) {
        EXPECT_FALSE(accepts(bad)) << bad;
    }
    EXPECT_FALSE(accepts("test.empty", false));
    EXPECT_TRUE(accepts("test.v2Thing"));
}

TEST_F(GraphCommandsTest, AddNodeCompletesItsNameAndPosition) {
    const Performed first = run(addNode("Grade"));
    EXPECT_EQ(first.label, "Add Light Grade");
    EXPECT_EQ(json::write(toJson(first.descriptor)),
              R"({"command":"graph.addNode","params":{"type":"Grade","name":"LightGrade1"}})");

    const Performed second = run(addNode("Grade", "Key", graph::NodePosition{.x = 10.0, .y = -20.0}));
    EXPECT_EQ(json::write(toJson(second.descriptor)),
              R"({"command":"graph.addNode","params":{"type":"Grade","name":"Key","position":[10.0,-20.0]}})");
    EXPECT_EQ(m_graph.node(id("Key")).position(), (graph::NodePosition{.x = 10.0, .y = -20.0}));

    expectError(addNode("Blur"), "there is no node type 'Blur'");
    expectError(addNode("Grade", "Key"), "a node named 'Key' exists already");
    expectError(addNode("Grade", "two words"),
                "node names use letters, digits and _, and start with a letter or _: 'two words'");
}

TEST_F(GraphCommandsTest, ConnectDisconnectRemove) {
    (void)run(addNode("Source"));
    (void)run(addNode("Grade"));
    (void)run(addNode("Sink"));
    EXPECT_EQ(run(connect("Source1", "LightGrade1", 0)).label, "Connect");
    (void)run(connect("LightGrade1", "Sink1", 0));
    EXPECT_EQ(m_graph.node(id("Sink1")).input(0), id("LightGrade1"));

    expectError(connect("LightGrade1", "LightGrade1", 0),
                "connecting 'LightGrade1' into 'LightGrade1' would make a loop");
    expectError(connect("Sink1", "LightGrade1", 0), "'Sink1' has no output to connect");
    expectError(connect("Source1", "LightGrade1", 3), "node 'LightGrade1' has no input 3");
    expectError(connect("Nowhere", "LightGrade1", 0), "there is no node named 'Nowhere'");

    EXPECT_EQ(run(disconnect("Sink1", 0)).label, "Disconnect");
    EXPECT_FALSE(m_graph.node(id("Sink1")).input(0));

    EXPECT_EQ(run(removeNodes({"Source1"})).label, "Delete Node");
    EXPECT_FALSE(m_graph.node(id("LightGrade1")).input(0)); // its connection went with it
    EXPECT_EQ(run(removeNodes({"LightGrade1", "Sink1", "LightGrade1"})).label, "Delete Nodes");
    EXPECT_EQ(m_graph.nodeCount(), 0U);
}

TEST_F(GraphCommandsTest, RenameBypassMove) {
    (void)run(addNode("Grade"));
    EXPECT_EQ(run(renameNode("LightGrade1", "Key")).label, "Rename Node");
    EXPECT_TRUE(m_graph.findNode("Key"));
    (void)run(addNode("Grade"));
    expectError(renameNode("LightGrade1", "Key"), "a node named 'Key' exists already");

    EXPECT_EQ(run(setBypassed("Key", true)).label, "Bypass Node");
    EXPECT_TRUE(m_graph.node(id("Key")).isBypassed());
    EXPECT_EQ(run(setBypassed("Key", false)).label, "Enable Node");

    EXPECT_EQ(run(moveNodes({{"Key", {.x = 1.0, .y = 2.0}}})).label, "Move Node");
    EXPECT_EQ(run(moveNodes({{"Key", {.x = 3.0, .y = 4.0}}, {"LightGrade1", {.x = 5.0, .y = 6.0}}})).label,
              "Move Nodes");
    EXPECT_EQ(m_graph.node(id("LightGrade1")).position(), (graph::NodePosition{.x = 5.0, .y = 6.0}));
}

TEST_F(GraphCommandsTest, SetValueStaticAndAtAFrame) {
    (void)run(addNode("Grade"));
    const graph::Node& node = m_graph.node(id("LightGrade1"));
    const Performed set = run(setValue(node, "gain", 2.5));
    EXPECT_EQ(set.label, "Set Gain");
    EXPECT_EQ(json::write(set.descriptor.params), R"({"node":"LightGrade1","param":"gain","value":2.5})");

    // Values are checked and clamped like any other value; enums are written by item id.
    (void)run(setValue(m_graph.node(id("LightGrade1")), "mode", std::int64_t{2}));
    EXPECT_EQ(json::write(graph::toJson(m_graph.node(id("LightGrade1")).def().param("mode"),
                                        m_graph.node(id("LightGrade1")).paramState(4).value)),
              R"("c")");
    (void)run({.command = "graph.setValue", .params = {{"node", "LightGrade1"}, {"param", "gain"}, {"value", 50}}});
    EXPECT_EQ(m_graph.node(id("LightGrade1")).paramState(0).value, graph::ParamValue{10.0});

    // With a frame on an animated parameter: a key there.
    (void)run(setKey("LightGrade1", "gain", 0, {.frame = 1.0, .value = 1.0}));
    (void)run(setValue(m_graph.node(id("LightGrade1")), "gain", 3.0, 10.0));
    const graph::Node& animated = m_graph.node(id("LightGrade1"));
    EXPECT_EQ(animated.paramState(0).curves[0].size(), 2U);
    EXPECT_EQ(animated.valueAt(0, 10.0), graph::ParamValue{3.0});

    expectError({.command = "graph.setValue", .params = {{"node", "LightGrade1"}, {"param", "gian"}, {"value", 1.0}}},
                "node 'LightGrade1' has no parameter 'gian'");
    expectError(
        {.command = "graph.setValue", .params = {{"node", "LightGrade1"}, {"param", "gain"}, {"value", "loud"}}},
        "parameter 'gain' needs a number");
    expectError({.command = "graph.setValue", .params = {{"node", "LightGrade1"}, {"param", "gain"}}},
                "missing \"value\"");
    expectError({.command = "graph.setValue", .params = {{"node", 5}, {"param", "gain"}, {"value", 1.0}}},
                "a node must be named by text");
}

TEST_F(GraphCommandsTest, Keyframes) {
    (void)run(addNode("Grade"));
    const Performed key = run(setKey("LightGrade1", "tint", 2, {.frame = 5.0, .value = 0.5}));
    EXPECT_EQ(key.label, "Set Keyframe: Tint");
    EXPECT_EQ(json::write(key.descriptor.params), R"({"node":"LightGrade1","param":"tint","component":2,)"
                                                  R"("key":{"frame":5.0,"value":0.5,"interpolation":"linear"}})");
    (void)run(setKey("LightGrade1", "tint", 2, {.frame = 15.0, .value = 1.5}));
    EXPECT_EQ(m_graph.node(id("LightGrade1")).valueAt(1, 10.0), (graph::ParamValue{graph::Rgba{1.0, 1.0, 1.0, 1.0}}));

    EXPECT_EQ(
        run(setExtrapolation("LightGrade1", "tint", anim::Extrapolation::Linear, anim::Extrapolation::Linear)).label,
        "Set Extrapolation: Tint");
    EXPECT_EQ(m_graph.node(id("LightGrade1")).paramState(1).curves[2].after(), anim::Extrapolation::Linear);

    EXPECT_EQ(run(removeKey("LightGrade1", "tint", 2, 15.0)).label, "Delete Keyframe: Tint");
    EXPECT_EQ(m_graph.node(id("LightGrade1")).paramState(1).curves[2].size(), 1U);
    EXPECT_EQ(run(removeAnimation("LightGrade1", "tint", 0.0)).label, "Delete Animation: Tint");
    EXPECT_FALSE(m_graph.node(id("LightGrade1")).paramState(1).isAnimated());

    expectError(setKey("LightGrade1", "layer", 0, {.frame = 1.0, .value = 1.0}),
                "parameter 'layer' of node 'LightGrade1' cannot be animated");
    expectError(setKey("LightGrade1", "gain", 1, {.frame = 1.0, .value = 1.0}), "parameter 'gain' has no component 1");
    expectError(setExtrapolation("LightGrade1", "gain", anim::Extrapolation::Linear, anim::Extrapolation::Linear),
                "parameter 'gain' of node 'LightGrade1' is not animated");
    expectError({.command = "graph.setExtrapolation",
                 .params = {{"node", "LightGrade1"}, {"param", "tint"}, {"before", "cycle"}, {"after", "linear"}}},
                "\"before\" must be constant or linear");
}

TEST_F(GraphCommandsTest, GroupRunsItsStepsAsOne) {
    (void)run(addNode("Source"));
    const Performed grouped = run(group(
        "Add Light Grade", {addNode("Grade"), connect("Source1", "LightGrade1", 0), setBypassed("LightGrade1", true)}));
    EXPECT_EQ(grouped.label, "Add Light Grade");
    EXPECT_EQ(m_graph.node(id("LightGrade1")).input(0), id("Source1"));
    // The steps are completed like single commands (the new node's name).
    const json::Value& firstStep = grouped.descriptor.params.at("steps").asArray()[0];
    EXPECT_EQ(firstStep.asObject().at("params").asObject().at("name"), json::Value("LightGrade1"));

    // A failing step fails the whole group: nothing of it stays.
    expectError(group("Two", {addNode("Merge"), connect("Nowhere", "Merge1", 0)}), "there is no node named 'Nowhere'");
    EXPECT_FALSE(m_graph.findNode("Merge1"));
    expectError({.command = "group", .params = {{"label", "Bad"}, {"steps", json::Array{json::Value(3)}}}},
                R"(a command must be an object with "command" and "params")");
}

TEST_F(GraphCommandsTest, UnknownCommandsAndMalformedParameters) {
    expectError({.command = "graph.explode", .params = {}}, "unknown command 'graph.explode'");
    (void)run(addNode("Grade"));
    expectError({.command = "graph.connect", .params = {{"source", "LightGrade1"}, {"target", "LightGrade1"}}},
                "missing \"input\"");
    expectError({.command = "graph.disconnect", .params = {{"target", "LightGrade1"}, {"input", -1}}},
                "\"input\" must be 0 or more");
    expectError({.command = "graph.disconnect", .params = {{"target", "LightGrade1"}, {"input", 0.5}}},
                "\"input\" must be a whole number");
    expectError({.command = "graph.setBypassed", .params = {{"node", "LightGrade1"}, {"bypassed", "yes"}}},
                "\"bypassed\" must be true or false");
    expectError({.command = "graph.removeNodes", .params = {{"nodes", "LightGrade1"}}}, "\"nodes\" must be a list");
    expectError(
        {.command = "graph.moveNodes",
         .params = {{"nodes", json::Array{json::Object{{"node", "LightGrade1"}, {"position", json::Array{1}}}}}}},
        "\"position\" must be two numbers [x, y]");
    expectError(
        {.command = "graph.addNode",
         .params = {{"type", "Grade"}, {"position", json::Array{1.0, std::numeric_limits<double>::infinity()}}}},
        "\"position\" must be finite");
}

TEST_F(GraphCommandsTest, DescriptorsRoundTripThroughJson) {
    (void)run(addNode("Grade"));
    const std::vector<Descriptor> descriptors = {
        addNode("Merge", "M", graph::NodePosition{.x = 1.5, .y = 2.0}),
        removeNodes({"A", "B"}),
        connect("A", "B", 1),
        disconnect("B", 0),
        renameNode("A", "C"),
        setBypassed("A", false),
        moveNodes({{"A", {.x = 0.0, .y = 0.0}}}),
        setValue(m_graph.node(id("LightGrade1")), "offset", graph::Vec2{0.5, -0.5}, 3.0),
        setKey("A", "gain", 0,
               {.frame = 2.0, .value = 1.0, .interpolation = anim::Interpolation::Bezier, .inSlope = 0.5}),
        removeKey("A", "gain", 0, 2.0),
        removeAnimation("A", "gain", 2.0),
        setExtrapolation("A", "gain", anim::Extrapolation::Constant, anim::Extrapolation::Linear),
        group("Several", {connect("A", "B", 0), disconnect("B", 0)})};
    for (const Descriptor& descriptor : descriptors) {
        EXPECT_EQ(descriptorFromJson(json::parse(json::write(toJson(descriptor), {.indent = 2}))), descriptor)
            << descriptor.command;
    }
}

TEST(Descriptors, MalformedOnesAreRefused) {
    const auto refused = [](const json::Value& value) {
        try {
            (void)descriptorFromJson(value);
            return false;
        } catch (const CommandError&) {
            return true;
        }
    };
    EXPECT_TRUE(refused(json::Array{}));
    EXPECT_TRUE(refused(json::Object{{"params", json::Object{}}}));
    EXPECT_TRUE(refused(json::Object{{"command", "x"}, {"params", 1}}));
    EXPECT_EQ(descriptorFromJson(json::Object{{"command", "x"}}), (Descriptor{.command = "x", .params = {}}));
}

TEST_F(GraphCommandsTest, ReplaysFollowRenamedNodes) {
    // The graph already has the names the replayed steps were recorded with.
    (void)run(addNode("Source"));
    (void)run(addNode("Grade"));
    NameMap names;
    const Performed added = run(addNode("Grade", "LightGrade1"), &names);
    EXPECT_EQ(added.descriptor.params.at("name"), json::Value("LightGrade2"));
    const Performed connected = run(connect("Source1", "LightGrade1", 0), &names);
    EXPECT_EQ(m_graph.node(id("LightGrade2")).input(0), id("Source1"));
    EXPECT_FALSE(m_graph.node(id("LightGrade1")).input(0)); // the graph's own node is untouched
    // The kept descriptor names the node really used.
    EXPECT_EQ(connected.descriptor.params.at("target"), json::Value("LightGrade2"));

    // A rename to a taken name also gets a free one, and later steps follow.
    (void)run(renameNode("LightGrade1", "Source1"), &names);
    EXPECT_TRUE(m_graph.findNode("Source2"));
    (void)run(setBypassed("Source1", true), &names);
    EXPECT_TRUE(m_graph.node(id("Source2")).isBypassed());
    EXPECT_FALSE(m_graph.node(id("Source1")).isBypassed());

    // Outside a replay a taken name is an error.
    expectError(addNode("Grade", "LightGrade1"), "a node named 'LightGrade1' exists already");
}

TEST_F(GraphCommandsTest, ASliderDragContinuesOnTheSameParameterAndFrame) {
    const CommandType* set = m_registry.find("graph.setValue");
    const auto params = [](const char* node, const char* param, std::optional<double> frame) {
        json::Object result{{"node", node}, {"param", param}, {"value", 1.0}};
        if (frame) {
            result.set("frame", *frame);
        }
        return result;
    };
    EXPECT_TRUE(set->continues(params("A", "gain", {}), params("A", "gain", {})));
    EXPECT_TRUE(set->continues(params("A", "gain", 3.0), params("A", "gain", 3.0)));
    EXPECT_FALSE(set->continues(params("A", "gain", 3.0), params("A", "gain", 4.0)));
    EXPECT_FALSE(set->continues(params("A", "gain", 3.0), params("A", "gain", {})));
    EXPECT_FALSE(set->continues(params("A", "gain", {}), params("B", "gain", {})));
    EXPECT_FALSE(set->continues(params("A", "gain", {}), params("A", "tint", {})));
}

TEST_F(GraphCommandsTest, NodeAndKeyDragsContinueOnTheSameNodesAndKey) {
    const CommandType* move = m_registry.find("graph.moveNodes");
    EXPECT_TRUE(move->continues(moveNodes({{"A", {}}, {"B", {}}}).params,
                                moveNodes({{"A", {.x = 5.0}}, {"B", {.y = 1.0}}}).params));
    EXPECT_FALSE(move->continues(moveNodes({{"A", {}}}).params, moveNodes({{"A", {}}, {"B", {}}}).params));
    EXPECT_FALSE(move->continues(moveNodes({{"A", {}}}).params, moveNodes({{"B", {}}}).params));

    const CommandType* key = m_registry.find("graph.setKey");
    EXPECT_TRUE(key->continues(setKey("A", "gain", 0, {.frame = 2.0, .value = 1.0}).params,
                               setKey("A", "gain", 0, {.frame = 2.0, .value = 3.0}).params));
    EXPECT_FALSE(
        key->continues(setKey("A", "gain", 0, {.frame = 2.0}).params, setKey("A", "gain", 0, {.frame = 3.0}).params));
    EXPECT_FALSE(
        key->continues(setKey("A", "tint", 0, {.frame = 2.0}).params, setKey("A", "tint", 1, {.frame = 2.0}).params));

    EXPECT_FALSE(m_registry.find("graph.connect")->continues);
}

} // namespace
} // namespace pf::commands
