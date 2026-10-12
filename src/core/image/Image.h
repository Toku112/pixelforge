#pragma once

// The engine's image (FORMAT_NOTES §19): any number of named channels of scene-linear float32 samples over a data
// window (where pixels exist), inside a display window (the frame), as in OpenEXR. Pixels outside the data window
// read as 0; pixels outside the display window are kept, never cropped. Colour channels are premultiplied by alpha
// (§19.4). Values are never clipped: above 1, negative, infinite and NaN samples are stored as they are.
//
// Storage is tiled and copy-on-write (Tile.h): copying an Image copies tile references, not pixels, so images are
// cheap to pass by value; a write gives the writing image its own copy of the tiles it changes. A tile whose pixels
// all have one value may be stored as just that value (a "constant" tile, no memory); new images and new channels
// start that way.
//
// Threads: const functions may run on any number of threads at once. writableTile(), overwriteTile(),
// setTileConstant(), setTileContent() and copyTile() may run on several threads at once for different (channel, tile)
// pairs of the same image.
// Everything else needs the image to itself. Pointers in tile views stay valid until that tile of that image is
// written or the image changes shape (data window, channels) or is destroyed.

#include "core/image/ChannelSet.h"
#include "core/image/Rect.h"
#include "core/image/Tile.h"

#include <cstddef>
#include <span>
#include <string_view>
#include <vector>

namespace pf::image {

// Read access to one tile of one channel.
struct ConstTile {
    Rect rect;                      // the tile's pixels: its grid cell ∩ the data window
    const float* samples = nullptr; // rect.area() samples, row by row, rows rect.width() apart; nullptr if constant
    float constant = 0.0F;          // the value of every pixel when samples is nullptr

    [[nodiscard]] bool isConstant() const { return samples == nullptr; }

    // The sample at (x, y), which must lie inside rect.
    [[nodiscard]] float at(int x, int y) const {
        if (samples == nullptr) {
            return constant;
        }
        return samples[(static_cast<std::ptrdiff_t>(y - rect.y0) * rect.width()) + (x - rect.x0)];
    }
};

// Write access to one tile of one channel; always backed by samples.
struct MutableTile {
    Rect rect;
    float* samples = nullptr; // rect.area() samples, row by row, rows rect.width() apart

    // The sample at (x, y), which must lie inside rect.
    [[nodiscard]] float& at(int x, int y) const {
        return samples[(static_cast<std::ptrdiff_t>(y - rect.y0) * rect.width()) + (x - rect.x0)];
    }
};

class Image {
public:
    // No channels, empty windows.
    Image() = default;

    // Every sample 0, no tile memory used yet. Throws std::invalid_argument when a window lies outside
    // ±maxCoordinate. The data window may be empty (an image with no pixels), larger than the display window or
    // outside it.
    Image(const Rect& displayWindow, const Rect& dataWindow, ChannelSet channels = {});

    [[nodiscard]] const Rect& displayWindow() const { return m_displayWindow; }
    void setDisplayWindow(const Rect& displayWindow);

    [[nodiscard]] const Rect& dataWindow() const { return m_dataWindow; }
    // Moves or resizes the data window. Pixels inside both the old and the new window keep their values; new pixels
    // are 0; tiles that keep their pixels are shared, not copied.
    void setDataWindow(const Rect& dataWindow);

    // ---- channels
    [[nodiscard]] const ChannelSet& channels() const { return m_channels; }
    [[nodiscard]] std::size_t channelCount() const { return m_channels.size(); }
    [[nodiscard]] bool hasChannel(std::string_view name) const { return m_channels.contains(name); }

    // Position of a channel in channels() (the canonical order), used by the fast functions below. Throws
    // std::out_of_range when the channel does not exist. Indices change when channels are added or removed.
    [[nodiscard]] std::size_t channelIndex(std::string_view name) const;

    // Adds a channel whose samples all equal `value`. Throws std::invalid_argument when it exists or the name is
    // empty.
    void addChannel(std::string_view name, float value = 0.0F);
    // Throws std::out_of_range when the channel does not exist.
    void removeChannel(std::string_view name);
    // Throws std::out_of_range when `from` does not exist, std::invalid_argument when `to` exists already.
    void renameChannel(std::string_view from, std::string_view to);

