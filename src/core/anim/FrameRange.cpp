#include "core/anim/FrameRange.h"

#include <algorithm>
#include <cmath>

namespace pf::anim {
namespace {

// The remainder of a / b in [0, b) for b > 0, also for negative a.
std::int64_t positiveRemainder(std::int64_t a, std::int64_t b) {
    const std::int64_t r = a % b;
    return r < 0 ? r + b : r;
}

std::int64_t mapOutside(std::int64_t frame, const FrameRange& range, OutsideRange mode, std::int64_t holdFrame) {
    switch (mode) {
    case OutsideRange::Hold:
    case OutsideRange::Black: // handled by the caller
        return holdFrame;
    case OutsideRange::Loop:
        return range.first + positiveRemainder(frame - range.first, range.length());
    case OutsideRange::Bounce: {
        const std::int64_t length = range.length();
        if (length == 1) {
            return range.first;
        }
        const std::int64_t period = 2 * (length - 1);
        const std::int64_t k = positiveRemainder(frame - range.first, period);
        return range.first + (k < length ? k : period - k);
    }
    }
    return holdFrame;
}

} // namespace

std::int64_t wholeFrame(double frame) {
    if (std::isnan(frame)) {
        return 0;
    }
    const auto limit = static_cast<double>(maxWholeFrame);
    return static_cast<std::int64_t>(std::clamp(std::floor(frame + 0.5), -limit, limit));
}

std::optional<std::int64_t> frameInRange(std::int64_t frame, const FrameRange& range, OutsideRange before,
                                         OutsideRange after) {
    if (range.contains(frame)) {
        return frame;
    }
    const bool isBefore = frame < range.first;
    const OutsideRange mode = isBefore ? before : after;
    if (mode == OutsideRange::Black) {
        return std::nullopt;
    }
    return mapOutside(frame, range, mode, isBefore ? range.first : range.last);
}

std::vector<FrameRange> runsOf(std::span<const std::int64_t> sortedFrames) {
    std::vector<FrameRange> runs;
    for (const std::int64_t frame : sortedFrames) {
        if (!runs.empty() && runs.back().last + 1 == frame) {
            runs.back().last = frame;
        } else {
            runs.push_back({.first = frame, .last = frame});
        }
    }
    return runs;
}

std::string toString(std::span<const FrameRange> runs) {
    std::string text;
    for (const FrameRange& run : runs) {
        if (!text.empty()) {
            text += ", ";
        }
        text += std::to_string(run.first);
        if (run.last != run.first) {
            text += "–" + std::to_string(run.last);
        }
    }
    return text;
}

} // namespace pf::anim
