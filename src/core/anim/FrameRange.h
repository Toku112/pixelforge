#pragma once

// Whole frames and frame ranges (docs/specs/sequences.md §4, FORMAT_NOTES §23.3): turning the comp's frame (a real
// number) into a whole frame, mapping frames outside a range (hold, loop, bounce, black), and writing lists of frames
// as short text ("7, 12–14").

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace pf::anim {

// What a sequence shows at frames outside its range.
enum class OutsideRange : std::uint8_t {
    Hold,   // the first (before) or last (after) frame
    Loop,   // the range again and again: 1 2 3 1 2 3
    Bounce, // forwards and backwards without repeating the end frames: 1 2 3 2 1 2 3
    Black,  // nothing
};

// Whole frames first … last, both included.
struct FrameRange {
    std::int64_t first = 1;
    std::int64_t last = 1;

    [[nodiscard]] bool contains(std::int64_t frame) const { return frame >= first && frame <= last; }
    // Frames in the range (at least 1 when first ≤ last).
    [[nodiscard]] std::int64_t length() const { return last - first + 1; }

    friend bool operator==(const FrameRange&, const FrameRange&) = default;
};

// Whole frames are limited to ±2⁵³, the range where every whole number is exact as a double.
inline constexpr std::int64_t maxWholeFrame = std::int64_t{1} << 53;

// The nearest whole frame; halves round up (1.5 → 2, −1.5 → −1). Clamped to ±maxWholeFrame; NaN gives 0.
[[nodiscard]] std::int64_t wholeFrame(double frame);

// The frame of `range` shown at `frame`: frames inside the range show themselves, frames before it follow `before`
// and frames after it `after`; nullopt for Black. `range` must have first ≤ last; the frame and the range's ends
// must lie within ±2⁶⁰.
[[nodiscard]] std::optional<std::int64_t> frameInRange(std::int64_t frame, const FrameRange& range, OutsideRange before,
                                                       OutsideRange after);

// The runs of consecutive frames in `sortedFrames` (ascending, no repeats): {1, 2, 3, 7} → {1–3, 7}.
[[nodiscard]] std::vector<FrameRange> runsOf(std::span<const std::int64_t> sortedFrames);

// Runs as text: "1–3, 7"; ranges with an en dash, negative frames with a minus sign ("-5–-1"); empty for none.
[[nodiscard]] std::string toString(std::span<const FrameRange> runs);

} // namespace pf::anim
