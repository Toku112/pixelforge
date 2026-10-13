#pragma once

// EXR header attributes as metadata entries (FORMAT_NOTES §22.5): a typed value and display text for every attribute
// type OpenEXR defines. Internal to io/exr.

#include "io/Metadata.h"

#include <openexr.h>

#include <cstdint>
#include <string>

namespace pf::io::exr {

[[nodiscard]] MetadataEntry describeAttribute(const exr_attribute_t& attribute);

// "DWAA" for EXR_COMPRESSION_DWAA; "unknown (n)" for a value OpenEXR does not define.
[[nodiscard]] std::string compressionName(int compression);

// "01:00:00:01" (";" before the frames in drop-frame time code) from an EXR/SMPTE time code's bits.
[[nodiscard]] std::string timeCodeText(std::uint32_t timeAndFlags);

} // namespace pf::io::exr
