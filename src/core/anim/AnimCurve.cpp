#include "core/anim/AnimCurve.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

namespace pf::anim {
namespace {

void checkFinite(double number, const char* what) {
    if (!std::isfinite(number)) {
        throw std::invalid_argument(std::string("keyframe ") + what + " must be a finite number");
    }
}

void checkWeight(double weight, const char* what) {
    if (std::isnan(weight) || weight < 0.0 || weight > 1.0) {
        throw std::invalid_argument(std::string("keyframe ") + what + " must lie between 0 and 1");
    }
}

// The cubic Bézier through b0..b3 at parameter s.
double bezier(double b0, double b1, double b2, double b3, double s) {
    const double r = 1.0 - s;
    return (r * r * r * b0) + (3.0 * r * r * s * b1) + (3.0 * r * s * s * b2) + (s * s * s * b3);
}

// The parameter s in [0, 1] where the Bézier with x control points 0, x1, x2, 1 reaches u. With 0 <= x1 <= x2 <= 1
// x(s) never decreases, so the root is unique; Newton steps, falling back to halving the bracket when a step would
// leave it or the slope vanishes.
double solveBezierX(double x1, double x2, double u) {
    constexpr double tolerance = 1e-14;
    constexpr int maxIterations = 100;
    double lo = 0.0;
    double hi = 1.0;
    double s = u;
    for (int i = 0; i < maxIterations; ++i) {
        const double x = bezier(0.0, x1, x2, 1.0, s) - u;
        if (std::abs(x) < tolerance) {
            break;
        }
        if (x < 0.0) {
            lo = s;
        } else {
            hi = s;
        }
        const double r = 1.0 - s;
        const double slope = (3.0 * r * r * x1) + (6.0 * r * s * (x2 - x1)) + (3.0 * s * s * (1.0 - x2));
        double next = 0.5 * (lo + hi);
        if (slope > 0.0) {
            const double newton = s - (x / slope);
            if (newton > lo && newton < hi) {
                next = newton;
            }
        }
        s = next;
    }
    return s;
}

} // namespace

void AnimCurve::setKey(const Keyframe& key) {
    checkFinite(key.frame, "frame");
    checkFinite(key.value, "value");
    checkFinite(key.inSlope, "in-slope");
    checkFinite(key.outSlope, "out-slope");
    checkWeight(key.inWeight, "in-weight");
    checkWeight(key.outWeight, "out-weight");
    const auto first = std::ranges::lower_bound(m_keys, key.frame - frameTolerance, {}, &Keyframe::frame);
    const auto last = std::upper_bound(first, m_keys.end(), key.frame + frameTolerance,
                                       [](double frame, const Keyframe& k) { return frame < k.frame; });
    m_keys.insert(m_keys.erase(first, last), key);
}

bool AnimCurve::removeKey(double frame) {
    const std::optional<std::size_t> index = findKey(frame);
    if (!index) {
        return false;
    }
    m_keys.erase(m_keys.begin() + static_cast<std::ptrdiff_t>(*index));
    return true;
}

std::optional<std::size_t> AnimCurve::findKey(double frame) const {
    const auto found = std::ranges::lower_bound(m_keys, frame - frameTolerance, {}, &Keyframe::frame);
    if (found == m_keys.end() || found->frame > frame + frameTolerance) {
        return std::nullopt;
    }
    return static_cast<std::size_t>(found - m_keys.begin());
}

void AnimCurve::setExtrapolation(Extrapolation before, Extrapolation after) {
    m_before = before;
    m_after = after;
}

double AnimCurve::value(double frame) const {
    if (m_keys.empty()) {
        throw std::logic_error("an animation curve without keys has no value");
    }
    const Keyframe& first = m_keys.front();
    const Keyframe& last = m_keys.back();
    if (frame <= first.frame) {
        return m_before == Extrapolation::Linear ? first.value + ((frame - first.frame) * inSlope(0)) : first.value;
    }
    if (frame >= last.frame) {
        return m_after == Extrapolation::Linear ? last.value + ((frame - last.frame) * outSlope(m_keys.size() - 1))
                                                : last.value;
    }
    const auto next = std::ranges::upper_bound(m_keys, frame, {}, &Keyframe::frame);
    return segmentValue(static_cast<std::size_t>(next - m_keys.begin()) - 1, frame);
}

double AnimCurve::inSlope(std::size_t index) const {
    const Keyframe& key = m_keys.at(index);
    switch (key.interpolation) {
    case Interpolation::Smooth:
        return smoothSlope(index);
    case Interpolation::Bezier:
        return key.inSlope;
    case Interpolation::Constant: // a held key still arrives in a straight line
    case Interpolation::Linear:
        break;
    }
    if (index > 0) {
        return secant(index - 1, index);
    }
    return m_keys.size() > 1 ? secant(0, 1) : 0.0;
}

double AnimCurve::outSlope(std::size_t index) const {
    const Keyframe& key = m_keys.at(index);
    switch (key.interpolation) {
    case Interpolation::Constant:
        return 0.0;
    case Interpolation::Smooth:
        return smoothSlope(index);
    case Interpolation::Bezier:
        return key.outSlope;
    case Interpolation::Linear:
        break;
    }
    if (index + 1 < m_keys.size()) {
        return secant(index, index + 1);
    }
    return m_keys.size() > 1 ? secant(index - 1, index) : 0.0;
}

double AnimCurve::secant(std::size_t from, std::size_t to) const {
    const Keyframe& a = m_keys[from];
    const Keyframe& b = m_keys[to];
    return (b.value - a.value) / (b.frame - a.frame);
}

double AnimCurve::smoothSlope(std::size_t index) const {
    const std::size_t count = m_keys.size();
    if (count < 2) {
        return 0.0;
    }
    if (index == 0) {
        return m_before == Extrapolation::Linear ? secant(0, 1) : 0.0;
    }
    if (index == count - 1) {
        return m_after == Extrapolation::Linear ? secant(index - 1, index) : 0.0;
    }
    const double left = secant(index - 1, index);
    const double right = secant(index, index + 1);
    if (left * right <= 0.0) {
        return 0.0; // a peak, a valley or a flat stretch
    }
    // The slope across both neighbours, limited to three times the gentler side: with both ends of a segment within
    // that limit, the cubic between steadily rising keys keeps rising (FORMAT_NOTES §20.1).
    const double across = secant(index - 1, index + 1);
    const double limit = 3.0 * std::min(std::abs(left), std::abs(right));
    return std::copysign(std::min(std::abs(across), limit), across);
}

double AnimCurve::segmentValue(std::size_t index, double frame) const {
    const Keyframe& a = m_keys[index];
    const Keyframe& b = m_keys[index + 1];
    if (a.interpolation == Interpolation::Constant) {
        return a.value;
    }
    const double length = b.frame - a.frame;
    const double u = (frame - a.frame) / length;
    const bool straightIn = b.interpolation == Interpolation::Linear || b.interpolation == Interpolation::Constant;
    if (a.interpolation == Interpolation::Linear && straightIn) {
        return a.value + ((b.value - a.value) * u);
    }
    double w0 = a.interpolation == Interpolation::Bezier ? a.outWeight : Keyframe::defaultWeight;
    double w1 = b.interpolation == Interpolation::Bezier ? b.inWeight : Keyframe::defaultWeight;
    if (w0 + w1 > 1.0) { // handles that would cross: shorten both in proportion
        const double scale = 1.0 / (w0 + w1);
        w0 *= scale;
        w1 *= scale;
    }
    const double y1 = a.value + (outSlope(index) * w0 * length);
    const double y2 = b.value - (inSlope(index + 1) * w1 * length);
    const bool uniform = w0 == Keyframe::defaultWeight && w1 == Keyframe::defaultWeight;
    const double s = uniform ? u : solveBezierX(w0, 1.0 - w1, u);
    return bezier(a.value, y1, y2, b.value, s);
}

} // namespace pf::anim
