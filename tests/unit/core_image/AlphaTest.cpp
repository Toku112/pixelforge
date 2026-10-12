// Premultiplied alpha (core/image/Alpha.h, FORMAT_NOTES §19.4).

#include "core/image/Alpha.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pf::image {
namespace {

constexpr Rect frame{.x0 = 0, .y0 = 0, .x1 = 600, .y1 = 300}; // 3 × 2 tiles, edge tiles clipped

TEST(Alpha, ScalarConversions) {
    EXPECT_EQ(premultiplied(0.5F, 0.5F), 0.25F);
    EXPECT_EQ(unpremultiplied(0.25F, 0.5F), 0.5F);
    EXPECT_EQ(premultiplied(50.0F, 0.5F), 25.0F); // no clipping above 1
    EXPECT_EQ(premultiplied(-0.2F, 0.5F), -0.1F);
    EXPECT_EQ(unpremultiplied(1.0F, 2.0F), 0.5F); // alpha above 1 divides too
    // Alpha 0: a pixel that only adds light keeps its colour.
    EXPECT_EQ(unpremultiplied(0.3F, 0.0F), 0.3F);
    EXPECT_EQ(unpremultiplied(0.3F, -0.0F), 0.3F);
}

TEST(Alpha, ColourChannelsOf) {
    EXPECT_EQ(colourChannelsOf(ChannelSet{"R", "G", "B", "A", "Z"}, "A"), (ChannelSet{"R", "G", "B"}));
    EXPECT_EQ(colourChannelsOf(ChannelSet{"R", "A", "diffuse.R", "diffuse.G", "diffuse.B", "diffuse.A"}, "diffuse.A"),
              (ChannelSet{"diffuse.R", "diffuse.G", "diffuse.B"}));
    EXPECT_EQ(colourChannelsOf(ChannelSet{"Y", "A"}, "A"), ChannelSet{"Y"});
    // Vectors, depth and IDs are data, never premultiplied.
    EXPECT_EQ(colourChannelsOf(ChannelSet{"N.X", "N.Y", "N.Z", "Z", "id", "A"}, "A"), ChannelSet{});
}

TEST(Alpha, PremultiplyAndBackRestoresColour) {
    Image image(frame, frame, {"R", "G", "B", "A", "Z"});
    for (int y = frame.y0; y < frame.y1; y += 7) {
        for (int x = frame.x0; x < frame.x1; x += 5) {
            image.setSample("R", x, y, 0.001F * static_cast<float>(x));
            image.setSample("G", x, y, 20.0F); // HDR
            image.setSample("B", x, y, -0.25F);
            image.setSample("A", x, y, 0.01F + (0.003F * static_cast<float>(y)));
            image.setSample("Z", x, y, 100.0F);
        }
    }
    const Image straight = image;
    const ChannelSet colour = colourChannelsOf(image.channels(), "A");
    premultiply(image, colour, "A");

    EXPECT_FLOAT_EQ(image.sample("G", 5, 7), 20.0F * straight.sample("A", 5, 7));
    EXPECT_EQ(image.sample("Z", 5, 7), 100.0F); // untouched
    EXPECT_EQ(image.sample("A", 5, 7), straight.sample("A", 5, 7));

    unpremultiply(image, colour, "A");
    for (int y = frame.y0; y < frame.y1; y += 7) {
        for (int x = frame.x0; x < frame.x1; x += 5) {
            for (const char* name : {"R", "G", "B"}) {
                const float expected = straight.sample(name, x, y);
                ASSERT_NEAR(image.sample(name, x, y), expected, 1.0e-6F * std::max(1.0F, std::abs(expected)))
                    << name << " at " << x << ", " << y;
            }
        }
    }
}

TEST(Alpha, ZeroAlphaKeepsEmissionThroughUnpremultiply) {
    Image image(frame, frame, {"R", "A"});
    image.setSample("R", 10, 10, 0.8F); // light with no coverage (alpha stays 0)
    unpremultiply(image, ChannelSet{"R"}, "A");
    EXPECT_EQ(image.sample("R", 10, 10), 0.8F);
}

TEST(Alpha, ConstantTilesStayConstant) {
    Image image(frame, frame, {"R", "A"});
    image.fill(0, frame, 0.5F);
    image.fill(1, frame, 0.25F);
    premultiply(image, ChannelSet{"R"}, "A");
    EXPECT_EQ(image.storedTileCount(), 0U);
    EXPECT_EQ(image.sample("R", 599, 299), 0.125F);

    // A stored alpha tile next to a constant colour tile.
    image.setSample("A", 300, 10, 0.5F);
    unpremultiply(image, ChannelSet{"R"}, "A");
    EXPECT_EQ(image.sample("R", 300, 10), 0.25F);
    EXPECT_EQ(image.sample("R", 301, 10), 0.5F);
    EXPECT_EQ(image.sample("R", 10, 10), 0.5F);
}

TEST(Alpha, BadArgumentsAreRefused) {
    Image image(frame, frame, {"R", "A"});
    EXPECT_THROW(premultiply(image, ChannelSet{"R", "A"}, "A"), std::invalid_argument);
    EXPECT_THROW(premultiply(image, ChannelSet{"R"}, "missing"), std::out_of_range);
    EXPECT_THROW(premultiply(image, ChannelSet{"G"}, "A"), std::out_of_range);
}

} // namespace
} // namespace pf::image
