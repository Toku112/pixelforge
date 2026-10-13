#pragma once

// What changed between two states of one graph (docs/specs/commands-history.md §4): the nodes that are new, removed
// or different, each before and after. Nodes are shared and immutable, so a delta holds only pointers to them — the
// graph's counterpart of a tile diff. A History step keeps one to undo and redo its command (Graph::apply and
// Graph::revert).

#include "core/graph/NodeId.h"

#include <memory>
#include <span>
#include <vector>

namespace pf::graph {

class Graph;
class Node;

struct NodeChange {
    NodeId id;
    std::shared_ptr<const Node> before; // null: the node did not exist yet
    std::shared_ptr<const Node> after;  // null: the node was removed
};

class GraphDelta {
public:
    // The nodes of two states of the same graph that differ. A node replaced by an equal copy is left out (the
    // before state's node is the one to keep: see Graph::apply).
    [[nodiscard]] static GraphDelta between(const Graph& before, const Graph& after);

    [[nodiscard]] bool empty() const { return m_changes.empty(); }
    // By node id.
    [[nodiscard]] std::span<const NodeChange> changes() const { return m_changes; }

    // This delta followed by `next` (which starts where this one ends), as one delta: a continuous edit merged into
    // one History step. A node added and removed again within the two drops out.
    void append(const GraphDelta& next);

private:
    std::vector<NodeChange> m_changes;
};

} // namespace pf::graph
