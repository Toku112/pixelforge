#pragma once

// Read (docs/specs/node-graph.md §6, docs/specs/sequences.md §4): an image file or an image sequence as a node. Opens
// files through the format registry (io/), describes them from their headers and reads only the requested channels
// over the requested region. At a proxy scale it averages each p × p block.
//
// `file` is a still (a plain path: the same image at every frame) or a frame pattern ("render####.exr"): then the
// comp frame picks the file, through the frame offset, the frame range (from the files on disk, or First/Last) and
// what to show before and after the range and where a frame is missing. Which file shows is worked out once per frame
// and evaluation (NodeOp::prepare) and goes into the node's hash with its size and modification time, so re-rendered,
// new and deleted frames are picked up by the next evaluation, and frames showing the same file share results.
//
// Open files and folder listings are kept in small caches shared by every Read node. A file with nothing the node
// can show (only deep data, item 9) is an error that gives the reader's reasons.
//
// Still to come: movies (Phase 1), the input colour space (PLAN item 11).

#include "core/graph/NodeDef.h"
#include "io/ImageReader.h"

#include <memory>
#include <string_view>

namespace pf::nodes {

inline constexpr std::string_view readTypeId = "Read";

// `formats` must contain every format the node should read; it is shared, not copied.
[[nodiscard]] std::shared_ptr<const graph::NodeDef> makeReadNodeDef(std::shared_ptr<const io::FormatRegistry> formats);

} // namespace pf::nodes
