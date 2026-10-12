#pragma once

// Interleaved pixel buffers at the boundary (FORMAT_NOTES §19.6): what decoders hand over and encoders, the GPU
// upload and the clipboard want — every pixel's samples side by side (RGBA RGBA …), in any sample type. Converting
// in copies such a buffer into an Image's float planes (premultiplying straight alpha); converting out does the
// reverse (unpremultiplying for straight alpha, rounding and clamping for 8/16-bit).

#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "core/image/SampleConversion.h"

#include <cstddef>
#include <span>
#include <string>
#include <vector>

namespace pf::image {

enum class AlphaMode : std::uint8_t {
    Premultiplied, // colour already multiplied by alpha (OpenEXR, the engine)
    Straight,      // colour not multiplied by alpha (most PNG, TIFF and image-editor data)
};

struct InterleavedLayout {
    SampleType type = SampleType::Float32;
    // The image channel of each sample of a pixel, in buffer order: {"R", "G", "B", "A"}, {"B", "G", "R", "A"},
    // {"Y"}, … Names must be distinct.
    std::vector<std::string> channels;
    // The alpha channel among `channels`, or empty. With AlphaMode::Straight, its colour channels
    // (colourChannelsOf(), Alpha.h) are converted between straight and premultiplied.
    std::string alpha;
    AlphaMode alphaMode = AlphaMode::Premultiplied;
    // Bytes from the start of one row to the next; 0 means rows follow each other without gaps.
    std::size_t rowStride = 0;

    [[nodiscard]] std::size_t pixelBytes() const { return channels.size() * bytesPerSample(type); }
    [[nodiscard]] std::size_t rowBytes(int width) const;
    // Bytes a buffer for `region` must have.
    [[nodiscard]] std::size_t bufferBytes(const Rect& region) const;
};

// Converts `pixels` (the pixels of `region`, top row first, samples in native byte order) to float and stores them in
// the image's channels. Pixels of `region` outside the data window are skipped. Throws std::invalid_argument for a
// bad layout or a buffer that is too small, std::out_of_range when the image lacks one of the channels.
void importInterleaved(Image& image, const Rect& region, std::span<const std::byte> pixels,
                       const InterleavedLayout& layout);

// Fills `pixels` (the pixels of `region`) from the image's channels; pixels outside the data window are 0. Integer
// types clamp to 0–1 (after unpremultiplying for straight alpha) and round to the nearest code value. Throws like
// importInterleaved().
void exportInterleaved(const Image& image, const Rect& region, std::span<std::byte> pixels,
                       const InterleavedLayout& layout);

} // namespace pf::image
