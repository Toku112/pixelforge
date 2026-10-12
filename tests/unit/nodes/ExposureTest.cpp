// The Exposure node (nodes/exposure, docs/specs/node-graph.md §6, FORMAT_NOTES §20.2).

#include "core/image/Image.h"
#include "nodes/exposure/ExposureNode.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <cmath>
#include <limits>

namespace pf::nodes {
namespace {

using image::Image;
using image::Rect;

constexpr Rect frame{.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 200};

TEST(Exposure, Maths) {
    EXPECT_FLOAT_EQ(applyExposure(0.25F, {.exposure = 1.0}), 0.5F);
    EXPECT_FLOAT_EQ(applyExposure(0.25F, {.exposure = -2.0}), 0.0625F);
    EXPECT_FLOAT_EQ(applyExposure(4.0F, {.exposure = 3.0}), 32.0F); // never clipped
    EXPECT_FLOAT_EQ(applyExposure(0.25F, {.offset = 0.1}), 0.35F);
    EXPECT_FLOAT_EQ(applyExposure(0.25F, {.gamma = 2.0}), 0.5F);      // 0.25^(1/2)
    EXPECT_FLOAT_EQ(applyExposure(-0.25F, {.gamma = 2.0}), -0.5F);    // mirrored below 0
    EXPECT_FLOAT_EQ(applyExposure(-0.25F, {.exposure = 1.0}), -0.5F); // negatives kept
    // Order: exposure, then offset, then gamma.
    EXPECT_FLOAT_EQ(applyExposure(0.1F, {.exposure = 1.0, .offset = 0.05, .gamma = 0.5}), 0.0625F); // 0.25²
    EXPECT_TRUE(std::isnan(applyExposure(std::numeric_limits<float>::quiet_NaN(), {.exposure = 1.0, .gamma = 2.2})));
    EXPECT_EQ(applyExposure(std::numeric_limits<float>::infinity(), {.exposure = 1.0, .gamma = 2.2}),
              std::numeric_limits<float>::infinity());
    EXPECT_TRUE(ExposureSettings{}.isNeutral());
    EXPECT_FALSE(ExposureSettings{.gamma = 1.1}.isNeutral());
}

TEST(Exposure, PremultipliedColour) {
    // Straight 0.25 at alpha 0.5; gamma works on the straight value: 0.25 → 0.5, premultiplied 0.25.
    EXPECT_FLOAT_EQ(applyExposurePremultiplied(0.125F, 0.5F, {.gamma = 2.0}), 0.25F);
    // Offset too: (0.25 + 0.25) · 0.5.
    EXPECT_FLOAT_EQ(applyExposurePremultiplied(0.125F, 0.5F, {.offset = 0.25}), 0.25F);
    // Exposure alone scales the premultiplied value directly.
    EXPECT_FLOAT_EQ(applyExposurePremultiplied(0.125F, 0.5F, {.exposure = 1.0}), 0.25F);
    // Where alpha is 0 the colour (light without coverage) is adjusted as it is.
    EXPECT_FLOAT_EQ(applyExposurePremultiplied(0.5F, 0.0F, {.offset = 0.25}), 0.75F);
}

Image testImage() {
    Image image(frame, frame, {"R", "G", "B", "A", "Z", "diffuse.R", "diffuse.G", "diffuse.B"});
    for (int y = frame.y0; y < frame.y1; ++y) {
        for (int x = frame.x0; x < frame.x1; ++x) {
            const float alpha = static_cast<float>(y) / 199.0F;
            image.setSample("R", x, y, (static_cast<float>(x) / 30.0F - 1.0F) * alpha); // −1 … 9, premultiplied
            image.setSample("G", x, y, 0.5F * alpha);
            image.setSample("A", x, y, alpha);
            image.setSample("Z", x, y, 100.0F + static_cast<float>(x));
        }
    }
    image.fill(image.channelIndex("B"), frame, 0.75F);
    image.fill(image.channelIndex("diffuse.R"), frame, 0.2F); // constant tiles, and the layer has no alpha
    return image;
}

// Every 7th column of every 9th row: colour adjusted as applyExposurePremultiplied says, alpha and data unchanged.
void expectAdjusted(const Image& result, const Image& source, const ExposureSettings& settings) {
    for (int y = 0; y < 200; y += 9) {
        for (int x = 0; x < 300; x += 7) {
            const float a = source.sample("A", x, y);
            for (const char* channel : {"R", "G", "B"}) {
                ASSERT_FLOAT_EQ(result.sample(channel, x, y),
                                applyExposurePremultiplied(source.sample(channel, x, y), a, settings))
                    << channel << " at (" << x << ", " << y << ")";
            }
            ASSERT_EQ(result.sample("A", x, y), a);
            ASSERT_EQ(result.sample("Z", x, y), source.sample("Z", x, y));
            ASSERT_EQ(result.sample("diffuse.R", x, y), 0.2F);
        }
    }
}

TEST(Exposure, NodeAdjustsTheColourOfOneLayer) {
    testing::NodeBench bench;
    const Image source = testImage();
    const graph::NodeId read = bench.read(source);
    const graph::NodeId exposure = bench.add("Exposure");
    bench.graph.connect(read, exposure, 0);
    const ExposureSettings settings{.exposure = 1.5, .offset = 0.02, .gamma = 1.8};
    bench.graph.setValue(exposure, "exposure", settings.exposure);
    bench.graph.setValue(exposure, "offset", settings.offset);
    bench.graph.setValue(exposure, "gamma", settings.gamma);

    const Image input = bench.evaluate(read, source.channels());
    const Image result = bench.evaluate(exposure, source.channels());
    ASSERT_EQ(result.channels(), source.channels());
    expectAdjusted(result, source, settings);
    // Untouched channels share the input's tiles.
    const std::size_t z = result.channelIndex("Z");
    EXPECT_EQ(result.tile(z, {.x = 0, .y = 0}).samples, input.tile(z, {.x = 0, .y = 0}).samples);

    // Another layer: only its colour changes.
    bench.graph.setValue(exposure, "layer", std::string("diffuse"));
    bench.graph.setValue(exposure, "offset", 0.0);
    bench.graph.setValue(exposure, "gamma", 1.0);
    const Image diffuse = bench.evaluate(exposure, source.channels());
    EXPECT_FLOAT_EQ(diffuse.sample("diffuse.R", 10, 10), 0.2F * std::exp2(1.5F));
    EXPECT_EQ(diffuse.sample("R", 10, 10), source.sample("R", 10, 10));
}

TEST(Exposure, ConstantTilesStayConstant) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(testImage());
    const graph::NodeId shuffle = bench.add("Shuffle"); // red = 1 everywhere: a constant tile
    bench.graph.connect(read, shuffle, 0);
    bench.graph.setValue(shuffle, "red", std::string("1"));
    const graph::NodeId exposure = bench.add("Exposure");
    bench.graph.connect(shuffle, exposure, 0);
    bench.graph.setValue(exposure, "exposure", 2.0);
    const Image result = bench.evaluate(exposure, {"R"});
    const image::ConstTile tile = result.tile(0, {.x = 1, .y = 0});
    EXPECT_TRUE(tile.isConstant());
    EXPECT_EQ(tile.constant, 4.0F);
}

TEST(Exposure, NeutralSettingsPassTheInputThrough) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(testImage());
    const graph::NodeId exposure = bench.add("Exposure");
    bench.graph.connect(read, exposure, 0);
    EXPECT_EQ(bench.evaluator.hash(bench.graph, exposure, 1.0), bench.evaluator.hash(bench.graph, read, 1.0));
    bench.graph.setValue(exposure, "exposure", 0.5);
    EXPECT_NE(bench.evaluator.hash(bench.graph, exposure, 1.0), bench.evaluator.hash(bench.graph, read, 1.0));
}

