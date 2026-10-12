#pragma once

// Tiles (FORMAT_NOTES §19.3): every channel of an image is stored as square tiles of tileSize × tileSize float
// samples on one grid aligned to pixel (0, 0), so tiles of different images line up and can be shared. A tile holds
// only the pixels of its grid cell that lie inside the image's data window (edge tiles are smaller, never padded).
// Tile storage is reference counted and copy-on-write: copying an image copies no pixels, and writing to a shared
// tile first gives the writer its own copy.

#include "core/image/Rect.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory_resource>

namespace pf::image {

// 256 × 256, chosen by measurement (D-073, spikes/tile-size): neighbourhood filters slow down with smaller tiles,
// partial requests waste more work with bigger ones.
inline constexpr int tileSizeLog2 = 8;
inline constexpr int tileSize = 1 << tileSizeLog2;

// The position of a tile on the grid, in tiles: tile (tx, ty) is the cell [tx·256, (tx+1)·256) × [ty·256, (ty+1)·256).
struct TileCoord {
    int x = 0;
    int y = 0;

    friend constexpr bool operator==(const TileCoord&, const TileCoord&) = default;
};

// The tile containing pixel (x, y). Right shifts of negative numbers round toward minus infinity (defined since
// C++20), so pixel −1 lies in tile −1.
[[nodiscard]] constexpr TileCoord tileContaining(int x, int y) {
    return {.x = x >> tileSizeLog2, .y = y >> tileSizeLog2};
}

// The pixels of a whole grid cell.
[[nodiscard]] constexpr Rect tileCell(TileCoord tile) {
    return Rect::fromSize(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
}

// The tiles touched by `pixels`, as a half-open range of tile coordinates (Rect{} for an empty rectangle).
[[nodiscard]] Rect tilesCovering(const Rect& pixels);

// Where tile samples get their memory (FORMAT_NOTES §19.3). The default is the C++ allocator; the engine installs
// its tile pool at startup (engine/TilePool.h, D-074). Every tile remembers the resource it came from and gives its
// memory back there, so the resource may change while tiles exist. Pass nullptr to restore the default.
void setTileMemoryResource(std::pmr::memory_resource* resource) noexcept;
[[nodiscard]] std::pmr::memory_resource* tileMemoryResource() noexcept;

// Alignment of every tile's first sample: one cache line, enough for any vector width we use.
inline constexpr std::size_t tileSampleAlignment = 64;

// The samples of one tile of one channel: rect.area() floats, row by row, rows rect.width() apart.
class TileBuffer {
public:
    // Samples are left uninitialised. `rect` must not be empty and must lie inside one grid cell. The memory comes
    // from tileMemoryResource().
    explicit TileBuffer(const Rect& rect);
    ~TileBuffer();
    TileBuffer(const TileBuffer&) = delete;
    TileBuffer(TileBuffer&&) = delete;
    TileBuffer& operator=(const TileBuffer&) = delete;
    TileBuffer& operator=(TileBuffer&&) = delete;

    [[nodiscard]] const Rect& rect() const { return m_rect; }
    [[nodiscard]] float* samples() { return m_samples; }
    [[nodiscard]] const float* samples() const { return m_samples; }

private:
    friend class TileRef;

    [[nodiscard]] std::size_t byteSize() const;

    mutable std::atomic<std::uint32_t> m_refs{0};
    Rect m_rect;
    std::pmr::memory_resource* m_memory = nullptr; // where m_samples came from
    float* m_samples = nullptr;
};

// A counted reference to a TileBuffer (null or shared). Copies share the buffer; the last reference frees it.
// isUnique() tells a writer whether it may change the buffer in place. Reference counts are atomic, so references
// to one buffer may be copied and dropped on several threads at once.
class TileRef {
public:
    TileRef() = default;
    // A new buffer for `rect`, samples uninitialised.
    [[nodiscard]] static TileRef allocate(const Rect& rect);

    TileRef(const TileRef& other) noexcept;
    TileRef(TileRef&& other) noexcept;
    TileRef& operator=(const TileRef& other) noexcept;
    TileRef& operator=(TileRef&& other) noexcept;
    ~TileRef();

    [[nodiscard]] explicit operator bool() const { return m_buffer != nullptr; }
    [[nodiscard]] TileBuffer* get() const { return m_buffer; }
    [[nodiscard]] TileBuffer* operator->() const { return m_buffer; }

    // True when this is the only reference. A writer that sees true may change the buffer: no other reference
    // exists that could read it, and the reads of references dropped earlier have finished (acquire ordering).
    [[nodiscard]] bool isUnique() const;

    void reset();

private:
    explicit TileRef(TileBuffer* buffer) : m_buffer(buffer) {}

    TileBuffer* m_buffer = nullptr;
};

} // namespace pf::image
