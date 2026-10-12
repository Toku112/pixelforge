#pragma once

// Viewer (docs/specs/node-graph.md §6): what the viewer panel shows. Ten inputs (keys 1–9 and 0 in the viewer, PLAN
// item 12), no output. Evaluating a Viewer evaluates its active input unchanged; its display settings (exposure,
// gamma, layer, channel, display, view) are read by the viewer's display path and never touch pixel data or cache
// keys.

#include "core/graph/NodeDef.h"

#include <cstddef>
#include <memory>
#include <string_view>

namespace pf::nodes {

inline constexpr std::string_view viewerTypeId = "Viewer";
inline constexpr std::size_t viewerInputCount = 10;

// Values of the `channel` parameter.
enum class ViewerChannel : std::uint8_t { Rgb, Red, Green, Blue, Alpha, Luminance };

[[nodiscard]] std::shared_ptr<const graph::NodeDef> makeViewerNodeDef();

} // namespace pf::nodes