    // Makes channel `to` (added if missing) a copy of channel `from` of `source`, which may be this image. Pixels
    // outside source's data window become 0. When both data windows are equal, the tiles are shared, not copied.
    void copyChannel(const Image& source, std::string_view from, std::string_view to);

    // ---- single samples (convenient, not fast: tests, readouts)
    // 0 outside the data window. Throws std::out_of_range for an unknown channel.
    [[nodiscard]] float sample(std::string_view channel, int x, int y) const;
    // Throws std::out_of_range for an unknown channel or a pixel outside the data window.
    void setSample(std::string_view channel, int x, int y, float value);

    // ---- regions (any rectangle; `rowStride` is the distance between rows in samples, at least region.width())
    // Copies a region of one channel into `dst`; samples outside the data window are 0.
    void read(std::size_t channel, const Rect& region, std::span<float> dst, std::size_t rowStride) const;
    // Copies `src` into a region of one channel; the part outside the data window is ignored.
    void write(std::size_t channel, const Rect& region, std::span<const float> src, std::size_t rowStride);
    // Sets every sample of the region (inside the data window) to `value`. Whole tiles become constant tiles.
    void fill(std::size_t channel, const Rect& region, float value);

    // ---- tiles (the fast path for nodes)
    // The tiles that hold the data window, as a half-open range of tile coordinates.
    [[nodiscard]] const Rect& tileRange() const { return m_tileRange; }
    // Read access. Throws std::out_of_range for a tile outside tileRange().
    [[nodiscard]] ConstTile tile(std::size_t channel, TileCoord tile) const;
    // Write access keeping the current values: a shared tile is copied first, a constant tile is expanded.
    [[nodiscard]] MutableTile writableTile(std::size_t channel, TileCoord tile);
    // Write access for a caller that will set every sample of the tile: no copying, the current values are lost
    // (the samples are undefined until written).
    [[nodiscard]] MutableTile overwriteTile(std::size_t channel, TileCoord tile);
    // Makes every pixel of the tile `value` and releases its memory.
    void setTileConstant(std::size_t channel, TileCoord tile, float value);

    // ---- sharing tiles between images (the node result cache keeps TileContents)
    // A tile's contents as a value: stored samples (shared, never written through this value) or a constant.
    struct TileContent {
        TileRef storage; // null: every pixel equals `constant`
        float constant = 0.0F;
    };
    [[nodiscard]] TileContent tileContent(std::size_t channel, TileCoord tile) const;
    // Makes the tile share `content`. Stored samples must hold exactly this tile's pixels (its grid cell ∩ the data
    // window); throws std::invalid_argument otherwise.
    void setTileContent(std::size_t channel, TileCoord tile, TileContent content);
    // Makes the tile equal the same pixels of channel `sourceChannel` of `source` (which may be this image): shares
    // the source tile when it holds the same pixels, otherwise copies (0 outside source's data window).
    void copyTile(std::size_t channel, TileCoord tile, const Image& source, std::size_t sourceChannel);

    // ---- memory
    // Tiles that hold samples (not constant), over all channels. Tiles shared with other images count here too.
    [[nodiscard]] std::size_t storedTileCount() const;
    // Bytes of those tiles' samples.
    [[nodiscard]] std::size_t storedBytes() const;

private:
    struct Slot {
        TileRef storage; // null: every pixel equals `constant`
        float constant = 0.0F;
    };
    using Plane = std::vector<Slot>; // one slot per tile of m_tileRange, row by row

    [[nodiscard]] Plane makePlane(float value) const;
    void checkChannel(std::size_t channel) const;
    [[nodiscard]] std::size_t slotIndex(TileCoord tile) const;
    [[nodiscard]] Rect pixelsOf(TileCoord tile) const { return intersect(tileCell(tile), m_dataWindow); }
    [[nodiscard]] Slot& slot(std::size_t channel, TileCoord tile);
    [[nodiscard]] const Slot& slot(std::size_t channel, TileCoord tile) const;

    Rect m_displayWindow;
    Rect m_dataWindow;
    Rect m_tileRange;
    ChannelSet m_channels;
    std::vector<Plane> m_planes; // one per channel, in m_channels order
};

} // namespace pf::image
