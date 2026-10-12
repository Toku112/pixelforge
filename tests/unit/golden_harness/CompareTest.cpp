// Comparison rules of the golden harness (support/golden/Compare.h).

#include "support/golden/Compare.h"

#include "support/golden/DeltaE.h"

#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace pf::golden {
namespace {

constexpr float nan = std::numeric_limits<float>::quiet_NaN();
constexpr float infinity = std::numeric_limits<float>::infinity();
constexpr Box frame{.minX = 0, .minY = 0, .maxX = 3, .maxY = 2}; // 4 × 3 pixels

// The parts of a result that only exist in some cases; a test that expects them fails with an exception otherwise.
const DeltaEReport& deltaEOf(const CompareResult& result) {
    if (!result.deltaE) {
        throw std::logic_error("the result has no ΔE report");
    }
    return *result.deltaE;
}

const Image& differenceOf(const CompareResult& result) {
    if (!result.difference) {
        throw std::logic_error("the result has no difference image");
    }
    return *result.difference;
}

// A 4 × 3 image whose channels all hold `value`.
Image filled(std::initializer_list<std::string_view> names, float value) {
    Image image = Image::create(frame, frame, names);
    for (Channel& channel : image.channels) {
        channel.samples.assign(channel.samples.size(), value);
    }
    return image;
}

// Compares two single-channel images that differ only at pixel (1, 2).
CompareResult compareOneSample(float expected, float actual, const CompareOptions& options = {}) {
    const Image expectedImage = filled({"R"}, expected);
    Image actualImage = expectedImage;
    actualImage.channel("R").samples[actualImage.indexOf(1, 2)] = actual;
    return compare(actualImage, expectedImage, options);
}

TEST(GoldenCompare, IdenticalImagesMatch) {
    Image image = Image::create(frame, {.minX = -2, .minY = -1, .maxX = 5, .maxY = 2}, {"R", "G", "Z"});
    for (std::size_t i = 0; i < image.pixelCount(); ++i) {
        image.channel("R").samples[i] = 1000.0F * static_cast<float>(i);
        image.channel("G").samples[i] = -0.25F * static_cast<float>(i);
    }
    const CompareResult result = compare(image, image);
    EXPECT_TRUE(result.passed) << result.describe();
    EXPECT_EQ(result.describe(), "match");
    ASSERT_EQ(result.channels.size(), 3U);
    EXPECT_EQ(result.channels[0].maxError, 0.0);
}

TEST(GoldenCompare, AllowsAnAbsoluteErrorOf1eMinus4UpToOne) {
    EXPECT_TRUE(compareOneSample(0.5F, 0.5F + 0.9e-4F).passed);
    EXPECT_FALSE(compareOneSample(0.5F, 0.5F + 1.1e-4F).passed);
    EXPECT_TRUE(compareOneSample(0.0F, -0.9e-4F).passed);
    EXPECT_FALSE(compareOneSample(0.0F, 1.1e-4F).passed);
}

TEST(GoldenCompare, AllowsARelativeErrorOf1eMinus4AboveOne) {
    EXPECT_TRUE(compareOneSample(100.0F, 100.009F).passed);
    EXPECT_FALSE(compareOneSample(100.0F, 100.011F).passed);
    EXPECT_TRUE(compareOneSample(-50.0F, -50.004F).passed);
    EXPECT_FALSE(compareOneSample(-50.0F, -50.006F).passed);
}

TEST(GoldenCompare, ReportsTheSampleFurthestOverItsAllowance) {
    Image expected = filled({"R"}, 0.5F);
    expected.channel("R").samples[expected.indexOf(3, 0)] = 1000.0F;
    Image actual = expected;
    actual.channel("R").samples[actual.indexOf(3, 0)] = 1000.05F; // within 0.1 (relative): passes
    actual.channel("R").samples[actual.indexOf(2, 1)] = 0.502F;   // 20 × its allowance
    actual.channel("R").samples[actual.indexOf(0, 2)] = 0.5005F;  // 5 × its allowance

    const CompareResult result = compare(actual, expected);
    EXPECT_FALSE(result.passed);
    ASSERT_EQ(result.channels.size(), 1U);
    const ChannelReport& report = result.channels[0];
    EXPECT_EQ(report.sampleCount, 12U);
    EXPECT_EQ(report.samplesOverTolerance, 2U);
    EXPECT_EQ(report.worstX, 2);
    EXPECT_EQ(report.worstY, 1);
    EXPECT_NEAR(report.worstError, 0.002, 1e-6);
    EXPECT_NEAR(report.worstAllowed, 1e-4, 1e-12);
    EXPECT_NEAR(report.maxError, 0.05, 1e-4);
    EXPECT_NE(result.describe().find("R: 2 of 12 samples over tolerance; worst at (2, 1)"), std::string::npos)
        << result.describe();
}

TEST(GoldenCompare, NanAndInfinityFailByDefault) {
    EXPECT_FALSE(compareOneSample(0.5F, nan).passed);
    EXPECT_FALSE(compareOneSample(0.5F, infinity).passed);
    EXPECT_FALSE(compareOneSample(nan, nan).passed); // even when both have it

    const CompareResult result = compareOneSample(0.5F, nan);
    EXPECT_EQ(result.channels[0].nonFiniteMismatches, 1U);
    EXPECT_EQ(result.channels[0].nonFiniteActual, 1U);
    EXPECT_EQ(result.channels[0].samplesOverTolerance, 0U);
    EXPECT_NE(result.describe().find("NaN or infinity"), std::string::npos);
}

TEST(GoldenCompare, MustMatchAllowsTheSameNanOrInfinity) {
    CompareOptions options;
    options.tolerance.nonFinite = NonFinite::MustMatch;
    EXPECT_TRUE(compareOneSample(nan, nan, options).passed);
    EXPECT_TRUE(compareOneSample(infinity, infinity, options).passed);
    EXPECT_TRUE(compareOneSample(-infinity, -infinity, options).passed);
    EXPECT_FALSE(compareOneSample(infinity, -infinity, options).passed);
    EXPECT_FALSE(compareOneSample(nan, 1.0F, options).passed);
    EXPECT_FALSE(compareOneSample(1.0F, nan, options).passed);
    EXPECT_FALSE(compareOneSample(nan, infinity, options).passed);
}

TEST(GoldenCompare, PerChannelToleranceOverridesTheDefault) {
    const Image expected = filled({"R", "Z"}, 10.0F);
    Image actual = filled({"R", "Z"}, 10.05F);
    CompareOptions options;
    options.channelTolerances["Z"] = FloatTolerance{.absolute = 0.1, .relative = 0.0};

    const CompareResult result = compare(actual, expected, options);
    EXPECT_FALSE(result.passed);
    ASSERT_EQ(result.channels.size(), 2U);
    EXPECT_FALSE(result.channels[0].passed); // R: default tolerance
    EXPECT_TRUE(result.channels[1].passed);  // Z: its own

    actual.channel("R") = expected.channel("R");
    EXPECT_TRUE(compare(actual, expected, options).passed);
}

TEST(GoldenCompare, ReportsStructuralDifferencesWithoutComparingPixels) {
    const Image expected = filled({"R", "G", "Z"}, 1.0F);
    const Image actual = Image::create({.minX = 0, .minY = 0, .maxX = 9, .maxY = 9},
                                       {.minX = 0, .minY = 0, .maxX = 4, .maxY = 2}, {"R", "G", "extra"});
    CompareOptions options;
    options.channelTolerances["Y"] = FloatTolerance{};

    const CompareResult result = compare(actual, expected, options);
    EXPECT_FALSE(result.passed);
    EXPECT_TRUE(result.channels.empty());
    EXPECT_FALSE(result.difference.has_value());
    const std::string text = result.describe();
    EXPECT_NE(text.find("display window differs: actual (0, 0)–(9, 9), expected (0, 0)–(3, 2)"), std::string::npos)
        << text;
    EXPECT_NE(text.find("data window differs"), std::string::npos) << text;
    EXPECT_NE(text.find("channel 'Z' is missing from the actual image"), std::string::npos) << text;
    EXPECT_NE(text.find("unexpected channel 'extra'"), std::string::npos) << text;
    EXPECT_NE(text.find("tolerance is given for channel 'Y'"), std::string::npos) << text;
}

TEST(GoldenCompare, DifferenceImageHoldsTheErrorsAndTheFailedPixels) {
    const Image expected = filled({"R", "G"}, 0.25F);
    Image actual = expected;
    actual.channel("R").samples[actual.indexOf(1, 1)] = 0.75F;
    actual.channel("G").samples[actual.indexOf(2, 0)] = nan;
    actual.channel("G").samples[actual.indexOf(3, 2)] = 0.25005F; // within tolerance

    const CompareResult result = compare(actual, expected);
    ASSERT_TRUE(result.difference.has_value());
    const Image& difference = differenceOf(result);
    EXPECT_EQ(difference.displayWindow, expected.displayWindow);
    EXPECT_EQ(difference.dataWindow, expected.dataWindow);
    ASSERT_NE(difference.find("golden.failed"), nullptr);
    const auto at = [&difference](std::string_view channel, int x, int y) {
        return difference.channel(channel).samples[difference.indexOf(x, y)];
    };
    EXPECT_FLOAT_EQ(at("R", 1, 1), 0.5F);
    EXPECT_TRUE(std::isinf(at("G", 2, 0)));
    EXPECT_NEAR(at("G", 3, 2), 5e-5F, 1e-6F);
    EXPECT_EQ(at("golden.failed", 1, 1), 1.0F);
    EXPECT_EQ(at("golden.failed", 2, 0), 1.0F);
    EXPECT_EQ(at("golden.failed", 3, 2), 0.0F);
    EXPECT_EQ(at("golden.failed", 0, 0), 0.0F);
}

// ---- ΔE mode ----

CompareOptions deltaEMode() {
    CompareOptions options;
    options.mode = CompareMode::DeltaE;
    return options;
}

Image grey(float value, float alpha = 1.0F) {
    Image image = filled({"R", "G", "B", "A"}, value);
    image.channel("A").samples.assign(image.pixelCount(), alpha);
    return image;
}

TEST(GoldenCompareDeltaE, IdenticalImagesMatch) {
    const CompareResult result = compare(grey(0.5F), grey(0.5F), deltaEMode());
    EXPECT_TRUE(result.passed) << result.describe();
    ASSERT_TRUE(result.deltaE.has_value());
    EXPECT_EQ(deltaEOf(result).maximum, 0.0);
    EXPECT_TRUE(result.channels.empty()); // R, G, B and A are compared perceptually only
}

TEST(GoldenCompareDeltaE, OneEightBitCodeValueIsWithinTolerance) {
    Image actual = grey(128.0F / 255.0F);
    actual.channel("R").samples.assign(actual.pixelCount(), 129.0F / 255.0F);
    const CompareResult result = compare(actual, grey(128.0F / 255.0F), deltaEMode());
    EXPECT_TRUE(result.passed) << result.describe();
    EXPECT_GT(deltaEOf(result).maximum, 0.0);
    EXPECT_LT(deltaEOf(result).maximum, 1.0);
}

TEST(GoldenCompareDeltaE, FailsWhenTheAverageIsOverItsLimit) {
    // 0.50 → 0.52 (sRGB-encoded) is about 2 ΔE everywhere: under the maximum (3), over the average limit (1).
    const CompareResult result = compare(grey(0.52F), grey(0.5F), deltaEMode());
    EXPECT_FALSE(result.passed);
    EXPECT_GT(deltaEOf(result).average, 1.0);
    EXPECT_LT(deltaEOf(result).maximum, 3.0);
    EXPECT_EQ(deltaEOf(result).pixelsOverMaximum, 0U);
    EXPECT_NE(result.describe().find("ΔE2000: average"), std::string::npos);
}

TEST(GoldenCompareDeltaE, FailsWhenOnePixelIsOverTheMaximum) {
    Image actual = grey(0.5F);
    actual.channel("G").samples[actual.indexOf(3, 1)] = 0.8F;
    const CompareResult result = compare(actual, grey(0.5F), deltaEMode());
    EXPECT_FALSE(result.passed);
    EXPECT_NEAR(deltaEOf(result).average, deltaEOf(result).maximum / 12.0, 1e-9); // one pixel of twelve differs
    EXPECT_GT(deltaEOf(result).maximum, 3.0);
    EXPECT_EQ(deltaEOf(result).maximumX, 3);
    EXPECT_EQ(deltaEOf(result).maximumY, 1);
    EXPECT_EQ(deltaEOf(result).pixelsOverMaximum, 1U);
    const Image& difference = differenceOf(result);
    EXPECT_EQ(difference.channel("golden.failed").samples[difference.indexOf(3, 1)], 1.0F);
    EXPECT_GT(difference.channel("golden.deltaE").samples[difference.indexOf(3, 1)], 3.0F);
}

TEST(GoldenCompareDeltaE, IgnoresColourUnderZeroAlphaButCatchesAlphaDifferences) {
    EXPECT_TRUE(compare(grey(0.9F, 0.0F), grey(0.1F, 0.0F), deltaEMode()).passed);
    EXPECT_FALSE(compare(grey(0.5F, 0.5F), grey(0.5F, 1.0F), deltaEMode()).passed);
}

TEST(GoldenCompareDeltaE, ImagesWithoutAlphaAreOpaque) {
    const Image expected = filled({"R", "G", "B"}, 0.5F);
    EXPECT_TRUE(compare(expected, expected, deltaEMode()).passed);
    Image actual = expected;
    actual.channel("B").samples.assign(actual.pixelCount(), 0.9F);
    EXPECT_FALSE(compare(actual, expected, deltaEMode()).passed);
}

TEST(GoldenCompareDeltaE, EncodingSelectsWhetherTheTransferCurveIsApplied) {
    CompareOptions linearOptions = deltaEMode();
    linearOptions.deltaE.encoding = RgbEncoding::LinearSrgb;
    const CompareResult linear = compare(grey(0.22F), grey(0.2F), linearOptions);
    const CompareResult encoded = compare(grey(0.22F), grey(0.2F), deltaEMode());

    // Inputs are floats, so the expected values are computed from the same float values.
    const auto brighter = static_cast<double>(0.22F);
    const auto darker = static_cast<double>(0.2F);
    const double linearDeltaE =
        deltaE2000(linearSrgbToLab(brighter, brighter, brighter), linearSrgbToLab(darker, darker, darker));
    const double brighterLinear = srgbToLinear(brighter);
    const double darkerLinear = srgbToLinear(darker);
    const double encodedDeltaE = deltaE2000(linearSrgbToLab(brighterLinear, brighterLinear, brighterLinear),
                                            linearSrgbToLab(darkerLinear, darkerLinear, darkerLinear));
    EXPECT_NEAR(deltaEOf(linear).maximum, linearDeltaE, 1e-9);
    EXPECT_NEAR(deltaEOf(encoded).maximum, encodedDeltaE, 1e-9);
    EXPECT_GT(std::abs(linearDeltaE - encodedDeltaE), 0.1);
}

TEST(GoldenCompareDeltaE, ComparesOtherChannelsInFloat) {
    Image expected = grey(0.5F);
    expected.addChannel("Z", 100.0F);
    Image actual = expected;
    actual.channel("Z").samples[0] = 100.5F;
    const CompareResult result = compare(actual, expected, deltaEMode());
    EXPECT_FALSE(result.passed);
    EXPECT_TRUE(deltaEOf(result).passed);
    ASSERT_EQ(result.channels.size(), 1U);
    EXPECT_EQ(result.channels[0].name, "Z");
    EXPECT_FALSE(result.channels[0].passed);
}

TEST(GoldenCompareDeltaE, NanFails) {
    Image actual = grey(0.5F);
    actual.channel("B").samples[2] = nan;
    const CompareResult result = compare(actual, grey(0.5F), deltaEMode());
    EXPECT_FALSE(result.passed);
    EXPECT_EQ(deltaEOf(result).nonFinitePixels, 1U);
}

TEST(GoldenCompareDeltaE, NeedsRgbChannels) {
    const Image image = filled({"Y"}, 0.5F);
    const CompareResult result = compare(image, image, deltaEMode());
    EXPECT_FALSE(result.passed);
    EXPECT_NE(result.describe().find("ΔE mode needs channels R, G and B"), std::string::npos);
}

} // namespace
} // namespace pf::golden
