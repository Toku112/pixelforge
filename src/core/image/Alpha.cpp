#include "core/image/Alpha.h"

#include <stdexcept>
#include <string>
#include <vector>

namespace pf::image {
namespace {

// Applies `op(colour, alpha)` to every sample of the colour channels. Where both tiles are constant the result is a
// constant tile, so constant images stay free of tile memory.
template <typename Op>
void applyWithAlpha(Image& image, const ChannelSet& colour, std::string_view alpha, Op op) {
    if (colour.contains(alpha)) {
        throw std::invalid_argument("channel '" + std::string(alpha) + "' cannot be its own alpha");
    }
    const std::size_t alphaIndex = image.channelIndex(alpha);
    std::vector<std::size_t> colourIndices;
    colourIndices.reserve(colour.size());
    for (const std::string& name : colour) {
        colourIndices.push_back(image.channelIndex(name));
    }

    const Rect& tiles = image.tileRange();
    for (int ty = tiles.y0; ty < tiles.y1; ++ty) {
        for (int tx = tiles.x0; tx < tiles.x1; ++tx) {
            const TileCoord coord{.x = tx, .y = ty};
            const ConstTile a = image.tile(alphaIndex, coord);
            for (const std::size_t index : colourIndices) {
                const ConstTile c = image.tile(index, coord);
                if (a.isConstant() && c.isConstant()) {
                    image.setTileConstant(index, coord, op(c.constant, a.constant));
                    continue;
                }
                const MutableTile out = image.writableTile(index, coord);
                const auto count = static_cast<std::size_t>(out.rect.area());
                for (std::size_t i = 0; i < count; ++i) {
                    out.samples[i] = op(out.samples[i], a.isConstant() ? a.constant : a.samples[i]);
                }
            }
        }
    }
}

} // namespace

ChannelSet colourChannelsOf(const ChannelSet& channels, std::string_view alpha) {
    ChannelSet result;
    for (const std::string& name : channels.inLayer(layerOf(alpha))) {
        const std::string_view suffix = suffixOf(name);
        if (name != alpha && (suffix == "R" || suffix == "G" || suffix == "B" || suffix == "Y")) {
            result.insert(name);
        }
    }
    return result;
}

void premultiply(Image& image, const ChannelSet& colour, std::string_view alpha) {
    applyWithAlpha(image, colour, alpha, [](float c, float a) { return premultiplied(c, a); });
}

void unpremultiply(Image& image, const ChannelSet& colour, std::string_view alpha) {
    applyWithAlpha(image, colour, alpha, [](float c, float a) { return unpremultiplied(c, a); });
}

} // namespace pf::image
