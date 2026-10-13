// The EXR reader (docs/specs/exr-reading.md): opening, every compression in scanline and tiled parts, windows,
// regions, channel subsets, multi-part and multi-view naming, lazy reading, concurrency, deep and subsampled parts,
// tile levels, line orders and the coordinate limit. Files are written with OpenEXR's own high-level library
// (support/exr/ExrFixture.h); lossy compressions are checked against OpenEXR's own decoding of the same file.

#include "io/exr/ExrReader.h"

#include "core/image/ChannelSet.h"
#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "io/Formats.h"
#include "io/ImageReader.h"
#include "support/exr/ExrFixture.h"
#include "support/golden/ExrFile.h"
#include "support/nodes/TestBench.h"

#include <OpenEXR/ImfHeader.h>
#include <gtest/gtest.h>

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace pf::io {
namespace {

using image::ChannelSet;
using image::Image;
using image::Rect;
using testing::ExrChannelSpec;
using testing::ExrLevels;
using testing::ExrLineOrder;
using testing::ExrPartSpec;
using testing::ExrPattern;
using testing::ExrSample;
using testing::ExrStorage;
using testing::matchesFixture;
using testing::sameImage;

Image readAll(const ImageReader& reader, const ParallelFor& parallel = {}) {
    return reader.read(reader.info().channels, reader.info().dataWindow, parallel);
}

// A render-like part: colour and alpha in half, depth in float, an object ID in uint; overscan with a negative origin.
ExrPartSpec renderPart(int compression, ExrStorage storage, bool specials) {
    ExrPartSpec part;
    part.displayWindow = {.x0 = 0, .y0 = 0, .x1 = 48, .y1 = 40};
    part.dataWindow = {.x0 = -3, .y0 = -2, .x1 = 51, .y1 = 42};
    part.compression = compression;
    part.storage = storage;
    const ExrPattern colour = specials ? ExrPattern::ValuesAndSpecials : ExrPattern::Values;
    part.channels = {{.name = "R", .type = ExrSample::Half, .pattern = colour},
                     {.name = "G", .type = ExrSample::Half},
                     {.name = "B", .type = ExrSample::Half},
                     {.name = "A", .type = ExrSample::Half},
                     {.name = "Z", .type = ExrSample::Float, .pattern = colour},
                     {.name = "objectId", .type = ExrSample::UInt}};
    return part;
}

std::string compressionLabel(int compression) {
    static const std::vector<std::string> names{"none", "rle",  "zips", "zip",      "piz",     "pxr24", "b44",
                                                "b44a", "dwaa", "dwab", "htj2k256", "htj2k32", "lj2k",  "zstd"};
    return names.at(static_cast<std::size_t>(compression));
}

bool isLossy(int compression) {
    return compression == 5 || compression == 6 || compression == 7 || compression == 8 || compression == 9 ||
           compression == 12;
}

TEST(ExrReader, OpensTheHeaderAndDescribesTheFile) {
    const testing::TemporaryFolder folder;
    const ExrPartSpec part = renderPart(3, ExrStorage::Scanline, false);
    testing::writeExrFixture(folder.file("render.exr"), part);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("render.exr"));
    const ImageFileInfo& info = reader->info();
    EXPECT_EQ(info.displayWindow, (Rect{.x0 = 0, .y0 = 0, .x1 = 48, .y1 = 40}));
    EXPECT_EQ(info.dataWindow, (Rect{.x0 = -3, .y0 = -2, .x1 = 51, .y1 = 42}));
    EXPECT_EQ(info.channels.names(), (std::vector<std::string>{"R", "G", "B", "A", "Z", "objectId"}));
    ASSERT_EQ(info.fileChannels.size(), 6U);
    EXPECT_EQ(info.fileChannels[0].name, "R");
    EXPECT_EQ(info.fileChannels[0].type, StoredType::Half);
    EXPECT_EQ(info.fileChannels[4].type, StoredType::Float32);
    EXPECT_EQ(info.fileChannels[5].type, StoredType::UInt32);
    EXPECT_DOUBLE_EQ(info.pixelAspectRatio, 1.0);
    EXPECT_TRUE(info.views.empty());
    EXPECT_TRUE(info.notes.empty());
    ASSERT_EQ(info.metadata.size(), 1U);
    EXPECT_NE(info.metadata[0].find("compression"), nullptr);
    EXPECT_EQ(info.metadata[0].find("compression")->text, "ZIP");
    EXPECT_EQ(reader->statistics().blocksDecoded, 0U) << "opening must not decode pixels";
}

// ---- every compression, scanline and tiled

struct CompressionCase {
    int compression = 0;
    ExrStorage storage = ExrStorage::Scanline;
};

class ExrCompression : public ::testing::TestWithParam<CompressionCase> {};

TEST_P(ExrCompression, ReadsWhatOpenExrWrote) {
    const auto [compression, storage] = GetParam();
    const testing::TemporaryFolder folder;
    const bool lossy = isLossy(compression);
    const ExrPartSpec part = renderPart(compression, storage, !lossy);
    const std::filesystem::path file = folder.file("render.exr");
    testing::writeExrFixture(file, part);

    const std::unique_ptr<ImageReader> reader = openExr(file);
    const Image image = readAll(*reader);
    ASSERT_EQ(image.dataWindow(), part.dataWindow);
    if (!lossy) {
        for (const ExrChannelSpec& channel : part.channels) {
            EXPECT_TRUE(matchesFixture(image, channel.name, channel, part.dataWindow));
        }
        return;
    }
    // Lossy: exactly what OpenEXR's own reader decodes, and close to what was written on average (catches mixed-up
    // channels; the pattern is deliberately noisy, which block compressions such as B44 handle poorly per pixel).
    const golden::Image reference = golden::readExr(file);
    for (const ExrChannelSpec& channel : part.channels) {
        const golden::Channel& expected = reference.channel(channel.name);
        std::size_t wrong = 0;
        double error = 0.0;
        double magnitude = 0.0;
        for (int y = part.dataWindow.y0; y < part.dataWindow.y1; ++y) {
            for (int x = part.dataWindow.x0; x < part.dataWindow.x1; ++x) {
                const float actual = image.sample(channel.name, x, y);
                const float decoded = expected.samples[reference.indexOf(x, y)];
                if (std::bit_cast<std::uint32_t>(actual) != std::bit_cast<std::uint32_t>(decoded) &&
                    !(std::isnan(actual) && std::isnan(decoded))) {
                    ++wrong;
                }
                const float written = testing::exrFixtureValue(channel, x, y);
                error += std::abs(static_cast<double>(actual) - static_cast<double>(written));
                magnitude += std::abs(static_cast<double>(written));
            }
        }
        EXPECT_EQ(wrong, 0U) << channel.name << ": samples differ from OpenEXR's own decoding";
        EXPECT_LT(error, 0.1 * magnitude) << channel.name << ": too far from the written values on average";
    }
}

std::vector<CompressionCase> allCompressions() {
    std::vector<CompressionCase> cases;
    for (int compression = 0; compression <= 13; ++compression) {
        cases.push_back({.compression = compression, .storage = ExrStorage::Scanline});
        cases.push_back({.compression = compression, .storage = ExrStorage::Tiled});
    }
    return cases;
}

INSTANTIATE_TEST_SUITE_P(AllCompressions, ExrCompression, ::testing::ValuesIn(allCompressions()),
                         [](const ::testing::TestParamInfo<CompressionCase>& test) {
                             return compressionLabel(test.param.compression) +
                                    (test.param.storage == ExrStorage::Tiled ? "_tiled" : "_scanline");
                         });

// ---- regions and channels

TEST(ExrReader, RegionsAndChannelSubsetsMatchTheWholeImage) {
    const testing::TemporaryFolder folder;
    for (const ExrStorage storage : {ExrStorage::Scanline, ExrStorage::Tiled}) {
        ExrPartSpec part = renderPart(4, storage, false); // PIZ: 32-line chunks
        part.dataWindow = {.x0 = -7, .y0 = -5, .x1 = 300, .y1 = 140};
        part.displayWindow = {.x0 = 0, .y0 = 0, .x1 = 290, .y1 = 130};
        testing::writeExrFixture(folder.file("big.exr"), part);
        const std::unique_ptr<ImageReader> reader = openExr(folder.file("big.exr"));
        const Image whole = readAll(*reader);

        const std::vector<Rect> regions{{.x0 = 0, .y0 = 0, .x1 = 1, .y1 = 1},
                                        {.x0 = 250, .y0 = 31, .x1 = 290, .y1 = 33},
                                        {.x0 = -100, .y0 = -100, .x1 = 10, .y1 = 10},
                                        {.x0 = 31, .y0 = 15, .x1 = 257, .y1 = 97},
                                        {.x0 = 299, .y0 = 139, .x1 = 400, .y1 = 400}};
        for (const Rect& region : regions) {
            const Image piece = reader->read({"G", "objectId"}, region, {});
            const Rect expectedWindow = image::intersect(region, part.dataWindow);
            ASSERT_EQ(piece.dataWindow(), expectedWindow) << image::toString(region);
            // The same pixels as the whole image cut to the region.
            Image cut(whole.displayWindow(), expectedWindow, {"G", "objectId"});
            cut.copyChannel(whole, "G", "G");
            cut.copyChannel(whole, "objectId", "objectId");
            EXPECT_TRUE(sameImage(piece, cut)) << image::toString(region);
        }
        // Outside the data window and unknown channels: nothing.
        EXPECT_TRUE(reader->read({"G"}, {.x0 = 1000, .y0 = 0, .x1 = 1010, .y1 = 10}, {}).dataWindow().isEmpty());
        EXPECT_TRUE(reader->read({"nope"}, part.dataWindow, {}).channels().empty());
    }
}

TEST(ExrReader, ReadingWithManyThreadsGivesTheSamePixels) {
    const testing::TemporaryFolder folder;
    for (const int compression : {2, 3, 8, 9}) { // ZIPS (1 line), ZIP (16), DWAA (32), DWAB (256)
        for (const ExrStorage storage : {ExrStorage::Scanline, ExrStorage::Tiled}) {
            ExrPartSpec part = renderPart(compression, storage, false);
            part.dataWindow = {.x0 = 0, .y0 = 0, .x1 = 700, .y1 = 600};
            part.displayWindow = part.dataWindow;
            part.tileWidth = 64;
            part.tileHeight = 64;
            testing::writeExrFixture(folder.file("threads.exr"), part);
            const std::unique_ptr<ImageReader> reader = openExr(folder.file("threads.exr"));
            const Image serial = readAll(*reader);
            EXPECT_TRUE(sameImage(readAll(*reader, testing::testThreads(8)), serial)) << compression;

            // Several reads of one open file at the same time, each spread over threads itself.
            std::vector<Image> results(4);
            std::vector<std::thread> readers;
            readers.reserve(results.size());
            for (Image& result : results) {
                readers.emplace_back([&] { result = readAll(*reader, testing::testThreads(3)); });
            }
            for (std::thread& thread : readers) {
                thread.join();
            }
            for (const Image& result : results) {
                EXPECT_TRUE(sameImage(result, serial)) << compression;
            }
        }
    }
}

// ---- multi-part files

TEST(ExrReader, PartsWithDifferentDataWindowsAreReadIntoOneImage) {
    const testing::TemporaryFolder folder;
    ExrPartSpec beauty;
    beauty.name = "beauty";
    beauty.dataWindow = {.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 48};
    beauty.channels = {{.name = "R"}, {.name = "G"}, {.name = "B"}};
    ExrPartSpec crop;
    crop.name = "crop";
    crop.dataWindow = {.x0 = 40, .y0 = 30, .x1 = 90, .y1 = 70}; // reaches beyond the frame
    crop.channels = {{.name = "crop.Y", .type = ExrSample::Float}};
    crop.compression = 4;
    testing::writeExrFixture(folder.file("parts.exr"), std::vector<ExrPartSpec>{beauty, crop});

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("parts.exr"));
    const ImageFileInfo& info = reader->info();
    EXPECT_EQ(info.dataWindow, (Rect{.x0 = 0, .y0 = 0, .x1 = 90, .y1 = 70}));
    EXPECT_EQ(info.channels.names(), (std::vector<std::string>{"R", "G", "B", "crop.Y"}));
    ASSERT_EQ(info.metadata.size(), 2U);
    EXPECT_EQ(info.metadata[0].name, "beauty");
    EXPECT_EQ(info.metadata[1].name, "crop");
    EXPECT_EQ(info.fileChannels[3].part, 1U);

    const Image image = readAll(*reader);
    EXPECT_TRUE(matchesFixture(image, "G", beauty.channels[1], beauty.dataWindow));
    EXPECT_TRUE(matchesFixture(image, "crop.Y", crop.channels[0], crop.dataWindow));
}

