#include "core/image/Rect.h"

#include <algorithm>
#include <cstdint>
#include <stdexcept>

namespace pf::image {
namespace {

// Builds a rectangle from 64-bit coordinates, clamped to ±maxCoordinate; empty results become Rect{}.
Rect clamped(std::int64_t x0, std::int64_t y0, std::int64_t x1, std::int64_t y1) {
    const auto clamp = [](std::int64_t v) {
        return static_cast<int>(std::clamp<std::int64_t>(v, -maxCoordinate, maxCoordinate));
    };
    const Rect rect{.x0 = clamp(x0), .y0 = clamp(y0), .x1 = clamp(x1), .y1 = clamp(y1)};
    return rect.isEmpty() ? Rect{} : rect;
}

} // namespace

std::string toString(const Rect& rect) {
    return "[" + std::to_string(rect.x0) + ", " + std::to_string(rect.x1) + ") × [" + std::to_string(rect.y0) + ", " +
           std::to_string(rect.y1) + ")";
}

Rect intersect(const Rect& a, const Rect& b) {
    const Rect rect{
        .x0 = std::max(a.x0, b.x0), .y0 = std::max(a.y0, b.y0), .x1 = std::min(a.x1, b.x1), .y1 = std::min(a.y1, b.y1)};
    return rect.isEmpty() ? Rect{} : rect;
}

Rect unite(const Rect& a, const Rect& b) {
    if (a.isEmpty()) {
        return b.isEmpty() ? Rect{} : b;
    }
    if (b.isEmpty()) {
        return a;
    }
    return {
        .x0 = std::min(a.x0, b.x0), .y0 = std::min(a.y0, b.y0), .x1 = std::max(a.x1, b.x1), .y1 = std::max(a.y1, b.y1)};
}

Rect translate(const Rect& rect, int dx, int dy) {
    if (rect.isEmpty()) {
        return {};
    }
    return clamped(std::int64_t{rect.x0} + dx, std::int64_t{rect.y0} + dy, std::int64_t{rect.x1} + dx,
                   std::int64_t{rect.y1} + dy);
}

Rect pad(const Rect& rect, int left, int top, int right, int bottom) {
    if (rect.isEmpty()) {
        return {};
    }
    return clamped(std::int64_t{rect.x0} - left, std::int64_t{rect.y0} - top, std::int64_t{rect.x1} + right,
                   std::int64_t{rect.y1} + bottom);
}

Rect pad(const Rect& rect, int amount) {
    return pad(rect, amount, amount, amount, amount);
}

Rect alignOut(const Rect& rect, int grid) {
    if (grid <= 0) {
        throw std::invalid_argument("alignOut: grid must be positive, got " + std::to_string(grid));
    }
    if (rect.isEmpty()) {
        return {};
    }
    const auto down = [grid](int v) { return std::int64_t{floorDiv(v, grid)} * grid; };
    const auto up = [grid](int v) { return (std::int64_t{floorDiv(v - 1, grid)} + 1) * grid; };
    return clamped(down(rect.x0), down(rect.y0), up(rect.x1), up(rect.y1));
}

} // namespace pf::image
