#pragma once

// Reading image files (docs/specs/node-graph.md §6, Read node). A format registers a function that opens a file;
// an open file is an ImageReader that describes the image and reads any channels over any region. Formats arrive
// one by one: OpenEXR with PLAN item 9, the others through OpenImageIO later.
//
// Readers convert at the boundary (FORMAT_NOTES §19): what they return is scene-linear float with premultiplied
// alpha, windows and channel names as in OpenEXR. File I/O never runs on the UI thread.

#include "core/image/ChannelSet.h"
#include "core/image/Image.h"
#include "core/image/Rect.h"

#include <filesystem>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace pf::io {

// A file that cannot be opened or read; the message names the file and says why in plain language.
class FileError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct ImageFileInfo {
    image::Rect displayWindow;
    image::Rect dataWindow;
    image::ChannelSet channels;
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
    // the file's display window and that data window. Throws FileError.
    [[nodiscard]] virtual image::Image read(const image::ChannelSet& channels, const image::Rect& region) const = 0;
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
