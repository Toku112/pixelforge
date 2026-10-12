// Sample-type conversions at the boundary (core/image/SampleConversion.h, FORMAT_NOTES §19.5).

#include "core/image/SampleConversion.h"

#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <limits>

namespace pf::image {
namespace {

constexpr float infinity = std::numeric_limits<float>::infinity();
constexpr float nan = std::numeric_limits<float>::quiet_NaN();

TEST(SampleConversion, BytesPerSample) {
    EXPECT_EQ(bytesPerSample(SampleType::UInt8), 1U);
    EXPECT_EQ(bytesPerSample(SampleType::UInt16), 2U);
    EXPECT_EQ(bytesPerSample(SampleType::Half), 2U);
    EXPECT_EQ(bytesPerSample(SampleType::Float32), 4U);
}

TEST(SampleConversion, EveryUInt8CodeRoundTrips) {
    for (int code = 0; code <= 255; ++code) {
        const auto value = static_cast<std::uint8_t>(code);
        const float f = fromUInt8(value);
        ASSERT_EQ(f, static_cast<float>(code) / 255.0F) << code;
        ASSERT_EQ(toUInt8(f), value) << code;
    }
    EXPECT_EQ(fromUInt8(0), 0.0F);
    EXPECT_EQ(fromUInt8(255), 1.0F);
}

TEST(SampleConversion, EveryUInt16CodeRoundTrips) {
    for (int code = 0; code <= 65535; ++code) {
        const auto value = static_cast<std::uint16_t>(code);
        const float f = fromUInt16(value);
        ASSERT_EQ(f, static_cast<float>(code) / 65535.0F) << code;
        ASSERT_EQ(toUInt16(f), value) << code;
    }
    EXPECT_EQ(fromUInt16(65535), 1.0F);
}

TEST(SampleConversion, IntegerEncodingClampsAndRounds) {
    EXPECT_EQ(toUInt8(-0.5F), 0);
    EXPECT_EQ(toUInt8(1.5F), 255);
    EXPECT_EQ(toUInt8(infinity), 255);
    EXPECT_EQ(toUInt8(-infinity), 0);
    EXPECT_EQ(toUInt8(nan), 0);
    EXPECT_EQ(toUInt8(0.5F), 128); // 127.5 rounds up
    EXPECT_EQ(toUInt8(0.499F), 127);
    EXPECT_EQ(toUInt8(1.0F / 510.0F), 1); // 0.5 code values round up
    EXPECT_EQ(toUInt8(0.9F / 255.0F), 1); // nearest code
    EXPECT_EQ(toUInt8(0.4F / 255.0F), 0);

    EXPECT_EQ(toUInt16(-1.0F), 0);
    EXPECT_EQ(toUInt16(2.0F), 65535);
    EXPECT_EQ(toUInt16(nan), 0);
    EXPECT_EQ(toUInt16(0.5F), 32768); // 32767.5 rounds up
    EXPECT_EQ(toUInt16(infinity), 65535);
}

TEST(SampleConversion, HalfKnownValues) {
    EXPECT_EQ(fromHalfBits(0x0000), 0.0F);
    EXPECT_TRUE(std::signbit(fromHalfBits(0x8000)));
    EXPECT_EQ(fromHalfBits(0x3C00), 1.0F);
    EXPECT_EQ(fromHalfBits(0xC000), -2.0F);
    EXPECT_EQ(fromHalfBits(0x7BFF), 65504.0F);              // largest half
    EXPECT_EQ(fromHalfBits(0x0400), std::ldexp(1.0F, -14)); // smallest normal
    EXPECT_EQ(fromHalfBits(0x0001), std::ldexp(1.0F, -24)); // smallest subnormal
    EXPECT_EQ(fromHalfBits(0x7C00), infinity);
    EXPECT_EQ(fromHalfBits(0xFC00), -infinity);
    EXPECT_TRUE(std::isnan(fromHalfBits(0x7E00)));

    EXPECT_EQ(toHalfBits(1.0F), 0x3C00);
    EXPECT_EQ(toHalfBits(-2.0F), 0xC000);
    EXPECT_EQ(toHalfBits(65504.0F), 0x7BFF);
    EXPECT_EQ(toHalfBits(0.0F), 0x0000);
    EXPECT_EQ(toHalfBits(-0.0F), 0x8000);
    EXPECT_EQ(toHalfBits(infinity), 0x7C00);
    EXPECT_EQ(toHalfBits(-infinity), 0xFC00);
}

TEST(SampleConversion, HalfRoundsToNearestEven) {
    // Halfway between 1 and the next half (1 + 2^-10): the even one, 1.
    EXPECT_EQ(toHalfBits(1.0F + std::ldexp(1.0F, -11)), 0x3C00);
    // Halfway between 1 + 2^-10 (odd) and 1 + 2·2^-10 (even): the even one.
    EXPECT_EQ(toHalfBits(1.0F + (3.0F * std::ldexp(1.0F, -11))), 0x3C02);
    // Just above halfway: up.
    EXPECT_EQ(toHalfBits(std::nextafter(1.0F + std::ldexp(1.0F, -11), 2.0F)), 0x3C01);
    // Subnormals: 2^-25 lies halfway between 0 and the smallest subnormal, so rounds to 0 (even).
    EXPECT_EQ(toHalfBits(std::ldexp(1.0F, -25)), 0x0000);
    EXPECT_EQ(toHalfBits(1.5F * std::ldexp(1.0F, -25)), 0x0001);
    EXPECT_EQ(toHalfBits(std::ldexp(1.0F, -30)), 0x0000);
    EXPECT_EQ(toHalfBits(-std::ldexp(1.0F, -30)), 0x8000);
}

TEST(SampleConversion, HalfOverflowsToInfinity) {
    EXPECT_EQ(toHalfBits(65519.0F), 0x7BFF); // still rounds down to 65504
    EXPECT_EQ(toHalfBits(65520.0F), 0x7C00); // halfway to 65536: rounds to even, past the largest half
    EXPECT_EQ(toHalfBits(1.0e6F), 0x7C00);
    EXPECT_EQ(toHalfBits(-1.0e6F), 0xFC00);
    EXPECT_TRUE(std::isnan(fromHalfBits(toHalfBits(nan))));
}

TEST(SampleConversion, EveryHalfRoundTripsThroughFloat) {
    for (int bits = 0; bits <= 0xFFFF; ++bits) {
        const auto value = static_cast<std::uint16_t>(bits);
        const float f = fromHalfBits(value);
        const bool isNan = (value & 0x7C00) == 0x7C00 && (value & 0x03FF) != 0;
        if (isNan) {
            ASSERT_TRUE(std::isnan(f)) << bits;
            ASSERT_TRUE(std::isnan(fromHalfBits(toHalfBits(f)))) << bits;
        } else {
            ASSERT_EQ(toHalfBits(f), value) << bits;
        }
    }
}

} // namespace
} // namespace pf::image
