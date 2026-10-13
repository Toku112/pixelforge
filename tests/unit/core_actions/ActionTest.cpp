// Recording and playing Actions, and their file form (core/actions/Action.h, docs/specs/commands-history.md §7).

#include "core/actions/Action.h"

#include "core/commands/GraphCommands.h"
#include "core/history/History.h"
#include "support/graph/TestTypes.h"

#include <gtest/gtest.h>

#include <string>
#include <vector>

namespace pf::actions {
namespace {

using commands::addNode;
using commands::connect;
using history::History;
using history::Merge;

void setGain(History& target, const std::string& node, double gain, Merge merge = Merge::No) {
    (void)target.execute(commands::setValue(testing::nodeNamed(target.graph(), node), "gain", gain), merge);
}

class ActionTest : public ::testing::Test {
protected:
    // A small comp made by hand while recording: nodes, wires, a slider drag, keys and a group.
    Action recordSession() {
        const Recorder recorder(m_history);
        (void)m_history.execute(addNode("Source"));
        (void)m_history.execute(addNode("Grade", {}, graph::NodePosition{.x = 100.0, .y = 0.0}));
        (void)m_history.execute(connect("Source1", "LightGrade1", 0));
        setGain(m_history, "LightGrade1", 1.5);
        setGain(m_history, "LightGrade1", 2.0, Merge::Continue);
        setGain(m_history, "LightGrade1", 2.75, Merge::Continue);
        (void)m_history.execute(commands::setKey("LightGrade1", "tint", 0, {.frame = 1.0, .value = 0.2}));
        (void)m_history.execute(commands::setKey(
            "LightGrade1", "tint", 0, {.frame = 24.0, .value = 0.9, .interpolation = anim::Interpolation::Smooth}));
        (void)m_history.execute(commands::group("Add Sink", {addNode("Sink"), connect("LightGrade1", "Sink1", 0),
                                                             commands::setBypassed("LightGrade1", true)}));
        (void)m_history.execute(commands::renameNode("LightGrade1", "KeyLight"));
        return recorder.action("Build comp");
    }

