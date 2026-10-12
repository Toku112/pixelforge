#pragma once

// Integer pixel rectangles: data windows, display windows, regions of interest and tiles (FORMAT_NOTES §19.1).

#include <cstdint>
#include <string>

namespace pf::image {

// Every coordinate stays within ±maxCoordinate (2^29, over 500 million pixels each way, far beyond any real image),
// so widths, sums of two coordinates and tile maths never overflow an int. Functions below clamp their results to
// this range; images refuse windows outside it.
inline constexpr int maxCoordinate = 1 << 29;

// A half-open rectangle of pixels: x in [x0, x1), y in [y0, y1). y grows downward (row 0 at the top), as in OpenEXR
// and image editors. Pixel (x, y) covers the area [x, x + 1) × [y, y + 1); its centre is (x + 0.5, y + 0.5).
// OpenEXR's boxes are inclusive (max = x1 − 1); io/ converts at the file boundary.
//
// A rectangle with x1 <= x0 or y1 <= y0 is empty. The functions below return every empty result as Rect{}, so empty
// results compare equal; compare with isEmpty() when a rectangle may come from elsewhere.
struct Rect {
    int x0 = 0;
    int y0 = 0;
    int x1 = 0;
    int y1 = 0;

    [[nodiscard]] static constexpr Rect fromSize(int x, int y, int width, int height) {
        return {.x0 = x, .y0 = y, .x1 = x + width, .y1 = y + height};
    }

    [[nodiscard]] constexpr bool isEmpty() const { return x1 <= x0 || y1 <= y0; }
    [[nodiscard]] constexpr int width() const { return x1 > x0 ? x1 - x0 : 0; }
    [[nodiscard]] constexpr int height() const { return y1 > y0 ? y1 - y0 : 0; }
    [[nodiscard]] constexpr std::int64_t area() const { return std::int64_t{width()} * std::int64_t{height()}; }

    [[nodiscard]] constexpr bool contains(int x, int y) const { return x >= x0 && x < x1 && y >= y0 && y < y1; }

    // True when every pixel of `other` lies inside this rectangle; an empty rectangle lies inside every rectangle.
    [[nodiscard]] constexpr bool contains(const Rect& other) const {
        return other.isEmpty() || (other.x0 >= x0 && other.x1 <= x1 && other.y0 >= y0 && other.y1 <= y1);
    }

    friend constexpr bool operator==(const Rect&, const Rect&) = default;
};

// "[x0, x1) × [y0, y1)", for messages and test output.
[[nodiscard]] std::string toString(const Rect& rect);

// True when all four coordinates lie within ±maxCoordinate.
[[nodiscard]] constexpr bool isWithinLimits(const Rect& rect) {
    const auto inRange = [](int v) { return v >= -maxCoordinate && v <= maxCoordinate; };
    return inRange(rect.x0) && inRange(rect.y0) && inRange(rect.x1) && inRange(rect.y1);
}

// The pixels in both rectangles.
[[nodiscard]] Rect intersect(const Rect& a, const Rect& b);

// The smallest rectangle holding both; an empty operand is ignored.
[[nodiscard]] Rect unite(const Rect& a, const Rect& b);

// Moved by (dx, dy).
[[nodiscard]] Rect translate(const Rect& rect, int dx, int dy);

// Grown by the given number of pixels on each side (negative values shrink it). An empty rectangle stays empty.
[[nodiscard]] Rect pad(const Rect& rect, int left, int top, int right, int bottom);
[[nodiscard]] Rect pad(const Rect& rect, int amount);

// Grown outward to multiples of `grid` (> 0) on every side, e.g. to whole tiles. An empty rectangle stays empty.
[[nodiscard]] Rect alignOut(const Rect& rect, int grid);

// floor(a / b) for b > 0, also for negative a (C++ division rounds toward zero).
[[nodiscard]] constexpr int floorDiv(int a, int b) {
    const int q = a / b;
    return (a % b != 0 && a < 0) ? q - 1 : q;
}

} // namespace pf::image
