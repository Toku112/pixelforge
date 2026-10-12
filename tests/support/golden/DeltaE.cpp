#include "support/golden/DeltaE.h"

#include <cmath>
#include <numbers>

namespace pf::golden {
namespace {

constexpr double degree = std::numbers::pi / 180.0;
constexpr double pow25To7 = 6103515625.0; // 25^7

// Linear sRGB → XYZ, primaries adapted from D65 to D50 with the Bradford transform (FORMAT_NOTES §2.2).
constexpr double m00 = 0.436074716;
constexpr double m01 = 0.385064915;
constexpr double m02 = 0.143080403;
constexpr double m10 = 0.222504478;
constexpr double m11 = 0.716878669;
constexpr double m12 = 0.060616852;
constexpr double m20 = 0.013932173;
constexpr double m21 = 0.097104526;
constexpr double m22 = 0.714173298;

// D50 reference white: the row sums of the matrix, so sRGB white lands exactly on a* = b* = 0.
constexpr double whiteX = m00 + m01 + m02;
constexpr double whiteY = m10 + m11 + m12;
constexpr double whiteZ = m20 + m21 + m22;

constexpr double labEpsilon = 216.0 / 24389.0; // (6/29)^3
constexpr double labKappa = 24389.0 / 27.0;    // (29/3)^3

double labF(double t) {
    return t > labEpsilon ? std::cbrt(t) : ((labKappa * t) + 16.0) / 116.0;
}

double pow7(double value) {
    const double squared = value * value;
    return squared * squared * squared * value;
}

// Hue angle in degrees, 0–360.
double hueDegrees(double b, double a) {
    const double hue = std::atan2(b, a) / degree;
    return hue < 0.0 ? hue + 360.0 : hue;
}

} // namespace

double srgbToLinear(double encoded) {
    const double magnitude = std::abs(encoded);
    const double linear = magnitude <= 0.04045 ? magnitude / 12.92 : std::pow((magnitude + 0.055) / 1.055, 2.4);
    return encoded < 0.0 ? -linear : linear;
}

double linearToSrgb(double linear) {
    const double magnitude = std::abs(linear);
    const double encoded =
        magnitude <= 0.0031308 ? magnitude * 12.92 : (1.055 * std::pow(magnitude, 1.0 / 2.4)) - 0.055;
    return linear < 0.0 ? -encoded : encoded;
}

Lab linearSrgbToLab(double r, double g, double b) {
    const double x = (m00 * r) + (m01 * g) + (m02 * b);
    const double y = (m10 * r) + (m11 * g) + (m12 * b);
    const double z = (m20 * r) + (m21 * g) + (m22 * b);
    const double fx = labF(x / whiteX);
    const double fy = labF(y / whiteY);
    const double fz = labF(z / whiteZ);
    return {.l = (116.0 * fy) - 16.0, .a = 500.0 * (fx - fy), .b = 200.0 * (fy - fz)};
}

double deltaE2000(const Lab& first, const Lab& second) {
    // Step 1: a′ adjusted so that near-neutral colours get a fairer chroma estimate; C′ and h′.
    const double chroma1 = std::hypot(first.a, first.b);
    const double chroma2 = std::hypot(second.a, second.b);
    const double meanChroma7 = pow7((chroma1 + chroma2) / 2.0);
    const double g = 0.5 * (1.0 - std::sqrt(meanChroma7 / (meanChroma7 + pow25To7)));
    const double a1 = (1.0 + g) * first.a;
    const double a2 = (1.0 + g) * second.a;
    const double c1 = std::hypot(a1, first.b);
    const double c2 = std::hypot(a2, second.b);
    const double h1 = c1 == 0.0 ? 0.0 : hueDegrees(first.b, a1);
    const double h2 = c2 == 0.0 ? 0.0 : hueDegrees(second.b, a2);

    // Step 2: ΔL′, ΔC′, ΔH′.
    const double deltaL = second.l - first.l;
    const double deltaC = c2 - c1;
    double deltaHue = 0.0;
    if (c1 * c2 != 0.0) {
        deltaHue = h2 - h1;
        if (deltaHue > 180.0) {
            deltaHue -= 360.0;
        } else if (deltaHue < -180.0) {
            deltaHue += 360.0;
        }
    }
    const double deltaH = 2.0 * std::sqrt(c1 * c2) * std::sin(deltaHue / 2.0 * degree);

    // Step 3: weighting functions and the rotation term.
    const double meanL = (first.l + second.l) / 2.0;
    const double meanC = (c1 + c2) / 2.0;
    double meanH = h1 + h2;
    if (c1 * c2 != 0.0) {
        if (std::abs(h1 - h2) <= 180.0) {
            meanH = (h1 + h2) / 2.0;
        } else if (h1 + h2 < 360.0) {
            meanH = (h1 + h2 + 360.0) / 2.0;
        } else {
            meanH = (h1 + h2 - 360.0) / 2.0;
        }
    }
    const double t = 1.0 - (0.17 * std::cos((meanH - 30.0) * degree)) + (0.24 * std::cos(2.0 * meanH * degree)) +
                     (0.32 * std::cos(((3.0 * meanH) + 6.0) * degree)) -
                     (0.20 * std::cos(((4.0 * meanH) - 63.0) * degree));
    const double hueOffset = (meanH - 275.0) / 25.0;
    const double deltaTheta = 30.0 * std::exp(-(hueOffset * hueOffset));
    const double meanC7 = pow7(meanC);
    const double rc = 2.0 * std::sqrt(meanC7 / (meanC7 + pow25To7));
    const double lightnessOffset = (meanL - 50.0) * (meanL - 50.0);
    const double sl = 1.0 + (0.015 * lightnessOffset / std::sqrt(20.0 + lightnessOffset));
    const double sc = 1.0 + (0.045 * meanC);
    const double sh = 1.0 + (0.015 * meanC * t);
    const double rt = -std::sin(2.0 * deltaTheta * degree) * rc;

    const double l = deltaL / sl;
    const double c = deltaC / sc;
    const double h = deltaH / sh;
    return std::sqrt((l * l) + (c * c) + (h * h) + (rt * c * h));
}

} // namespace pf::golden
