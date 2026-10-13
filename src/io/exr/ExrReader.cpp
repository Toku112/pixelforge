#include "io/exr/ExrReader.h"

#include "core/image/Tile.h"
#include "io/exr/ExrMetadata.h"
#include "io/exr/ExrNaming.h"

#include <openexr.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace pf::io {
namespace {

using image::ChannelSet;
using image::Image;
using image::MutableTile;
using image::Rect;
using image::TileCoord;

// ---- OpenEXR's reasons for failures

// OpenEXR reports why a call failed through a callback, on the thread where it happened, and the call then returns
// an error code. The message waits in this thread's slot until the code becomes a FileError.
std::string& exrMessage() {
    thread_local std::string message;
    return message;
}

void keepExrMessage(exr_const_context_t /*context*/, exr_result_t /*code*/, const char* message) {
    exrMessage() = message != nullptr ? message : "";
}

// OpenEXR's reason for `result`: the message the failing call reported, or the library's text for the code.
std::string exrReason(exr_result_t result) {
    std::string reason = std::exchange(exrMessage(), std::string());
    if (reason.empty()) {
        const char* text = exr_get_default_error_message(result);
        reason = text != nullptr ? text : "unknown error";
    }
    return reason;
}

struct ContextDeleter {
    void operator()(std::remove_pointer_t<exr_context_t>* context) const {
        exr_context_t handle = context;
        exr_finish(&handle);
    }
};
using Context = std::unique_ptr<std::remove_pointer_t<exr_context_t>, ContextDeleter>;

// One part of the file, as far as reading pixels needs it.
struct Part {
    std::string label; // for messages: " of part 'ViewLayer.Combined'"; empty in a file with one part
    exr_storage_t storage = EXR_STORAGE_SCANLINE;
    Rect dataWindow;
    int linesPerChunk = 1; // scanline parts
    int tileWidth = 0;     // tiled parts (level 0)
    int tileHeight = 0;
};

// The most float samples one decoded chunk may need (256 MB). Real files stay far below (a 16-line chunk of a
// 100,000-pixel-wide image with four channels needs 25 MB); a damaged header can claim anything, and this keeps such a
// file from making the reader allocate gigabytes before the damage shows.
constexpr std::size_t maxBlockSamples = std::size_t{1} << 26;

// Where the samples of one channel of the description are.
struct Source {
    int part = 0;
    std::string storedName;
};

// OpenEXR's inclusive box as a half-open rectangle; nothing when it reaches beyond the engine's coordinate range.
std::optional<Rect> toRect(const exr_attr_box2i_t& box) {
    const auto inRange = [](std::int64_t v) { return v >= -image::maxCoordinate && v <= image::maxCoordinate; };
    const std::int64_t x1 = std::int64_t{box.max.x} + 1;
    const std::int64_t y1 = std::int64_t{box.max.y} + 1;
    if (!inRange(box.min.x) || !inRange(box.min.y) || !inRange(x1) || !inRange(y1)) {
        return std::nullopt;
    }
    return Rect{.x0 = box.min.x, .y0 = box.min.y, .x1 = static_cast<int>(x1), .y1 = static_cast<int>(y1)};
}

StoredType storedTypeOf(exr_pixel_type_t type) {
    switch (type) {
    case EXR_PIXEL_UINT:
        return StoredType::UInt32;
    case EXR_PIXEL_HALF:
        return StoredType::Half;
    default:
        return StoredType::Float32;
    }
}

std::string inQuotes(std::string_view text) {
    return "'" + std::string(text) + "'";
}

// A decode pipeline of OpenEXR for one thread, reused for consecutive chunks of one part.
class DecodePipeline {
public:
    explicit DecodePipeline(exr_const_context_t context) : m_context(context) {
        m_decoder.pipe_size = sizeof(exr_decode_pipeline_t);
    }
    ~DecodePipeline() {
        if (m_used) {
            exr_decoding_destroy(m_context, &m_decoder); // also after a failed set-up: it frees what exists
        }
    }
    DecodePipeline(const DecodePipeline&) = delete;
    DecodePipeline(DecodePipeline&&) = delete;
    DecodePipeline& operator=(const DecodePipeline&) = delete;
    DecodePipeline& operator=(DecodePipeline&&) = delete;