TEST(ExrReader, ReadsOnlyThePartsAndBlocksARequestNeeds) {
    const testing::TemporaryFolder folder;
    ExrPartSpec first;
    first.name = "first";
    first.dataWindow = {.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 64};
    first.channels = {{.name = "first.R"}, {.name = "first.G"}};
    ExrPartSpec second = first;
    second.name = "second";
    second.channels = {{.name = "second.Z", .type = ExrSample::Float}};
    testing::writeExrFixture(folder.file("lazy.exr"), std::vector<ExrPartSpec>{first, second}); // ZIP: 16 lines

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("lazy.exr"));
    const Image all = reader->read({"second.Z"}, first.dataWindow, {});
    EXPECT_EQ(reader->statistics().blocksDecoded, 4U) << "only the second part's four chunks";
    EXPECT_GT(reader->statistics().bytesRead, 0U);
    EXPECT_TRUE(matchesFixture(all, "second.Z", second.channels[0], second.dataWindow));

    (void)reader->read({"first.R"}, {.x0 = 10, .y0 = 16, .x1 = 20, .y1 = 32}, {});
    EXPECT_EQ(reader->statistics().blocksDecoded, 5U) << "rows 16–31 are one chunk";
    (void)reader->read({"first.R", "first.G", "second.Z"}, {.x0 = 0, .y0 = 15, .x1 = 64, .y1 = 17}, {});
    EXPECT_EQ(reader->statistics().blocksDecoded, 9U) << "rows 15–16 touch two chunks in each part";
}

