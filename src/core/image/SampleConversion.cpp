#include "core/image/SampleConversion.h"

#include <Imath/half.h>

#include <algorithm>
#include <cmath>

namespace pf::image {

float fromUInt8(std::uint8_t code) {
    return static_cast<float>(code) / 255.0F;
}

float fromUInt16(std::uint16_t code) {
    return static_cast<float>(code) / 65535.0F;
}

std::uint8_t toUInt8(float value) {
    if (std::isnan(value)) {
        return 0;
    }
    return static_cast<std::uint8_t>(std::floor((std::clamp(value, 0.0F, 1.0F) * 255.0F) + 0.5F));
}

std::uint16_t toUInt16(float value) {
    if (std::isnan(value)) {
        return 0;
    }
    return static_cast<std::uint16_t>(std::floor((std::clamp(value, 0.0F, 1.0F) * 65535.0F) + 0.5F));
}

float fromHalfBits(std::uint16_t bits) {
    return imath_half_to_float(bits);
}

std::uint16_t toHalfBits(float value) {
    return imath_float_to_half(value);
}

} // namespace pf::image
