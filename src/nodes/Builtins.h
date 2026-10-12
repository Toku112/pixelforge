#pragma once

// The node types that ship with the app, registered once at startup.

#include "core/graph/NodeDef.h"
#include "io/ImageReader.h"

#include <memory>

namespace pf::nodes {

// Adds Read, Viewer, Shuffle and Exposure. `formats` are the image formats the Read node opens.
void registerBuiltinNodes(graph::NodeRegistry& registry, std::shared_ptr<const io::FormatRegistry> formats);

} // namespace pf::nodes
