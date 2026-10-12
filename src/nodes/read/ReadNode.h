#pragma once

// Read (docs/specs/node-graph.md §6): an image file as a node. Opens the file through the format registry (io/),
// describes it from its header and reads only the requested channels over the requested region. At a proxy scale it
// averages each p × p block. Open files are kept in a small cache shared by every Read node and reopened when the
// file's size or modification time changes; the same stamp goes into the node's hash, so a re-rendered file is
// picked up by the next evaluation.
//
// Still to come: image sequences and frame ranges (PLAN item 10), the input colour space (item 11).

#include "core/graph/NodeDef.h"
#include "io/ImageReader.h"

#include <memory>
#include <string_view>

namespace pf::nodes {

inline constexpr std::string_view readTypeId = "Read";

// `formats` must contain every format the node should read; it is shared, not copied.
[[nodiscard]] std::shared_ptr<const graph::NodeDef> makeReadNodeDef(std::shared_ptr<const io::FormatRegistry> formats);

} // namespace pf::nodes