TEST(ExrReader, BlenderStyleMultiPartNamesAreKept) {
    const testing::TemporaryFolder folder;
    std::vector<ExrPartSpec> parts(3);
    parts[0].name = "ViewLayer.Combined";
    parts[0].channels = {{.name = "ViewLayer.Combined.A"},
                         {.name = "ViewLayer.Combined.B"},
                         {.name = "ViewLayer.Combined.G"},
                         {.name = "ViewLayer.Combined.R"}};
    parts[1].name = "ViewLayer.Depth";
    parts[1].channels = {{.name = "ViewLayer.Depth.Z", .type = ExrSample::Float}};
    parts[2].name = "ViewLayer.CryptoObject00";
    for (const char* suffix : {"r", "g", "b", "a"}) {
        parts[2].channels.push_back({.name = std::string("ViewLayer.CryptoObject00.") + suffix,
                                     .type = ExrSample::Float,
                                     .pattern = ExrPattern::IdBits});
    }
    for (ExrPartSpec& part : parts) {
        part.compression = 8; // DWAA, as Blender writes by default; data channels stay lossless
    }
    testing::writeExrFixture(folder.file("cycles.exr"), parts);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("cycles.exr"));
    EXPECT_EQ(
        reader->info().channels.names(),
        (std::vector<std::string>{"ViewLayer.Combined.R", "ViewLayer.Combined.G", "ViewLayer.Combined.B",
                                  "ViewLayer.Combined.A", "ViewLayer.CryptoObject00.r", "ViewLayer.CryptoObject00.g",
                                  "ViewLayer.CryptoObject00.b", "ViewLayer.CryptoObject00.a", "ViewLayer.Depth.Z"}));
    EXPECT_TRUE(reader->info().notes.empty());
    // IDs must come through bit for bit (DWA keeps non-colour channels lossless).
    const Image ids = reader->read({"ViewLayer.CryptoObject00.r", "ViewLayer.CryptoObject00.b"},
                                   reader->info().dataWindow, testing::testThreads(4));
    EXPECT_TRUE(matchesFixture(ids, "ViewLayer.CryptoObject00.r", parts[2].channels[0], parts[2].dataWindow));
    EXPECT_TRUE(matchesFixture(ids, "ViewLayer.CryptoObject00.b", parts[2].channels[2], parts[2].dataWindow));
}

