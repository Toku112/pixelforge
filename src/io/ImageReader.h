#pragma once

// Reading image files (docs/specs/node-graph.md §6, Read node). A format registers a function that opens a file;
// an open file is an ImageReader that describes the image and reads any channels over any region. Formats arrive
// one by one: OpenEXR with PLAN item 9 (io/exr, docs/specs/exr-reading.md), the others through OpenImageIO later.
//
// Readers convert at the boundary (FORMAT_NOTES §19): what they return is scene-linear float with premultiplied
// alpha, windows and channel names as in OpenEXR. File I/O never runs on the UI thread.

#include "core/image/ChannelSet.h"
#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "io/Metadata.h"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace pf::io {

// A file that cannot be opened or read; the message names the file and says why in plain language.
class FileError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// How a file stores a channel's samples.
enum class StoredType : std::uint8_t {
    UInt8,
    UInt16,
    UInt32, // OpenEXR's 32-bit unsigned integers (IDs, sample counts)
    Half,
    Float32,
};

// Where a channel of the description comes from.
struct FileChannel {
    std::string name;       // the channel's name in ImageFileInfo::channels
    std::string storedName; // its name in the file (an EXR part or view may hold it without the layer or view)
    StoredType type = StoredType::Float32;
    std::size_t part = 0; // the part (EXR) holding it: an index into ImageFileInfo::metadata
    std::string view;     // its view in a multi-view file; empty for the default view and for channels of no view
};

struct ImageFileInfo {
    image::Rect displayWindow;
    image::Rect dataWindow;
    image::ChannelSet channels;

    // Details; formats fill what they know.
    double pixelAspectRatio = 1.0;
    std::vector<FileChannel> fileChannels; // one per channel, in the order of `channels`
    std::vector<std::string> views;        // the views of a multi-view file, the default view first; else empty
    std::vector<MetadataGroup> metadata;   // header attributes, one group per part
    std::vector<std::string> notes;        // what the reader left out or renamed, in plain language
};

// What a reader has done so far: for tests (lazy reading is checked by counting) and I/O statistics.
struct ReadStatistics {
    std::uint64_t blocksDecoded = 0; // blocks of the file (EXR: chunks — groups of scanlines, or tiles)
    std::uint64_t bytesRead = 0;     // compressed bytes of those blocks
};

// How a reader may spread its work over threads: calls body(i) for every i in [0, count), in any order and possibly
// at the same time, and returns when all calls have finished, rethrowing the exception of one that failed. The Read
// node passes its evaluation's task runner (which also stops at cancellation); a default ParallelFor runs the calls
// one after another on the calling thread.
class ParallelFor {
public:
    using Body = std::function<void(std::size_t)>;
    using Runner = std::function<void(std::size_t, const Body&)>;

    ParallelFor() = default;
    explicit ParallelFor(Runner runner) : m_runner(std::move(runner)) {}

    void operator()(std::size_t count, const Body& body) const;

private:
    Runner m_runner;
};

// An open image file. Every function may run on several threads at once.
class ImageReader {
public:
    ImageReader() = default;
    virtual ~ImageReader() = default;
    ImageReader(const ImageReader&) = delete;
    ImageReader(ImageReader&&) = delete;
    ImageReader& operator=(const ImageReader&) = delete;
    ImageReader& operator=(ImageReader&&) = delete;

    [[nodiscard]] virtual const ImageFileInfo& info() const = 0;
    // The given channels (those the file has; others are left out) over `region` ∩ the data window: an image with
    // the file's display window and that data window. `parallel` spreads the work over threads. Throws FileError.
    [[nodiscard]] virtual image::Image read(const image::ChannelSet& channels, const image::Rect& region,
                                            const ParallelFor& parallel) const = 0;
    [[nodiscard]] virtual ReadStatistics statistics() const { return {}; }
};

struct ImageFormat {
    std::string name;                    // "OpenEXR"
    std::vector<std::string> extensions; // lower case, without the dot: {"exr"}
    // Opens a file; throws FileError when it is not a readable file of this format.
    std::function<std::unique_ptr<ImageReader>(const std::filesystem::path&)> open;
};

// The formats the app reads, filled once at startup and only read afterwards (any thread).
class FormatRegistry {
public:
    // Throws std::invalid_argument for a format without a name, extensions or open function, or an extension that
    // another format has.
    void add(ImageFormat format);
    // The format for a file's extension (case-insensitive), or null.
    [[nodiscard]] const ImageFormat* formatFor(const std::filesystem::path& file) const;
    // Opens a file with the format of its extension. Throws FileError when the file does not exist, no format
    // reads its extension, or the format cannot read it.
    [[nodiscard]] std::unique_ptr<ImageReader> open(const std::filesystem::path& file) const;

private:
    std::vector<ImageFormat> m_formats;
};

// Paths are stored as UTF-8 text (project files, parameters). These convert on every platform, including Windows,
// where std::filesystem would otherwise read narrow strings in the local code page.
[[nodiscard]] std::filesystem::path pathFromUtf8(std::string_view utf8);
[[nodiscard]] std::string pathToUtf8(const std::filesystem::path& path);

} // namespace pf::io
