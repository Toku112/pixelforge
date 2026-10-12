#pragma once

// Premultiplied alpha (FORMAT_NOTES §19.4). Inside the engine, colour channels are premultiplied: a pixel stores
// colour × alpha. Straight (unpremultiplied) colour exists only at file boundaries and in image-editor documents whose
// maths needs it; these functions convert between the two.

#include "core/image/ChannelSet.h"
#include "core/image/Image.h"

#include <string_view>

namespace pf::image {

[[nodiscard]] constexpr float premultiplied(float straight, float alpha) {
    return straight * alpha;
}

// Where alpha is 0 the colour is returned unchanged: a pixel with no coverage may still add light (a glow, a flame)
// and that light must survive a round trip. Any other alpha (also above 1 or negative) divides.
[[nodiscard]] constexpr float unpremultiplied(float premultipliedColour, float alpha) {
    return alpha != 0.0F ? premultipliedColour / alpha : premultipliedColour;
}

// The colour channels that `alpha` covers: channels of the same layer whose suffix is R, G, B or Y (luminance).
// For "A" in {R, G, B, A, Z} that is {R, G, B}; for "diffuse.A" it is diffuse.R/G/B. Depth, vectors, IDs and other
// data channels are never premultiplied.
[[nodiscard]] ChannelSet colourChannelsOf(const ChannelSet& channels, std::string_view alpha);

// Multiply / divide the given channels by `alpha`, over the data window. Throws std::out_of_range when a channel is
// missing, std::invalid_argument when `colour` contains `alpha`.
void premultiply(Image& image, const ChannelSet& colour, std::string_view alpha);
void unpremultiply(Image& image, const ChannelSet& colour, std::string_view alpha);

} // namespace pf::image
