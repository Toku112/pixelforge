#include "core/graph/GraphDelta.h"

#include "core/graph/Graph.h"
#include "core/graph/Node.h"

#include <cstddef>
#include <utility>

namespace pf::graph {

GraphDelta GraphDelta::between(const Graph& before, const Graph& after) {
    GraphDelta delta;
    // Both maps are sorted by id: walk them side by side.
    auto a = before.m_nodes.begin();
    auto b = after.m_nodes.begin();
    while (a != before.m_nodes.end() || b != after.m_nodes.end()) {
        if (b == after.m_nodes.end() || (a != before.m_nodes.end() && a->first < b->first)) {
            delta.m_changes.push_back({.id = a->first, .before = a->second, .after = nullptr});
            ++a;
        } else if (a == before.m_nodes.end() || b->first < a->first) {
            delta.m_changes.push_back({.id = b->first, .before = nullptr, .after = b->second});
            ++b;
        } else {
            if (a->second != b->second && !(*a->second == *b->second)) {
                delta.m_changes.push_back({.id = a->first, .before = a->second, .after = b->second});
            }
            ++a;
            ++b;
        }
    }
    return delta;
}

void GraphDelta::append(const GraphDelta& next) {
    std::vector<NodeChange> merged;
    merged.reserve(m_changes.size() + next.m_changes.size());
    std::size_t i = 0;
    std::size_t j = 0;
    while (i < m_changes.size() || j < next.m_changes.size()) {
        if (j == next.m_changes.size() || (i < m_changes.size() && m_changes[i].id < next.m_changes[j].id)) {
            merged.push_back(m_changes[i++]);
        } else if (i == m_changes.size() || next.m_changes[j].id < m_changes[i].id) {
            merged.push_back(next.m_changes[j++]);
        } else {
            NodeChange change{.id = m_changes[i].id, .before = m_changes[i].before, .after = next.m_changes[j].after};
            // The same node before and after (added and removed again): nothing changed. A different copy with
            // equal contents stays: the graph holds that copy, and undo must put the earlier one back.
            if (change.before != change.after) {
                merged.push_back(std::move(change));
            }
            ++i;
            ++j;
        }
    }
    m_changes = std::move(merged);
}

} // namespace pf::graph
