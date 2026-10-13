#pragma once

// A node in a graph (docs/specs/node-graph.md §4): an instance of a node type with its own name, parameter values,
// animation, input connections, bypass flag and node-view position. Nodes are immutable once in a Graph — the graph
// replaces a node with an edited copy — so evaluations running on other threads can keep reading the old one.

#include "core/anim/AnimCurve.h"
#include "core/graph/NodeDef.h"
#include "core/graph/NodeId.h"
#include "core/graph/Param.h"

#include <cstddef>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace pf::graph {

// One parameter's data in a node.
struct ParamState {
    ParamValue value; // the static value: used where a component has no keys
    // Numeric parameters: empty when not animated, otherwise one curve per component (a curve without keys means
    // that component keeps the static value).
    std::vector<anim::AnimCurve> curves;

    [[nodiscard]] bool isAnimated() const;
    friend bool operator==(const ParamState&, const ParamState&) = default;
};

struct NodePosition {
    double x = 0.0;
    double y = 0.0;
    friend bool operator==(const NodePosition&, const NodePosition&) = default;
};

class Node {
public:
    // Every parameter at its default, nothing connected.
    Node(NodeId id, std::string name, std::shared_ptr<const NodeDef> def);

    [[nodiscard]] NodeId id() const { return m_id; }
    [[nodiscard]] const std::string& name() const { return m_name; }
    [[nodiscard]] const NodeDef& def() const { return *m_def; }
    [[nodiscard]] const std::shared_ptr<const NodeDef>& defPointer() const { return m_def; }

    [[nodiscard]] std::span<const std::optional<NodeId>> inputs() const { return m_inputs; }
    [[nodiscard]] std::optional<NodeId> input(std::size_t index) const { return m_inputs.at(index); }
    [[nodiscard]] bool isBypassed() const { return m_bypassed; }
    [[nodiscard]] const NodePosition& position() const { return m_position; }

    [[nodiscard]] std::size_t paramCount() const { return m_params.size(); }
    [[nodiscard]] const ParamState& paramState(std::size_t index) const { return m_params.at(index); }
    // Throws std::out_of_range for an unknown parameter id.
    [[nodiscard]] std::size_t paramIndex(std::string_view id) const;

    // A parameter's value at `frame`: animated components from their curves, the others static; clamped into the
    // limits, rounded for Int/Enum/Bool.
    [[nodiscard]] ParamValue valueAt(std::size_t param, double frame) const;
    // Every parameter's value at `frame`, for node code.
    [[nodiscard]] ParamValues valuesAt(double frame) const;

    // The same node in the same state: id, name, type (the same definition), inputs, parameters, bypass, position.
    friend bool operator==(const Node& a, const Node& b);

private:
    friend class Graph;

    NodeId m_id;
    std::string m_name;
    std::shared_ptr<const NodeDef> m_def;
    std::vector<std::optional<NodeId>> m_inputs; // one per input of the type
    std::vector<ParamState> m_params;            // one per parameter of the type
    bool m_bypassed = false;
    NodePosition m_position;
};

} // namespace pf::graph