    graph::NodeRegistry m_types = testing::testNodeTypes();
    commands::CommandRegistry m_commands = testing::builtinCommands();
    History m_history{m_commands, m_types};
};

TEST_F(ActionTest, RecordsOneStepPerHistoryStep) {
    const Action action = recordSession();
    EXPECT_EQ(action.name, "Build comp");
    ASSERT_EQ(action.steps.size(), m_history.size() - 1);
    for (std::size_t i = 0; i < action.steps.size(); ++i) {
        EXPECT_EQ(action.steps[i], *m_history.descriptor(i + 1));
    }
    // The drag recorded its final value only.
    EXPECT_EQ(action.steps[3].params.at("value"), json::Value(2.75));
}

TEST_F(ActionTest, PlayingRebuildsTheSameGraph) {
    const Action action = recordSession();
    History other(m_commands, m_types);
    EXPECT_EQ(play(action, other), action.steps.size());
    EXPECT_TRUE(testing::sameGraph(m_history.graph(), other.graph()));
    // Each step is its own History step, with the same labels.
    for (std::size_t i = 1; i < m_history.size(); ++i) {
        EXPECT_EQ(other.entries()[i].label, m_history.entries()[i].label);
    }
}

TEST_F(ActionTest, SavedActionsPlayTheSame) {
    const Action action = recordSession();
    const std::string text = json::write(toJson(action), {.indent = 2});
    const Action loaded = actionFromJson(json::parse(text));
    EXPECT_EQ(loaded, action);
    History other(m_commands, m_types);
    (void)play(loaded, other);
    EXPECT_TRUE(testing::sameGraph(m_history.graph(), other.graph()));
    EXPECT_NE(text.find(R"("format": "pixelforge-action")"), std::string::npos);
}

TEST_F(ActionTest, PlayingIntoAGraphThatHasTheNamesAlready) {
    const Action action = recordSession();
    // Play the same action twice into one graph: the second copy's nodes get free names and its steps follow them.
    History other(m_commands, m_types);
    (void)play(action, other);
    (void)play(action, other);
    const graph::Graph& g = other.graph();
    EXPECT_EQ(g.nodeCount(), 6U);
    ASSERT_TRUE(g.findNode("Source2"));
    ASSERT_TRUE(g.findNode("KeyLight1")); // the second rename to "KeyLight" got a free name
    ASSERT_TRUE(g.findNode("Sink2"));
    const graph::Node& second = testing::nodeNamed(g, "KeyLight1");
    EXPECT_EQ(second.input(0), g.findNode("Source2"));
    EXPECT_EQ(testing::nodeNamed(g, "Sink2").input(0), g.findNode("KeyLight1"));
    EXPECT_TRUE(second.isBypassed());
    // The first copy is untouched by the second.
    EXPECT_EQ(testing::nodeNamed(g, "KeyLight").input(0), g.findNode("Source1"));
    EXPECT_EQ(testing::nodeNamed(g, "Sink1").input(0), g.findNode("KeyLight"));
}

TEST_F(ActionTest, UndoIsNotRecordedAndStopEndsRecording) {
    Recorder recorder(m_history);
    EXPECT_TRUE(recorder.isRecording());
    (void)m_history.execute(addNode("Source"));
    (void)m_history.execute(addNode("Grade"));
    m_history.undo();
    (void)m_history.execute(addNode("Merge"));
    recorder.stop();
    EXPECT_FALSE(recorder.isRecording());
    (void)m_history.execute(addNode("Sink"));
    ASSERT_EQ(recorder.steps().size(), 3U);
    EXPECT_EQ(recorder.steps()[1].params.at("type"), json::Value("Grade"));
    EXPECT_EQ(recorder.steps()[2].params.at("type"), json::Value("Merge"));
}

TEST_F(ActionTest, AFailingStepStopsPlayback) {
    const Action action{
        .name = "Broken",
        .steps = {addNode("Source"), addNode("Grade"), connect("Missing", "LightGrade1", 0), addNode("Merge")}};
    History other(m_commands, m_types);
    try {
        (void)play(action, other);
        FAIL() << "no error";
    } catch (const ActionError& error) {
        EXPECT_EQ(error.step(), 2U);
        EXPECT_STREQ(error.what(), "step 3 (graph.connect): there is no node named 'Missing'");
    }
    // The steps before it stay done, each undoable.
    EXPECT_EQ(other.size(), 3U);
    EXPECT_FALSE(other.graph().findNode("Merge1"));
    other.undo();
    EXPECT_FALSE(other.graph().findNode("LightGrade1"));
}

TEST_F(ActionTest, RefusesFilesThatAreNotActions) {
    const auto refuses = [](const std::string& text, const std::string& message) {
        try {
            (void)actionFromJson(json::parse(text));
            ADD_FAILURE() << "no error for " << text;
        } catch (const ActionError& error) {
            EXPECT_EQ(std::string(error.what()), message);
        }
    };
    refuses("[]", "not an action file: it is not a JSON object");
    refuses(R"({"format":"pixelforge-brushes","version":1,"steps":[]})",
            R"(not an action file: "format" is not "pixelforge-action")");
    refuses(R"({"format":"pixelforge-action","steps":[]})", R"(not an action file: "version" is missing)");
    refuses(R"({"format":"pixelforge-action","version":2,"steps":[]})",
            "this action was saved by a newer version (format 2) and cannot be read");
    refuses(R"({"format":"pixelforge-action","version":1})", R"(not an action file: "steps" is missing)");
    refuses(R"({"format":"pixelforge-action","version":1,"steps":[{"command":"graph.connect"},{"params":{}}]})",
            R"(step 2: a command needs "command": its name as text)");
    const Action empty = actionFromJson(json::parse(R"({"format":"pixelforge-action","version":1,"steps":[]})"));
    EXPECT_TRUE(empty.steps.empty());
    EXPECT_EQ(empty.name, "");
}

} // namespace
} // namespace pf::actions
