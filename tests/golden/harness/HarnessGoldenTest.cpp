// Golden self-test of the harness: procedural images must match their checked-in expected EXRs on every platform.
// Catches platform differences in EXR reading and accidental changes to the comparison rules, and keeps the whole
// golden path (file layout, update-golden) exercised before the first real feature uses it.

#include "support/golden/Golden.h"
#include "support/golden/GoldenImage.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <numbers>

namespace pf::golden {
namespace {

// Scene-linear render-pass-like data: a 48 × 32 frame with 4 pixels of overscan on the left and top and pixels
// stopping 8 short on the right; an HDR ramp (1/16 to 256), signed values, premultiplied alpha, depth and a
// layer-named pass.
Image sceneLinearImage() {
    Image image =
        Image::create({.minX = 0, .minY = 0, .maxX = 47, .maxY = 31}, {.minX = -4, .minY = -4, .maxX = 39, .maxY = 31},
                      {"R", "G", "B", "A", "Z", "diffuse_direct.R"});
    const Box& window = image.dataWindow;
    for (int y = window.minY; y <= window.maxY; ++y) {
        for (int x = window.minX; x <= window.maxX; ++x) {
            const double u = static_cast<double>(x - window.minX) / (window.width() - 1);
            const double v = static_cast<double>(y - window.minY) / (window.height() - 1);
            const double alpha = 0.25 + (0.75 * v);
            const std::size_t i = image.indexOf(x, y);
            image.channel("R").samples[i] = static_cast<float>(std::exp2((12.0 * u) - 4.0) * alpha);
            image.channel("G").samples[i] = static_cast<float>(2.0 * std::sin(2.0 * std::numbers::pi * v) * alpha);
            image.channel("B").samples[i] = static_cast<float>(u * v * alpha);
            image.channel("A").samples[i] = static_cast<float>(alpha);
            image.channel("Z").samples[i] = static_cast<float>(10.0 + (1000.0 * u * u));
            image.channel("diffuse_direct.R").samples[i] = static_cast<float>(0.18 * (1.0 + std::cos(9.0 * u * v)));
        }
    }
    return image;
}

// Display-referred 8-bit data (code values / 255, sRGB-encoded, straight alpha): a hue sweep with a soft edge.
Image displayReferredImage() {
    const Box frame{.minX = 0, .minY = 0, .maxX = 63, .maxY = 15};
    Image image = Image::create(frame, frame, {"R", "G", "B", "A"});
    const auto code = [](double value) {
        return static_cast<float>(std::round(std::clamp(value, 0.0, 1.0) * 255.0) / 255.0);
    };
    for (int y = frame.minY; y <= frame.maxY; ++y) {
        for (int x = frame.minX; x <= frame.maxX; ++x) {
            const double hue = 2.0 * std::numbers::pi * x / 64.0;
            const std::size_t i = image.indexOf(x, y);
            image.channel("R").samples[i] = code(0.5 + (0.5 * std::cos(hue)));
            image.channel("G").samples[i] = code(0.5 + (0.5 * std::cos(hue - (2.0 * std::numbers::pi / 3.0))));
            image.channel("B").samples[i] = code(0.5 + (0.5 * std::cos(hue + (2.0 * std::numbers::pi / 3.0))));
            image.channel("A").samples[i] = code(static_cast<double>(y) / 12.0);
        }
    }
    return image;
}

TEST(GoldenHarness, SceneLinearImageMatchesItsExpectedExr) {
    EXPECT_TRUE(matchesGolden(sceneLinearImage(), "harness/scene_linear"));
}

TEST(GoldenHarness, DisplayReferredImageMatchesInDeltaEMode) {
    CompareOptions options;
    options.mode = CompareMode::DeltaE;
    EXPECT_TRUE(matchesGolden(displayReferredImage(), "harness/display_8bit", options));
}

} // namespace
} // namespace pf::golden
