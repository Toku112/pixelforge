#pragma once

// The image formats that ship with the app, registered once at startup: OpenEXR (io/exr) now, OpenImageIO's
// formats later (PLAN B22).

#include "io/ImageReader.h"

namespace pf::io {

// Adds every built-in format to `registry`.
void addBuiltinFormats(FormatRegistry& registry);

} // namespace pf::io
