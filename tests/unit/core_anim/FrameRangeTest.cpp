// Whole frames and frame ranges (core/anim/FrameRange.h, FORMAT_NOTES §23.3).

#include "core/anim/FrameRange.h"

#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>
#include <vector>

namespace pf::anim {
namespace {

// The frames shown at `from` … `to` (Black as −999).
std::vector<std::int64_t> shown(std::int64_t from, std::int64_t to, const FrameRange& range, OutsideRange before,
                                OutsideRange after) {
    std::vector<std::int64_t> frames;
    for (std::int64_t frame = from; frame <= to; ++frame) {
        frames.push_back(frameInRange(frame, range, before, after).value_or(-999));
    }
    return frames;
}

TEST(FrameRange, WholeFramesRoundToTheNearestWithHalvesUp) {
    EXPECT_EQ(wholeFrame(7.0), 7);
    EXPECT_EQ(wholeFrame(7.49), 7);
    EXPECT_EQ(wholeFrame(7.5), 8);
    EXPECT_EQ(wholeFrame(-1.5), -1);
    EXPECT_EQ(wholeFrame(-1.51), -2);
    EXPECT_EQ(wholeFrame(-0.4), 0);
    EXPECT_EQ(wholeFrame(1e300), maxWholeFrame);
    EXPECT_EQ(wholeFrame(-std::numeric_limits<double>::infinity()), -maxWholeFrame);
    EXPECT_EQ(wholeFrame(std::nan("")), 0);
}

TEST(FrameRange, FramesInsideTheRangeShowThemselves) {
    const FrameRange range{.first = 3, .last = 6};
    EXPECT_EQ(range.length(), 4);
    EXPECT_TRUE(range.contains(3));
    EXPECT_FALSE(range.contains(7));
    for (std::int64_t frame = 3; frame <= 6; ++frame) {
        EXPECT_EQ(frameInRange(frame, range, OutsideRange::Black, OutsideRange::Black), frame);
    }
}

TEST(FrameRange, HoldShowsTheEndFrames) {
    EXPECT_EQ(shown(-1, 9, {.first = 3, .last = 6}, OutsideRange::Hold, OutsideRange::Hold),
              (std::vector<std::int64_t>{3, 3, 3, 3, 3, 4, 5, 6, 6, 6, 6}));
}

TEST(FrameRange, LoopRepeatsTheRangeBothWays) {
    EXPECT_EQ(shown(-3, 10, {.first = 1, .last = 3}, OutsideRange::Loop, OutsideRange::Loop),
              (std::vector<std::int64_t>{3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1}));
}

TEST(FrameRange, BounceDoesNotRepeatTheEndFrames) {
    EXPECT_EQ(shown(1, 10, {.first = 1, .last = 3}, OutsideRange::Hold, OutsideRange::Bounce),
              (std::vector<std::int64_t>{1, 2, 3, 2, 1, 2, 3, 2, 1, 2}));
    EXPECT_EQ(shown(-4, 1, {.first = 1, .last = 3}, OutsideRange::Bounce, OutsideRange::Hold),
              (std::vector<std::int64_t>{2, 1, 2, 3, 2, 1})); // backwards from 1: 2 3 2 1 2 …
    // Short ranges: one frame holds, two alternate.
    EXPECT_EQ(shown(1, 4, {.first = 1, .last = 1}, OutsideRange::Bounce, OutsideRange::Bounce),
              (std::vector<std::int64_t>{1, 1, 1, 1}));
    EXPECT_EQ(shown(5, 9, {.first = 5, .last = 6}, OutsideRange::Bounce, OutsideRange::Bounce),
              (std::vector<std::int64_t>{5, 6, 5, 6, 5}));
}

TEST(FrameRange, BlackShowsNothingAndEachSideHasItsOwnMode) {
    EXPECT_EQ(shown(0, 5, {.first = 2, .last = 3}, OutsideRange::Black, OutsideRange::Hold),
              (std::vector<std::int64_t>{-999, -999, 2, 3, 3, 3}));
    EXPECT_EQ(shown(0, 5, {.first = 2, .last = 3}, OutsideRange::Hold, OutsideRange::Black),
              (std::vector<std::int64_t>{2, 2, 2, 3, -999, -999}));
}

TEST(FrameRange, NegativeAndFarAwayFrames) {
    const FrameRange range{.first = -10, .last = -8};
    EXPECT_EQ(frameInRange(-11, range, OutsideRange::Loop, OutsideRange::Loop), -8);
    EXPECT_EQ(frameInRange(-7, range, OutsideRange::Loop, OutsideRange::Loop), -10);
    const std::int64_t far = std::int64_t{1} << 55;
    EXPECT_EQ(frameInRange(far, {.first = 1, .last = 1000}, OutsideRange::Hold, OutsideRange::Loop),
              1 + ((far - 1) % 1000));
    EXPECT_EQ(frameInRange(-far, {.first = 0, .last = 2}, OutsideRange::Bounce, OutsideRange::Hold),
              std::optional<std::int64_t>(0)); // 2⁵⁵ is a multiple of the period 4
}

TEST(FrameRange, RunsAndTheirText) {
    const std::vector<std::int64_t> frames{-5, -4, -3, 1, 7, 8, 12};
    const std::vector<FrameRange> runs = runsOf(frames);
    EXPECT_EQ(
        runs,
        (std::vector<FrameRange>{
            {.first = -5, .last = -3}, {.first = 1, .last = 1}, {.first = 7, .last = 8}, {.first = 12, .last = 12}}));
    EXPECT_EQ(toString(runs), "-5–-3, 1, 7–8, 12");
    EXPECT_EQ(toString(std::vector<FrameRange>{}), "");
    EXPECT_TRUE(runsOf(std::vector<std::int64_t>{}).empty());
}

} // namespace
} // namespace pf::anim
