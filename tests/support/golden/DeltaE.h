#pragma once

// Colour difference for display-referred golden comparisons (docs/FORMAT_NOTES.md §2.1–§2.3): the sRGB transfer
// curve, linear sRGB → CIE L*a*b* (D50, Bradford-adapted, as ICC profiles use) and CIEDE2000.

namespace pf::golden {

struct Lab {
    double l = 0.0; // lightness, 0–100
    double a = 0.0; // green (−) to red (+)
    double b = 0.0; // blue (−) to yellow (+)
};

// sRGB-encoded value (0–1) → linear light. Values outside 0–1 are mirrored around zero, so the curve stays monotonic.
[[nodiscard]] double srgbToLinear(double encoded);

// Linear light → sRGB-encoded value; the inverse of srgbToLinear().
[[nodiscard]] double linearToSrgb(double linear);

// Linear-light sRGB (may exceed 1) → L*a*b* relative to D50.
[[nodiscard]] Lab linearSrgbToLab(double r, double g, double b);

// CIEDE2000 colour difference (Sharma, Wu & Dalal 2005), with the parametric weights kL = kC = kH = 1. About 1 is
// the smallest difference most people can see side by side.
[[nodiscard]] double deltaE2000(const Lab& first, const Lab& second);

} // namespace pf::golden
