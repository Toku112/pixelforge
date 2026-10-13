#include "io/exr/ExrMetadata.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstring>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

// OpenEXR hands attribute values over as a tagged union (exr_attribute_t: `type` says which member is valid).
// NOLINTBEGIN(cppcoreguidelines-pro-type-union-access)

namespace pf::io::exr {
namespace {

// Shortest text that reads back as the same number, independent of the locale ("0.64", "1e-05", "27000").
template <class Number>
std::string numberText(Number value) {
    std::array<char, 64> buffer{};
    const auto [end, error] = std::to_chars(buffer.data(), buffer.data() + buffer.size(), value);
    if (error != std::errc{}) {
        return "?";
    }
    return {buffer.data(), end};
}

// "a, b, c" from numbers given as text.
std::string joined(std::span<const std::string> parts, std::string_view separator = ", ") {
    std::string text;
    for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i > 0) {
            text += separator;
        }
        text += parts[i];
    }
    return text;
}

// Numbers of one kind as typed values and display text: "(x, y)" when bracketed.
struct Numbers {
    std::vector<double> values;
    std::vector<std::string> texts;

    template <class Number>
    Numbers& add(Number value) {
        values.push_back(static_cast<double>(value));
        texts.push_back(numberText(value));
        return *this;
    }
    [[nodiscard]] std::string bracketed(std::size_t from = 0, std::size_t count = std::string::npos) const {
        const std::span<const std::string> all(texts);
        return "(" + joined(all.subspan(from, std::min(count, all.size() - from))) + ")";
    }
};

// Rows of a square matrix: "[a, b, c; d, e, f; g, h, i]".
template <class Number, std::size_t Size>
MetadataEntry matrixEntry(const std::array<Number, Size * Size>& m, MetadataEntry entry) {
    Numbers numbers;
    for (const Number value : m) {
        numbers.add(value);
    }
    std::vector<std::string> rows;
    rows.reserve(Size);
    for (std::size_t row = 0; row < Size; ++row) {
        rows.push_back(joined(std::span<const std::string>(numbers.texts).subspan(row * Size, Size)));
    }
    entry.text = "[" + joined(rows, "; ") + "]";
    entry.value = std::move(numbers.values);
    return entry;
}

// The numbers of one of OpenEXR's matrix structs. They are packed (byte-aligned), so they are copied as bytes rather
// than bound to references.
template <class Number, std::size_t Count, class Matrix>
std::array<Number, Count> matrixValues(const Matrix& matrix) {
    static_assert(sizeof(Matrix) == Count * sizeof(Number));
    std::array<Number, Count> values{};
    std::memcpy(values.data(), &matrix, sizeof(Matrix));
    return values;
}

std::string stringOf(const exr_attr_string_t& text) {
    if (text.str == nullptr || text.length <= 0) {
        return {};
    }
    return {text.str, static_cast<std::size_t>(text.length)};
}

std::string pixelTypeName(exr_pixel_type_t type) {
    switch (type) {
    case EXR_PIXEL_UINT:
        return "uint";
    case EXR_PIXEL_HALF:
        return "half";
    case EXR_PIXEL_FLOAT:
        return "float";
    default:
        return "unknown type";
    }
}

std::string lineOrderName(int order) {
    switch (order) {
    case EXR_LINEORDER_INCREASING_Y:
        return "increasing Y";
    case EXR_LINEORDER_DECREASING_Y:
        return "decreasing Y";
    case EXR_LINEORDER_RANDOM_Y:
        return "random Y";
    default:
        return "unknown (" + std::to_string(order) + ")";
    }
}

std::string tileText(const exr_attr_tiledesc_t& tiles) {
    std::string text = std::to_string(tiles.x_size) + " × " + std::to_string(tiles.y_size) + " tiles, ";
    const int levels = tiles.level_and_round & 0xF;
    const int rounding = (tiles.level_and_round >> 4) & 0xF;
    switch (levels) {
    case EXR_TILE_ONE_LEVEL:
        return text + "one level";
    case EXR_TILE_MIPMAP_LEVELS:
        text += "mipmap levels";
        break;
    case EXR_TILE_RIPMAP_LEVELS:
        text += "ripmap levels";
        break;
    default:
        return text + "unknown level mode (" + std::to_string(levels) + ")";
    }
    return text + (rounding == EXR_TILE_ROUND_UP ? " (sizes rounded up)" : " (sizes rounded down)");
}

std::string envmapName(int envmap) {
    switch (envmap) {
    case EXR_ENVMAP_LATLONG:
        return "latitude-longitude";
    case EXR_ENVMAP_CUBE:
        return "cube";
    default:
        return "unknown (" + std::to_string(envmap) + ")";
    }
}

std::string deepStateName(int state) {
    switch (state) {
    case EXR_DIS_MESSY:
        return "messy";
    case EXR_DIS_SORTED:
        return "sorted";
    case EXR_DIS_NON_OVERLAPPING:
        return "non-overlapping";
    case EXR_DIS_TIDY:
        return "tidy";
    default:
        return "unknown (" + std::to_string(state) + ")";
    }
}

