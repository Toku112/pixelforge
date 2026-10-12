#pragma once

// Conversions between the engine's float32 samples and the sample types of files and image-editor documents
// (FORMAT_NOTES §19.5). They change only the number format: 8 and 16-bit code values map linearly onto 0–1, and
// half floats keep their value. Transfer functions (sRGB, gamma) and colour spaces are OpenColorIO's job (color/).

#include <cstddef>
#include <cstdint>

namespace pf::image {

enum class SampleType : std::uint8_t {
    UInt8,   // code values 0–255
    UInt16,  // code values 0–65535 (full range, as in PNG and TIFF)
    Half,    // IEEE 754 binary16, as in OpenEXR
    Float32, // IEEE 754 binary32
};

[[nodiscard]] constexpr std::size_t bytesPerSample(SampleType type) {
    switch (type) {
    case SampleType::UInt8:
        return 1;
    case SampleType::UInt16:
    case SampleType::Half:
        return 2;
    case SampleType::Float32:
        return 4;
    }
    return 0;
}

// Code value / 255, exactly rounded.
[[nodiscard]] float fromUInt8(std::uint8_t code);
// Code value / 65535, exactly rounded.
[[nodiscard]] float fromUInt16(std::uint16_t code);

// round(value × 255) after clamping to 0–1; halves round up; NaN gives 0.
[[nodiscard]] std::uint8_t toUInt8(float value);
// round(value × 65535) after clamping to 0–1; halves round up; NaN gives 0.
[[nodiscard]] std::uint16_t toUInt16(float value);

// The value of a half float given by its 16 bits. Every half value is exact in float32.
[[nodiscard]] float fromHalfBits(std::uint16_t bits);
// The bits of the nearest half float (ties to even). Magnitudes above 65504 (the largest half) that round past it
// become ±infinity; NaN stays NaN; values too small for a half's subnormals become ±0.
[[nodiscard]] std::uint16_t toHalfBits(float value);

} // namespace pf::image
