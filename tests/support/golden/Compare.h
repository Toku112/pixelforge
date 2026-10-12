#pragma once

// Comparison of an actual image with an expected one (CLAUDE.md §4 step 3, docs/FORMAT_NOTES.md §18).
//
// Float mode (scene-linear data, the default): every channel is compared sample by sample. A sample passes when
// |actual − expected| ≤ max(absolute, relative × |expected|); the defaults (1e-4 and 1e-4) give 1e-4 for values up
// to 1 and 1e-4 relative above. NaN and infinity fail unless a channel allows them where the expected image has them.
//
// ΔE mode (display-referred results, e.g. 8/16-bit documents): R, G, B with straight alpha A are composited in linear
// light over black and over white, converted to L*a*b* (D50) and compared with CIEDE2000; a pixel's difference is the
// larger of the two. Passes when the average is ≤ 1.0 and the maximum ≤ 3.0. Other channels use float mode.
//
// Both images must have the same display window, data window and channel names.

#include "support/golden/GoldenImage.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace pf::golden {

enum class NonFinite : std::uint8_t {
    Fail,      // any NaN or infinity in either image fails: almost always a bug
    MustMatch, // allowed where the expected image has the same: NaN for NaN, the same infinity for an infinity
};

struct FloatTolerance {
    double absolute = 1e-4;
    double relative = 1e-4;
    NonFinite nonFinite = NonFinite::Fail;
};

enum class CompareMode : std::uint8_t {
    Float,
    DeltaE,
};

enum class RgbEncoding : std::uint8_t {
    Srgb,       // values carry the sRGB transfer curve (8/16-bit documents)
    LinearSrgb, // linear light with sRGB primaries
};

struct DeltaETolerance {
    double average = 1.0;
    double maximum = 3.0;
    RgbEncoding encoding = RgbEncoding::Srgb;
};

struct CompareOptions {
    CompareMode mode = CompareMode::Float;
    FloatTolerance tolerance; // float mode: every channel; ΔE mode: every channel except R, G, B and A
    std::map<std::string, FloatTolerance, std::less<>> channelTolerances; // overrides, by full channel name
    DeltaETolerance deltaE;                                               // ΔE mode only
};

struct ChannelReport {
    std::string name;
    bool passed = true;
    std::size_t sampleCount = 0;
    std::size_t samplesOverTolerance = 0; // finite samples whose difference exceeds the allowance
    std::size_t nonFiniteMismatches = 0;  // samples failing because of NaN or infinity
    std::size_t nonFiniteActual = 0;
    std::size_t nonFiniteExpected = 0;

    // Over samples where both values are finite: the largest and the mean |actual − expected|, and the sample
    // furthest over (or closest to) its allowance, i.e. with the largest difference ÷ allowance.
    double maxError = 0.0;
    double meanError = 0.0;
    int worstX = 0;
    int worstY = 0;
    double worstActual = 0.0;
    double worstExpected = 0.0;
    double worstError = 0.0;
    double worstAllowed = 0.0;
};

struct DeltaEReport {
    bool passed = true;
    double average = 0.0;
    double maximum = 0.0;
    int maximumX = 0;
    int maximumY = 0;
    std::size_t pixelsOverMaximum = 0;
    std::size_t nonFinitePixels = 0; // pixels with NaN or infinity in R, G, B or A (each counts as failing)
    DeltaETolerance tolerance;
};

struct CompareResult {
    bool passed = false;
    std::vector<std::string> structuralProblems; // window or channel-set differences: no pixels were compared
    std::vector<ChannelReport> channels;         // float-compared channels, in the expected image's order
    std::optional<DeltaEReport> deltaE;          // ΔE mode only

    // Per-sample difference, same windows as the expected image (absent when the structure differs): |actual −
    // expected| per float-compared channel (infinity where NaN or infinity made the sample fail), "golden.deltaE" in
    // ΔE mode, and "golden.failed" = 1 where any channel of the pixel failed.
    std::optional<Image> difference;

    // Multi-line description of what failed (or "match" when everything passed).
    [[nodiscard]] std::string describe() const;
};

[[nodiscard]] CompareResult compare(const Image& actual, const Image& expected, const CompareOptions& options = {});

} // namespace pf::golden