int bcd(std::uint32_t bits) {
    return static_cast<int>(((bits >> 4U) * 10U) + (bits & 0xFU));
}

std::string twoDigits(int value) {
    return (value < 10 ? "0" : "") + std::to_string(value);
}

MetadataEntry describeKnown(const exr_attribute_t& a, MetadataEntry entry) {
    switch (a.type) {
    case EXR_ATTR_INT:
        entry.value = std::int64_t{a.i};
        entry.text = numberText(a.i);
        break;
    case EXR_ATTR_FLOAT:
        entry.value = static_cast<double>(a.f);
        entry.text = numberText(a.f);
        break;
    case EXR_ATTR_DOUBLE:
        entry.value = a.d;
        entry.text = numberText(a.d);
        break;
    case EXR_ATTR_STRING:
        entry.text = stringOf(*a.string);
        entry.value = entry.text;
        break;
    case EXR_ATTR_STRING_VECTOR: {
        std::vector<std::string> texts;
        texts.reserve(static_cast<std::size_t>(std::max(a.stringvector->n_strings, 0)));
        for (int i = 0; i < a.stringvector->n_strings; ++i) {
            texts.push_back(stringOf(a.stringvector->strings[i]));
        }
        entry.text = joined(texts);
        entry.value = std::move(texts);
        break;
    }
    case EXR_ATTR_FLOAT_VECTOR: {
        Numbers numbers;
        for (int i = 0; i < a.floatvector->length; ++i) {
            numbers.add(a.floatvector->arr[i]);
        }
        entry.text = joined(numbers.texts);
        entry.value = std::move(numbers.values);
        break;
    }
    case EXR_ATTR_V2I:
    case EXR_ATTR_V2F:
    case EXR_ATTR_V2D:
    case EXR_ATTR_V3I:
    case EXR_ATTR_V3F:
    case EXR_ATTR_V3D: {
        Numbers numbers;
        if (a.type == EXR_ATTR_V2I) {
            numbers.add(a.v2i->x).add(a.v2i->y);
        } else if (a.type == EXR_ATTR_V2F) {
            numbers.add(a.v2f->x).add(a.v2f->y);
        } else if (a.type == EXR_ATTR_V2D) {
            numbers.add(a.v2d->x).add(a.v2d->y);
        } else if (a.type == EXR_ATTR_V3I) {
            numbers.add(a.v3i->x).add(a.v3i->y).add(a.v3i->z);
        } else if (a.type == EXR_ATTR_V3F) {
            numbers.add(a.v3f->x).add(a.v3f->y).add(a.v3f->z);
        } else {
            numbers.add(a.v3d->x).add(a.v3d->y).add(a.v3d->z);
        }
        entry.text = numbers.bracketed();
        entry.value = std::move(numbers.values);
        break;
    }
    case EXR_ATTR_BOX2I:
    case EXR_ATTR_BOX2F: {
        Numbers numbers;
        if (a.type == EXR_ATTR_BOX2I) {
            numbers.add(a.box2i->min.x).add(a.box2i->min.y).add(a.box2i->max.x).add(a.box2i->max.y);
        } else {
            numbers.add(a.box2f->min.x).add(a.box2f->min.y).add(a.box2f->max.x).add(a.box2f->max.y);
        }
        entry.text = numbers.bracketed(0, 2) + " – " + numbers.bracketed(2, 2);
        entry.value = std::move(numbers.values);
        break;
    }
    case EXR_ATTR_CHROMATICITIES: {
        const exr_attr_chromaticities_t& c = *a.chromaticities;
        Numbers numbers;
        numbers.add(c.red_x).add(c.red_y).add(c.green_x).add(c.green_y).add(c.blue_x).add(c.blue_y);
        numbers.add(c.white_x).add(c.white_y);
        entry.text = "red " + numbers.bracketed(0, 2) + ", green " + numbers.bracketed(2, 2) + ", blue " +
                     numbers.bracketed(4, 2) + ", white " + numbers.bracketed(6, 2);
        entry.value = std::move(numbers.values);
        break;
    }
    case EXR_ATTR_M33F:
        entry = matrixEntry<float, 3>(matrixValues<float, 9>(*a.m33f), std::move(entry));
        break;
    case EXR_ATTR_M33D:
        entry = matrixEntry<double, 3>(matrixValues<double, 9>(*a.m33d), std::move(entry));
        break;
    case EXR_ATTR_M44F:
        entry = matrixEntry<float, 4>(matrixValues<float, 16>(*a.m44f), std::move(entry));
        break;
    case EXR_ATTR_M44D:
        entry = matrixEntry<double, 4>(matrixValues<double, 16>(*a.m44d), std::move(entry));
        break;
    case EXR_ATTR_RATIONAL:
        entry.value = std::vector<double>{static_cast<double>(a.rational->num), static_cast<double>(a.rational->denom)};
        entry.text = numberText(a.rational->num) + "/" + numberText(a.rational->denom);
        break;
    case EXR_ATTR_KEYCODE: {
        const exr_attr_keycode_t& k = *a.keycode;
        Numbers numbers;
        numbers.add(k.film_mfc_code).add(k.film_type).add(k.prefix).add(k.count).add(k.perf_offset);
        numbers.add(k.perfs_per_frame).add(k.perfs_per_count);
        entry.text = "manufacturer " + numbers.texts[0] + ", film type " + numbers.texts[1] + ", prefix " +
                     numbers.texts[2] + ", count " + numbers.texts[3] + ", perforation offset " + numbers.texts[4] +
                     ", " + numbers.texts[5] + " perforations per frame, " + numbers.texts[6] +
                     " perforations per count";
        entry.value = std::move(numbers.values);
        break;
    }
    case EXR_ATTR_TIMECODE:
        entry.text = timeCodeText(a.timecode->time_and_flags);
        entry.value = entry.text;
        break;
    case EXR_ATTR_COMPRESSION:
        entry.text = compressionName(a.uc);
        entry.value = entry.text;
        break;
    case EXR_ATTR_LINEORDER:
        entry.text = lineOrderName(a.uc);
        entry.value = entry.text;
        break;
    case EXR_ATTR_ENVMAP:
        entry.text = envmapName(a.uc);
        entry.value = entry.text;
        break;
    case EXR_ATTR_DEEP_IMAGE_STATE:
        entry.text = deepStateName(a.uc);
        entry.value = entry.text;
        break;
    case EXR_ATTR_TILEDESC:
        entry.text = tileText(*a.tiledesc);
        entry.value = entry.text;
        break;
    case EXR_ATTR_CHLIST: {
        std::vector<std::string> channels;
        for (int i = 0; i < a.chlist->num_channels; ++i) {
            const exr_attr_chlist_entry_t& c = a.chlist->entries[i];
            std::string text = stringOf(c.name) + " (" + pixelTypeName(c.pixel_type);
            if (c.x_sampling != 1 || c.y_sampling != 1) {
                text += ", subsampled " + std::to_string(c.x_sampling) + " × " + std::to_string(c.y_sampling);
            }
            channels.push_back(text + ")");
        }
        entry.text = joined(channels);
        entry.value = std::move(channels);
        break;
    }
    case EXR_ATTR_PREVIEW:
        entry.text = "preview image, " + std::to_string(a.preview->width) + " × " + std::to_string(a.preview->height);
        break;
    case EXR_ATTR_BYTES:
        entry.text = std::to_string(a.bytes->size) + " bytes";
        break;
    case EXR_ATTR_OPAQUE:
        entry.text = std::to_string(a.opaque->size) + " bytes";
        break;
    default:
        entry.text = "unreadable";
        break;
    }
    return entry;
}

} // namespace

