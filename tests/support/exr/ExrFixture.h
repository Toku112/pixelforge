#pragma once

// EXR files for tests of the EXR reader (io/exr), written straight with OpenEXR's own high-level library — not with
// our code — so a bug in the reader cannot hide in the files it reads. Pixels follow a fixed pattern
// (exrFixtureValue), so tests know every expected sample without storing images.

#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "io/ImageReader.h"

#include <OpenEXR/ImfChannelList.h> // defines Imf::Channel, which ImfHeader.h only declares
#include <OpenEXR/ImfHeader.h>
#include <gtest/gtest.h>

#include <cstdint>
#include <filesystem>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace pf::testing {

enum class ExrSample : std::uint8_t { UInt, Half, Float };

enum class ExrPattern : std::uint8_t {
    Values,            // smooth-ish values from about −130 to +130, many above 1, some tiny
    ValuesAndSpecials, // the same with NaN, +infinity and −infinity at some pixels (lossless compressions only)
    IdBits,            // float bit patterns like Cryptomatte IDs (any finite, normal float), which must survive exactly
    Smooth,            // render-like: soft gradients and a bright highlight up to about 40 (for lossy golden files)
};

struct ExrChannelSpec {
    std::string name;
    ExrSample type = ExrSample::Half;
    ExrPattern pattern = ExrPattern::Values;
    int xSampling = 1;
    int ySampling = 1;
};

enum class ExrStorage : std::uint8_t { Scanline, Tiled, DeepScanline };
enum class ExrLevels : std::uint8_t { One, Mipmap, Ripmap };
enum class ExrLineOrder : std::uint8_t { IncreasingY, DecreasingY, RandomY };

struct ExrPartSpec {
    std::string name; // required when a file has several parts
    std::string view; // the part's "view" attribute (views stored as parts); empty: none
    image::Rect displayWindow{.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 48};
    image::Rect dataWindow{.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 48};
    std::vector<ExrChannelSpec> channels;
    int compression = 3; // OpenEXR's numbers: 0 none, 1 RLE, 2 ZIPS, 3 ZIP, 4 PIZ, 5 PXR24, 6 B44, 7 B44A, 8 DWAA,
                         // 9 DWAB, 10 HTJ2K256, 11 HTJ2K32, 12 LJ2K, 13 ZSTD
    ExrStorage storage = ExrStorage::Scanline;
    int tileWidth = 32;
    int tileHeight = 16;
    ExrLevels levels = ExrLevels::One;
    ExrLineOrder lineOrder = ExrLineOrder::IncreasingY;
    std::vector<std::string> multiView;         // the "multiView" attribute (views inside one part); empty: none
    std::function<void(Imf::Header&)> decorate; // adds more attributes
};

// Writes the parts as one file (a single-part file for one part), creating missing folders. Throws on failure.
void writeExrFixture(const std::filesystem::path& file, std::span<const ExrPartSpec> parts);
void writeExrFixture(const std::filesystem::path& file, const ExrPartSpec& part);

// The value a fixture holds at pixel (x, y) of `channel`, as reading it must give it: rounded to half for half
// channels, an integer converted to float for uint channels.
[[nodiscard]] float exrFixtureValue(const ExrChannelSpec& channel, int x, int y);

// Checks channel `name` of `image` against the fixture pattern of `channel` over the image's data window: bit for bit
// (NaN matches NaN) inside `stored` (the window the file holds the channel in), 0 outside it.
[[nodiscard]] ::testing::AssertionResult matchesFixture(const image::Image& image, std::string_view name,
                                                        const ExrChannelSpec& channel, const image::Rect& stored);

// Bit-for-bit equality of two images (windows, channels, every sample; NaN matches NaN).
[[nodiscard]] ::testing::AssertionResult sameImage(const image::Image& actual, const image::Image& expected);

// A ParallelFor that really runs on `threads` threads, to test readers under concurrency.
[[nodiscard]] io::ParallelFor testThreads(int threads);

// A file's bytes, and writing bytes back (for damaged-file tests).
[[nodiscard]] std::vector<std::uint8_t> readBytes(const std::filesystem::path& file);
void writeBytes(const std::filesystem::path& file, std::span<const std::uint8_t> bytes);

} // namespace pf::testing
