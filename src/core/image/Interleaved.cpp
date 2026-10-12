#include "core/image/Interleaved.h"

#include "core/image/Alpha.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <optional>
#include <stdexcept>

namespace pf::image {
namespace {

// The layout matched against an image: for each sample of a pixel, its channel index in the image, and which
// samples are converted between straight and premultiplied colour.
struct Resolved {
    std::vector<std::size_t> channelIndex; // per buffer sample
    std::vector<bool> isColour;            // per buffer sample: divided / multiplied by alpha
    std::optional<std::size_t> alphaSample;
};

Resolved resolve(const Image& image, const Rect& region, std::size_t bufferSize, const InterleavedLayout& layout) {
    if (layout.channels.empty()) {
        throw std::invalid_argument("interleaved layout has no channels");
    }
    const ChannelSet names(layout.channels);
    if (names.size() != layout.channels.size()) {
        throw std::invalid_argument("interleaved layout names a channel twice");
    }
    if (!region.isEmpty() && layout.rowStride != 0 &&
        layout.rowStride < static_cast<std::size_t>(region.width()) * layout.pixelBytes()) {
        throw std::invalid_argument("row stride " + std::to_string(layout.rowStride) + " is shorter than a row");
    }
    if (bufferSize < layout.bufferBytes(region)) {
        throw std::invalid_argument("pixel buffer of " + std::to_string(bufferSize) + " bytes is too small for " +
                                    toString(region) + " (needs " + std::to_string(layout.bufferBytes(region)) + ")");
    }

    Resolved resolved;
    resolved.isColour.assign(layout.channels.size(), false);
    ChannelSet colour;
    if (!layout.alpha.empty()) {
        const auto found = std::ranges::find(layout.channels, layout.alpha);
        if (found == layout.channels.end()) {
            throw std::invalid_argument("alpha channel '" + layout.alpha + "' is not in the layout");
        }
        resolved.alphaSample = static_cast<std::size_t>(found - layout.channels.begin());
        if (layout.alphaMode == AlphaMode::Straight) {
            colour = colourChannelsOf(names, layout.alpha);
        }
    }
    for (std::size_t s = 0; s < layout.channels.size(); ++s) {
        resolved.channelIndex.push_back(image.channelIndex(layout.channels[s]));
        resolved.isColour[s] = colour.contains(layout.channels[s]);
    }
    return resolved;
}

float decode(SampleType type, const std::byte* at) {
    switch (type) {
    case SampleType::UInt8:
        return fromUInt8(std::to_integer<std::uint8_t>(*at));
    case SampleType::UInt16: {
        std::uint16_t code = 0;
        std::memcpy(&code, at, sizeof code);
        return fromUInt16(code);
    }
    case SampleType::Half: {
        std::uint16_t bits = 0;
        std::memcpy(&bits, at, sizeof bits);
        return fromHalfBits(bits);
    }
    case SampleType::Float32: {
        float value = 0.0F;
        std::memcpy(&value, at, sizeof value);
        return value;
    }
    }
    return 0.0F;
}

void encode(SampleType type, float value, std::byte* at) {
    switch (type) {
    case SampleType::UInt8:
        *at = std::byte{toUInt8(value)};
        return;
    case SampleType::UInt16: {
        const std::uint16_t code = toUInt16(value);
        std::memcpy(at, &code, sizeof code);
        return;
    }
    case SampleType::Half: {
        const std::uint16_t bits = toHalfBits(value);
        std::memcpy(at, &bits, sizeof bits);
        return;
    }
    case SampleType::Float32:
        std::memcpy(at, &value, sizeof value);
        return;
    }
}

} // namespace

std::size_t InterleavedLayout::rowBytes(int width) const {
    return rowStride != 0 ? rowStride : static_cast<std::size_t>(width) * pixelBytes();
}

std::size_t InterleavedLayout::bufferBytes(const Rect& region) const {
    if (region.isEmpty()) {
        return 0;
    }
    return ((static_cast<std::size_t>(region.height()) - 1) * rowBytes(region.width())) +
           (static_cast<std::size_t>(region.width()) * pixelBytes());
}

void importInterleaved(Image& image, const Rect& region, std::span<const std::byte> pixels,
                       const InterleavedLayout& layout) {
    const Resolved resolved = resolve(image, region, pixels.size(), layout);
    const std::size_t rowBytes = layout.rowBytes(region.width());
    const std::size_t pixelBytes = layout.pixelBytes();
    const std::size_t sampleBytes = bytesPerSample(layout.type);
    const auto byteAt = [&](int x, int y, std::size_t sample) {
        return pixels.data() + (static_cast<std::size_t>(y - region.y0) * rowBytes) +
               (static_cast<std::size_t>(x - region.x0) * pixelBytes) + (sample * sampleBytes);
    };

    const Rect inside = intersect(region, image.dataWindow());
    const Rect tiles = tilesCovering(inside);
    std::vector<MutableTile> targets(layout.channels.size());
    for (int ty = tiles.y0; ty < tiles.y1; ++ty) {
        for (int tx = tiles.x0; tx < tiles.x1; ++tx) {
            const TileCoord coord{.x = tx, .y = ty};
            const Rect tilePixels = intersect(tileCell(coord), image.dataWindow());
            const Rect part = intersect(tilePixels, inside);
            for (std::size_t s = 0; s < targets.size(); ++s) {
                const std::size_t channel = resolved.channelIndex[s];
                targets[s] =
                    part == tilePixels ? image.overwriteTile(channel, coord) : image.writableTile(channel, coord);
                for (int y = part.y0; y < part.y1; ++y) {
                    for (int x = part.x0; x < part.x1; ++x) {
                        targets[s].at(x, y) = decode(layout.type, byteAt(x, y, s));
                    }
                }
            }
            if (!resolved.alphaSample || layout.alphaMode != AlphaMode::Straight) {
                continue;
            }
            const MutableTile& alpha = targets[*resolved.alphaSample];
            for (std::size_t s = 0; s < targets.size(); ++s) {
                if (!resolved.isColour[s]) {
                    continue;
                }
                for (int y = part.y0; y < part.y1; ++y) {
                    for (int x = part.x0; x < part.x1; ++x) {
                        targets[s].at(x, y) = premultiplied(targets[s].at(x, y), alpha.at(x, y));
                    }
                }
            }
        }
    }
}

void exportInterleaved(const Image& image, const Rect& region, std::span<std::byte> pixels,
                       const InterleavedLayout& layout) {
    const Resolved resolved = resolve(image, region, pixels.size(), layout);
    if (region.isEmpty()) {
        return;
    }
    const std::size_t rowBytes = layout.rowBytes(region.width());
    const std::size_t pixelBytes = layout.pixelBytes();
    const std::size_t sampleBytes = bytesPerSample(layout.type);
    const auto byteAt = [&](int x, int y, std::size_t sample) {
        return pixels.data() + (static_cast<std::size_t>(y - region.y0) * rowBytes) +
               (static_cast<std::size_t>(x - region.x0) * pixelBytes) + (sample * sampleBytes);
    };

    const Rect inside = intersect(region, image.dataWindow());
    if (inside != region) {
        // Zero bytes are 0 in every sample type (+0.0 for half and float).
        for (int y = region.y0; y < region.y1; ++y) {
            std::fill_n(byteAt(region.x0, y, 0), static_cast<std::size_t>(region.width()) * pixelBytes, std::byte{0});
        }
    }
    const bool straight = resolved.alphaSample && layout.alphaMode == AlphaMode::Straight;
    const Rect tiles = tilesCovering(inside);
    std::vector<ConstTile> sources(layout.channels.size());
    for (int ty = tiles.y0; ty < tiles.y1; ++ty) {
        for (int tx = tiles.x0; tx < tiles.x1; ++tx) {
            const TileCoord coord{.x = tx, .y = ty};
            for (std::size_t s = 0; s < sources.size(); ++s) {
                sources[s] = image.tile(resolved.channelIndex[s], coord);
            }
            const ConstTile* alpha = straight ? &sources[*resolved.alphaSample] : nullptr;
            const Rect part = intersect(sources.front().rect, inside);
            for (int y = part.y0; y < part.y1; ++y) {
                for (int x = part.x0; x < part.x1; ++x) {
                    for (std::size_t s = 0; s < sources.size(); ++s) {
                        float value = sources[s].at(x, y);
                        if (alpha != nullptr && resolved.isColour[s]) {
                            value = unpremultiplied(value, alpha->at(x, y));
                        }
                        encode(layout.type, value, byteAt(x, y, s));
                    }
                }
            }
        }
    }
}

} // namespace pf::image
