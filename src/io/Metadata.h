#pragma once

// File metadata (docs/specs/exr-reading.md §7): the attributes of a file's header as typed values with display text.
// One group per part of the file (OpenEXR) or per metadata block (other formats later). The Metadata panel shows
// them; colour-space detection and the Cryptomatte picker read them.

#include <cstdint>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace pf::io {

// A typed header value. Numbers are stored as double, which holds every 32-bit integer and float exactly.
using MetadataValue = std::variant<std::monostate,           // a type the app cannot interpret (previews, raw bytes)
                                   std::int64_t,             // whole numbers
                                   double,                   // decimal numbers
                                   std::string,              // text, and named values ("DWAA", "increasing Y")
                                   std::vector<std::string>, // lists of text (string vectors, channel lists)
                                   std::vector<double>>;     // vectors, boxes, matrices, chromaticities, rationals

struct MetadataEntry {
    std::string name; // "Software", "cryptomatte/542cafa/manifest", "dataWindow"
    std::string type; // the file's name for the type: "string", "v2f", "box2i", "chromaticities", …
    MetadataValue value;
    std::string text; // for display, locale-independent: "Blender 5.2.0 LTS", "(0, 0) – (1919, 1079)"
};

struct MetadataGroup {
    std::string name;                   // the part's name ("ViewLayer.Combined"); empty when the file names none
    std::vector<MetadataEntry> entries; // in file order

    // The entry with this name, or null.
    [[nodiscard]] const MetadataEntry* find(std::string_view entryName) const;
};

} // namespace pf::io
