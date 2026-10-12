// Colour maths of the golden harness (docs/FORMAT_NOTES.md §2.1–§2.3).

#include "support/golden/DeltaE.h"

#include <gtest/gtest.h>

#include <array>
#include <cmath>

namespace pf::golden {
namespace {

// Test pairs published with Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula: implementation
// notes, supplementary test data, and mathematical observations", to 4 decimals. They cover the hue-angle edge cases.
// Columns: L1 a1 b1, L2 a2 b2, ΔE00.
constexpr std::array<std::array<double, 7>, 34> sharmaPairs = {{
    {50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425},
    {50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615},
    {50.0, 2.8361, -74.0200, 50.0, 0.0, -82.7485, 3.4412},
    {50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0000},
    {50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0000},
    {50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0000},
    {50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669},
    {50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669},
    {50.0, 2.4900, -0.0010, 50.0, -2.4900, 0.0009, 7.1792},
    {50.0, 2.4900, -0.0010, 50.0, -2.4900, 0.0010, 7.1792},
    {50.0, 2.4900, -0.0010, 50.0, -2.4900, 0.0011, 7.2195},
    {50.0, 2.4900, -0.0010, 50.0, -2.4900, 0.0012, 7.2195},
    {50.0, -0.0010, 2.4900, 50.0, 0.0009, -2.4900, 4.8045},
    {50.0, -0.0010, 2.4900, 50.0, 0.0010, -2.4900, 4.8045},
    {50.0, -0.0010, 2.4900, 50.0, 0.0011, -2.4900, 4.7461},
    {50.0, 2.5000, 0.0000, 50.0, 0.0000, -2.5000, 4.3065},
    {50.0, 2.5000, 0.0000, 73.0, 25.0000, -18.0000, 27.1492},
    {50.0, 2.5000, 0.0000, 61.0, -5.0000, 29.0000, 22.8977},
    {50.0, 2.5000, 0.0000, 56.0, -27.0000, -3.0000, 31.9030},
    {50.0, 2.5000, 0.0000, 58.0, 24.0000, 15.0000, 19.4535},
    {50.0, 2.5000, 0.0000, 50.0, 3.1736, 0.5854, 1.0000},
    {50.0, 2.5000, 0.0000, 50.0, 3.2972, 0.0000, 1.0000},
    {50.0, 2.5000, 0.0000, 50.0, 1.8634, 0.5757, 1.0000},
    {50.0, 2.5000, 0.0000, 50.0, 3.2592, 0.3350, 1.0000},
    {60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644},
    {63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.2630},
    {61.2901, 3.7196, -5.3901, 61.4292, 2.2480, -4.9620, 1.8731},
    {35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645},
    {22.7233, 20.0904, -46.6940, 23.0331, 14.9730, -42.5619, 2.0373},
    // NOLINTNEXTLINE(modernize-use-std-numbers): published test data, not √2
    {36.4612, 47.8580, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146},
    {90.8027, -2.0831, 1.4410, 91.1528, -1.6435, 0.0447, 1.4441},
    {90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381},
    {6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377},
    {2.0776, 0.0795, -1.1350, 0.9033, -0.0636, -0.5514, 0.9082},
}};

Lab firstOf(const std::array<double, 7>& row) {
    return {.l = row[0], .a = row[1], .b = row[2]};
}

Lab secondOf(const std::array<double, 7>& row) {
    return {.l = row[3], .a = row[4], .b = row[5]};
}

TEST(DeltaE2000, MatchesThePublishedTestPairs) {
    for (std::size_t i = 0; i < sharmaPairs.size(); ++i) {
        const std::array<double, 7>& row = sharmaPairs.at(i);
        EXPECT_NEAR(deltaE2000(firstOf(row), secondOf(row)), row[6], 5e-5) << "test pair " << i + 1;
    }
}

TEST(DeltaE2000, IsSymmetricAndZeroForIdenticalColours) {
    for (const std::array<double, 7>& row : sharmaPairs) {
        EXPECT_NEAR(deltaE2000(firstOf(row), secondOf(row)), deltaE2000(secondOf(row), firstOf(row)), 1e-10);
        EXPECT_EQ(deltaE2000(firstOf(row), firstOf(row)), 0.0);
    }
}

TEST(SrgbTransfer, MapsTheEndPointsAndTheLinearSegment) {
    EXPECT_EQ(srgbToLinear(0.0), 0.0);
    EXPECT_NEAR(srgbToLinear(1.0), 1.0, 1e-12);
    EXPECT_NEAR(srgbToLinear(0.04045), 0.04045 / 12.92, 1e-12);
    EXPECT_NEAR(srgbToLinear(0.5), 0.214041, 1e-6);
}

TEST(SrgbTransfer, RoundTripsIncludingHdrAndNegativeValues) {
    for (const double value : {-0.5, -0.001, 0.0, 0.002, 0.04, 0.2, 0.5, 0.9, 1.0, 1.5, 4.0}) {
        EXPECT_NEAR(linearToSrgb(srgbToLinear(value)), value, 1e-10) << "value " << value;
    }
    EXPECT_LT(srgbToLinear(-0.5), 0.0);
    EXPECT_GT(srgbToLinear(1.5), 1.0);
}

TEST(LinearSrgbToLab, MapsWhiteAndBlackToTheEndsOfTheNeutralAxis) {
    const Lab white = linearSrgbToLab(1.0, 1.0, 1.0);
    EXPECT_NEAR(white.l, 100.0, 1e-9);
    EXPECT_NEAR(white.a, 0.0, 1e-9);
    EXPECT_NEAR(white.b, 0.0, 1e-9);
    const Lab black = linearSrgbToLab(0.0, 0.0, 0.0); // 116 × (16/116) − 16: zero up to rounding
    EXPECT_NEAR(black.l, 0.0, 1e-12);
    EXPECT_EQ(black.a, 0.0);
    EXPECT_EQ(black.b, 0.0);
}

TEST(LinearSrgbToLab, KeepsGreysNeutral) {
    for (const double grey : {0.001, 0.2, 0.5, 4.0}) {
        const Lab lab = linearSrgbToLab(grey, grey, grey);
        EXPECT_NEAR(lab.a, 0.0, 1e-9) << "grey " << grey;
        EXPECT_NEAR(lab.b, 0.0, 1e-9) << "grey " << grey;
    }
    EXPECT_NEAR(linearSrgbToLab(0.2, 0.2, 0.2).l, (116.0 * std::cbrt(0.2)) - 16.0, 1e-9);
}

TEST(LinearSrgbToLab, ConvertsTheSrgbPrimaries) {
    // Reference values: the sRGB primaries in L*a*b* (D50, Bradford adaptation), to 2 decimals.
    struct Primary {
        const char* name = "";
        std::array<double, 3> rgb{};
        Lab lab;
    };
    for (const Primary& primary :
         {Primary{.name = "red", .rgb = {1.0, 0.0, 0.0}, .lab = {.l = 54.29, .a = 80.81, .b = 69.89}},
          Primary{.name = "green", .rgb = {0.0, 1.0, 0.0}, .lab = {.l = 87.82, .a = -79.29, .b = 80.99}},
          Primary{.name = "blue", .rgb = {0.0, 0.0, 1.0}, .lab = {.l = 29.57, .a = 68.29, .b = -112.03}}}) {
        const Lab lab = linearSrgbToLab(primary.rgb[0], primary.rgb[1], primary.rgb[2]);
        EXPECT_NEAR(lab.l, primary.lab.l, 0.05) << primary.name;
        EXPECT_NEAR(lab.a, primary.lab.a, 0.05) << primary.name;
        EXPECT_NEAR(lab.b, primary.lab.b, 0.05) << primary.name;
    }
}

} // namespace
} // namespace pf::golden
