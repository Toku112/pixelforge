// Keyframe curves (core/anim/AnimCurve.h, FORMAT_NOTES §20.1). Reference values are worked out by hand from the
// cubic Hermite basis: h00 = 2u³ − 3u² + 1, h10 = u³ − 2u² + u, h01 = −2u³ + 3u², h11 = u³ − u².

#include "core/anim/AnimCurve.h"

#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <random>
#include <stdexcept>

namespace pf::anim {
namespace {

constexpr double tight = 1e-12;

// Calls check(frame) at `first`, `first + step`, … up to `last` (integer steps: no rounding drift).
template <class Check>
void sample(double first, double last, double step, const Check& check) {
    const auto count = static_cast<int>(std::floor(((last - first) / step) + 1e-9));
    for (int i = 0; i <= count; ++i) {
        check(first + (i * step));
    }
}

Keyframe key(double frame, double value, Interpolation interpolation) {
    return {.frame = frame, .value = value, .interpolation = interpolation};
}

Keyframe bezierKey(double frame, double value, double inSlope, double outSlope, double inWeight = 1.0 / 3.0,
                   double outWeight = 1.0 / 3.0) {
    return {.frame = frame,
            .value = value,
            .interpolation = Interpolation::Bezier,
            .inSlope = inSlope,
            .outSlope = outSlope,
            .inWeight = inWeight,
            .outWeight = outWeight};
}

AnimCurve curve(std::initializer_list<Keyframe> keys) {
    AnimCurve result;
    for (const Keyframe& k : keys) {
        result.setKey(k);
    }
    return result;
}

TEST(AnimCurve, AnEmptyCurveHasNoValue) {
    const AnimCurve empty;
    EXPECT_TRUE(empty.empty());
    EXPECT_THROW((void)empty.value(0.0), std::logic_error);
}

TEST(AnimCurve, OneKeyHoldsEverywhere) {
    AnimCurve c = curve({key(5.0, 2.5, Interpolation::Smooth)});
    c.setExtrapolation(Extrapolation::Linear, Extrapolation::Linear);
    for (const double frame : {-100.0, 5.0, 5.5, 1e6}) {
        EXPECT_EQ(c.value(frame), 2.5);
    }
}

TEST(AnimCurve, KeysStaySortedAndReplaceTheirFrame) {
    AnimCurve c = curve({key(10.0, 1.0, Interpolation::Linear), key(0.0, 0.0, Interpolation::Linear),
                         key(5.0, 3.0, Interpolation::Linear)});
    ASSERT_EQ(c.size(), 3U);
    EXPECT_EQ(c.keys()[0].frame, 0.0);
    EXPECT_EQ(c.keys()[1].frame, 5.0);
    EXPECT_EQ(c.keys()[2].frame, 10.0);

    c.setKey(key(5.0 + 1e-7, 4.0, Interpolation::Linear)); // the same frame within the tolerance
    ASSERT_EQ(c.size(), 3U);
    EXPECT_EQ(c.keys()[1].value, 4.0);
    EXPECT_EQ(c.findKey(5.0), 1U);
    EXPECT_FALSE(c.findKey(5.01).has_value());

    EXPECT_TRUE(c.removeKey(5.0));
    EXPECT_FALSE(c.removeKey(5.0));
    EXPECT_EQ(c.size(), 2U);
}

TEST(AnimCurve, RefusesNumbersThatAreNotFinite) {
    AnimCurve c;
    const double nan = std::numeric_limits<double>::quiet_NaN();
    const double inf = std::numeric_limits<double>::infinity();
    EXPECT_THROW(c.setKey(key(nan, 0.0, Interpolation::Linear)), std::invalid_argument);
    EXPECT_THROW(c.setKey(key(0.0, inf, Interpolation::Linear)), std::invalid_argument);
    EXPECT_THROW(c.setKey(bezierKey(0.0, 0.0, nan, 0.0)), std::invalid_argument);
    EXPECT_THROW(c.setKey(bezierKey(0.0, 0.0, 0.0, 0.0, 1.5)), std::invalid_argument);
    EXPECT_THROW(c.setKey(bezierKey(0.0, 0.0, 0.0, 0.0, 0.3, -0.1)), std::invalid_argument);
    EXPECT_TRUE(c.empty());
}

TEST(AnimCurve, EveryKeyTypePassesThroughItsKeys) {
    for (const Interpolation type :
         {Interpolation::Constant, Interpolation::Linear, Interpolation::Smooth, Interpolation::Bezier}) {
        const AnimCurve c =
            curve({key(-3.0, 1.0, type), key(0.5, -2.0, type), key(4.0, 7.0, type), key(9.25, 7.5, type)});
        for (const Keyframe& k : c.keys()) {
            EXPECT_NEAR(c.value(k.frame), k.value, tight) << "type " << static_cast<int>(type);
        }
    }
}

TEST(AnimCurve, ConstantKeysHoldUntilTheNextKey) {
    const AnimCurve c = curve({key(0.0, 1.0, Interpolation::Constant), key(10.0, 5.0, Interpolation::Constant)});
    EXPECT_EQ(c.value(0.0), 1.0);
    EXPECT_EQ(c.value(9.999), 1.0);
    EXPECT_EQ(c.value(10.0), 5.0);
    EXPECT_EQ(c.outSlope(0), 0.0);
}

TEST(AnimCurve, LinearKeysAreStraightLines) {
    const AnimCurve c = curve({key(0.0, 0.0, Interpolation::Linear), key(10.0, 5.0, Interpolation::Linear),
                               key(20.0, -5.0, Interpolation::Constant)});
    EXPECT_EQ(c.value(2.0), 1.0);
    EXPECT_EQ(c.value(5.0), 2.5);
    EXPECT_EQ(c.value(15.0), 0.0); // a held key is still reached in a straight line
    EXPECT_EQ(c.inSlope(2), -1.0);
}

TEST(AnimCurve, SmoothBetweenTwoKeysEasesInAndOut) {
    const AnimCurve c = curve({key(0.0, 0.0, Interpolation::Smooth), key(4.0, 1.0, Interpolation::Smooth)});
    EXPECT_EQ(c.inSlope(0), 0.0);
    EXPECT_EQ(c.outSlope(1), 0.0);
    EXPECT_NEAR(c.value(1.0), 0.15625, tight); // h01(0.25)
    EXPECT_NEAR(c.value(2.0), 0.5, tight);
    EXPECT_NEAR(c.value(3.0), 0.84375, tight);
}

TEST(AnimCurve, SmoothUsesTheSlopeAcrossItsNeighbours) {
    const AnimCurve c = curve({key(0.0, 0.0, Interpolation::Smooth), key(1.0, 1.0, Interpolation::Smooth),
                               key(2.0, 2.0, Interpolation::Smooth)});
    EXPECT_EQ(c.inSlope(1), 1.0);
    EXPECT_EQ(c.outSlope(1), 1.0);
    // Segment 0–1 with slopes 0 and 1: h01(0.5) + h11(0.5) = 0.5 − 0.125.
    EXPECT_NEAR(c.value(0.5), 0.375, tight);
}

TEST(AnimCurve, SmoothIsFlatAtPeaksAndNeverOvershoots) {
    const AnimCurve c = curve({key(0.0, 0.0, Interpolation::Smooth), key(10.0, 1.0, Interpolation::Smooth),
                               key(13.0, 0.2, Interpolation::Smooth)});
    EXPECT_EQ(c.inSlope(1), 0.0);
    sample(0.0, 13.0, 0.01, [&](double frame) {
        const double v = c.value(frame);
        EXPECT_LE(v, 1.0);
        EXPECT_GE(v, 0.0);
    });
}

TEST(AnimCurve, SmoothKeepsRisingBetweenRisingKeys) {
    // Unevenly spaced, steadily rising keys: the slope across the neighbours (0.11 at key 1) would overshoot the
    // flat stretch after it, so it is limited to three times that stretch's slope.
    const AnimCurve c = curve({key(0.0, 0.0, Interpolation::Smooth), key(1.0, 10.0, Interpolation::Smooth),
                               key(100.0, 11.0, Interpolation::Smooth)});
    EXPECT_NEAR(c.outSlope(1), 3.0 / 99.0, tight);
    double previous = c.value(0.0);
    sample(0.0, 100.0, 0.05, [&](double frame) {
        const double v = c.value(frame);
        EXPECT_GE(v, previous - tight) << "at frame " << frame;
        previous = v;
    });

    // Random rising keys, random spacing.
    std::mt19937 random(7);
    std::uniform_real_distribution<double> step(0.01, 20.0);
    AnimCurve randomCurve;
    double frame = 0.0;
    double value = 0.0;
    for (int i = 0; i < 40; ++i) {
        randomCurve.setKey(key(frame, value, Interpolation::Smooth));
        frame += step(random);
        value += step(random) * step(random);
    }
    previous = randomCurve.value(0.0);
    sample(0.0, frame, 0.01, [&](double f) {
        const double v = randomCurve.value(f);
        EXPECT_GE(v, previous - 1e-9) << "at frame " << f;
        previous = v;
    });
}

TEST(AnimCurve, BezierWithThirdHandlesIsTheHermiteCubic) {
    const AnimCurve c = curve({bezierKey(0.0, 0.0, 0.0, 2.0), bezierKey(1.0, 1.0, 0.0, 0.0)});
    // h10(0.5) · 2 + h01(0.5) = 0.125 · 2 + 0.5.
    EXPECT_NEAR(c.value(0.5), 0.75, tight);
    EXPECT_EQ(c.outSlope(0), 2.0);
    EXPECT_EQ(c.inSlope(1), 0.0);
}

TEST(AnimCurve, BezierHandleLengthsBendTimeNotTheEnds) {
    // Handles lying on the line y = x keep the curve on that line whatever their lengths: checks that the frame →
    // curve parameter solve is exact.
    const AnimCurve c = curve({bezierKey(0.0, 0.0, 1.0, 1.0, 0.3, 0.1), bezierKey(10.0, 10.0, 1.0, 1.0, 0.6, 0.3)});
    sample(0.0, 10.0, 0.37, [&](double frame) { EXPECT_NEAR(c.value(frame), frame, 1e-9); });
}

TEST(AnimCurve, CrossingBezierHandlesAreShortenedInProportion) {
    const AnimCurve crossing = curve({bezierKey(0.0, 0.0, 0.0, 3.0, 0.3, 0.8), bezierKey(1.0, 1.0, -2.0, 0.0, 0.8)});
    const AnimCurve halves = curve({bezierKey(0.0, 0.0, 0.0, 3.0, 0.3, 0.5), bezierKey(1.0, 1.0, -2.0, 0.0, 0.5)});
    sample(0.0, 1.0, 0.05, [&](double frame) { EXPECT_NEAR(crossing.value(frame), halves.value(frame), tight); });
}

TEST(AnimCurve, ZeroLengthBezierHandlesStillSolve) {
    const AnimCurve c = curve({bezierKey(0.0, 0.0, 0.0, 5.0, 0.0, 0.0), bezierKey(1.0, 1.0, 5.0, 0.0, 0.0, 0.0)});
    double previous = 0.0;
    sample(0.0, 1.0, 0.01, [&](double frame) {
        const double v = c.value(frame);
        EXPECT_TRUE(std::isfinite(v));
        EXPECT_GE(v, previous - tight);
        previous = v;
    });
}

TEST(AnimCurve, ExtrapolationHoldsOrContinues) {
    AnimCurve c = curve({key(0.0, 0.0, Interpolation::Linear), key(10.0, 5.0, Interpolation::Linear)});
    EXPECT_EQ(c.value(-10.0), 0.0);
    EXPECT_EQ(c.value(20.0), 5.0);
    c.setExtrapolation(Extrapolation::Linear, Extrapolation::Linear);
    EXPECT_EQ(c.value(-10.0), -5.0);
    EXPECT_EQ(c.value(20.0), 10.0);

    // Smooth end keys point at their neighbour when the curve continues past them, so the line goes on straight.
    AnimCurve smooth = curve({key(0.0, 0.0, Interpolation::Smooth), key(10.0, 10.0, Interpolation::Smooth)});
    smooth.setExtrapolation(Extrapolation::Linear, Extrapolation::Linear);
    EXPECT_NEAR(smooth.value(2.5), 2.5, tight);
    EXPECT_NEAR(smooth.value(20.0), 20.0, tight);
    EXPECT_NEAR(smooth.value(-1.0), -1.0, tight);

    // A held last key stays flat.
    AnimCurve held = curve({key(0.0, 0.0, Interpolation::Linear), key(10.0, 5.0, Interpolation::Constant)});
    held.setExtrapolation(Extrapolation::Linear, Extrapolation::Linear);
    EXPECT_EQ(held.value(20.0), 5.0);
}

TEST(AnimCurve, SubFramesAndNegativeFrames) {
    const AnimCurve c = curve({key(-2.5, 1.0, Interpolation::Linear), key(-0.5, 3.0, Interpolation::Linear)});
    EXPECT_NEAR(c.value(-1.5), 2.0, tight);
    EXPECT_NEAR(c.value(-2.25), 1.25, tight);
}

TEST(AnimCurve, MixedKeyTypesUseEachSidesSlope) {
    // Linear key 0 leaves toward key 1 (slope 1); smooth key 1 (a peak) arrives flat: h10(0.5)·1·1 + h01(0.5)·1.
    const AnimCurve c = curve({key(0.0, 0.0, Interpolation::Linear), key(1.0, 1.0, Interpolation::Smooth),
                               key(2.0, 0.0, Interpolation::Linear)});
    EXPECT_EQ(c.outSlope(0), 1.0);
    EXPECT_EQ(c.inSlope(1), 0.0);
    EXPECT_NEAR(c.value(0.5), 0.625, tight);
}

} // namespace
} // namespace pf::anim
