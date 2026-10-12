#pragma once

// The node graph (docs/specs/node-graph.md §4): nodes, their connections, parameter values and animation. A Graph is
// a value: copying it shares every node, and each edit replaces only the node it changes with an edited copy. The UI
// edits its graph on the UI thread (through Commands, PLAN item 8); background work evaluates a copy, so neither
// side ever waits for the other.
//
// Connections run from a node's output to one input of another node; an input holds at most one. The graph never
// contains a loop: connect() refuses one.
//
// Errors: GraphError for edits the user may try and must be told about (a loop, a name in use); std::out_of_range
// for unknown nodes, inputs and parameters; std::invalid_argument for values of the wrong type.

#include "core/anim/AnimCurve.h"
#include "core/graph/Node.h"
#include "core/graph/NodeDef.h"
#include "core/graph/NodeId.h"
#include "core/graph/Param.h"

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace pf::graph {

class GraphError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// One connection: `source`'s output feeds input `input` of `target`.
struct Connection {
    NodeId source;
    NodeId target;
    std::size_t input = 0;
    friend bool operator==(const Connection&, const Connection&) = default;
};

class Graph {
public:
    // ---- nodes
    // Adds a node of type `def` with every parameter at its default. An empty name gives the next free
    // "<Label>N" (spaces removed): "Exposure1", "Exposure2". Throws GraphError for a name in use or not an
    // identifier.
    NodeId addNode(std::shared_ptr<const NodeDef> def, std::string name = {});
    // Removes the node and every connection from it.
    void removeNode(NodeId id);
    [[nodiscard]] bool contains(NodeId id) const { return m_nodes.contains(id); }
    [[nodiscard]] const Node& node(NodeId id) const;
    // The node itself, shared: stays valid and unchanged after the graph moves on.
    [[nodiscard]] std::shared_ptr<const Node> nodePointer(NodeId id) const;
    [[nodiscard]] std::vector<NodeId> nodeIds() const; // in creation order
    [[nodiscard]] std::size_t nodeCount() const { return m_nodes.size(); }
    [[nodiscard]] std::optional<NodeId> findNode(std::string_view name) const;
    void renameNode(NodeId id, std::string name);
    void setBypassed(NodeId id, bool bypassed);
    void setPosition(NodeId id, NodePosition position);

    // ---- connections
    // Connects `source`'s output to input `input` of `target`, replacing what was connected there. Throws GraphError
    // when the connection would make a loop or `source` has no output.
    void connect(NodeId source, NodeId target, std::size_t input);
    // Leaves input `input` of `target` unconnected.
    void disconnect(NodeId target, std::size_t input);
    // True when connecting `source` into `target` would make a loop (`source` is `target` or depends on it).
    [[nodiscard]] bool wouldCreateLoop(NodeId source, NodeId target) const;
    // Every connection from `source`'s output, by target then input.
    [[nodiscard]] std::vector<Connection> outputsOf(NodeId source) const;

    // ---- parameters (identified by id; values are normalized: checked, clamped, rounded)
    // The static value. Components that are animated keep following their keys.
    void setValue(NodeId id, std::string_view param, ParamValue value);
    // What a panel does: when the parameter is animated, a key at `frame` on every component (an existing key keeps
    // its type; new keys are Linear, Bool and Enum keys Constant); otherwise the static value.
    void setValueAt(NodeId id, std::string_view param, double frame, ParamValue value);
    // A key on one component. Bool and Enum keys are always Constant. Throws std::invalid_argument when the
    // parameter cannot be animated.
    void setKey(NodeId id, std::string_view param, std::size_t component, const anim::Keyframe& key);
    // Removes the key at `frame` from one component; false when there was none.
    bool removeKey(NodeId id, std::string_view param, std::size_t component, double frame);
    // Ends the animation: the static value becomes the value at `frame`.
    void removeAnimation(NodeId id, std::string_view param, double frame);
    // Extrapolation of every component's curve.
    void setExtrapolation(NodeId id, std::string_view param, anim::Extrapolation before, anim::Extrapolation after);

private:
    // A private copy of a node to edit (the shared one stays as it was).
    [[nodiscard]] Node& edit(NodeId id);
    [[nodiscard]] std::string uniqueName(const NodeDef& def) const;
    void checkName(std::string_view name, NodeId except) const;

    std::map<NodeId, std::shared_ptr<const Node>> m_nodes;
    std::uint64_t m_lastId = 0;
};

} // namespace pf::graph