TEST(ExrReader, ClashingNamesInPartsArePrefixedWithThePartName) {
    const testing::TemporaryFolder folder;
    std::vector<ExrPartSpec> parts(2);
    parts[0].name = "diffuse";
    parts[0].channels = {{.name = "R"}, {.name = "G"}, {.name = "B"}};
    parts[1].name = "specular"; // the same names with other values
    for (const char* name : {"R", "G", "B"}) {
        parts[1].channels.push_back({.name = name, .type = ExrSample::Float, .pattern = ExrPattern::IdBits});
    }
    testing::writeExrFixture(folder.file("clash.exr"), parts);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("clash.exr"));
    const ImageFileInfo& info = reader->info();
    EXPECT_EQ(info.channels.names(),
              (std::vector<std::string>{"R", "G", "B", "specular.R", "specular.G", "specular.B"}));
    ASSERT_EQ(info.notes.size(), 3U);
    EXPECT_NE(info.notes[0].find("shown as 'specular."), std::string::npos) << info.notes[0];
    const auto specularR = std::ranges::find(info.fileChannels, "specular.R", &FileChannel::name);
    ASSERT_NE(specularR, info.fileChannels.end());
    EXPECT_EQ(specularR->storedName, "R");
    EXPECT_EQ(specularR->part, 1U);
    const Image image = readAll(*reader);
    EXPECT_TRUE(matchesFixture(image, "specular.R", parts[1].channels[0], parts[1].dataWindow));
    EXPECT_TRUE(matchesFixture(image, "R", parts[0].channels[0], parts[0].dataWindow));
}

