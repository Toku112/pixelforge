// Damaged and incomplete EXR files (docs/specs/exr-reading.md §6): files cut short at many lengths and files with
// bytes changed at many places, for several kinds of file. Opening and reading each one must either work or throw a
// FileError naming the file — never crash, hang, throw anything else or touch memory it should not (the debug build
// runs this under AddressSanitizer and UndefinedBehaviorSanitizer).

#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "io/ImageReader.h"
#include "io/exr/ExrReader.h"
#include "support/exr/ExrFixture.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace pf::io {
namespace {

using testing::ExrChannelSpec;
using testing::ExrPartSpec;
using testing::ExrSample;
using testing::ExrStorage;

struct Outcome {
    int opened = 0;
    int read = 0;
    int refused = 0;
};

// Opens and reads a (possibly damaged) file the way the app does; anything but success or a FileError naming the
// file fails the test. Reads stay within the original frame plus a margin, as a viewer's would, so a damaged header
// claiming a huge image cannot make the test allocate it.
void tryFile(const std::filesystem::path& file, const image::Rect& frame, Outcome& outcome) {
    try {
        const std::unique_ptr<ImageReader> reader = openExr(file);
        ++outcome.opened;
        const image::Rect region = image::pad(frame, 64);
        // Every eighth file on threads (failures inside parallel decoding), the others on this thread (fast).
        const bool threaded = (outcome.opened % 8) == 0;
        (void)reader->read(reader->info().channels, region, threaded ? testing::testThreads(3) : ParallelFor{});
        ++outcome.read;
    } catch (const FileError& error) {
        ++outcome.refused;
        const std::string message = error.what();
        EXPECT_NE(message.find(file.filename().string()), std::string::npos) << message;
    } catch (const std::exception& error) {
        ADD_FAILURE() << "unexpected exception: " << error.what();
    }
}

// Lengths to cut files at: every byte through the first header, then steps of 7, then of 61 through the pixel data.
std::size_t nextLength(std::size_t length) {
    if (length < 450) {
        return length + 1;
    }
    return length + (length < 1500 ? 7 : 61);
}

// Small files of several kinds, so that cuts and damage reach every part of the format.
std::vector<std::vector<ExrPartSpec>> kindsOfFile() {
    const image::Rect frame{.x0 = 0, .y0 = 0, .x1 = 24, .y1 = 18};
    const auto part = [&](int compression, ExrStorage storage) {
        ExrPartSpec spec;
        spec.displayWindow = frame;
        spec.dataWindow = {.x0 = -2, .y0 = -1, .x1 = 25, .y1 = 19};
        spec.compression = compression;
        spec.storage = storage;
        spec.tileWidth = 8;
        spec.tileHeight = 4;
        spec.channels = {{.name = "R"},
                         {.name = "G"},
                         {.name = "Z", .type = ExrSample::Float},
                         {.name = "id", .type = ExrSample::UInt}};
        return spec;
    };
    std::vector<std::vector<ExrPartSpec>> kinds;
    kinds.push_back({part(3, ExrStorage::Scanline)});  // ZIP
    kinds.push_back({part(4, ExrStorage::Tiled)});     // PIZ, tiled
    kinds.push_back({part(8, ExrStorage::Scanline)});  // DWAA
    kinds.push_back({part(6, ExrStorage::Tiled)});     // B44, tiled
    kinds.push_back({part(10, ExrStorage::Scanline)}); // HTJ2K
    kinds.push_back({part(1, ExrStorage::Scanline)});  // RLE
    ExrPartSpec mip = part(13, ExrStorage::Tiled);     // ZSTD, mipmaps
    mip.levels = testing::ExrLevels::Mipmap;
    kinds.push_back({mip});
    std::vector<ExrPartSpec> multi{part(2, ExrStorage::Scanline), part(5, ExrStorage::Tiled)}; // ZIPS + PXR24
    multi[0].name = "beauty";
    multi[1].name = "data";
    for (ExrChannelSpec& channel : multi[1].channels) {
        channel.name = "data." + channel.name;
    }
    kinds.push_back(multi);
    std::vector<ExrPartSpec> deep{part(3, ExrStorage::Scanline), part(2, ExrStorage::DeepScanline)};
    deep[0].name = "flat";
    deep[1].name = "deep";
    deep[1].channels = {{.name = "deep.Z", .type = ExrSample::Float}};
    kinds.push_back(deep);
    return kinds;
}

TEST(ExrDamagedFile, FilesCutShortAtAnyLength) {
    const testing::TemporaryFolder folder;
    Outcome outcome;
    for (const std::vector<ExrPartSpec>& kind : kindsOfFile()) {
        testing::writeExrFixture(folder.file("whole.exr"), kind);
        const std::vector<std::uint8_t> whole = testing::readBytes(folder.file("whole.exr"));
        // Every length through the first header (about 400 bytes for these files), then steps through the other
        // headers, the chunk tables and the pixel data.
        std::vector<std::size_t> lengths;
        for (std::size_t length = 0; length < whole.size(); length = nextLength(length)) {
            lengths.push_back(length);
        }
        for (const std::size_t length : lengths) {
            testing::writeBytes(
                folder.file("cut.exr"),
                std::vector<std::uint8_t>(whole.begin(), whole.begin() + static_cast<std::ptrdiff_t>(length)));
            tryFile(folder.file("cut.exr"), kind.front().displayWindow, outcome);
        }
    }
    EXPECT_GT(outcome.refused, 0);
    EXPECT_GT(outcome.opened, 0) << "files cut inside the pixel data still open";
}

TEST(ExrDamagedFile, FilesWithChangedBytes) {
    const testing::TemporaryFolder folder;
    Outcome outcome;
    std::uint32_t state = 2026;
    const auto next = [&state] { // a fixed sequence of pseudo-random numbers
        state = (state * 1664525U) + 1013904223U;
        return state >> 8U;
    };
    for (const std::vector<ExrPartSpec>& kind : kindsOfFile()) {
        testing::writeExrFixture(folder.file("whole.exr"), kind);
        const std::vector<std::uint8_t> whole = testing::readBytes(folder.file("whole.exr"));
        for (int variant = 0; variant < 300; ++variant) {
            std::vector<std::uint8_t> bytes = whole;
            // Mostly the header and tables (where damage changes how the rest is read), sometimes the pixel data.
            const std::size_t limit = variant % 3 == 0 ? bytes.size() : std::min<std::size_t>(bytes.size(), 1500);
            const int changes = 1 + static_cast<int>(next() % 4);
            for (int c = 0; c < changes; ++c) {
                const std::size_t at = next() % limit;
                switch (next() % 4) {
                case 0:
                    bytes[at] = static_cast<std::uint8_t>(bytes[at] ^ (1U << (next() % 8))); // one bit
                    break;
                case 1:
                    bytes[at] = 0xFF;
                    break;
                case 2:
                    bytes[at] = 0x00;
                    break;
                default:
                    bytes[at] = static_cast<std::uint8_t>(next());
                    break;
                }
            }
            testing::writeBytes(folder.file("changed.exr"), bytes);
            tryFile(folder.file("changed.exr"), kind.front().displayWindow, outcome);
        }
    }
    EXPECT_GT(outcome.refused, 0);
    EXPECT_GT(outcome.read, 0);
}

} // namespace
} // namespace pf::io