MetadataEntry describeAttribute(const exr_attribute_t& attribute) {
    MetadataEntry entry;
    entry.name = attribute.name != nullptr ? attribute.name : "";
    entry.type = attribute.type_name != nullptr ? attribute.type_name : "";
    if (attribute.rawptr == nullptr && attribute.type != EXR_ATTR_INT && attribute.type != EXR_ATTR_FLOAT &&
        attribute.type != EXR_ATTR_DOUBLE && attribute.type != EXR_ATTR_COMPRESSION &&
        attribute.type != EXR_ATTR_LINEORDER && attribute.type != EXR_ATTR_ENVMAP &&
        attribute.type != EXR_ATTR_DEEP_IMAGE_STATE) {
        entry.text = "unreadable";
        return entry;
    }
    return describeKnown(attribute, std::move(entry));
}

std::string compressionName(int compression) {
    static constexpr std::array<std::string_view, 14> names{"None",     "RLE",     "ZIPS", "ZIP",  "PIZ",
                                                            "PXR24",    "B44",     "B44A", "DWAA", "DWAB",
                                                            "HTJ2K256", "HTJ2K32", "LJ2K", "ZSTD"};
    if (compression >= 0 && static_cast<std::size_t>(compression) < names.size()) {
        return std::string(names[static_cast<std::size_t>(compression)]);
    }
    return "unknown (" + std::to_string(compression) + ")";
}

std::string timeCodeText(std::uint32_t timeAndFlags) {
    const bool dropFrame = ((timeAndFlags >> 6U) & 1U) != 0;
    const int frames = bcd(timeAndFlags & 0x3FU);
    const int seconds = bcd((timeAndFlags >> 8U) & 0x7FU);
    const int minutes = bcd((timeAndFlags >> 16U) & 0x7FU);
    const int hours = bcd((timeAndFlags >> 24U) & 0x3FU);
    return twoDigits(hours) + ":" + twoDigits(minutes) + ":" + twoDigits(seconds) + (dropFrame ? ";" : ":") +
           twoDigits(frames);
}

} // namespace pf::io::exr

// NOLINTEND(cppcoreguidelines-pro-type-union-access)