// ---- views

TEST(ExrReader, ViewsInOnePartGiveTheDefaultViewPlainNames) {
    const testing::TemporaryFolder folder;
    ExrPartSpec part;
    part.multiView = {"left", "right"};
    part.channels = {{.name = "R"},
                     {.name = "right.R"},
                     {.name = "left.Z", .type = ExrSample::Float},
                     {.name = "right.Z", .type = ExrSample::Float},
                     {.name = "diffuse.left.G"},
                     {.name = "diffuse.right.G"},
                     {.name = "tmp.B"}};
    testing::writeExrFixture(folder.file("stereo.exr"), part);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("stereo.exr"));
    const ImageFileInfo& info = reader->info();
    EXPECT_EQ(info.views, (std::vector<std::string>{"left", "right"}));
    EXPECT_EQ(info.channels.names(),
              (std::vector<std::string>{"R", "Z", "diffuse.G", "diffuse.right.G", "right.R", "right.Z", "tmp.B"}));
    const auto view = [&](const std::string& name) {
        return std::ranges::find(info.fileChannels, name, &FileChannel::name)->view;
    };
    EXPECT_EQ(view("Z"), "");
    EXPECT_EQ(view("right.Z"), "right");
    EXPECT_EQ(view("diffuse.right.G"), "right");
    EXPECT_EQ(view("tmp.B"), "");
    const Image image = readAll(*reader);
    EXPECT_TRUE(matchesFixture(image, "Z", part.channels[2], part.dataWindow));
    EXPECT_TRUE(matchesFixture(image, "diffuse.G", part.channels[4], part.dataWindow));
    EXPECT_TRUE(matchesFixture(image, "diffuse.right.G", part.channels[5], part.dataWindow));
}

TEST(ExrReader, ViewsInPartsAreNamedLikeViewsInOnePart) {
    const testing::TemporaryFolder folder;
    std::vector<ExrPartSpec> parts(3);
    parts[0].name = "rgba.left";
    parts[0].view = "left";
    parts[0].channels = {{.name = "R"}, {.name = "G"}, {.name = "diffuse.R"}};
    parts[1].name = "rgba.right";
    parts[1].view = "right";
    for (const char* name : {"R", "G", "diffuse.R"}) { // the same names with other values
        parts[1].channels.push_back({.name = name, .type = ExrSample::Float, .pattern = ExrPattern::IdBits});
    }
    parts[2].name = "depth";
    parts[2].channels = {{.name = "Z", .type = ExrSample::Float}};
    testing::writeExrFixture(folder.file("stereo.exr"), parts);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("stereo.exr"));
    const ImageFileInfo& info = reader->info();
    EXPECT_EQ(info.views, (std::vector<std::string>{"left", "right"}));
    EXPECT_EQ(info.channels.names(),
              (std::vector<std::string>{"R", "G", "Z", "diffuse.R", "diffuse.right.R", "right.R", "right.G"}));
    const Image image = readAll(*reader);
    EXPECT_TRUE(matchesFixture(image, "right.G", parts[1].channels[1], parts[1].dataWindow));
    EXPECT_TRUE(matchesFixture(image, "diffuse.right.R", parts[1].channels[2], parts[1].dataWindow));
    EXPECT_TRUE(matchesFixture(image, "diffuse.R", parts[0].channels[2], parts[0].dataWindow));
}