    // Sets the pipeline up for `chunk`; `first` tells whether this was the first chunk (the unpacking routines are
    // chosen once, after the channel buffers of the first chunk are set).
    exr_result_t prepare(int part, const exr_chunk_info_t& chunk, bool& first) {
        first = !m_used;
        m_used = true;
        return first ? exr_decoding_initialize(m_context, part, &chunk, &m_decoder)
                     : exr_decoding_update(m_context, part, &chunk, &m_decoder);
    }

    [[nodiscard]] exr_decode_pipeline_t& decoder() { return m_decoder; }
    [[nodiscard]] std::span<exr_coding_channel_info_t> channels() const {
        return {m_decoder.channels, static_cast<std::size_t>(std::max<int>(m_decoder.channel_count, 0))};
    }

private:
    exr_const_context_t m_context;
    exr_decode_pipeline_t m_decoder{};
    bool m_used = false;
};

// What one part delivers to a read: its channels and the area it covers.
struct PartRead {
    int part = 0;
    Rect region; // the read's region ∩ the part's data window
    struct Channel {
        std::string storedName;
        std::size_t output = 0; // channel index in the result image
    };
    std::vector<Channel> channels;
};

// A chunk of a part: a scanline chunk by its first row, or a level-0 tile by its tile coordinates.
struct Block {
    std::size_t read = 0; // index into the PartReads
    int x = 0;
    int y = 0;
};

// The result's tiles, prepared for writing before the parallel decode: each pixel is written by exactly one chunk,
// so the chunks may write into the same tile at once.
class TileTargets {
public:
    explicit TileTargets(Image& image)
        : m_range(image.tileRange()),
          m_tiles(image.channelCount() * static_cast<std::size_t>(m_range.area())) {}

    // Prepares the pixels of channel `channel` that `covered` holds: tiles it covers whole are written from scratch,
    // others keep 0 where it does not reach.
    void prepare(Image& image, std::size_t channel, const Rect& covered) {
        const Rect tiles = image::tilesCovering(covered);
        for (int ty = tiles.y0; ty < tiles.y1; ++ty) {
            for (int tx = tiles.x0; tx < tiles.x1; ++tx) {
                const TileCoord tile{.x = tx, .y = ty};
                const Rect pixels = image::intersect(image::tileCell(tile), image.dataWindow());
                m_tiles[index(channel, tile)] =
                    covered.contains(pixels) ? image.overwriteTile(channel, tile) : image.writableTile(channel, tile);
            }
        }
    }

    // Copies `count` samples into channel `channel` from pixel (x, y) on; the run must stay inside one tile.
    void write(std::size_t channel, int x, int y, const float* samples, int count) const {
        const MutableTile& tile = m_tiles[index(channel, image::tileContaining(x, y))];
        if (tile.samples == nullptr) {
            throw std::logic_error("EXR reading wrote to a tile it had not prepared");
        }
        std::memcpy(&tile.at(x, y), samples, static_cast<std::size_t>(count) * sizeof(float));
    }

private:
    [[nodiscard]] std::size_t index(std::size_t channel, TileCoord tile) const {
        const auto perChannel = static_cast<std::size_t>(m_range.area());
        return (channel * perChannel) +
               (static_cast<std::size_t>(tile.y - m_range.y0) * static_cast<std::size_t>(m_range.width())) +
               static_cast<std::size_t>(tile.x - m_range.x0);
    }

