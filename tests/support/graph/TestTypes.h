#pragma once

// Test support for graph edits, commands and the History: node types with every kind of parameter (no pixel work),
// and a comparison of two graphs by node names.

#include "core/commands/Command.h"
#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"

#include <gtest/gtest.h>

#include <string_view>

namespace pf::testing {

// Types: "Source" (no input), "Grade" (one input), "Merge" (two inputs), "Sink" (one input, no output). Each has the
// parameters gain (Float 0–10, default 1), tint (Color), steps (Int 1–64, default 4), invert (Bool), mode (Enum: a,
// b, c), offset (Vector2), layer (String) and file (File). Labels: "Source", "Light Grade", "Merge", "Sink".
[[nodiscard]] graph::NodeRegistry testNodeTypes();

// The built-in commands (commands/GraphCommands.h).
[[nodiscard]] commands::CommandRegistry builtinCommands();

// The node named `name`; throws std::out_of_range when there is none.
[[nodiscard]] graph::NodeId nodeId(const graph::Graph& graph, std::string_view name);
[[nodiscard]] const graph::Node& nodeNamed(const graph::Graph& graph, std::string_view name);

// Equal graphs, node by node, matched by name: type, parameters and animation, inputs (by the source's name), bypass
// and position. Node ids may differ.
[[nodiscard]] ::testing::AssertionResult sameGraph(const graph::Graph& expected, const graph::Graph& actual);

} // namespace pf::testing