// ---- deep, subsampled, levels, line orders

TEST(ExrReader, DeepPartsAreReportedAndFlatPartsStillRead) {
    const testing::TemporaryFolder folder;
    std::vector<ExrPartSpec> parts(2);
    parts[0].name = "flat";
    parts[0].channels = {{.name = "R"}, {.name = "A"}};
    parts[1].name = "deep";
    parts[1].storage = ExrStorage::DeepScanline;
    parts[1].compression = 2; // deep data allows none, RLE, ZIPS and ZIP
    parts[1].channels = {{.name = "deep.A", .type = ExrSample::Float}, {.name = "deep.Z", .type = ExrSample::Float}};
    testing::writeExrFixture(folder.file("deep.exr"), parts);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("deep.exr"));
    EXPECT_EQ(reader->info().channels.names(), (std::vector<std::string>{"R", "A"}));
    ASSERT_EQ(reader->info().notes.size(), 1U);
    EXPECT_EQ(reader->info().notes[0], "part 'deep' holds deep data, which is not read yet");
    EXPECT_TRUE(matchesFixture(readAll(*reader), "R", parts[0].channels[0], parts[0].dataWindow));

    testing::writeExrFixture(folder.file("deep_only.exr"), parts[1]);
    const std::unique_ptr<ImageReader> deepOnly = openExr(folder.file("deep_only.exr"));
    EXPECT_TRUE(deepOnly->info().channels.empty());
    EXPECT_EQ(deepOnly->info().dataWindow, parts[1].dataWindow) << "the size still shows";
    EXPECT_EQ(deepOnly->info().notes, (std::vector<std::string>{"the file holds deep data, which is not read yet"}));
    EXPECT_TRUE(readAll(*deepOnly).channels().empty());
}

TEST(ExrReader, SubsampledChannelsAreLeftOutWithANote) {
    const testing::TemporaryFolder folder;
    ExrPartSpec part;
    part.channels = {
        {.name = "Y"}, {.name = "RY", .xSampling = 2, .ySampling = 2}, {.name = "BY", .xSampling = 2, .ySampling = 2}};
    testing::writeExrFixture(folder.file("yc.exr"), part);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("yc.exr"));
    EXPECT_EQ(reader->info().channels.names(), (std::vector<std::string>{"Y"}));
    EXPECT_EQ(reader->info().notes.size(), 2U);
    EXPECT_TRUE(matchesFixture(readAll(*reader), "Y", part.channels[0], part.dataWindow));
}

TEST(ExrReader, TileLevelsAndLineOrders) {
    const testing::TemporaryFolder folder;
    for (const ExrLevels levels : {ExrLevels::Mipmap, ExrLevels::Ripmap}) {
        ExrPartSpec part = renderPart(4, ExrStorage::Tiled, true);
        part.levels = levels;
        testing::writeExrFixture(folder.file("levels.exr"), part);
        const Image image = readAll(*openExr(folder.file("levels.exr")));
        for (const ExrChannelSpec& channel : part.channels) {
            EXPECT_TRUE(matchesFixture(image, channel.name, channel, part.dataWindow)) << "levels";
        }
    }
    ExrPartSpec decreasing = renderPart(3, ExrStorage::Scanline, true);
    decreasing.lineOrder = ExrLineOrder::DecreasingY;
    ExrPartSpec random = renderPart(3, ExrStorage::Tiled, true);
    random.lineOrder = ExrLineOrder::RandomY;
    for (const ExrPartSpec& part : {decreasing, random}) {
        testing::writeExrFixture(folder.file("order.exr"), part);
        const Image image = readAll(*openExr(folder.file("order.exr")), testing::testThreads(4));
        for (const ExrChannelSpec& channel : part.channels) {
            EXPECT_TRUE(matchesFixture(image, channel.name, channel, part.dataWindow)) << "line order";
        }
    }
}

