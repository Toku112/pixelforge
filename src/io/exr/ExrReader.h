#pragma once

// OpenEXR files (docs/specs/exr-reading.md, FORMAT_NOTES §22, D-077): scanline and tiled parts with every
// compression, multi-part, multi-layer and multi-view channel naming, lazy reading of only the parts, blocks and
// channels a request needs, and every header attribute as metadata. Built on OpenEXR's low-level library
// (OpenEXRCore), which lets many threads decode one open file at once.

#include "io/ImageReader.h"

#include <filesystem>
#include <memory>

namespace pf::io {

// The OpenEXR format for the format registry (extension "exr").
[[nodiscard]] ImageFormat exrFormat();

// Opens an EXR file: reads and checks its header, no pixels. Throws FileError when the file cannot be opened or is
// not a readable OpenEXR file.
[[nodiscard]] std::unique_ptr<ImageReader> openExr(const std::filesystem::path& file);

} // namespace pf::io
