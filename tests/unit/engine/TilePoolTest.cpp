// Tile memory (engine/TilePool.h) and its use as core/image's tile memory resource.

#include "engine/TilePool.h"

#include "core/image/Image.h"
#include "core/image/Tile.h"

#include <gtest/gtest.h>

#include <bit>
#include <cstdint>
#include <memory_resource>
#include <thread>
#include <vector>

namespace pf::engine {
namespace {

constexpr std::size_t block = TilePool::blockBytes;
constexpr std::size_t align = image::tileSampleAlignment;

// Installs a resource as the tile memory for one test.
class TileMemoryScope {
public:
    explicit TileMemoryScope(std::pmr::memory_resource* resource) { image::setTileMemoryResource(resource); }
    ~TileMemoryScope() { image::setTileMemoryResource(nullptr); }
    TileMemoryScope(const TileMemoryScope&) = delete;
    TileMemoryScope(TileMemoryScope&&) = delete;
    TileMemoryScope& operator=(const TileMemoryScope&) = delete;
    TileMemoryScope& operator=(TileMemoryScope&&) = delete;
};

TEST(TilePool, BlockIsOneFullTileOfFloats) {
    EXPECT_EQ(block, std::size_t{256} * 256 * 4);
}

TEST(TilePool, ReleasedFullTilesAreReused) {
    TilePool pool;
    void* first = pool.allocate(block, align);
    EXPECT_EQ(pool.stats().bytesInUse, block);
    pool.deallocate(first, block, align);
    EXPECT_EQ(pool.stats().bytesInUse, 0U);
    EXPECT_EQ(pool.stats().bytesFree, block);

    void* second = pool.allocate(block, align);
    EXPECT_EQ(second, first);
    const TilePoolStats stats = pool.stats();
    EXPECT_EQ(stats.reused, 1U);
    EXPECT_EQ(stats.allocated, 1U);
    EXPECT_EQ(stats.bytesFree, 0U);
    pool.deallocate(second, block, align);
}

TEST(TilePool, EdgeTilesAreNotKept) {
    TilePool pool;
    const std::size_t edge = std::size_t{128} * 56 * sizeof(float); // the corner tile of a 1920 × 1080 image
    void* pointer = pool.allocate(edge, align);
    EXPECT_EQ(pool.bytesInUse(), edge);
    pool.deallocate(pointer, edge, align);
    EXPECT_EQ(pool.stats().bytesInUse, 0U);
    EXPECT_EQ(pool.stats().bytesFree, 0U);
}

TEST(TilePool, EveryBlockIsAligned) {
    TilePool pool;
    for (const std::size_t bytes : {block, std::size_t{4}, std::size_t{1000}, std::size_t{100000}}) {
        void* pointer = pool.allocate(bytes, alignof(float));
        EXPECT_EQ(std::bit_cast<std::uintptr_t>(pointer) % align, 0U) << bytes;
        pool.deallocate(pointer, bytes, alignof(float));
    }
}

TEST(TilePool, KeepsAtMostTheRetainLimit) {
    TilePool pool;
    pool.setRetainLimit(2 * block);
    std::vector<void*> blocks;
    blocks.reserve(5);
    for (int i = 0; i < 5; ++i) {
        blocks.push_back(pool.allocate(block, align));
    }
    for (void* pointer : blocks) {
        pool.deallocate(pointer, block, align);
    }
    EXPECT_EQ(pool.stats().bytesFree, 2 * block);

    pool.setRetainLimit(block); // lowering releases the extra block now
    EXPECT_EQ(pool.stats().bytesFree, block);
    EXPECT_EQ(pool.retainLimit(), block);
}

TEST(TilePool, ReleaseFreeGivesEverythingBack) {
    TilePool unused;
    unused.releaseFree(); // before any allocation (oneTBB's clean-up must not run then, D-074)

    TilePool pool;
    void* a = pool.allocate(block, align);
    void* b = pool.allocate(block, align);
    pool.deallocate(a, block, align);
    pool.deallocate(b, block, align);
    EXPECT_EQ(pool.stats().bytesFree, 2 * block);
    pool.releaseFree();
    EXPECT_EQ(pool.stats().bytesFree, 0U);
}

TEST(TilePool, ProcessPoolIsOneObject) {
    EXPECT_EQ(&TilePool::process(), &TilePool::process());
    EXPECT_TRUE(TilePool::process().is_equal(TilePool::process()));
    const TilePool other;
    EXPECT_FALSE(other.is_equal(TilePool::process()));
}

TEST(TilePool, ManyThreads) {
    TilePool pool;
    pool.setRetainLimit(16 * block);
    std::vector<std::thread> threads;
    threads.reserve(8);
    for (int t = 0; t < 8; ++t) {
        threads.emplace_back([&pool, t] {
            std::vector<void*> held;
            for (int i = 0; i < 400; ++i) {
                const std::size_t bytes = (i % 5 == 0) ? std::size_t{1024} * (t + 1) : block;
                void* pointer = pool.allocate(bytes, align);
                static_cast<float*>(pointer)[0] = 1.0F; // touch it
                pool.deallocate(pointer, bytes, align);
                if (i % 50 == 0) {
                    held.push_back(pool.allocate(block, align));
                }
            }
            for (void* pointer : held) {
                pool.deallocate(pointer, block, align);
            }
        });
    }
    for (std::thread& thread : threads) {
        thread.join();
    }
    const TilePoolStats stats = pool.stats();
    EXPECT_EQ(stats.bytesInUse, 0U);
    EXPECT_LE(stats.bytesFree, 16 * block);
    EXPECT_EQ(stats.reused + stats.allocated, 8U * (400U + 8U));
}

// ---- as the tile memory of images

TEST(TileMemory, ImageTilesComeFromTheInstalledPool) {
    TilePool pool;
    {
        const TileMemoryScope scope(&pool);
        EXPECT_EQ(image::tileMemoryResource(), &pool);
        // 1920 × 1080: 8 × 5 tiles, 28 of them full.
        const image::Rect hd{.x0 = 0, .y0 = 0, .x1 = 1920, .y1 = 1080};
        image::Image frame(hd, hd, {"R"});
        EXPECT_EQ(pool.bytesInUse(), 0U); // constant tiles hold no memory
        for (int ty = 0; ty < 5; ++ty) {
            for (int tx = 0; tx < 8; ++tx) {
                (void)frame.overwriteTile(0, {.x = tx, .y = ty});
            }
        }
        EXPECT_EQ(pool.bytesInUse(), frame.storedBytes());
        EXPECT_EQ(pool.bytesInUse(), std::size_t{1920} * 1080 * sizeof(float));
    }
    EXPECT_EQ(image::tileMemoryResource(), std::pmr::new_delete_resource());
    EXPECT_EQ(pool.stats().bytesInUse, 0U);
    EXPECT_EQ(pool.stats().bytesFree, 28 * block); // the full tiles wait for reuse
}

TEST(TileMemory, ATileReturnsToTheResourceItCameFrom) {
    TilePool pool;
    image::TileRef tile;
    {
        const TileMemoryScope scope(&pool);
        tile = image::TileRef::allocate(image::tileCell({.x = 0, .y = 0}));
    }
    // The default resource is installed again; releasing the tile still goes to the pool.
    EXPECT_EQ(pool.bytesInUse(), block);
    tile.reset();
    EXPECT_EQ(pool.bytesInUse(), 0U);
    EXPECT_EQ(pool.stats().bytesFree, block);
}

} // namespace
} // namespace pf::engine