// ---- windows and the frame

TEST(ExrReader, DataWindowsAnywhereAndThePixelAspectRatio) {
    const testing::TemporaryFolder folder;
    ExrPartSpec part;
    part.displayWindow = {.x0 = 0, .y0 = 0, .x1 = 1920, .y1 = 1080};
    part.dataWindow = {.x0 = -500, .y0 = 2000, .x1 = -470, .y1 = 2010}; // entirely outside the frame
    part.channels = {{.name = "R"}};
    part.decorate = [](Imf::Header& header) { header.pixelAspectRatio() = 2.0F; };
    testing::writeExrFixture(folder.file("outside.exr"), part);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("outside.exr"));
    EXPECT_EQ(reader->info().displayWindow, part.displayWindow);
    EXPECT_EQ(reader->info().dataWindow, part.dataWindow);
    EXPECT_DOUBLE_EQ(reader->info().pixelAspectRatio, 2.0);
    EXPECT_TRUE(matchesFixture(readAll(*reader), "R", part.channels[0], part.dataWindow));
}

TEST(ExrReader, WindowsBeyondTheCoordinateLimitAreRefused) {
    const testing::TemporaryFolder folder;
    ExrPartSpec part;
    part.channels = {{.name = "R"}};
    testing::writeExrFixture(folder.file("huge.exr"), part);
    // Move the data window's left edge to −1,000,000,000 in the header (the row count, and so the file's layout,
    // stays the same).
    std::vector<std::uint8_t> bytes = testing::readBytes(folder.file("huge.exr"));
    const std::string key = std::string("dataWindow") + '\0' + "box2i" + '\0';
    const auto found = std::ranges::search(bytes, key).begin();
    ASSERT_NE(found, bytes.end());
    const auto offset = static_cast<std::size_t>(found - bytes.begin()) + key.size() + 4; // after the size field
    const std::int32_t farLeft = -1'000'000'000;
    std::memcpy(&bytes[offset], &farLeft, sizeof(farLeft));
    testing::writeBytes(folder.file("huge.exr"), bytes);

    try {
        (void)openExr(folder.file("huge.exr"));
        FAIL() << "a window beyond the limit must be refused";
    } catch (const FileError& error) {
        EXPECT_NE(std::string(error.what()).find("beyond 536,870,912 pixels"), std::string::npos) << error.what();
    }
}

// ---- opening through the registry, and files that are not EXR

TEST(ExrReader, TheFormatRegistryOpensExrFiles) {
    const testing::TemporaryFolder folder;
    ExrPartSpec part;
    part.channels = {{.name = "R"}};
    testing::writeExrFixture(folder.file("Frame 01.EXR"), part);
    FormatRegistry formats;
    addBuiltinFormats(formats);
    ASSERT_NE(formats.formatFor("shot.exr"), nullptr);
    EXPECT_EQ(formats.formatFor("shot.exr")->name, "OpenEXR");
    EXPECT_EQ(formats.open(folder.file("Frame 01.EXR"))->info().channels, (ChannelSet{"R"}));
}

TEST(ExrReader, FilesThatAreNotExrGiveClearErrors) {
    const testing::TemporaryFolder folder;
    const auto messageOf = [](const std::filesystem::path& file) {
        try {
            (void)openExr(file);
        } catch (const FileError& error) {
            return std::string(error.what());
        }
        return std::string("(opened)");
    };
    const std::string missing = messageOf(folder.file("missing.exr"));
    EXPECT_NE(missing.find("missing.exr"), std::string::npos) << missing;
    EXPECT_NE(missing.find("cannot be read"), std::string::npos) << missing;

    testing::writeBytes(folder.file("text.exr"), std::vector<std::uint8_t>{'h', 'e', 'l', 'l', 'o'});
    const std::string text = messageOf(folder.file("text.exr"));
    EXPECT_NE(text.find("text.exr"), std::string::npos) << text;
    EXPECT_NE(text.find("not an OpenEXR file"), std::string::npos) << text;

    testing::writeBytes(folder.file("empty.exr"), {});
    EXPECT_NE(messageOf(folder.file("empty.exr")).find("empty.exr"), std::string::npos);
}

