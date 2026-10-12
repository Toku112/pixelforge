// Pixel rectangles and region maths (core/image/Rect.h, FORMAT_NOTES §19.1).

#include "core/image/Rect.h"

#include <gtest/gtest.h>

#include <stdexcept>

namespace pf::image {
namespace {

constexpr Rect hd{.x0 = 0, .y0 = 0, .x1 = 1920, .y1 = 1080};

TEST(Rect, SizeAndArea) {
    EXPECT_EQ(hd.width(), 1920);
    EXPECT_EQ(hd.height(), 1080);
    EXPECT_EQ(hd.area(), 1920 * 1080);
    EXPECT_FALSE(hd.isEmpty());

    constexpr Rect negative{.x0 = -10, .y0 = -20, .x1 = -4, .y1 = 0};
    EXPECT_EQ(negative.width(), 6);
    EXPECT_EQ(negative.height(), 20);

    EXPECT_EQ(Rect::fromSize(-5, 7, 10, 3), (Rect{.x0 = -5, .y0 = 7, .x1 = 5, .y1 = 10}));
}

TEST(Rect, AreaDoesNotOverflow) {
    constexpr Rect huge{.x0 = -maxCoordinate, .y0 = -maxCoordinate, .x1 = maxCoordinate, .y1 = maxCoordinate};
    EXPECT_EQ(huge.area(), 4LL * maxCoordinate * maxCoordinate);
}

TEST(Rect, EmptyRectangles) {
    EXPECT_TRUE(Rect{}.isEmpty());
    constexpr Rect inverted{.x0 = 5, .y0 = 0, .x1 = 2, .y1 = 10};
    EXPECT_TRUE(inverted.isEmpty());
    EXPECT_EQ(inverted.width(), 0);
    EXPECT_EQ(inverted.area(), 0);
    constexpr Rect flat{.x0 = 0, .y0 = 3, .x1 = 10, .y1 = 3};
    EXPECT_TRUE(flat.isEmpty());
    EXPECT_EQ(flat.area(), 0);
}

TEST(Rect, ContainsIsHalfOpen) {
    EXPECT_TRUE(hd.contains(0, 0));
    EXPECT_TRUE(hd.contains(1919, 1079));
    EXPECT_FALSE(hd.contains(1920, 0));
    EXPECT_FALSE(hd.contains(0, 1080));
    EXPECT_FALSE(hd.contains(-1, 5));

    EXPECT_TRUE(hd.contains(hd));
    EXPECT_TRUE(hd.contains(Rect{.x0 = 100, .y0 = 100, .x1 = 200, .y1 = 200}));
    EXPECT_FALSE(hd.contains(Rect{.x0 = 100, .y0 = 100, .x1 = 1921, .y1 = 200}));
    EXPECT_TRUE(hd.contains(Rect{.x0 = 5000, .y0 = 5000, .x1 = 5000, .y1 = 6000})); // empty: inside everything
}

TEST(Rect, Intersect) {
    const Rect a{.x0 = -10, .y0 = -10, .x1 = 10, .y1 = 10};
    const Rect b{.x0 = 0, .y0 = 5, .x1 = 30, .y1 = 30};
    EXPECT_EQ(intersect(a, b), (Rect{.x0 = 0, .y0 = 5, .x1 = 10, .y1 = 10}));
    EXPECT_EQ(intersect(b, a), intersect(a, b));
    EXPECT_EQ(intersect(a, a), a);

    // Touching edges share no pixel; every empty result is Rect{}.
    EXPECT_EQ(intersect(a, Rect{.x0 = 10, .y0 = -10, .x1 = 20, .y1 = 10}), Rect{});
    EXPECT_EQ(intersect(a, Rect{.x0 = 50, .y0 = 50, .x1 = 60, .y1 = 60}), Rect{});
    EXPECT_EQ(intersect(a, Rect{}), Rect{});
}

TEST(Rect, Unite) {
    const Rect a{.x0 = 0, .y0 = 0, .x1 = 10, .y1 = 10};
    const Rect b{.x0 = -5, .y0 = 20, .x1 = 3, .y1 = 25};
    EXPECT_EQ(unite(a, b), (Rect{.x0 = -5, .y0 = 0, .x1 = 10, .y1 = 25}));
    // Empty operands are ignored, wherever their coordinates are.
    const Rect emptyFarAway{.x0 = 1000, .y0 = 1000, .x1 = 900, .y1 = 1000};
    EXPECT_EQ(unite(a, emptyFarAway), a);
    EXPECT_EQ(unite(emptyFarAway, a), a);
    EXPECT_EQ(unite(emptyFarAway, emptyFarAway), Rect{});
}

TEST(Rect, Translate) {
    EXPECT_EQ(translate(hd, -100, 50), (Rect{.x0 = -100, .y0 = 50, .x1 = 1820, .y1 = 1130}));
    EXPECT_EQ(translate(Rect{}, 5, 5), Rect{});
}

TEST(Rect, Pad) {
    EXPECT_EQ(pad(hd, 8), (Rect{.x0 = -8, .y0 = -8, .x1 = 1928, .y1 = 1088}));
    EXPECT_EQ(pad(hd, 1, 2, 3, 4), (Rect{.x0 = -1, .y0 = -2, .x1 = 1923, .y1 = 1084}));
    // Negative padding shrinks; shrinking past nothing gives an empty rectangle.
    EXPECT_EQ(pad(hd, -10), (Rect{.x0 = 10, .y0 = 10, .x1 = 1910, .y1 = 1070}));
    EXPECT_EQ(pad(hd, -600), Rect{});
    // An empty rectangle has no pixels to grow around.
    EXPECT_EQ(pad(Rect{}, 10), Rect{});
}

TEST(Rect, ResultsAreClampedToTheCoordinateLimit) {
    const Rect nearEdge{.x0 = maxCoordinate - 10, .y0 = 0, .x1 = maxCoordinate, .y1 = 10};
    EXPECT_EQ(translate(nearEdge, maxCoordinate, 0), Rect{}); // pushed past the limit: nothing left
    EXPECT_EQ(pad(nearEdge, 0, 0, 100, 0).x1, maxCoordinate);
    EXPECT_EQ(pad(hd, maxCoordinate).x0, -maxCoordinate);
    EXPECT_TRUE(isWithinLimits(pad(hd, maxCoordinate)));
    EXPECT_FALSE(isWithinLimits(Rect{.x0 = 0, .y0 = 0, .x1 = maxCoordinate + 1, .y1 = 1}));
}

TEST(Rect, AlignOut) {
    EXPECT_EQ(alignOut(hd, 256), (Rect{.x0 = 0, .y0 = 0, .x1 = 2048, .y1 = 1280}));
    EXPECT_EQ(alignOut(Rect{.x0 = -1, .y0 = -256, .x1 = 1, .y1 = 256}, 256),
              (Rect{.x0 = -256, .y0 = -256, .x1 = 256, .y1 = 256}));
    EXPECT_EQ(alignOut(Rect{.x0 = -257, .y0 = 3, .x1 = -255, .y1 = 4}, 256),
              (Rect{.x0 = -512, .y0 = 0, .x1 = 0, .y1 = 256}));
    EXPECT_EQ(alignOut(Rect{}, 256), Rect{});
    EXPECT_THROW((void)alignOut(hd, 0), std::invalid_argument);
}

TEST(Rect, FloorDiv) {
    EXPECT_EQ(floorDiv(7, 2), 3);
    EXPECT_EQ(floorDiv(-7, 2), -4);
    EXPECT_EQ(floorDiv(-8, 2), -4);
    EXPECT_EQ(floorDiv(0, 256), 0);
    EXPECT_EQ(floorDiv(-1, 256), -1);
    EXPECT_EQ(floorDiv(-256, 256), -1);
    EXPECT_EQ(floorDiv(-257, 256), -2);
}

TEST(Rect, ToString) {
    EXPECT_EQ(toString(Rect{.x0 = -1, .y0 = 2, .x1 = 3, .y1 = 4}), "[-1, 3) × [2, 4)");
}

} // namespace
} // namespace pf::image
