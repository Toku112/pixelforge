#pragma once

// Memory for image tiles (D-074, measured in spikes/tile-alloc). Installed as the tile memory resource of core/image
// at startup (Engine.h), so every tile's samples come from here.
//
// Full 256 × 256 tiles (256 KB each, almost all tile memory) are kept on a free list when released and handed out
// again: refilling a cache after eviction then costs no page faults. At most retainLimit() bytes are kept; beyond
// that, and for smaller edge tiles, memory goes straight back to oneTBB's scalable allocator. That allocator, unlike
// the macOS system allocator, really returns memory to the operating system when asked (releaseFree()).
//
// In AddressSanitizer builds the blocks come from operator new and kept blocks are poisoned, so out-of-bounds
// access and use after release are still caught.
//
// All functions may run on any number of threads at once.

#include "core/image/Tile.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory_resource>
#include <mutex>
#include <vector>

namespace pf::engine {

struct TilePoolStats {
    std::size_t bytesInUse = 0;  // samples of tiles that exist (every size)
    std::size_t bytesFree = 0;   // kept on the free list for reuse
    std::uint64_t reused = 0;    // allocations served from the free list
    std::uint64_t allocated = 0; // allocations served by the system allocator
};

class TilePool final : public std::pmr::memory_resource {
public:
    // Bytes of one full tile of one channel, the block size that is kept for reuse.
    static constexpr std::size_t blockBytes = std::size_t{image::tileSize} * image::tileSize * sizeof(float);
    static constexpr std::size_t defaultRetainLimit = std::size_t{1} << 30; // 1 GiB, until the engine sets it

    TilePool() = default;
    // Returns kept blocks. Tiles still using the pool must be gone by then; the process-wide pool is never destroyed.
    ~TilePool() override;
    TilePool(const TilePool&) = delete;
    TilePool(TilePool&&) = delete;
    TilePool& operator=(const TilePool&) = delete;
    TilePool& operator=(TilePool&&) = delete;

    // The pool the app's images use. It lives until the process ends, so tiles may outlive the engine.
    [[nodiscard]] static TilePool& process();

    // How many bytes of released blocks are kept for reuse. Lowering it releases the extra blocks now.
    void setRetainLimit(std::size_t bytes);
    [[nodiscard]] std::size_t retainLimit() const { return m_retainLimit.load(std::memory_order_relaxed); }

    // Gives every kept block back and asks the allocator to return its free memory to the operating system.
    void releaseFree();

    [[nodiscard]] std::size_t bytesInUse() const { return m_bytesInUse.load(std::memory_order_relaxed); }
    [[nodiscard]] TilePoolStats stats() const;

private:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override;
    void do_deallocate(void* pointer, std::size_t bytes, std::size_t alignment) override;
    [[nodiscard]] bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override {
        return this == &other;
    }

    // Releases kept blocks until at most `keepBytes` remain.
    void shrinkTo(std::size_t keepBytes);

    std::atomic<std::size_t> m_retainLimit{defaultRetainLimit};
    std::atomic<std::size_t> m_bytesInUse{0};
    std::atomic<std::uint64_t> m_reused{0};
    std::atomic<std::uint64_t> m_allocated{0};
    std::atomic<bool> m_systemAllocatorUsed{false};

    mutable std::mutex m_mutex;
    std::vector<void*> m_free; // kept blocks of blockBytes, aligned to image::tileSampleAlignment (m_mutex)
};

} // namespace pf::engine