TEST(ExrReader, MissingBlocksNameTheRowsAndThePart) {
    const testing::TemporaryFolder folder;
    std::vector<ExrPartSpec> parts(2);
    parts[0].name = "beauty";
    parts[0].channels = {{.name = "R"}};
    parts[1].name = "ViewLayer.Combined";
    parts[1].channels = {{.name = "ViewLayer.Combined.R"}};
    parts[1].compression = 4; // PIZ: 32 lines per chunk
    testing::writeExrFixture(folder.file("cut.exr"), parts);
    std::vector<std::uint8_t> bytes = testing::readBytes(folder.file("cut.exr"));
    bytes.resize(bytes.size() - 40); // the last chunk (the second part's rows 32–47) is cut short
    testing::writeBytes(folder.file("cut.exr"), bytes);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("cut.exr"));
    EXPECT_NO_THROW((void)reader->read({"R"}, reader->info().dataWindow, {})) << "the first part is complete";
    EXPECT_NO_THROW((void)reader->read({"ViewLayer.Combined.R"}, {.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 32}, {}));
    try {
        (void)reader->read({"ViewLayer.Combined.R"}, reader->info().dataWindow, testing::testThreads(2));
        FAIL() << "the cut rows must be an error";
    } catch (const FileError& error) {
        const std::string message = error.what();
        EXPECT_NE(message.find("cannot read "), std::string::npos) << message;
        EXPECT_NE(message.find("cut.exr"), std::string::npos) << message;
        EXPECT_NE(message.find("rows 32–47 of part 'ViewLayer.Combined'"), std::string::npos) << message;
    }
}

// ---- the owner's Cycles render (tests/fixtures/README.md), where it exists

std::unique_ptr<ImageReader> openOwnersRender() {
    const std::filesystem::path file = std::filesystem::path(PF_SOURCE_DIR) / "blender render" / "render0001.exr";
    return std::filesystem::exists(file) ? openExr(file) : nullptr;
}

TEST(ExrReader, OwnersCyclesRenderIsDescribed) {
    const std::unique_ptr<ImageReader> reader = openOwnersRender();
    if (!reader) {
        GTEST_SKIP() << "the owner's render is not on this machine";
    }
    const ImageFileInfo& info = reader->info();
    EXPECT_EQ(info.displayWindow, (Rect{.x0 = 0, .y0 = 0, .x1 = 1920, .y1 = 1080}));
    EXPECT_EQ(info.metadata.size(), 13U);
    EXPECT_TRUE(info.notes.empty());
    EXPECT_TRUE(info.channels.contains("ViewLayer.Combined.R"));
    EXPECT_TRUE(info.channels.contains("ViewLayer.Depth.Z"));
    EXPECT_TRUE(info.channels.contains("ViewLayer.CryptoObject00.r"));
}

TEST(ExrReader, OwnersCyclesRenderMetadata) {
    const std::unique_ptr<ImageReader> reader = openOwnersRender();
    if (!reader) {
        GTEST_SKIP() << "the owner's render is not on this machine";
    }
    const ImageFileInfo& info = reader->info();
    const MetadataEntry* software = info.metadata[0].find("Software");
    ASSERT_NE(software, nullptr);
    EXPECT_EQ(software->text.rfind("Blender", 0), 0U);
    const MetadataEntry* colour = info.metadata[2].find("colorInteropID");
    ASSERT_NE(colour, nullptr);
    EXPECT_EQ(colour->text, "data");
}

TEST(ExrReader, OwnersCyclesRenderReadsOnePass) {
    const std::unique_ptr<ImageReader> reader = openOwnersRender();
    if (!reader) {
        GTEST_SKIP() << "the owner's render is not on this machine";
    }
    const Image depth = reader->read({"ViewLayer.Depth.Z"}, reader->info().dataWindow, testing::testThreads(8));
    EXPECT_EQ(reader->statistics().blocksDecoded, 34U) << "the depth part only";
    std::vector<float> samples(static_cast<std::size_t>(depth.dataWindow().area()));
    depth.read(0, depth.dataWindow(), samples, static_cast<std::size_t>(depth.dataWindow().width()));
    EXPECT_GT(*std::ranges::min_element(samples), 0.0F) << "depth: distance from the camera";
}

} // namespace
} // namespace pf::io