TEST(Exposure, AnimatesPerFrame) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(testImage());
    const graph::NodeId exposure = bench.add("Exposure");
    bench.graph.connect(read, exposure, 0);
    bench.graph.setKey(exposure, "exposure", 0, {.frame = 1.0, .value = 0.0});
    bench.graph.setKey(exposure, "exposure", 0, {.frame = 3.0, .value = 2.0});
    EXPECT_FLOAT_EQ(bench.evaluate(exposure, {"G"}, 2.0).sample("G", 5, 199), 1.0F); // 0.5 · 2¹
    EXPECT_FLOAT_EQ(bench.evaluate(exposure, {"G"}, 3.0).sample("G", 5, 199), 2.0F); // 0.5 · 2²
    EXPECT_FLOAT_EQ(bench.evaluate(exposure, {"G"}, 1.0).sample("G", 5, 199), 0.5F); // neutral: the input
}

TEST(Exposure, OnlyAlphaIsAddedToTheRequest) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(testImage());
    const graph::NodeId exposure = bench.add("Exposure");
    bench.graph.connect(read, exposure, 0);
    bench.graph.setValue(exposure, "gamma", 2.0);
    (void)bench.evaluate(exposure, {"R"});
    EXPECT_EQ(bench.counters->channelsRead, 2); // R and the alpha it needs
}

} // namespace
} // namespace pf::nodes
