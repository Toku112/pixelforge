// Graph deltas and states (core/graph/GraphDelta.h, Graph::apply/revert/restore): what a History step keeps.

#include "core/graph/GraphDelta.h"

#include "core/graph/Graph.h"
#include "support/graph/TestTypes.h"

#include <gtest/gtest.h>

#include <memory>
#include <stdexcept>

namespace pf::graph {
namespace {

class GraphDeltaTest : public ::testing::Test {
protected:
    NodeRegistry m_types = testing::testNodeTypes();
    Graph m_graph;
    NodeId m_source = m_graph.addNode(m_types.find("Source"));
    NodeId m_grade = m_graph.addNode(m_types.find("Grade"));
};

TEST_F(GraphDeltaTest, ListsOnlyNodesThatChanged) {
    Graph after = m_graph;
    after.setValue(m_grade, "gain", 2.0);
    const NodeId merge = after.addNode(m_types.find("Merge"));
    after.removeNode(m_source);

    const GraphDelta delta = GraphDelta::between(m_graph, after);
    ASSERT_EQ(delta.changes().size(), 3U);
    EXPECT_EQ(delta.changes()[0].id, m_source);
    EXPECT_EQ(delta.changes()[0].after, nullptr);
    EXPECT_EQ(delta.changes()[1].id, m_grade);
    EXPECT_EQ(delta.changes()[1].before, m_graph.nodePointer(m_grade));
    EXPECT_EQ(delta.changes()[1].after, after.nodePointer(m_grade));
    EXPECT_EQ(delta.changes()[2].id, merge);
    EXPECT_EQ(delta.changes()[2].before, nullptr);

    EXPECT_TRUE(GraphDelta::between(m_graph, m_graph).empty());
}

TEST_F(GraphDeltaTest, LeavesOutNodesReplacedByEqualCopies) {
    Graph after = m_graph;
    after.setValue(m_grade, "gain", 1.0); // the default again: a new node object with the same contents
    ASSERT_NE(after.nodePointer(m_grade), m_graph.nodePointer(m_grade));
    EXPECT_TRUE(GraphDelta::between(m_graph, after).empty());
}

TEST_F(GraphDeltaTest, AppliesAndRevertsWithTheSameNodeObjects) {
    const Graph before = m_graph;
    Graph after = m_graph;
    after.setValue(m_grade, "gain", 3.0);
    after.connect(m_source, m_grade, 0);
    const NodeId merge = after.addNode(m_types.find("Merge"));
    const GraphDelta delta = GraphDelta::between(before, after);

    m_graph.apply(delta);
    EXPECT_EQ(m_graph.nodePointer(m_grade), after.nodePointer(m_grade));
    EXPECT_EQ(m_graph.nodePointer(merge), after.nodePointer(merge));
    EXPECT_EQ(m_graph.nodePointer(m_source), before.nodePointer(m_source)); // unchanged nodes stay shared

    m_graph.revert(delta);
    EXPECT_FALSE(m_graph.contains(merge));
    EXPECT_EQ(m_graph.nodePointer(m_grade), before.nodePointer(m_grade));

    // A node id is never handed out twice, even after the node that had it was undone.
    const NodeId next = m_graph.addNode(m_types.find("Merge"));
    EXPECT_GT(next.value, merge.value);
}

TEST_F(GraphDeltaTest, RefusesAGraphInAnotherState) {
    Graph after = m_graph;
    after.setValue(m_grade, "gain", 3.0);
    const GraphDelta delta = GraphDelta::between(m_graph, after);

    Graph elsewhere = m_graph;
    elsewhere.setValue(m_grade, "gain", 5.0);
    const auto untouched = elsewhere.nodePointer(m_grade);
    EXPECT_THROW(elsewhere.apply(delta), std::logic_error);
    EXPECT_EQ(elsewhere.nodePointer(m_grade), untouched);
    EXPECT_THROW(m_graph.revert(delta), std::logic_error); // the graph is in the before state, not the after state
}

TEST_F(GraphDeltaTest, AppendMakesOneDeltaOfTwo) {
    Graph middle = m_graph;
    middle.setValue(m_grade, "gain", 2.0);
    const NodeId temporary = middle.addNode(m_types.find("Merge"));
    Graph end = middle;
    end.setValue(m_grade, "gain", 4.0);
    end.removeNode(temporary);
    end.setBypassed(m_source, true);

    GraphDelta delta = GraphDelta::between(m_graph, middle);
    delta.append(GraphDelta::between(middle, end));
    ASSERT_EQ(delta.changes().size(), 2U); // the node added and removed again drops out
    EXPECT_EQ(delta.changes()[0].id, m_source);
    EXPECT_EQ(delta.changes()[1].before, m_graph.nodePointer(m_grade));
    EXPECT_EQ(delta.changes()[1].after, end.nodePointer(m_grade));

    Graph replay = m_graph;
    replay.apply(delta);
    EXPECT_TRUE(testing::sameGraph(end, replay));
    replay.revert(delta);
    EXPECT_TRUE(testing::sameGraph(m_graph, replay));
}

TEST_F(GraphDeltaTest, RestoreTakesAnotherStateButKeepsIdsUsed) {
    const Graph opening = m_graph;
    const NodeId merge = m_graph.addNode(m_types.find("Merge"));
    m_graph.restore(opening);
    EXPECT_FALSE(m_graph.contains(merge));
    EXPECT_EQ(m_graph.nodePointer(m_source), opening.nodePointer(m_source));
    EXPECT_GT(m_graph.addNode(m_types.find("Merge")).value, merge.value);
}

TEST_F(GraphDeltaTest, FreeNamesForNewAndRenamedNodes) {
    EXPECT_EQ(m_graph.freeName(*m_types.find("Grade")), "LightGrade2");
    EXPECT_EQ(m_graph.freeName("Key"), "Key");
    EXPECT_EQ(m_graph.freeName("Source1"), "Source2");
    EXPECT_EQ(m_graph.freeName("LightGrade1"), "LightGrade2");
    EXPECT_EQ(m_graph.freeName("not valid"), "Node1");
    EXPECT_EQ(m_graph.freeName("123"), "Node1");
}

} // namespace
} // namespace pf::graph
