#pragma once

// EXR reading and writing for the golden-image harness, straight on OpenEXR (not on the app's io/ layer, which is
// code under test). Only what golden files need: one part, scanline or tiled, every channel read as float.

#include "support/golden/GoldenImage.h"

#include <cstdint>
#include <filesystem>

namespace pf::golden {

enum class SampleType : std::uint8_t {
    Half,  // 16-bit float: smaller files, about 3 significant digits
    Float, // 32-bit float: exact; the default for expected images
};

// Reads the first part of an EXR file; half and uint channels are converted to float. Throws std::runtime_error
// naming the file and the reason (missing, unreadable, truncated, deep data, subsampled channels).
[[nodiscard]] Image readExr(const std::filesystem::path& path);

// Writes a single-part scanline EXR with lossless ZIP compression, creating missing parent folders. Throws
// std::runtime_error naming the file and the reason.
void writeExr(const std::filesystem::path& path, const Image& image, SampleType type = SampleType::Float);

} // namespace pf::golden
