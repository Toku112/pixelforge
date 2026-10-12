// Interleaved pixel buffers at the boundary (core/image/Interleaved.h, FORMAT_NOTES §19.6).

#include "core/image/Interleaved.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <cstring>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace pf::image {
namespace {

template <typename T>
std::span<const std::byte> bytesOf(const std::vector<T>& v) {
    return std::as_bytes(std::span(v));
}

template <typename T>
std::span<std::byte> writableBytesOf(std::vector<T>& v) {
    return std::as_writable_bytes(std::span(v));
}

// A layout with every field set: GCC warns (as an error here) about initializers that leave fields out.
InterleavedLayout layoutOf(SampleType type, std::vector<std::string> channels, std::string alpha = {},
                           AlphaMode mode = AlphaMode::Premultiplied, std::size_t rowStride = 0) {
    return {.type = type,
            .channels = std::move(channels),
            .alpha = std::move(alpha),
            .alphaMode = mode,
            .rowStride = rowStride};
}

InterleavedLayout rgba(SampleType type, AlphaMode mode) {
    return layoutOf(type, {"R", "G", "B", "A"}, "A", mode);
}

TEST(Interleaved, LayoutSizes) {
    const InterleavedLayout layout = rgba(SampleType::UInt16, AlphaMode::Straight);
    EXPECT_EQ(layout.pixelBytes(), 8U);
    EXPECT_EQ(layout.rowBytes(10), 80U);
    EXPECT_EQ(layout.bufferBytes(Rect::fromSize(0, 0, 10, 3)), 240U);
    InterleavedLayout padded = layout;
    padded.rowStride = 128;
    EXPECT_EQ(padded.bufferBytes(Rect::fromSize(0, 0, 10, 3)), (2U * 128U) + 80U); // the last row needs no padding
    EXPECT_EQ(padded.bufferBytes(Rect{}), 0U);
}

TEST(Interleaved, StraightUInt8IsPremultipliedOnTheWayIn) {
    const Rect region = Rect::fromSize(0, 0, 1, 1);
    Image image(region, region, {"R", "G", "B", "A"});
    const std::vector<std::uint8_t> pixel{200, 100, 50, 128};
    importInterleaved(image, region, bytesOf(pixel), rgba(SampleType::UInt8, AlphaMode::Straight));
    const float alpha = 128.0F / 255.0F;
    EXPECT_EQ(image.sample("A", 0, 0), alpha);
    EXPECT_EQ(image.sample("R", 0, 0), (200.0F / 255.0F) * alpha);
    EXPECT_EQ(image.sample("B", 0, 0), (50.0F / 255.0F) * alpha);

    // Premultiplied input is stored as it is.
    importInterleaved(image, region, bytesOf(pixel), rgba(SampleType::UInt8, AlphaMode::Premultiplied));
    EXPECT_EQ(image.sample("R", 0, 0), 200.0F / 255.0F);
}

TEST(Interleaved, EveryStraightUInt8PixelRoundTrips) {
    // x = colour code, y = alpha code: all 65536 combinations.
    const Rect region = Rect::fromSize(0, 0, 256, 256);
    std::vector<std::uint8_t> in(static_cast<std::size_t>(region.area()) * 4);
    for (int y = 0; y < 256; ++y) {
        for (int x = 0; x < 256; ++x) {
            std::uint8_t* p = &in[((static_cast<std::size_t>(y) * 256) + x) * 4];
            p[0] = static_cast<std::uint8_t>(x);
            p[1] = static_cast<std::uint8_t>(255 - x);
            p[2] = static_cast<std::uint8_t>((x * 7) % 256);
            p[3] = static_cast<std::uint8_t>(y);
        }
    }
    Image image(region, region, {"R", "G", "B", "A"});
    const InterleavedLayout layout = rgba(SampleType::UInt8, AlphaMode::Straight);
    importInterleaved(image, region, bytesOf(in), layout);
    std::vector<std::uint8_t> out(in.size());
    exportInterleaved(image, region, writableBytesOf(out), layout);
    for (std::size_t i = 0; i < in.size(); i += 4) {
        const bool transparent = in[i + 3] == 0;
        for (std::size_t s = 0; s < 3; ++s) {
            // With alpha 0 the colour is gone after premultiplying: it comes back as 0.
            ASSERT_EQ(out[i + s], transparent ? 0 : in[i + s]) << "pixel " << i / 4 << " sample " << s;
        }
        ASSERT_EQ(out[i + 3], in[i + 3]);
    }
}

TEST(Interleaved, StraightUInt16PixelsRoundTrip) {
    const Rect region = Rect::fromSize(0, 0, 512, 256);
    std::vector<std::uint16_t> in(static_cast<std::size_t>(region.area()) * 2);
    std::mt19937 random(42);
    for (std::size_t i = 0; i < in.size(); i += 2) {
        in[i] = static_cast<std::uint16_t>(random() & 0xFFFF);
        in[i + 1] = static_cast<std::uint16_t>((random() & 0xFFFF) | 1); // alpha never 0
    }
    // Extremes: the smallest alpha with the largest colour, and full values.
    in[0] = 65535;
    in[1] = 1;
    in[2] = 65535;
    in[3] = 65535;
    const InterleavedLayout layout = layoutOf(SampleType::UInt16, {"Y", "A"}, "A", AlphaMode::Straight);
    Image image(region, region, {"Y", "A"});
    importInterleaved(image, region, bytesOf(in), layout);
    std::vector<std::uint16_t> out(in.size());
    exportInterleaved(image, region, writableBytesOf(out), layout);
    EXPECT_EQ(out, in);
}

TEST(Interleaved, FloatAndHalfKeepEveryValue) {
    const Rect region = Rect::fromSize(-3, 250, 4, 10); // crosses tile boundaries in x and y
    std::vector<float> in(static_cast<std::size_t>(region.area()) * 3);
    for (std::size_t i = 0; i < in.size(); ++i) {
        in[i] = (static_cast<float>(i) * 0.37F) - 5.0F; // negative and above 1
    }
    const InterleavedLayout floats = layoutOf(SampleType::Float32, {"N.X", "N.Y", "N.Z"});
    Image image(region, region, {"N.X", "N.Y", "N.Z"});
    importInterleaved(image, region, bytesOf(in), floats);
    EXPECT_EQ(image.sample("N.Y", -3, 250), in[1]);
    std::vector<float> out(in.size());
    exportInterleaved(image, region, writableBytesOf(out), floats);
    EXPECT_EQ(out, in);

    // Half: values representable in half survive both ways.
    std::vector<std::uint16_t> halves(in.size());
    for (std::size_t i = 0; i < in.size(); ++i) {
        halves[i] = toHalfBits(in[i]);
    }
    InterleavedLayout halfLayout = floats;
    halfLayout.type = SampleType::Half;
    importInterleaved(image, region, bytesOf(halves), halfLayout);
    EXPECT_EQ(image.sample("N.Z", 0, 259), fromHalfBits(halves[(((9 * 4) + 3) * 3) + 2]));
    std::vector<std::uint16_t> halvesOut(halves.size());
    exportInterleaved(image, region, writableBytesOf(halvesOut), halfLayout);
    EXPECT_EQ(halvesOut, halves);
}

TEST(Interleaved, ChannelOrderAndRowPadding) {
    const Rect region = Rect::fromSize(10, 20, 3, 2);
    const std::size_t stride = 16; // 3 pixels × 4 bytes + 4 bytes of padding
    std::vector<std::uint8_t> bgra(stride * 2, 0xEE);
    for (std::size_t y = 0; y < 2; ++y) {
        for (std::size_t x = 0; x < 3; ++x) {
            std::uint8_t* p = &bgra[(y * stride) + (x * 4)];
            p[0] = 10;                               // B
            p[1] = 20;                               // G
            p[2] = static_cast<std::uint8_t>(x + 1); // R
            p[3] = 255;                              // A
        }
    }
    const InterleavedLayout layout =
        layoutOf(SampleType::UInt8, {"B", "G", "R", "A"}, "A", AlphaMode::Straight, stride);
    Image image(region, region, {"R", "G", "B", "A"});
    importInterleaved(image, region, bytesOf(bgra), layout);
    EXPECT_EQ(image.sample("R", 12, 21), fromUInt8(3));
    EXPECT_EQ(image.sample("B", 12, 21), fromUInt8(10));

    std::vector<std::uint8_t> out(bgra.size(), 0xEE);
    exportInterleaved(image, region, writableBytesOf(out), layout);
    EXPECT_EQ(out, bgra); // pixels identical, padding bytes untouched
}

TEST(Interleaved, PixelsOutsideTheDataWindow) {
    const Rect data = Rect::fromSize(0, 0, 2, 2);
    const Rect region = Rect::fromSize(-1, 0, 4, 1); // one pixel left of the data window, one right
    Image image(data, data, {"R"});
    const std::vector<float> in{1.0F, 2.0F, 3.0F, 4.0F};
    const InterleavedLayout layout = layoutOf(SampleType::Float32, {"R"});
    importInterleaved(image, region, bytesOf(in), layout); // only the two pixels inside are stored
    EXPECT_EQ(image.sample("R", 0, 0), 2.0F);
    EXPECT_EQ(image.sample("R", 1, 0), 3.0F);

    std::vector<float> out(4, -1.0F);
    exportInterleaved(image, region, writableBytesOf(out), layout);
    EXPECT_EQ(out, (std::vector<float>{0.0F, 2.0F, 3.0F, 0.0F}));
}

TEST(Interleaved, IntegerExportClampsAfterUnpremultiplying) {
    const Rect region = Rect::fromSize(0, 0, 3, 1);
    Image image(region, region, {"R", "A"});
    image.setSample("R", 0, 0, 1.5F); // HDR, opaque
    image.setSample("A", 0, 0, 1.0F);
    image.setSample("R", 1, 0, 0.25F); // 50 % colour at 50 % alpha, premultiplied
    image.setSample("A", 1, 0, 0.5F);
    image.setSample("R", 2, 0, -0.1F);
    image.setSample("A", 2, 0, 1.0F);
    std::vector<std::uint8_t> out(6);
    const InterleavedLayout layout = layoutOf(SampleType::UInt8, {"R", "A"}, "A", AlphaMode::Straight);
    exportInterleaved(image, region, writableBytesOf(out), layout);
    EXPECT_EQ(out, (std::vector<std::uint8_t>{255, 255, 128, 128, 0, 255}));
}

// What importInterleaved() or exportInterleaved() throws for a 2 × 2 image with R, G and A and a buffer of
// `bufferFloats` floats: "invalid_argument", "out_of_range" or "none".
std::string errorOf(bool import, const InterleavedLayout& layout, std::size_t bufferFloats) {
    const Rect region = Rect::fromSize(0, 0, 2, 2);
    Image image(region, region, {"R", "G", "A"});
    std::vector<float> buffer(bufferFloats);
    try {
        if (import) {
            importInterleaved(image, region, bytesOf(buffer), layout);
        } else {
            exportInterleaved(image, region, writableBytesOf(buffer), layout);
        }
    } catch (const std::invalid_argument&) {
        return "invalid_argument";
    } catch (const std::out_of_range&) {
        return "out_of_range";
    }
    return "none";
}

TEST(Interleaved, BadLayoutsAreRefused) {
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {}), 8), "invalid_argument");
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {"R", "R"}), 8), "invalid_argument");
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {"R", "G"}, "A"), 8), "invalid_argument");
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {"R", "B"}), 8), "out_of_range"); // the image has no B
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {"R", "G"}), 8), "none");
}

TEST(Interleaved, BuffersThatAreTooSmallAreRefused) {
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {"R", "G", "A"}), 11), "invalid_argument");
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {"R", "G", "A"}), 12), "none");
    EXPECT_EQ(errorOf(false, layoutOf(SampleType::Float32, {"R", "G"}), 7), "invalid_argument");
    EXPECT_EQ(errorOf(false, layoutOf(SampleType::Float32, {"R", "G"}), 8), "none");
    // A row stride shorter than a row of pixels.
    EXPECT_EQ(errorOf(true, layoutOf(SampleType::Float32, {"R"}, {}, AlphaMode::Premultiplied, 4), 8),
              "invalid_argument");
}

} // namespace
} // namespace pf::image
