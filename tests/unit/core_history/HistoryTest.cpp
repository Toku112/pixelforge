// Undo, redo and the History panel model (core/history/History.h, docs/specs/commands-history.md §4–6).

#include "core/history/History.h"

#include "core/commands/GraphCommands.h"
#include "core/graph/Graph.h"
#include "support/graph/TestTypes.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace pf::history {
namespace {

using commands::addNode;
using commands::connect;

class HistoryTest : public ::testing::Test {
protected:
    // Sets the gain of `node` (an existing node of the current graph).
    bool setGain(const std::string& node, double gain, Merge merge = Merge::No) {
        const graph::Node& target = testing::nodeNamed(m_history.graph(), node);
        return m_history.execute(commands::setValue(target, "gain", gain), merge);
    }

    [[nodiscard]] double gain(const std::string& node) const {
        const graph::Node& target = testing::nodeNamed(m_history.graph(), node);
        return std::get<double>(target.paramState(0).value);
    }

    [[nodiscard]] std::vector<std::string> labels() const {
        std::vector<std::string> result;
        for (const Entry& entry : m_history.entries()) {
            result.push_back(entry.label);
        }
        return result;
    }

    graph::NodeRegistry m_types = testing::testNodeTypes();
    commands::CommandRegistry m_commands = testing::builtinCommands();
    History m_history{m_commands, m_types};
};

TEST_F(HistoryTest, ExecuteUndoRedo) {
    EXPECT_FALSE(m_history.canUndo());
    EXPECT_FALSE(m_history.canRedo());
    EXPECT_EQ(labels(), std::vector<std::string>{"New"});

    EXPECT_TRUE(m_history.execute(addNode("Source")));
    EXPECT_TRUE(m_history.execute(addNode("Grade")));
    EXPECT_TRUE(m_history.execute(connect("Source1", "LightGrade1", 0)));
    EXPECT_TRUE(setGain("LightGrade1", 2.0));
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Add Source", "Add Light Grade", "Connect", "Set Gain"}));
    EXPECT_EQ(m_history.currentIndex(), 4U);
    EXPECT_EQ(m_history.undoLabel(), "Set Gain");
    EXPECT_EQ(m_history.redoLabel(), "");

    const graph::Graph done = m_history.graph();
    m_history.undo();
    EXPECT_EQ(gain("LightGrade1"), 1.0);
    EXPECT_EQ(m_history.redoLabel(), "Set Gain");
    m_history.undo();
    EXPECT_FALSE(testing::nodeNamed(m_history.graph(), "LightGrade1").input(0));
    m_history.undo();
    m_history.undo();
    EXPECT_EQ(m_history.graph().nodeCount(), 0U);
    EXPECT_FALSE(m_history.canUndo());
    m_history.undo(); // nothing left: does nothing
    EXPECT_EQ(m_history.currentIndex(), 0U);

    for (int i = 0; i < 4; ++i) {
        m_history.redo();
    }
    EXPECT_FALSE(m_history.canRedo());
    EXPECT_TRUE(testing::sameGraph(done, m_history.graph()));
    // Redo restores the very same node objects (nothing is recomputed).
    EXPECT_EQ(m_history.graph().nodePointer(testing::nodeId(m_history.graph(), "LightGrade1")),
              done.nodePointer(testing::nodeId(done, "LightGrade1")));
}

TEST_F(HistoryTest, ClickingAnEntryAndBranching) {
    (void)m_history.execute(addNode("Source"));
    (void)m_history.execute(addNode("Grade"));
    (void)setGain("LightGrade1", 2.0);
    (void)setGain("LightGrade1", 3.0);

    m_history.goTo(2);
    EXPECT_EQ(gain("LightGrade1"), 1.0);
    const std::vector<Entry> entries = m_history.entries();
    ASSERT_EQ(entries.size(), 5U);
    EXPECT_TRUE(entries[0].isOpeningState);
    EXPECT_EQ(entries[1].state, EntryState::Past);
    EXPECT_EQ(entries[2].state, EntryState::Current);
    EXPECT_EQ(entries[3].state, EntryState::Future);
    m_history.goTo(4);
    EXPECT_EQ(gain("LightGrade1"), 3.0);
    m_history.goTo(0);
    EXPECT_EQ(m_history.graph().nodeCount(), 0U);
    m_history.goTo(3);
    EXPECT_EQ(gain("LightGrade1"), 2.0);
    EXPECT_THROW(m_history.goTo(5), std::out_of_range);

    // A new step drops the undone entries after the current one.
    const std::uint64_t keptId = m_history.entries()[3].id;
    (void)m_history.execute(addNode("Merge"));
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Add Source", "Add Light Grade", "Set Gain", "Add Merge"}));
    EXPECT_EQ(m_history.entries()[3].id, keptId);
    EXPECT_FALSE(m_history.canRedo());
}

TEST_F(HistoryTest, CommandsThatChangeNothingRecordNothing) {
    (void)m_history.execute(addNode("Grade"));
    EXPECT_FALSE(setGain("LightGrade1", 1.0)); // already 1
    EXPECT_FALSE(m_history.execute(commands::removeNodes({})));
    EXPECT_EQ(m_history.size(), 2U);
}

TEST_F(HistoryTest, FailedCommandsChangeNothing) {
    (void)m_history.execute(addNode("Grade"));
    const graph::Graph before = m_history.graph();
    EXPECT_THROW((void)m_history.execute(connect("LightGrade1", "LightGrade1", 0)), commands::CommandError);
    EXPECT_THROW((void)m_history.execute(commands::group("Two", {addNode("Merge"), addNode("Nothing")})),
                 commands::CommandError);
    EXPECT_EQ(m_history.size(), 2U);
    EXPECT_TRUE(testing::sameGraph(before, m_history.graph()));
}

TEST_F(HistoryTest, ASliderDragIsOneStep) {
    (void)m_history.execute(addNode("Grade"));
    EXPECT_TRUE(setGain("LightGrade1", 1.5));
    for (const double value : {2.0, 2.5, 3.0, 3.5}) {
        EXPECT_TRUE(setGain("LightGrade1", value, Merge::Continue));
    }
    EXPECT_FALSE(setGain("LightGrade1", 3.5, Merge::Continue)); // no movement this time
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Add Light Grade", "Set Gain"}));
    EXPECT_EQ(gain("LightGrade1"), 3.5);
    // The step keeps the last value: replaying it gives the end of the drag.
    EXPECT_EQ(m_history.descriptor(2)->params.at("value"), json::Value(3.5));

    m_history.undo();
    EXPECT_EQ(gain("LightGrade1"), 1.0); // back to before the drag
    m_history.redo();
    EXPECT_EQ(gain("LightGrade1"), 3.5);

    // After an undo or redo the next drag event starts a new step, even with Continue.
    EXPECT_TRUE(setGain("LightGrade1", 4.0, Merge::Continue));
    EXPECT_EQ(m_history.size(), 4U);
    // Another parameter, or a new drag (Merge::No), also starts a new step.
    (void)m_history.execute(
        commands::setValue(testing::nodeNamed(m_history.graph(), "LightGrade1"), "steps", std::int64_t{8}),
        Merge::Continue);
    EXPECT_EQ(m_history.size(), 5U);
    (void)setGain("LightGrade1", 5.0);
    (void)setGain("LightGrade1", 6.0);
    EXPECT_EQ(m_history.size(), 7U);
}

TEST_F(HistoryTest, DraggingNodesIsOneStep) {
    (void)m_history.execute(addNode("Grade"));
    (void)m_history.execute(addNode("Merge"));
    for (int i = 1; i <= 10; ++i) {
        const double x = i * 10.0;
        (void)m_history.execute(
            commands::moveNodes({{"LightGrade1", {.x = x, .y = 0.0}}, {"Merge1", {.x = x, .y = 50.0}}}),
            i == 1 ? Merge::No : Merge::Continue);
    }
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Add Light Grade", "Add Merge", "Move Nodes"}));
    m_history.undo();
    EXPECT_EQ(testing::nodeNamed(m_history.graph(), "Merge1").position(), graph::NodePosition{});
}

TEST_F(HistoryTest, OldestStepsAreDroppedOverTheLimit) {
    m_history.setMaxStates(3);
    (void)m_history.execute(addNode("Grade"));
    for (int i = 2; i <= 6; ++i) {
        (void)setGain("LightGrade1", i);
    }
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Set Gain", "Set Gain", "Set Gain"}));
    EXPECT_EQ(gain("LightGrade1"), 6.0);

    // Undo stops at the oldest step left…
    m_history.undo();
    m_history.undo();
    EXPECT_FALSE(m_history.canUndo());
    EXPECT_EQ(gain("LightGrade1"), 4.0);
    // …but the opening state can still be clicked, and every kept step reached again from it.
    m_history.goTo(0);
    EXPECT_EQ(m_history.graph().nodeCount(), 0U);
    EXPECT_FALSE(m_history.canUndo());
    m_history.redo();
    EXPECT_EQ(gain("LightGrade1"), 4.0);
    m_history.goTo(3);
    EXPECT_EQ(gain("LightGrade1"), 6.0);
}

TEST_F(HistoryTest, ANewStepFromTheOpeningStateStartsTheStepsAgain) {
    m_history.setMaxStates(3);
    (void)m_history.execute(addNode("Grade"));
    for (int i = 2; i <= 6; ++i) {
        (void)setGain("LightGrade1", i);
    }
    // Steps were dropped; from the opening state a new step starts the list again, undoable down to it.
    m_history.goTo(0);
    (void)m_history.execute(addNode("Merge"));
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Add Merge"}));
    EXPECT_TRUE(m_history.canUndo());
    m_history.undo();
    EXPECT_EQ(m_history.graph().nodeCount(), 0U);
}

TEST_F(HistoryTest, LoweringTheLimitKeepsTheCurrentEntry) {
    (void)m_history.execute(addNode("Grade"));
    for (int i = 2; i <= 6; ++i) {
        (void)setGain("LightGrade1", i);
    }
    m_history.goTo(1); // the oldest step
    m_history.setMaxStates(2);
    EXPECT_EQ(m_history.currentIndex(), 1U);
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Add Light Grade", "Set Gain"}));
    m_history.redo();
    EXPECT_EQ(gain("LightGrade1"), 2.0);

    m_history.setMaxStates(0); // clamped to 1
    EXPECT_EQ(m_history.maxStates(), 1U);
    EXPECT_EQ(labels(), (std::vector<std::string>{"New", "Set Gain"}));
    m_history.setMaxStates(5000);
    EXPECT_EQ(m_history.maxStates(), History::maxMaxStates);
}

TEST_F(HistoryTest, ToggleLastState) {
    (void)m_history.execute(addNode("Grade"));
    (void)setGain("LightGrade1", 2.0);
    (void)setGain("LightGrade1", 3.0);
    m_history.toggleLastState();
    EXPECT_EQ(gain("LightGrade1"), 2.0);
    m_history.toggleLastState();
    EXPECT_EQ(gain("LightGrade1"), 3.0);
    m_history.toggleLastState();
    EXPECT_EQ(gain("LightGrade1"), 2.0);
    // Any other move starts over from the new current entry.
    m_history.goTo(1);
    m_history.toggleLastState();
    EXPECT_EQ(m_history.currentIndex(), 0U);
    m_history.toggleLastState();
    EXPECT_EQ(m_history.currentIndex(), 1U);
}

TEST_F(HistoryTest, ObserversHearEveryChange) {
    std::vector<ChangeKind> kinds;
    std::vector<std::string> commandNames;
    const std::uint64_t observer = m_history.addObserver([&](const Change& change) {
        kinds.push_back(change.kind);
        if (change.descriptor != nullptr) {
            commandNames.push_back(change.descriptor->command);
        }
    });
    (void)m_history.execute(addNode("Grade"));
    (void)setGain("LightGrade1", 2.0);
    (void)setGain("LightGrade1", 2.5, Merge::Continue);
    m_history.undo();
    m_history.setMaxStates(1);
    EXPECT_EQ(kinds, (std::vector<ChangeKind>{ChangeKind::Executed, ChangeKind::Executed, ChangeKind::Merged,
                                              ChangeKind::Moved, ChangeKind::Trimmed}));
    EXPECT_EQ(commandNames, (std::vector<std::string>{"graph.addNode", "graph.setValue", "graph.setValue"}));
    m_history.removeObserver(observer);
    m_history.redo();
    EXPECT_EQ(kinds.size(), 5U);
}

TEST_F(HistoryTest, NodeIdsAreNeverReusedAfterUndo) {
    (void)m_history.execute(addNode("Grade"));
    const graph::NodeId first = testing::nodeId(m_history.graph(), "LightGrade1");
    m_history.undo();
    (void)m_history.execute(addNode("Grade"));
    EXPECT_NE(testing::nodeId(m_history.graph(), "LightGrade1"), first);
    m_history.goTo(0);
    (void)m_history.execute(addNode("Merge"));
    EXPECT_GT(testing::nodeId(m_history.graph(), "Merge1").value, first.value + 1);
}

TEST_F(HistoryTest, DroppedStepsReleaseTheirNodes) {
    // Memory stays bounded however many edits are made: nodes only dropped steps held are freed.
    (void)m_history.execute(addNode("Grade"));
    (void)setGain("LightGrade1", 2.0);
    const std::weak_ptr<const graph::Node> early =
        m_history.graph().nodePointer(testing::nodeId(m_history.graph(), "LightGrade1"));
    for (int i = 0; i < 500; ++i) {
        (void)setGain("LightGrade1", 3.0 + (i % 7));
    }
    EXPECT_EQ(m_history.size(), History::defaultMaxStates + 1);
    EXPECT_TRUE(early.expired());

    // Undone steps dropped by a new step are released too.
    const std::weak_ptr<const graph::Node> undone =
        m_history.graph().nodePointer(testing::nodeId(m_history.graph(), "LightGrade1"));
    m_history.undo();
    (void)setGain("LightGrade1", 9.5);
    EXPECT_TRUE(undone.expired());
}

TEST_F(HistoryTest, StartsFromAGivenGraph) {
    graph::Graph opened;
    (void)opened.addNode(m_types.find("Source"));
    History fromFile(m_commands, m_types, opened, "Open");
    EXPECT_EQ(fromFile.entries()[0].label, "Open");
    (void)fromFile.execute(commands::removeNodes({"Source1"}));
    fromFile.undo();
    EXPECT_TRUE(testing::sameGraph(opened, fromFile.graph()));
    EXPECT_EQ(fromFile.descriptor(0), nullptr);
    EXPECT_EQ(fromFile.descriptor(1)->command, "graph.removeNodes");
    EXPECT_THROW((void)fromFile.descriptor(2), std::out_of_range);
}

} // namespace
} // namespace pf::history
