#pragma once

// Node types (docs/specs/node-graph.md §4): what a node of a type has — inputs, output, parameters — and the NodeOp
// that does its pixel work. Types are registered once at startup (nodes/Builtins.h) and never change afterwards;
// nodes in graphs share their type's definition.

#include "core/graph/NodeOp.h"
#include "core/graph/Param.h"

#include <cstddef>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace pf::graph {

struct PortDef {
    std::string id;    // stable: "source", "input1"
    std::string label; // shown on the node: "Source", "1"
};

struct NodeDef {
    std::string typeId; // stable, stored in project files: "Exposure"
    // Raised whenever the node's output changes for the same parameters and inputs, so cached results of the old
    // version are never reused.
    int version = 1;
    std::string label;    // menus and default node names: "Exposure"
    std::string category; // menu group: "Color"
    std::vector<PortDef> inputs;
    bool hasOutput = true; // false: the Viewer
    std::vector<ParamDef> params;
    std::shared_ptr<const NodeOp> op;

    [[nodiscard]] std::optional<std::size_t> paramIndex(std::string_view id) const;
    // Throws std::out_of_range for an unknown id.
    [[nodiscard]] const ParamDef& param(std::string_view id) const;
};

// Throws std::invalid_argument when a definition is unusable: a type id or port id that is not an identifier, a
// missing label or op, a version below 1, repeated port or parameter ids, an invalid parameter (validate(ParamDef)).
void validate(const NodeDef& def);

class NodeRegistry {
public:
    // Throws std::invalid_argument for an invalid definition or a type id already registered.
    void add(std::shared_ptr<const NodeDef> def);
    // Null when there is no such type.
    [[nodiscard]] std::shared_ptr<const NodeDef> find(std::string_view typeId) const;
    // Every type, by type id.
    [[nodiscard]] std::vector<std::shared_ptr<const NodeDef>> types() const;

private:
    std::map<std::string, std::shared_ptr<const NodeDef>, std::less<>> m_types;
};

} // namespace pf::graph