    Rect m_range;
    std::vector<MutableTile> m_tiles;
};

// Which plane each of the pipeline's channels decodes into (the position of its stored name in the read), or none.
std::vector<std::optional<std::size_t>> planesFor(const PartRead& read,
                                                  std::span<const exr_coding_channel_info_t> decoded) {
    std::vector<std::optional<std::size_t>> planes(decoded.size());
    std::vector<bool> taken(read.channels.size(), false);
    for (std::size_t k = 0; k < decoded.size(); ++k) {
        const std::string_view name = decoded[k].channel_name != nullptr ? decoded[k].channel_name : "";
        for (std::size_t j = 0; j < read.channels.size(); ++j) {
            if (!taken[j] && read.channels[j].storedName == name) {
                planes[k] = j;
                taken[j] = true;
                break;
            }
        }
    }
    return planes;
}

// Points every requested channel of the pipeline at its float plane and leaves the others out. False when a
// requested channel's size differs from the chunk's (a damaged file).
bool bindPlanes(std::span<exr_coding_channel_info_t> decoded, std::span<const std::optional<std::size_t>> planeOf,
                const Rect& pixels, float* samples, std::size_t planeSize) {
    for (std::size_t k = 0; k < decoded.size(); ++k) {
        exr_coding_channel_info_t& channel = decoded[k];
        const std::optional<std::size_t> plane = k < planeOf.size() ? planeOf[k] : std::nullopt;
        // decode_to_ptr is a member of OpenEXR's union of the read and write pointers.
        if (!plane) {
            channel.decode_to_ptr = nullptr; // NOLINT(cppcoreguidelines-pro-type-union-access)
            channel.user_pixel_stride = 0;
            channel.user_line_stride = 0;
            continue;
        }
        if (channel.width != pixels.width() || channel.height != pixels.height()) {
            return false;
        }
        // OpenEXR takes byte pointers for any sample type.
        channel.decode_to_ptr = // NOLINT(cppcoreguidelines-pro-type-union-access)
            reinterpret_cast<std::uint8_t*>(samples + (*plane * planeSize)); // NOLINT(*-reinterpret-cast)
        channel.user_bytes_per_element = sizeof(float);
        channel.user_data_type = EXR_PIXEL_FLOAT;
        channel.user_pixel_stride = sizeof(float);
        channel.user_line_stride = static_cast<std::int32_t>(sizeof(float)) * pixels.width();
    }
    return true;
}

// Copies the part of a decoded chunk inside the read's region into the result's tiles, row by row, one tile at a time.
void scatter(const PartRead& read, const Rect& pixels, const float* samples, std::size_t planeSize,
             const TileTargets& targets) {
    const Rect area = image::intersect(pixels, read.region);
    for (std::size_t j = 0; j < read.channels.size(); ++j) {
        const float* plane = samples + (j * planeSize);
        for (int y = area.y0; y < area.y1; ++y) {
            const float* row = plane + (static_cast<std::ptrdiff_t>(y - pixels.y0) * pixels.width());
            for (int x = area.x0; x < area.x1;) {
                const int end = std::min(area.x1, (image::tileContaining(x, y).x + 1) * image::tileSize);
                targets.write(read.channels[j].output, x, y, row + (x - pixels.x0), end - x);
                x = end;
            }
        }
    }
}

// Where a chunk lies, and how messages name it.
struct ChunkPlace {
    Rect pixels;         // the chunk's pixels (inside the part's data window)
    std::string what;    // "rows 32–63 of part 'ViewLayer.Combined'", "the tile at (0, 0) – (63, 63)"
    std::string damaged; // "… are damaged or missing (the file may be incomplete)"
};

class ExrReader final : public ImageReader {
public:
    explicit ExrReader(const std::filesystem::path& file);

    [[nodiscard]] const ImageFileInfo& info() const override { return m_info; }
    [[nodiscard]] Image read(const ChannelSet& channels, const Rect& region,
                             const ParallelFor& parallel) const override;
    [[nodiscard]] ReadStatistics statistics() const override {
        return {.blocksDecoded = m_blocks.load(std::memory_order_relaxed),
                .bytesRead = m_bytes.load(std::memory_order_relaxed)};
    }

private:
    // ---- opening
    void describe();
    [[nodiscard]] MetadataGroup readMetadata(int part) const;
    [[nodiscard]] Part describePart(int part, const std::string& partName, bool multiPart);
    void collectChannels(int part, const Part& layout, const MetadataGroup& group, bool multiPart,
                         std::vector<exr::StoredChannel>& stored, std::vector<exr_pixel_type_t>& types);
    void nameChannels(const std::vector<exr::StoredChannel>& stored, const std::vector<exr_pixel_type_t>& types,
                      const std::vector<std::string>& views, bool multiPart);

