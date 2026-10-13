#pragma once

// The node graph's commands (docs/specs/commands-history.md §3) and "group", which runs several commands as one
// History step. Each builder makes the descriptor the UI executes; the comment shows its JSON parameters. Nodes are
// named, not numbered, so Actions and scripts can refer to them.

#include "core/anim/AnimCurve.h"
#include "core/commands/Command.h"
#include "core/graph/Node.h"
#include "core/graph/Param.h"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace pf::commands {

// Registers every command below.
void registerBuiltinCommands(CommandRegistry& registry);

// graph.addNode {"type": "Exposure", "name": "Exposure1", "position": [x, y]} → "Add Exposure". Without a name the
// node gets a free one ("Exposure2"), written into the descriptor; the position is optional.
[[nodiscard]] Descriptor addNode(std::string_view type, std::string_view name = {},
                                 std::optional<graph::NodePosition> position = std::nullopt);
// graph.removeNodes {"nodes": ["Blur1", "Grade2"]} → "Delete Node(s)". Connections from them are removed too.
[[nodiscard]] Descriptor removeNodes(const std::vector<std::string>& nodes);
// graph.connect {"source": "Read1", "target": "Exposure1", "input": 0} → "Connect".
[[nodiscard]] Descriptor connect(std::string_view source, std::string_view target, std::size_t input);
// graph.disconnect {"target": "Exposure1", "input": 0} → "Disconnect".
[[nodiscard]] Descriptor disconnect(std::string_view target, std::size_t input);
// graph.renameNode {"node": "Exposure1", "name": "KeyLight"} → "Rename Node".
[[nodiscard]] Descriptor renameNode(std::string_view node, std::string_view name);
// graph.setBypassed {"node": "Exposure1", "bypassed": true} → "Bypass Node" / "Enable Node".
[[nodiscard]] Descriptor setBypassed(std::string_view node, bool bypassed);
// graph.moveNodes {"nodes": [{"node": "Exposure1", "position": [120.0, 40.0]}]} → "Move Node(s)". Continuous while
// the same nodes are dragged.
[[nodiscard]] Descriptor moveNodes(const std::vector<std::pair<std::string, graph::NodePosition>>& positions);
// graph.setValue {"node": "Exposure1", "param": "exposure", "value": 1.5, "frame": 12.0} → "Set Exposure". With a
// frame it does what a panel does (a key on every component when the parameter is animated, otherwise the static
// value); without, it sets the static value. Continuous for the same node, parameter and frame (a slider drag).
[[nodiscard]] Descriptor setValue(const graph::Node& node, std::string_view param, const graph::ParamValue& value,
                                  std::optional<double> frame = std::nullopt);
// graph.setKey {"node": "Exposure1", "param": "exposure", "component": 0, "key": {"frame": 1.0, "value": 0.5,
// "interpolation": "linear"}} → "Set Keyframe: Exposure". Continuous for the same key (dragging its value).
[[nodiscard]] Descriptor setKey(std::string_view node, std::string_view param, std::size_t component,
                                const anim::Keyframe& key);
// graph.removeKey {"node": …, "param": …, "component": 0, "frame": 1.0} → "Delete Keyframe: Exposure".
[[nodiscard]] Descriptor removeKey(std::string_view node, std::string_view param, std::size_t component, double frame);
// graph.removeAnimation {"node": …, "param": …, "frame": 1.0} → "Delete Animation: Exposure": the parameter keeps its
// value at that frame.
[[nodiscard]] Descriptor removeAnimation(std::string_view node, std::string_view param, double frame);
// graph.setExtrapolation {"node": …, "param": …, "before": "constant", "after": "linear"} →
// "Set Extrapolation: Exposure".
[[nodiscard]] Descriptor setExtrapolation(std::string_view node, std::string_view param, anim::Extrapolation before,
                                          anim::Extrapolation after);
// group {"label": "Add Exposure", "steps": [descriptors]} → its label: several commands as one History step, in
// order (creating a node and wiring it in, for example).
[[nodiscard]] Descriptor group(std::string_view label, const std::vector<Descriptor>& steps);

} // namespace pf::commands
