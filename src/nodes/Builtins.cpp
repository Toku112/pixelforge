#include "nodes/Builtins.h"

#include "nodes/exposure/ExposureNode.h"
#include "nodes/read/ReadNode.h"
#include "nodes/shuffle/ShuffleNode.h"
#include "nodes/viewer/ViewerNode.h"

#include <utility>

namespace pf::nodes {

void registerBuiltinNodes(graph::NodeRegistry& registry, std::shared_ptr<const io::FormatRegistry> formats) {
    registry.add(makeReadNodeDef(std::move(formats)));
    registry.add(makeViewerNodeDef());
    registry.add(makeShuffleNodeDef());
    registry.add(makeExposureNodeDef());
}

} // namespace pf::nodes