    // ---- reading
    [[nodiscard]] std::vector<PartRead> plan(const ChannelSet& wanted, const Rect& window, Image& result,
                                             TileTargets& targets) const;
    void decode(const PartRead& read, std::span<const Block> blocks, const TileTargets& targets) const;
    [[nodiscard]] ChunkPlace locate(const PartRead& read, const Block& block, exr_chunk_info_t& chunk) const;

    [[noreturn]] void failOpen(const std::string& why) const { throw FileError("cannot open " + m_file + ": " + why); }
    [[noreturn]] void failRead(const std::string& what, exr_result_t result) const {
        throw FileError("cannot read " + m_file + ": " + what + ": " + exrReason(result));
    }

    std::string m_file; // UTF-8: for OpenEXR, which takes UTF-8 names on every platform, and for messages
    Context m_context;
    std::vector<Part> m_parts;
    std::vector<Source> m_sources; // one per channel of m_info.channels, in the same order
    ImageFileInfo m_info;
    mutable std::atomic<std::uint64_t> m_blocks{0};
    mutable std::atomic<std::uint64_t> m_bytes{0};
};

ExrReader::ExrReader(const std::filesystem::path& file) : m_file(pathToUtf8(file)) {
    exr_context_initializer_t init = EXR_DEFAULT_CONTEXT_INITIALIZER;
    init.error_handler_fn = &keepExrMessage;
    exr_context_t handle = nullptr;
    exrMessage().clear();
    const exr_result_t opened = exr_start_read(&handle, m_file.c_str(), &init);
    if (opened != EXR_ERR_SUCCESS) {
        const std::string reason = exrReason(opened);
        if (opened == EXR_ERR_FILE_ACCESS) {
            failOpen("the file cannot be read (" + reason + ")");
        }
        failOpen("it is not an OpenEXR file, or its header is damaged (" + reason + ")");
    }
    m_context.reset(handle);
    describe();
}

// A metadata entry of the given name and type, or null.
const MetadataEntry* findTyped(const MetadataGroup& group, std::string_view name, std::string_view type) {
    const MetadataEntry* entry = group.find(name);
    return entry != nullptr && entry->type == type ? entry : nullptr;
}

void ExrReader::describe() {
    int partCount = 0;
    if (exr_get_count(m_context.get(), &partCount) != EXR_ERR_SUCCESS || partCount <= 0) {
        failOpen("the file holds no images");
    }
    const bool multiPart = partCount > 1;
    std::vector<exr::StoredChannel> stored;
    std::vector<exr_pixel_type_t> types;
    std::vector<std::string> views;
    for (int p = 0; p < partCount; ++p) {
        MetadataGroup group = readMetadata(p);
        const std::string partName = group.name.empty() ? "#" + std::to_string(p + 1) : group.name;
        Part part = describePart(p, partName, multiPart);
        if (p == 0) {
            float aspect = 1.0F;
            if (exr_get_pixel_aspect_ratio(m_context.get(), 0, &aspect) == EXR_ERR_SUCCESS && std::isfinite(aspect) &&
                aspect > 0.0F) {
                m_info.pixelAspectRatio = static_cast<double>(aspect);
            }
        }

        // Views: the multiView list of a single-part file, the parts' view attributes of a multi-part one.
        if (const MetadataEntry* view = findTyped(group, "view", "string");
            multiPart && view != nullptr && !view->text.empty() &&
            std::ranges::find(views, view->text) == views.end()) {
            views.push_back(view->text);
        }
        if (const MetadataEntry* multiView = findTyped(group, "multiView", "stringvector");
            !multiPart && multiView != nullptr) {
            if (const auto* list = std::get_if<std::vector<std::string>>(&multiView->value)) {
                views = *list;
            }
        }

        const std::string where = multiPart ? "part " + inQuotes(partName) : std::string("the file");
        if (part.storage == EXR_STORAGE_DEEP_SCANLINE || part.storage == EXR_STORAGE_DEEP_TILED) {
            m_info.notes.push_back(where + " holds deep data, which is not read yet");
        } else if (part.storage != EXR_STORAGE_SCANLINE && part.storage != EXR_STORAGE_TILED) {
            m_info.notes.push_back(where + " is stored in a way this version cannot read");
        } else {
            collectChannels(p, part, group, multiPart, stored, types);
        }
        m_parts.push_back(std::move(part));
        m_info.metadata.push_back(std::move(group));
    }
    nameChannels(stored, types, views, multiPart);
    m_info.views = std::move(views);
    exrMessage().clear();
}

MetadataGroup ExrReader::readMetadata(int part) const {
    MetadataGroup group;
    std::int32_t count = 0;
    if (exr_get_attribute_count(m_context.get(), part, &count) == EXR_ERR_SUCCESS && count > 0) {
        group.entries.reserve(static_cast<std::size_t>(count));
        for (std::int32_t i = 0; i < count; ++i) {
            const exr_attribute_t* attribute = nullptr;
            if (exr_get_attribute_by_index(m_context.get(), part, EXR_ATTR_LIST_FILE_ORDER, i, &attribute) ==
                    EXR_ERR_SUCCESS &&
                attribute != nullptr) {
                group.entries.push_back(exr::describeAttribute(*attribute));
            }
        }
    }
    if (const MetadataEntry* name = findTyped(group, "name", "string")) {
        group.name = name->text;
    }
    return group;
}

// The part's storage, data window and chunk layout; the first part's display window becomes the file's.
Part ExrReader::describePart(int part, const std::string& partName, bool multiPart) {
    const exr_const_context_t context = m_context.get();
    Part result;
    result.label = multiPart ? " of part " + inQuotes(partName) : "";
    const std::string& label = result.label;
    exr_attr_box2i_t dataBox{};
    exr_attr_box2i_t displayBox{};
    if (exr_get_storage(context, part, &result.storage) != EXR_ERR_SUCCESS ||
        exr_get_data_window(context, part, &dataBox) != EXR_ERR_SUCCESS ||
        exr_get_display_window(context, part, &displayBox) != EXR_ERR_SUCCESS) {
        failOpen("the header" + label + " is incomplete");
    }
    const std::optional<Rect> dataWindow = toRect(dataBox);
    const std::optional<Rect> displayWindow = toRect(displayBox);
    if (!dataWindow || !displayWindow) {
        failOpen("the image" + label + " reaches beyond 536,870,912 pixels from the origin");
    }
    result.dataWindow = *dataWindow;
    if (part == 0) {
        m_info.displayWindow = *displayWindow;
    } else if (*displayWindow != m_info.displayWindow) {
        m_info.notes.push_back("part " + inQuotes(partName) +
                               " has a different frame (display window) from the first part; the first part's frame "
                               "is used");
    }
    if (result.storage == EXR_STORAGE_SCANLINE) {
        std::int32_t lines = 0;
        if (exr_get_scanlines_per_chunk(context, part, &lines) != EXR_ERR_SUCCESS || lines <= 0) {
            failOpen("the header" + label + " is damaged (no scanlines per block)");
        }
        result.linesPerChunk = lines;
    } else if (result.storage == EXR_STORAGE_TILED) {
        std::uint32_t width = 0;
        std::uint32_t height = 0;
        exr_tile_level_mode_t levels{};
        exr_tile_round_mode_t rounding{};
        constexpr auto limit = static_cast<std::uint32_t>(image::maxCoordinate);
        if (exr_get_tile_descriptor(context, part, &width, &height, &levels, &rounding) != EXR_ERR_SUCCESS ||
            width == 0 || height == 0 || width > limit || height > limit) {
            failOpen("the header" + label + " is damaged (no tile size)");
        }
        result.tileWidth = static_cast<int>(width);
        result.tileHeight = static_cast<int>(height);
    }
    return result;
}

void ExrReader::collectChannels(int part, const Part& layout, const MetadataGroup& group, bool multiPart,
                                std::vector<exr::StoredChannel>& stored, std::vector<exr_pixel_type_t>& types) {
    const exr_attr_chlist_t* channels = nullptr;
    if (exr_get_channels(m_context.get(), part, &channels) != EXR_ERR_SUCCESS || channels == nullptr) {
        failOpen("the header" + layout.label + " has no channel list");
    }
    const MetadataEntry* view = multiPart ? findTyped(group, "view", "string") : nullptr;
    const std::string partView = view != nullptr ? view->text : std::string();
    for (int c = 0; c < channels->num_channels; ++c) {
        const exr_attr_chlist_entry_t& channel = channels->entries[c];
        const std::string name(channel.name.str, static_cast<std::size_t>(std::max(channel.name.length, 0)));
        if (channel.x_sampling != 1 || channel.y_sampling != 1) {
            m_info.notes.push_back("channel " + inQuotes(name) + layout.label + " is stored at reduced resolution (" +
                                   std::to_string(channel.x_sampling) + " × " + std::to_string(channel.y_sampling) +
                                   "), which is not read yet");
            continue;
        }
        stored.push_back(
            {.part = static_cast<std::size_t>(part), .partName = group.name, .partView = partView, .storedName = name});
        types.push_back(channel.pixel_type);
    }
}

// Names (views, clashes), the engine's channel order, and the data window of the parts that deliver channels.
void ExrReader::nameChannels(const std::vector<exr::StoredChannel>& stored, const std::vector<exr_pixel_type_t>& types,
                             const std::vector<std::string>& views, bool multiPart) {
    const std::vector<exr::ChannelNaming> names = exr::nameChannels(stored, views, multiPart);
    struct Entry {
        FileChannel file;
        Source source;
    };
    std::vector<Entry> entries;
    entries.reserve(stored.size());
    for (std::size_t i = 0; i < stored.size(); ++i) {
        if (!names[i].note.empty()) {
            m_info.notes.push_back(names[i].note);
        }
        if (!names[i].name.empty()) {
            entries.push_back(
                {.file = {.name = names[i].name,
                          .storedName = stored[i].storedName,
                          .type = storedTypeOf(types[i]),
                          .part = stored[i].part,
                          .view = names[i].view},
                 .source = {.part = static_cast<int>(stored[i].part), .storedName = stored[i].storedName}});
        }
    }
    std::ranges::sort(entries, [](const Entry& a, const Entry& b) {
        return image::compareChannels(a.file.name, b.file.name) == std::strong_ordering::less;
    });
    std::vector<bool> partUsed(m_parts.size(), false);
    for (Entry& entry : entries) {
        m_info.channels.insert(entry.file.name);
        partUsed[static_cast<std::size_t>(entry.source.part)] = true;
        m_info.fileChannels.push_back(std::move(entry.file));
        m_sources.push_back(std::move(entry.source));
    }
    // All parts when none delivers channels (a deep-only file), so the size still shows.
    const bool anyUsed = std::ranges::find(partUsed, true) != partUsed.end();
    for (std::size_t p = 0; p < m_parts.size(); ++p) {
        if (partUsed[p] || !anyUsed) {
            m_info.dataWindow = image::unite(m_info.dataWindow, m_parts[p].dataWindow);
        }
    }
}

Image ExrReader::read(const ChannelSet& channels, const Rect& region, const ParallelFor& parallel) const {
    const Rect window = image::intersect(region, m_info.dataWindow);
    const ChannelSet wanted = image::intersect(channels, m_info.channels);
    Image result(m_info.displayWindow, window, wanted);
    if (window.isEmpty() || wanted.empty()) {
        return result;
    }
    TileTargets targets(result);
    const std::vector<PartRead> reads = plan(wanted, window, result, targets);

    // The chunks each part must decode, in batches of roughly 256 × 256 pixels or more, so that small chunks (one
    // scanline) do not each pay for setting up a decoder.
    std::vector<Block> blocks;
    std::vector<std::pair<std::size_t, std::size_t>> batches; // [begin, end) in blocks
    for (std::size_t r = 0; r < reads.size(); ++r) {
        const Part& part = m_parts[static_cast<std::size_t>(reads[r].part)];
        const Rect& area = reads[r].region;
        const Rect& data = part.dataWindow;
        const std::size_t first = blocks.size();
        std::int64_t chunkPixels = 0;
        if (part.storage == EXR_STORAGE_TILED) {
            const int tx0 = (area.x0 - data.x0) / part.tileWidth;
            const int tx1 = (area.x1 - 1 - data.x0) / part.tileWidth;
            const int ty0 = (area.y0 - data.y0) / part.tileHeight;
            const int ty1 = (area.y1 - 1 - data.y0) / part.tileHeight;
            for (int ty = ty0; ty <= ty1; ++ty) {
                for (int tx = tx0; tx <= tx1; ++tx) {
                    blocks.push_back({.read = r, .x = tx, .y = ty});
                }
            }
            chunkPixels = std::int64_t{part.tileWidth} * part.tileHeight;
        } else {
            const int lines = part.linesPerChunk;
            const int c0 = (area.y0 - data.y0) / lines;
            const int c1 = (area.y1 - 1 - data.y0) / lines;
            for (int c = c0; c <= c1; ++c) {
                blocks.push_back({.read = r, .x = data.x0, .y = data.y0 + (c * lines)});
            }
            chunkPixels = std::int64_t{lines} * data.width();
        }
        const auto perBatch = static_cast<std::size_t>(std::max<std::int64_t>(
            1, std::int64_t{image::tileSize} * image::tileSize / std::max<std::int64_t>(chunkPixels, 1)));
        for (std::size_t b = first; b < blocks.size(); b += perBatch) {
            batches.emplace_back(b, std::min(b + perBatch, blocks.size()));
        }
    }

    parallel(batches.size(), [&](std::size_t batch) {
        const auto [begin, end] = batches[batch];
        decode(reads[blocks[begin].read], std::span<const Block>(blocks).subspan(begin, end - begin), targets);
    });
    return result;
}

// What each part delivers, with the result's tiles prepared; channels outside their part's data window stay 0.
std::vector<PartRead> ExrReader::plan(const ChannelSet& wanted, const Rect& window, Image& result,
                                      TileTargets& targets) const {
    std::vector<PartRead> reads;
    for (std::size_t output = 0; output < wanted.size(); ++output) {
        const std::optional<std::size_t> index = m_info.channels.indexOf(wanted[output]);
        if (!index) {
            continue; // cannot happen: `wanted` holds only the file's channels
        }
        const Source& source = m_sources[*index];
        const Rect covered = image::intersect(window, m_parts[static_cast<std::size_t>(source.part)].dataWindow);
        if (covered.isEmpty()) {
            continue;
        }
        auto read = std::ranges::find(reads, source.part, &PartRead::part);
        if (read == reads.end()) {
            reads.push_back({.part = source.part, .region = covered, .channels = {}});
            read = std::prev(reads.end());
        }
        read->channels.push_back({.storedName = source.storedName, .output = output});
        targets.prepare(result, output, covered);
    }
    return reads;
}

ChunkPlace ExrReader::locate(const PartRead& read, const Block& block, exr_chunk_info_t& chunk) const {
    const Part& part = m_parts[static_cast<std::size_t>(read.part)];
    ChunkPlace place;
    exrMessage().clear();
    exr_result_t result = EXR_ERR_SUCCESS;
    bool wrongSize = false;
    if (part.storage == EXR_STORAGE_TILED) {
        const Rect cell =
            Rect::fromSize(part.dataWindow.x0 + (block.x * part.tileWidth),
                           part.dataWindow.y0 + (block.y * part.tileHeight), part.tileWidth, part.tileHeight);
        const Rect inside = image::intersect(cell, part.dataWindow);
        place.what = "the tile at (" + std::to_string(inside.x0) + ", " + std::to_string(inside.y0) + ") – (" +
                     std::to_string(inside.x1 - 1) + ", " + std::to_string(inside.y1 - 1) + ")" + part.label;
        place.damaged = place.what + " is damaged or missing (the file may be incomplete)";
        result = exr_read_tile_chunk_info(m_context.get(), read.part, block.x, block.y, 0, 0, &chunk);
        place.pixels = Rect::fromSize(cell.x0, cell.y0, chunk.width, chunk.height);
        wrongSize = place.pixels != inside;
    } else {
        const int last = std::min(block.y + part.linesPerChunk, part.dataWindow.y1) - 1;
        place.what = "rows " + std::to_string(block.y) + "–" + std::to_string(last) + part.label;
        place.damaged = place.what + " are damaged or missing (the file may be incomplete)";
        result = exr_read_scanline_chunk_info(m_context.get(), read.part, block.y, &chunk);
        place.pixels = {.x0 = part.dataWindow.x0,
                        .y0 = chunk.start_y,
                        .x1 = part.dataWindow.x1,
                        .y1 = chunk.start_y + chunk.height};
        wrongSize = chunk.start_y != block.y || place.pixels.y1 - 1 != last;
    }
    if (result != EXR_ERR_SUCCESS) {
        failRead(place.damaged, result);
    }
    if (wrongSize) {
        failRead(place.damaged, EXR_ERR_CORRUPT_CHUNK);
    }
    return place;
}

void ExrReader::decode(const PartRead& read, std::span<const Block> blocks, const TileTargets& targets) const {
    const exr_const_context_t context = m_context.get();
    DecodePipeline pipeline(context);
    std::vector<float> samples;                      // one plane per requested channel, chunk width × height
    std::vector<std::optional<std::size_t>> planeOf; // per pipeline channel: its plane, if requested

    for (const Block& block : blocks) {
        exr_chunk_info_t chunk{};
        const ChunkPlace place = locate(read, block, chunk);
        bool first = false;
        if (const exr_result_t result = pipeline.prepare(read.part, chunk, first); result != EXR_ERR_SUCCESS) {
            failRead(place.damaged, result);
        }
        const std::span<exr_coding_channel_info_t> decoded = pipeline.channels();
        if (first) {
            planeOf = planesFor(read, decoded);
            if (std::ranges::count_if(planeOf, [](const auto& plane) { return plane.has_value(); }) !=
                static_cast<std::ptrdiff_t>(read.channels.size())) {
                failRead(place.what + ": channels the header lists are missing", EXR_ERR_CORRUPT_CHUNK);
            }
        }

        // Each requested channel decodes into its own plane as float; the others are skipped.
        const Rect& pixels = place.pixels;
        const std::size_t planeSize =
            static_cast<std::size_t>(pixels.width()) * static_cast<std::size_t>(pixels.height());
        if (planeSize * read.channels.size() > maxBlockSamples) {
            failRead(place.what + " would need more than 256 MB to decode, which no real file needs",
                     EXR_ERR_CORRUPT_CHUNK);
        }
        if (samples.size() < planeSize * read.channels.size()) {
            samples.resize(planeSize * read.channels.size());
        }
        if (!bindPlanes(decoded, planeOf, pixels, samples.data(), planeSize)) {
            failRead(place.what + ": the chunk has an unexpected layout", EXR_ERR_CORRUPT_CHUNK);
        }
        if (first) {
            if (const exr_result_t result =
                    exr_decoding_choose_default_routines(context, read.part, &pipeline.decoder());
                result != EXR_ERR_SUCCESS) {
                failRead(place.damaged, result);
            }
        }
        if (const exr_result_t result = exr_decoding_run(context, read.part, &pipeline.decoder());
            result != EXR_ERR_SUCCESS) {
            failRead(place.damaged, result);
        }
        m_blocks.fetch_add(1, std::memory_order_relaxed);
        m_bytes.fetch_add(chunk.packed_size, std::memory_order_relaxed);
        scatter(read, pixels, samples.data(), planeSize, targets);
    }
}

} // namespace

std::unique_ptr<ImageReader> openExr(const std::filesystem::path& file) {
    return std::make_unique<ExrReader>(file);
}

ImageFormat exrFormat() {
    return {.name = "OpenEXR", .extensions = {"exr"}, .open = &openExr};
}

} // namespace pf::io
