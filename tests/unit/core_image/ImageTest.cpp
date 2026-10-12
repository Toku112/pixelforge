// The engine's image: windows, channels, regions, tiles and copy-on-write (core/image/Image.h, FORMAT_NOTES §19).

#include "core/image/Image.h"

#include <gtest/gtest.h>

#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>
#include <thread>
#include <vector>

namespace pf::image {
namespace {

constexpr Rect hd{.x0 = 0, .y0 = 0, .x1 = 1920, .y1 = 1080};

// A recognisable value for every (channel, x, y).
float pattern(std::size_t channel, int x, int y) {
    return (static_cast<float>(channel) * 1000.0F) + static_cast<float>(x) + (static_cast<float>(y) * 0.001F);
}

// Writes pattern() into every pixel of `region` of every channel.
void writePattern(Image& image, const Rect& region) {
    std::vector<float> buffer(static_cast<std::size_t>(region.area()));
    for (std::size_t c = 0; c < image.channelCount(); ++c) {
        std::size_t i = 0;
        for (int y = region.y0; y < region.y1; ++y) {
            for (int x = region.x0; x < region.x1; ++x) {
                buffer[i++] = pattern(c, x, y);
            }
        }
        image.write(c, region, buffer, static_cast<std::size_t>(region.width()));
    }
}

TEST(Image, NewImagesAreZeroAndUseNoTileMemory) {
    const Image image(hd, hd, {"R", "G", "B", "A"});
    EXPECT_EQ(image.displayWindow(), hd);
    EXPECT_EQ(image.dataWindow(), hd);
    EXPECT_EQ(image.channels(), (ChannelSet{"R", "G", "B", "A"}));
    EXPECT_EQ(image.tileRange(), (Rect{.x0 = 0, .y0 = 0, .x1 = 8, .y1 = 5}));
    EXPECT_EQ(image.storedTileCount(), 0U);
    EXPECT_EQ(image.storedBytes(), 0U);
    EXPECT_EQ(image.sample("G", 100, 100), 0.0F);
    EXPECT_TRUE(image.tile(0, {.x = 3, .y = 2}).isConstant());
}

TEST(Image, DefaultImageIsEmpty) {
    const Image image;
    EXPECT_EQ(image.channelCount(), 0U);
    EXPECT_TRUE(image.dataWindow().isEmpty());
    EXPECT_TRUE(image.tileRange().isEmpty());
}

TEST(Image, WindowsOutsideTheLimitsAreRefused) {
    const Rect tooBig{.x0 = 0, .y0 = 0, .x1 = maxCoordinate + 1, .y1 = 10};
    EXPECT_THROW(Image(hd, tooBig), std::invalid_argument);
    EXPECT_THROW(Image(tooBig, hd), std::invalid_argument);
    Image image(hd, hd);
    EXPECT_THROW(image.setDataWindow(tooBig), std::invalid_argument);
    EXPECT_THROW(image.setDisplayWindow(tooBig), std::invalid_argument);
}

TEST(Image, AnEmptyDataWindowHoldsNoPixels) {
    Image image(hd, Rect{.x0 = 50, .y0 = 50, .x1 = 50, .y1 = 80}, {"R"});
    EXPECT_EQ(image.dataWindow(), Rect{});
    EXPECT_TRUE(image.tileRange().isEmpty());
    EXPECT_EQ(image.sample("R", 50, 50), 0.0F);
    EXPECT_THROW(image.setSample("R", 50, 50, 1.0F), std::out_of_range);
    std::vector<float> out(4, 7.0F);
    image.read(0, Rect::fromSize(0, 0, 2, 2), out, 2);
    EXPECT_EQ(out, std::vector<float>(4, 0.0F));
}

TEST(Image, EdgeTilesAreClippedToTheDataWindow) {
    const Image image(hd, hd, {"R"});
    EXPECT_EQ(image.tile(0, {.x = 7, .y = 4}).rect, (Rect{.x0 = 1792, .y0 = 1024, .x1 = 1920, .y1 = 1080}));
    EXPECT_EQ(image.tile(0, {.x = 0, .y = 0}).rect, (Rect{.x0 = 0, .y0 = 0, .x1 = 256, .y1 = 256}));
    EXPECT_THROW((void)image.tile(0, {.x = 8, .y = 0}), std::out_of_range);
    EXPECT_THROW((void)image.tile(1, {.x = 0, .y = 0}), std::out_of_range);
}

TEST(Image, SamplesOutsideTheDataWindowReadAsZero) {
    // Data window larger than the frame on the left, smaller on the right (overscan and a partial render).
    Image image(hd, Rect{.x0 = -64, .y0 = 0, .x1 = 1000, .y1 = 1080}, {"R"});
    image.setSample("R", -64, 0, 3.0F);
    EXPECT_EQ(image.sample("R", -64, 0), 3.0F);
    EXPECT_EQ(image.sample("R", -65, 0), 0.0F);
    EXPECT_EQ(image.sample("R", 1500, 500), 0.0F);
    EXPECT_THROW(image.setSample("R", 1500, 500, 1.0F), std::out_of_range);
    EXPECT_THROW((void)image.sample("G", 0, 0), std::out_of_range);
}

TEST(Image, ValuesAreStoredUnclipped) {
    Image image(hd, hd, {"R"});
    const std::vector<float> values{1.0e30F,
                                    -5.0F,
                                    65504.0F,
                                    std::numeric_limits<float>::infinity(),
                                    -std::numeric_limits<float>::infinity(),
                                    std::numeric_limits<float>::denorm_min()};
    for (std::size_t i = 0; i < values.size(); ++i) {
        image.setSample("R", static_cast<int>(i), 0, values[i]);
    }
    for (std::size_t i = 0; i < values.size(); ++i) {
        EXPECT_EQ(image.sample("R", static_cast<int>(i), 0), values[i]);
    }
    image.setSample("R", 10, 0, std::numeric_limits<float>::quiet_NaN());
    EXPECT_TRUE(std::isnan(image.sample("R", 10, 0)));
}

TEST(Image, WriteAndReadRegionsAcrossTiles) {
    // Negative coordinates and a region crossing tile boundaries in both directions.
    const Rect data{.x0 = -300, .y0 = -10, .x1 = 600, .y1 = 520};
    Image image(hd, data, {"R", "G"});
    const Rect region{.x0 = -270, .y0 = -5, .x1 = 530, .y1 = 300};
    writePattern(image, region);

    for (const auto& [x, y] : std::vector<std::pair<int, int>>{{-270, -5}, {-1, 0}, {0, 255}, {255, 256}, {529, 299}}) {
        EXPECT_EQ(image.sample("R", x, y), pattern(0, x, y));
        EXPECT_EQ(image.sample("G", x, y), pattern(1, x, y));
    }
    EXPECT_EQ(image.sample("R", -271, 0), 0.0F); // outside the written region
    EXPECT_EQ(image.sample("R", 530, 0), 0.0F);

    // Read back with a padded row stride; samples outside the data window come back as 0.
    const Rect readRegion{.x0 = -310, .y0 = 295, .x1 = 20, .y1 = 305};
    const std::size_t stride = 400;
    std::vector<float> out((static_cast<std::size_t>(readRegion.height() - 1) * stride) + 330, -1.0F);
    image.read(1, readRegion, out, stride);
    for (int y = readRegion.y0; y < readRegion.y1; ++y) {
        for (int x = readRegion.x0; x < readRegion.x1; ++x) {
            const float expected = (region.contains(x, y)) ? pattern(1, x, y) : 0.0F;
            ASSERT_EQ(out[(static_cast<std::size_t>(y - readRegion.y0) * stride) + (x - readRegion.x0)], expected)
                << x << ", " << y;
        }
    }
    // The gap between rows is left alone.
    EXPECT_EQ(out[330], -1.0F);
}

TEST(Image, RegionBuffersAreChecked) {
    Image image(hd, hd, {"R"});
    std::vector<float> small(99);
    EXPECT_THROW(image.read(0, Rect::fromSize(0, 0, 10, 10), small, 10), std::invalid_argument);
    EXPECT_THROW(image.write(0, Rect::fromSize(0, 0, 10, 10), small, 10), std::invalid_argument);
    std::vector<float> enough(100);
    EXPECT_THROW(image.read(0, Rect::fromSize(0, 0, 10, 10), enough, 9), std::invalid_argument); // stride < width
    EXPECT_THROW(image.read(1, Rect::fromSize(0, 0, 10, 10), enough, 10), std::out_of_range);
    EXPECT_NO_THROW(image.read(0, Rect::fromSize(0, 0, 10, 10), enough, 10));
    // (h − 1) · stride + width samples are enough: the last row needs no padding.
    std::vector<float> tight(static_cast<std::size_t>(9 * 16) + 10);
    EXPECT_NO_THROW(image.read(0, Rect::fromSize(0, 0, 10, 10), tight, 16));
}

TEST(Image, FillMakesWholeTilesConstant) {
    Image image(hd, hd, {"R"});
    writePattern(image, hd);
    EXPECT_EQ(image.storedTileCount(), 40U);
    EXPECT_EQ(image.storedBytes(), static_cast<std::size_t>(1920 * 1080) * sizeof(float));

    image.fill(0, Rect{.x0 = 0, .y0 = 0, .x1 = 600, .y1 = 256}, 0.5F); // tiles (0,0), (1,0) whole, (2,0) partly
    EXPECT_EQ(image.storedTileCount(), 38U);
    EXPECT_TRUE(image.tile(0, {.x = 0, .y = 0}).isConstant());
    EXPECT_EQ(image.tile(0, {.x = 1, .y = 0}).constant, 0.5F);
    EXPECT_FALSE(image.tile(0, {.x = 2, .y = 0}).isConstant());
    EXPECT_EQ(image.sample("R", 599, 255), 0.5F);
    EXPECT_EQ(image.sample("R", 600, 255), pattern(0, 600, 255));

    image.fill(0, hd, 0.0F);
    EXPECT_EQ(image.storedTileCount(), 0U);
    EXPECT_EQ(image.sample("R", 1000, 1000), 0.0F);
}

TEST(Image, PartialFillOfAConstantTileExpandsIt) {
    Image image(hd, hd, {"A"});
    image.fill(0, hd, 1.0F);
    image.fill(0, Rect::fromSize(10, 10, 5, 5), 0.25F);
    EXPECT_EQ(image.storedTileCount(), 1U);
    EXPECT_EQ(image.sample("A", 12, 12), 0.25F);
    EXPECT_EQ(image.sample("A", 9, 12), 1.0F);
    // Filling with the value a constant tile already has changes nothing.
    image.fill(0, Rect::fromSize(300, 10, 5, 5), 1.0F);
    EXPECT_EQ(image.storedTileCount(), 1U);
}

TEST(Image, CopiesShareTilesUntilWritten) {
    Image original(hd, hd, {"R", "G"});
    writePattern(original, hd);
    Image copy = original; // NOLINT(performance-unnecessary-copy-initialization): the copy is the test
    for (std::size_t c = 0; c < 2; ++c) {
        EXPECT_EQ(copy.tile(c, {.x = 3, .y = 3}).samples, original.tile(c, {.x = 3, .y = 3}).samples);
    }

    copy.setSample("R", 800, 800, -1.0F); // tile (3, 3) of R
    EXPECT_EQ(copy.sample("R", 800, 800), -1.0F);
    EXPECT_EQ(original.sample("R", 800, 800), pattern(0, 800, 800));
    EXPECT_NE(copy.tile(0, {.x = 3, .y = 3}).samples, original.tile(0, {.x = 3, .y = 3}).samples);
    // The copied tile kept its other pixels.
    EXPECT_EQ(copy.sample("R", 801, 800), pattern(0, 801, 800));
    // Everything else is still shared.
    EXPECT_EQ(copy.tile(1, {.x = 3, .y = 3}).samples, original.tile(1, {.x = 3, .y = 3}).samples);
    EXPECT_EQ(copy.tile(0, {.x = 2, .y = 3}).samples, original.tile(0, {.x = 2, .y = 3}).samples);

    // Once the copy owns its tile, further writes happen in place.
    const float* owned = copy.tile(0, {.x = 3, .y = 3}).samples;
    copy.setSample("R", 802, 800, -2.0F);
    EXPECT_EQ(copy.tile(0, {.x = 3, .y = 3}).samples, owned);
}

TEST(Image, OverwriteTileNeverTouchesASharedTile) {
    Image original(hd, hd, {"R"});
    writePattern(original, hd);
    Image copy = original;
    const MutableTile tile = copy.overwriteTile(0, {.x = 0, .y = 0});
    std::fill_n(tile.samples, tile.rect.area(), 9.0F);
    EXPECT_EQ(copy.sample("R", 5, 5), 9.0F);
    EXPECT_EQ(original.sample("R", 5, 5), pattern(0, 5, 5));
}

TEST(Image, WritableTileExpandsAConstantTile) {
    Image image(hd, hd, {"A"});
    image.setTileConstant(0, {.x = 1, .y = 1}, 0.75F);
    const MutableTile tile = image.writableTile(0, {.x = 1, .y = 1});
    EXPECT_EQ(tile.at(300, 300), 0.75F);
    tile.at(300, 300) = 0.0F;
    EXPECT_EQ(image.sample("A", 300, 300), 0.0F);
    EXPECT_EQ(image.sample("A", 301, 300), 0.75F);
}

TEST(Image, ShrinkingTheDataWindowKeepsTheOverlap) {
    Image image(hd, hd, {"R"});
    writePattern(image, hd);
    const Image before = image;
    const Rect crop{.x0 = 100, .y0 = 300, .x1 = 1000, .y1 = 700};
    image.setDataWindow(crop);
    EXPECT_EQ(image.dataWindow(), crop);
    EXPECT_EQ(image.displayWindow(), hd);
    EXPECT_EQ(image.tileRange(), (Rect{.x0 = 0, .y0 = 1, .x1 = 4, .y1 = 3}));
    EXPECT_EQ(image.sample("R", 100, 300), pattern(0, 100, 300));
    EXPECT_EQ(image.sample("R", 999, 699), pattern(0, 999, 699));
    EXPECT_EQ(image.sample("R", 99, 300), 0.0F);
    // Tile (1, 2) = [256, 512) × [512, 768) is cut by the new window: a new, smaller buffer.
    EXPECT_EQ(image.tile(0, {.x = 1, .y = 2}).rect, (Rect{.x0 = 256, .y0 = 512, .x1 = 512, .y1 = 700}));
    // The original copy is unaffected.
    EXPECT_EQ(before.sample("R", 99, 300), pattern(0, 99, 300));
}

TEST(Image, GrowingTheDataWindowAddsZeros) {
    Image image(hd, Rect{.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 300}, {"R"});
    writePattern(image, image.dataWindow());
    const float* inner = image.tile(0, {.x = 0, .y = 0}).samples;
    image.setDataWindow(Rect{.x0 = -50, .y0 = -50, .x1 = 600, .y1 = 600});
    EXPECT_EQ(image.sample("R", 299, 299), pattern(0, 299, 299));
    EXPECT_EQ(image.sample("R", 300, 299), 0.0F);
    EXPECT_EQ(image.sample("R", -50, -50), 0.0F);
    EXPECT_EQ(image.sample("R", 599, 599), 0.0F);
    // A whole tile inside both windows is kept as it is, not copied.
    EXPECT_EQ(image.tile(0, {.x = 0, .y = 0}).samples, inner);
    image.setSample("R", 599, 599, 4.0F);
    EXPECT_EQ(image.sample("R", 599, 599), 4.0F);
}

TEST(Image, GrowingAConstantTileFillsOnlyTheOldPixels) {
    Image image(hd, Rect{.x0 = 0, .y0 = 0, .x1 = 100, .y1 = 100}, {"A"});
    image.fill(0, image.dataWindow(), 1.0F);
    EXPECT_EQ(image.storedTileCount(), 0U);
    image.setDataWindow(Rect{.x0 = 0, .y0 = 0, .x1 = 200, .y1 = 100});
    EXPECT_EQ(image.sample("A", 99, 50), 1.0F);
    EXPECT_EQ(image.sample("A", 100, 50), 0.0F);
    // Shrinking keeps a constant tile constant.
    image.setDataWindow(Rect{.x0 = 0, .y0 = 0, .x1 = 50, .y1 = 50});
    image.fill(0, image.dataWindow(), 2.0F);
    image.setDataWindow(Rect{.x0 = 10, .y0 = 10, .x1 = 40, .y1 = 40});
    EXPECT_TRUE(image.tile(0, {.x = 0, .y = 0}).isConstant());
    EXPECT_EQ(image.sample("A", 20, 20), 2.0F);
}

TEST(Image, MovingTheDataWindowOffTheOldOne) {
    Image image(hd, Rect::fromSize(0, 0, 100, 100), {"R"});
    writePattern(image, image.dataWindow());
    image.setDataWindow(Rect::fromSize(5000, 5000, 10, 10));
    EXPECT_EQ(image.sample("R", 5000, 5000), 0.0F);
    EXPECT_EQ(image.sample("R", 50, 50), 0.0F);
    EXPECT_EQ(image.storedTileCount(), 0U);
}

TEST(Image, AddRemoveAndRenameChannels) {
    Image image(hd, hd, {"R", "G", "B"});
    image.addChannel("A", 1.0F);
    EXPECT_EQ(image.channels(), (ChannelSet{"R", "G", "B", "A"}));
    EXPECT_EQ(image.channelIndex("A"), 3U);
    EXPECT_EQ(image.sample("A", 1919, 1079), 1.0F);
    EXPECT_EQ(image.storedTileCount(), 0U); // a constant channel costs no tile memory
    EXPECT_THROW(image.addChannel("A"), std::invalid_argument);
    EXPECT_THROW(image.addChannel(""), std::invalid_argument);

    image.setSample("G", 5, 5, 0.5F);
    image.renameChannel("G", "diffuse.G");
    EXPECT_FALSE(image.hasChannel("G"));
    EXPECT_EQ(image.sample("diffuse.G", 5, 5), 0.5F);
    EXPECT_EQ(image.channelIndex("diffuse.G"), 3U); // after the main layer's R, B, A
    EXPECT_THROW(image.renameChannel("R", "B"), std::invalid_argument);
    EXPECT_THROW(image.renameChannel("missing", "X"), std::out_of_range);
    EXPECT_NO_THROW(image.renameChannel("R", "R"));

    image.removeChannel("B");
    EXPECT_EQ(image.channels(), (ChannelSet{"R", "A", "diffuse.G"}));
    EXPECT_EQ(image.sample("diffuse.G", 5, 5), 0.5F);
    EXPECT_EQ(image.sample("A", 5, 5), 1.0F);
    EXPECT_THROW(image.removeChannel("B"), std::out_of_range);
}

TEST(Image, CopyChannelSharesTilesWhenTheWindowsMatch) {
    Image source(hd, hd, {"diffuse.R"});
    writePattern(source, hd);
    Image target(hd, hd, {"R"});
    target.copyChannel(source, "diffuse.R", "R");
    target.copyChannel(source, "diffuse.R", "Z"); // added
    EXPECT_EQ(target.sample("R", 700, 400), pattern(0, 700, 400));
    EXPECT_EQ(target.tile(target.channelIndex("Z"), {.x = 2, .y = 1}).samples,
              source.tile(0, {.x = 2, .y = 1}).samples);

    // From the image itself.
    target.copyChannel(target, "R", "G");
    EXPECT_EQ(target.sample("G", 700, 400), pattern(0, 700, 400));
    EXPECT_THROW(target.copyChannel(source, "missing", "Y"), std::out_of_range);
}

TEST(Image, CopyChannelBetweenDifferentWindows) {
    Image source(hd, Rect{.x0 = -100, .y0 = 0, .x1 = 700, .y1 = 800}, {"R"});
    writePattern(source, source.dataWindow());
    source.fill(0, Rect{.x0 = 512, .y0 = 256, .x1 = 700, .y1 = 512}, 3.0F); // all of source tile (2, 1): constant
    Image target(hd, Rect{.x0 = 0, .y0 = 300, .x1 = 1000, .y1 = 1000}, {"A"});
    target.fill(0, target.dataWindow(), 1.0F);
    target.copyChannel(source, "R", "R");
    const std::size_t r = target.channelIndex("R");

    EXPECT_EQ(target.sample("R", 0, 300), pattern(0, 0, 300));
    EXPECT_EQ(target.sample("R", 699, 799), pattern(0, 699, 799));
    EXPECT_EQ(target.sample("R", 700, 599), 0.0F); // outside the source
    EXPECT_EQ(target.sample("R", 699, 800), 0.0F);
    EXPECT_EQ(target.sample("R", 0, 299), 0.0F); // outside the target
    EXPECT_EQ(target.sample("A", 0, 300), 1.0F);
    // Tile (2, 1) is cut differently in the two images: the constant fills only the pixels the source has.
    EXPECT_EQ(target.sample("R", 600, 400), 3.0F);
    EXPECT_EQ(target.sample("R", 750, 400), 0.0F);
    // Tile (1, 2) = [256, 512) × [512, 768) holds the same pixels in both images, so it is shared.
    EXPECT_EQ(target.tile(r, {.x = 1, .y = 2}).samples, source.tile(0, {.x = 1, .y = 2}).samples);
}

TEST(Image, TileContentsMoveBetweenImagesWithoutCopying) {
    Image source(hd, hd, {"R", "G"});
    writePattern(source, hd);
    source.fill(1, hd, 0.5F);
    Image target(hd, hd, {"X", "Y"});
    const TileCoord t{.x = 2, .y = 1};
    target.setTileContent(0, t, source.tileContent(0, t));
    target.setTileContent(1, t, source.tileContent(1, t));
    EXPECT_EQ(target.tile(0, t).samples, source.tile(0, t).samples); // shared
    EXPECT_TRUE(target.tile(1, t).isConstant());
    EXPECT_EQ(target.sample("X", 600, 300), pattern(0, 600, 300));
    EXPECT_EQ(target.sample("Y", 600, 300), 0.5F);

    // Writing to the shared tile copies it first.
    target.setSample("X", 600, 300, -1.0F);
    EXPECT_EQ(source.sample("R", 600, 300), pattern(0, 600, 300));
}

TEST(Image, TileContentMustHoldTheTilesPixels) {
    Image source(hd, hd, {"R"});
    writePattern(source, hd);
    Image smaller(hd, Rect{.x0 = 0, .y0 = 0, .x1 = 100, .y1 = 100}, {"R"});
    EXPECT_THROW(smaller.setTileContent(0, {.x = 0, .y = 0}, source.tileContent(0, {.x = 0, .y = 0})),
                 std::invalid_argument);
    // Constant contents fit any tile.
    smaller.setTileContent(0, {.x = 0, .y = 0}, {.storage = {}, .constant = 3.0F});
    EXPECT_EQ(smaller.sample("R", 99, 99), 3.0F);
}

TEST(Image, CopyTileSharesMatchingTilesAndCopiesTheRest) {
    Image source(hd, hd, {"R"});
    writePattern(source, hd);
    // Same tile grid cell, same pixels: shared.
    Image same(hd, Rect{.x0 = 0, .y0 = 0, .x1 = 512, .y1 = 512}, {"A"});
    same.copyTile(0, {.x = 1, .y = 1}, source, 0);
    EXPECT_EQ(same.tile(0, {.x = 1, .y = 1}).samples, source.tile(0, {.x = 1, .y = 1}).samples);

    // A window that cuts the tile differently: copied, zeros outside the source's data window.
    const Rect overscan{.x0 = -100, .y0 = -100, .x1 = 200, .y1 = 200};
    Image other(hd, overscan, {"A"});
    other.copyTile(0, {.x = -1, .y = -1}, source, 0);
    other.copyTile(0, {.x = 0, .y = 0}, source, 0);
    EXPECT_EQ(other.sample("A", -50, -50), 0.0F);
    EXPECT_EQ(other.sample("A", 150, 150), pattern(0, 150, 150));
    EXPECT_NE(other.tile(0, {.x = 0, .y = 0}).samples, source.tile(0, {.x = 0, .y = 0}).samples);

    // A tile the source does not have becomes 0.
    other.fill(0, overscan, 7.0F);
    const Image empty(hd, Rect{}, {"R"});
    other.copyTile(0, {.x = 0, .y = 0}, empty, 0);
    EXPECT_TRUE(other.tile(0, {.x = 0, .y = 0}).isConstant());
    EXPECT_EQ(other.sample("A", 150, 150), 0.0F);
    EXPECT_EQ(other.sample("A", -50, -50), 7.0F);
}

TEST(Image, DifferentTilesCanBeWrittenFromSeveralThreads) {
    Image original(hd, hd, {"R", "G"});
    writePattern(original, hd);
    Image image = original; // every write must copy first
    const Rect tiles = image.tileRange();
    std::vector<std::thread> threads;
    for (int ty = tiles.y0; ty < tiles.y1; ++ty) {
        threads.emplace_back([&image, &tiles, ty] {
            for (int tx = tiles.x0; tx < tiles.x1; ++tx) {
                for (std::size_t c = 0; c < 2; ++c) {
                    const MutableTile tile = image.writableTile(c, {.x = tx, .y = ty});
                    for (int y = tile.rect.y0; y < tile.rect.y1; ++y) {
                        for (int x = tile.rect.x0; x < tile.rect.x1; ++x) {
                            tile.at(x, y) *= 2.0F;
                        }
                    }
                }
            }
        });
    }
    for (std::thread& thread : threads) {
        thread.join();
    }
    for (const auto& [x, y] : std::vector<std::pair<int, int>>{{0, 0}, {1919, 1079}, {1000, 600}, {255, 1023}}) {
        EXPECT_EQ(image.sample("G", x, y), 2.0F * pattern(1, x, y));
        EXPECT_EQ(original.sample("G", x, y), pattern(1, x, y));
    }
}

} // namespace
} // namespace pf::image
