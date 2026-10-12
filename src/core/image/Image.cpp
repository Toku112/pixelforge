#include "core/image/Image.h"

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace pf::image {
namespace {

Rect checkedWindow(const Rect& rect, const char* what) {
    if (!isWithinLimits(rect)) {
        throw std::invalid_argument(std::string(what) + " " + toString(rect) + " lies outside ±" +
                                    std::to_string(maxCoordinate));
    }
    return rect;
}

// Throws unless a buffer of `size` samples holds `region` with rows `rowStride` samples apart.
void checkRegionBuffer(const Rect& region, std::size_t size, std::size_t rowStride) {
    if (region.isEmpty()) {
        return;
    }
    const auto width = static_cast<std::size_t>(region.width());
    if (rowStride < width) {
        throw std::invalid_argument("row stride " + std::to_string(rowStride) + " is smaller than the region width " +
                                    std::to_string(width));
    }
    const std::size_t needed = ((static_cast<std::size_t>(region.height()) - 1) * rowStride) + width;
    if (size < needed) {
        throw std::invalid_argument("buffer of " + std::to_string(size) + " samples is too small for region " +
                                    toString(region) + " (needs " + std::to_string(needed) + ")");
    }
}

// Position of a channel that was just added to `channels`.
std::size_t positionIn(const ChannelSet& channels, std::string_view name) {
    const std::optional<std::size_t> index = channels.indexOf(name);
    if (!index) {
        throw std::logic_error("channel '" + std::string(name) + "' is missing from its own set");
    }
    return *index;
}

std::size_t indexIn(const Rect& range, TileCoord tile) {
    return (static_cast<std::size_t>(tile.y - range.y0) * static_cast<std::size_t>(range.width())) +
           static_cast<std::size_t>(tile.x - range.x0);
}

template <typename Function>
void forEachTile(const Rect& tiles, const Function& function) {
    for (int ty = tiles.y0; ty < tiles.y1; ++ty) {
        for (int tx = tiles.x0; tx < tiles.x1; ++tx) {
            function(TileCoord{.x = tx, .y = ty});
        }
    }
}

// Offset of pixel (x, y) in the samples of a tile holding `rect`.
std::ptrdiff_t offsetIn(const Rect& rect, int x, int y) {
    return (static_cast<std::ptrdiff_t>(y - rect.y0) * rect.width()) + (x - rect.x0);
}

// Copies the pixels of `part` (inside both tiles) from one tile to another.
void copyPart(const ConstTile& from, const Rect& part, const MutableTile& to) {
    for (int y = part.y0; y < part.y1; ++y) {
        float* out = to.samples + offsetIn(to.rect, part.x0, y);
        if (from.isConstant()) {
            std::fill_n(out, part.width(), from.constant);
        } else {
            std::copy_n(from.samples + offsetIn(from.rect, part.x0, y), part.width(), out);
        }
    }
}

} // namespace

Image::Image(const Rect& displayWindow, const Rect& dataWindow, ChannelSet channels)
    : m_displayWindow(checkedWindow(displayWindow, "display window")),
      m_dataWindow(checkedWindow(dataWindow, "data window").isEmpty() ? Rect{} : dataWindow),
      m_tileRange(tilesCovering(m_dataWindow)),
      m_channels(std::move(channels)) {
    m_planes.reserve(m_channels.size());
    for (std::size_t i = 0; i < m_channels.size(); ++i) {
        m_planes.push_back(makePlane(0.0F));
    }
}

void Image::setDisplayWindow(const Rect& displayWindow) {
    m_displayWindow = checkedWindow(displayWindow, "display window");
}

void Image::setDataWindow(const Rect& dataWindow) {
    const Rect data = checkedWindow(dataWindow, "data window").isEmpty() ? Rect{} : dataWindow;
    if (data == m_dataWindow) {
        return;
    }
    const Rect newRange = tilesCovering(data);
    const Rect keptTiles = intersect(newRange, m_tileRange);
    std::vector<Plane> planes;
    planes.reserve(m_planes.size());
    for (std::size_t channel = 0; channel < m_planes.size(); ++channel) {
        Plane plane(static_cast<std::size_t>(newRange.area()));
        forEachTile(keptTiles, [&](TileCoord t) {
            const Slot& from = m_planes[channel][slotIndex(t)];
            Slot& to = plane[indexIn(newRange, t)];
            const Rect oldPixels = pixelsOf(t);
            const Rect newPixels = intersect(tileCell(t), data);
            const Rect overlap = intersect(oldPixels, newPixels);
            if (overlap.isEmpty()) {
                return; // only new pixels: stays constant 0
            }
            if (oldPixels == newPixels) {
                to = from;
                return;
            }
            if (!from.storage && (from.constant == 0.0F || overlap == newPixels)) {
                to.constant = from.constant; // every new pixel equals the constant
                return;
            }
            TileRef buffer = TileRef::allocate(newPixels);
            const MutableTile view{.rect = newPixels, .samples = buffer->samples()};
            std::fill_n(view.samples, newPixels.area(), 0.0F);
            copyPart(tile(channel, t), overlap, view);
            to.storage = std::move(buffer);
        });
        planes.push_back(std::move(plane));
    }
    m_dataWindow = data;
    m_tileRange = newRange;
    m_planes = std::move(planes);
}

std::size_t Image::channelIndex(std::string_view name) const {
    const std::optional<std::size_t> index = m_channels.indexOf(name);
    if (!index) {
        throw std::out_of_range("image has no channel '" + std::string(name) + "'");
    }
    return *index;
}

void Image::addChannel(std::string_view name, float value) {
    ChannelSet channels = m_channels;
    if (!channels.insert(name)) {
        throw std::invalid_argument("image already has a channel '" + std::string(name) + "'");
    }
    const std::size_t index = positionIn(channels, name);
    m_planes.insert(m_planes.begin() + static_cast<std::ptrdiff_t>(index), makePlane(value));
    m_channels = std::move(channels);
}

void Image::removeChannel(std::string_view name) {
    const std::size_t index = channelIndex(name);
    m_planes.erase(m_planes.begin() + static_cast<std::ptrdiff_t>(index));
    m_channels.erase(name);
}

void Image::renameChannel(std::string_view from, std::string_view to) {
    const std::size_t index = channelIndex(from);
    if (from == to) {
        return;
    }
    ChannelSet channels = m_channels;
    if (!channels.insert(to)) {
        throw std::invalid_argument("image already has a channel '" + std::string(to) + "'");
    }
    channels.erase(from);
    Plane plane = std::move(m_planes[index]);
    m_planes.erase(m_planes.begin() + static_cast<std::ptrdiff_t>(index));
    m_planes.insert(m_planes.begin() + static_cast<std::ptrdiff_t>(positionIn(channels, to)), std::move(plane));
    m_channels = std::move(channels);
}

void Image::copyChannel(const Image& source, std::string_view from, std::string_view to) {
    const std::size_t sourceIndex = source.channelIndex(from);
    Plane plane;
    if (source.m_dataWindow == m_dataWindow) {
        plane = source.m_planes[sourceIndex]; // shares every tile
    } else {
        plane = makePlane(0.0F);
        forEachTile(intersect(m_tileRange, source.m_tileRange), [&](TileCoord t) {
            const Rect pixels = pixelsOf(t);
            const ConstTile src = source.tile(sourceIndex, t);
            const Rect part = intersect(pixels, src.rect);
            if (part.isEmpty()) {
                return;
            }
            Slot& slot = plane[slotIndex(t)];
            if (src.rect == pixels) {
                slot = source.m_planes[sourceIndex][source.slotIndex(t)]; // same pixels: share
            } else if (src.isConstant() && (src.constant == 0.0F || part == pixels)) {
                slot.constant = src.constant;
            } else {
                slot.storage = TileRef::allocate(pixels);
                const MutableTile view{.rect = pixels, .samples = slot.storage->samples()};
                std::fill_n(view.samples, pixels.area(), 0.0F);
                copyPart(src, part, view);
            }
        });
    }
    if (const std::optional<std::size_t> index = m_channels.indexOf(to)) {
        m_planes[*index] = std::move(plane);
        return;
    }
    ChannelSet channels = m_channels;
    channels.insert(to);
    m_planes.insert(m_planes.begin() + static_cast<std::ptrdiff_t>(positionIn(channels, to)), std::move(plane));
    m_channels = std::move(channels);
}

float Image::sample(std::string_view channel, int x, int y) const {
    const std::size_t index = channelIndex(channel);
    if (!m_dataWindow.contains(x, y)) {
        return 0.0F;
    }
    return tile(index, tileContaining(x, y)).at(x, y);
}

void Image::setSample(std::string_view channel, int x, int y, float value) {
    const std::size_t index = channelIndex(channel);
    if (!m_dataWindow.contains(x, y)) {
        throw std::out_of_range("pixel (" + std::to_string(x) + ", " + std::to_string(y) +
                                ") lies outside the data window " + toString(m_dataWindow));
    }
    writableTile(index, tileContaining(x, y)).at(x, y) = value;
}

void Image::read(std::size_t channel, const Rect& region, std::span<float> dst, std::size_t rowStride) const {
    checkChannel(channel);
    checkRegionBuffer(region, dst.size(), rowStride);
    if (region.isEmpty()) {
        return;
    }
    const auto rowOf = [&](int x, int y) {
        return dst.data() + (static_cast<std::size_t>(y - region.y0) * rowStride) + (x - region.x0);
    };
    const Rect inside = intersect(region, m_dataWindow);
    if (inside != region) {
        for (int y = region.y0; y < region.y1; ++y) {
            std::fill_n(rowOf(region.x0, y), region.width(), 0.0F);
        }
    }
    forEachTile(tilesCovering(inside), [&](TileCoord t) {
        const ConstTile src = tile(channel, t);
        const Rect part = intersect(src.rect, inside);
        for (int y = part.y0; y < part.y1; ++y) {
            if (src.isConstant()) {
                std::fill_n(rowOf(part.x0, y), part.width(), src.constant);
            } else {
                std::copy_n(src.samples + offsetIn(src.rect, part.x0, y), part.width(), rowOf(part.x0, y));
            }
        }
    });
}

void Image::write(std::size_t channel, const Rect& region, std::span<const float> src, std::size_t rowStride) {
    checkChannel(channel);
    checkRegionBuffer(region, src.size(), rowStride);
    const Rect inside = intersect(region, m_dataWindow);
    forEachTile(tilesCovering(inside), [&](TileCoord t) {
        const Rect pixels = pixelsOf(t);
        const Rect part = intersect(pixels, inside);
        const MutableTile dst = part == pixels ? overwriteTile(channel, t) : writableTile(channel, t);
        for (int y = part.y0; y < part.y1; ++y) {
            const float* row =
                src.data() + (static_cast<std::size_t>(y - region.y0) * rowStride) + (part.x0 - region.x0);
            std::copy_n(row, part.width(), dst.samples + offsetIn(dst.rect, part.x0, y));
        }
    });
}

void Image::fill(std::size_t channel, const Rect& region, float value) {
    checkChannel(channel);
    const Rect inside = intersect(region, m_dataWindow);
    forEachTile(tilesCovering(inside), [&](TileCoord t) {
        const Rect pixels = pixelsOf(t);
        const Rect part = intersect(pixels, inside);
        if (part == pixels) {
            setTileConstant(channel, t, value);
            return;
        }
        if (const Slot& current = slot(channel, t); !current.storage && current.constant == value) {
            return;
        }
        const MutableTile dst = writableTile(channel, t);
        for (int y = part.y0; y < part.y1; ++y) {
            std::fill_n(dst.samples + offsetIn(dst.rect, part.x0, y), part.width(), value);
        }
    });
}

ConstTile Image::tile(std::size_t channel, TileCoord tile) const {
    const Slot& current = slot(channel, tile);
    return {.rect = pixelsOf(tile),
            .samples = current.storage ? current.storage->samples() : nullptr,
            .constant = current.constant};
}

MutableTile Image::writableTile(std::size_t channel, TileCoord tile) {
    Slot& current = slot(channel, tile);
    const Rect pixels = pixelsOf(tile);
    if (!current.storage.isUnique()) {
        TileRef copy = TileRef::allocate(pixels);
        if (current.storage) {
            std::copy_n(current.storage->samples(), pixels.area(), copy->samples());
        } else {
            std::fill_n(copy->samples(), pixels.area(), current.constant);
        }
        current.storage = std::move(copy);
    }
    return {.rect = pixels, .samples = current.storage->samples()};
}

MutableTile Image::overwriteTile(std::size_t channel, TileCoord tile) {
    Slot& current = slot(channel, tile);
    const Rect pixels = pixelsOf(tile);
    if (!current.storage.isUnique()) {
        current.storage = TileRef::allocate(pixels);
    }
    return {.rect = pixels, .samples = current.storage->samples()};
}

void Image::setTileConstant(std::size_t channel, TileCoord tile, float value) {
    Slot& current = slot(channel, tile);
    current.storage.reset();
    current.constant = value;
}

std::size_t Image::storedTileCount() const {
    std::size_t count = 0;
    for (const Plane& plane : m_planes) {
        count += static_cast<std::size_t>(std::ranges::count_if(plane, [](const Slot& s) { return bool(s.storage); }));
    }
    return count;
}

std::size_t Image::storedBytes() const {
    std::size_t bytes = 0;
    for (const Plane& plane : m_planes) {
        for (const Slot& s : plane) {
            if (s.storage) {
                bytes += static_cast<std::size_t>(s.storage->rect().area()) * sizeof(float);
            }
        }
    }
    return bytes;
}

Image::Plane Image::makePlane(float value) const {
    return Plane(static_cast<std::size_t>(m_tileRange.area()), Slot{.storage = {}, .constant = value});
}

std::size_t Image::slotIndex(TileCoord tile) const {
    if (!m_tileRange.contains(tile.x, tile.y)) {
        throw std::out_of_range("tile (" + std::to_string(tile.x) + ", " + std::to_string(tile.y) +
                                ") lies outside the image's tiles " + toString(m_tileRange));
    }
    return indexIn(m_tileRange, tile);
}

void Image::checkChannel(std::size_t channel) const {
    if (channel >= m_planes.size()) {
        throw std::out_of_range("channel index " + std::to_string(channel) + " out of range (image has " +
                                std::to_string(m_planes.size()) + " channels)");
    }
}

Image::Slot& Image::slot(std::size_t channel, TileCoord tile) {
    checkChannel(channel);
    return m_planes[channel][slotIndex(tile)];
}

const Image::Slot& Image::slot(std::size_t channel, TileCoord tile) const {
    checkChannel(channel);
    return m_planes[channel][slotIndex(tile)];
}

} // namespace pf::image
