#pragma once

// One animated number (docs/specs/node-graph.md §2, FORMAT_NOTES §20.1): keys sorted by frame, a type per key that
// shapes the curve around it, and extrapolation before the first and after the last key. Frames are real numbers;
// keys closer than frameTolerance are the same key.
//
// Key types (the curve between two keys is a cubic Bézier built from the slopes the two keys give it):
//   Constant  the value holds until the next key (a step);
//   Linear    straight lines toward the neighbouring keys;
//   Smooth    a slope from the neighbours that never overshoots: flat at peaks, valleys and the end keys, and
//             limited so the curve keeps rising (or falling) between steadily rising (or falling) keys;
//   Bezier    the key's own slopes and handle lengths on each side.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace pf::anim {

enum class Interpolation : std::uint8_t { Constant, Linear, Smooth, Bezier };

// What the curve does outside its keys: hold the end value, or continue with the end slope.
enum class Extrapolation : std::uint8_t { Constant, Linear };

struct Keyframe {
    // A third of the segment: with these lengths on both sides a Bézier segment is the plain cubic through the
    // slopes (a Hermite curve).
    static constexpr double defaultWeight = 1.0 / 3.0;

    double frame = 0.0;
    double value = 0.0;
    Interpolation interpolation = Interpolation::Linear;
    // Bezier keys only: slopes in value units per frame, and handle lengths as a share (0–1) of the segment on that
    // side. Other key types work these out themselves.
    double inSlope = 0.0;
    double outSlope = 0.0;
    double inWeight = defaultWeight;
    double outWeight = defaultWeight;

    friend bool operator==(const Keyframe&, const Keyframe&) = default;
};

class AnimCurve {
public:
    static constexpr double frameTolerance = 1e-6;

    [[nodiscard]] bool empty() const { return m_keys.empty(); }
    [[nodiscard]] std::size_t size() const { return m_keys.size(); }
    [[nodiscard]] std::span<const Keyframe> keys() const { return m_keys; }

    // Adds `key`, replacing a key at the same frame. Throws std::invalid_argument when a number is not finite or a
    // weight lies outside 0–1.
    void setKey(const Keyframe& key);
    // Removes the key at `frame`; false when there is none.
    bool removeKey(double frame);
    // Index of the key at `frame` (within frameTolerance).
    [[nodiscard]] std::optional<std::size_t> findKey(double frame) const;

    [[nodiscard]] Extrapolation before() const { return m_before; }
    [[nodiscard]] Extrapolation after() const { return m_after; }
    void setExtrapolation(Extrapolation before, Extrapolation after);

    // The value at `frame`. Throws std::logic_error for a curve without keys.
    [[nodiscard]] double value(double frame) const;

    // The slopes the curve actually uses on each side of key `index` (value units per frame), whatever the key's
    // type: what a curve editor draws as handles. A Constant key's out-slope is 0.
    [[nodiscard]] double inSlope(std::size_t index) const;
    [[nodiscard]] double outSlope(std::size_t index) const;

    friend bool operator==(const AnimCurve&, const AnimCurve&) = default;

private:
    [[nodiscard]] double secant(std::size_t from, std::size_t to) const;
    [[nodiscard]] double smoothSlope(std::size_t index) const;
    [[nodiscard]] double segmentValue(std::size_t index, double frame) const;

    std::vector<Keyframe> m_keys; // sorted by frame, at least frameTolerance apart
    Extrapolation m_before = Extrapolation::Constant;
    Extrapolation m_after = Extrapolation::Constant;
};

} // namespace pf::anim
