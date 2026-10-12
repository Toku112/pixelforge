// The tile grid and copy-on-write tile storage (core/image/Tile.h, FORMAT_NOTES §19.3).

#include "core/image/Tile.h"

#include <gtest/gtest.h>

#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace pf::image {
namespace {

TEST(TileGrid, TileSizeIsAPowerOfTwo) {
    EXPECT_EQ(tileSize, 256);
    EXPECT_EQ(tileSize, 1 << tileSizeLog2);
}

TEST(TileGrid, TileContainingRoundsDown) {
    EXPECT_EQ(tileContaining(0, 0), (TileCoord{.x = 0, .y = 0}));
    EXPECT_EQ(tileContaining(255, 256), (TileCoord{.x = 0, .y = 1}));
    EXPECT_EQ(tileContaining(-1, -256), (TileCoord{.x = -1, .y = -1}));
    EXPECT_EQ(tileContaining(-257, 511), (TileCoord{.x = -2, .y = 1}));
    EXPECT_EQ(tileContaining(-maxCoordinate, maxCoordinate - 1),
              (TileCoord{.x = -(maxCoordinate / tileSize), .y = (maxCoordinate / tileSize) - 1}));
}

TEST(TileGrid, TileCell) {
    EXPECT_EQ(tileCell({.x = 0, .y = 0}), (Rect{.x0 = 0, .y0 = 0, .x1 = 256, .y1 = 256}));
    EXPECT_EQ(tileCell({.x = -1, .y = 2}), (Rect{.x0 = -256, .y0 = 512, .x1 = 0, .y1 = 768}));
    // Every pixel lies in the cell of the tile containing it.
    for (const int v : {-513, -512, -511, -257, -256, -255, -1, 0, 1, 255, 256, 257, 1919}) {
        EXPECT_TRUE(tileCell(tileContaining(v, -v)).contains(v, -v)) << v;
    }
}

TEST(TileGrid, TilesCovering) {
    // 1920 × 1080 touches 8 × 5 tiles; the last row of tiles holds 56 rows of pixels.
    EXPECT_EQ(tilesCovering(Rect{.x0 = 0, .y0 = 0, .x1 = 1920, .y1 = 1080}),
              (Rect{.x0 = 0, .y0 = 0, .x1 = 8, .y1 = 5}));
    EXPECT_EQ(tilesCovering(Rect{.x0 = -1, .y0 = 255, .x1 = 1, .y1 = 257}),
              (Rect{.x0 = -1, .y0 = 0, .x1 = 1, .y1 = 2}));
    EXPECT_EQ(tilesCovering(Rect{.x0 = 0, .y0 = 0, .x1 = 256, .y1 = 256}), (Rect{.x0 = 0, .y0 = 0, .x1 = 1, .y1 = 1}));
    EXPECT_EQ(tilesCovering(Rect{}), Rect{});
}

TEST(TileBuffer, HoldsOnlyPixelsOfOneCell) {
    const TileRef edge = TileRef::allocate(Rect{.x0 = 1792, .y0 = 1024, .x1 = 1920, .y1 = 1080});
    EXPECT_EQ(edge->rect().area(), 128 * 56);
    EXPECT_THROW((void)TileRef::allocate(Rect{.x0 = 250, .y0 = 0, .x1 = 260, .y1 = 10}), std::invalid_argument);
    EXPECT_THROW((void)TileRef::allocate(Rect{}), std::invalid_argument);
}

TEST(TileRef, CopiesShareAndTheLastReferenceFrees) {
    TileRef a = TileRef::allocate(Rect{.x0 = 0, .y0 = 0, .x1 = 4, .y1 = 4});
    EXPECT_TRUE(a.isUnique());
    a->samples()[0] = 42.0F;
    {
        const TileRef b = a; // NOLINT(performance-unnecessary-copy-initialization): the copy is the test
        EXPECT_EQ(b.get(), a.get());
        EXPECT_FALSE(a.isUnique());
        EXPECT_FALSE(b.isUnique());
        EXPECT_EQ(b->samples()[0], 42.0F);
    }
    EXPECT_TRUE(a.isUnique());

    TileRef moved = std::move(a);
    EXPECT_FALSE(a); // NOLINT(bugprone-use-after-move): a moved-from reference is null
    EXPECT_TRUE(moved.isUnique());

    TileRef assigned;
    assigned = moved;
    EXPECT_FALSE(moved.isUnique());
    assigned = TileRef{};
    EXPECT_TRUE(moved.isUnique());
    moved.reset();
    EXPECT_FALSE(moved);
    EXPECT_FALSE(moved.isUnique()); // a null reference owns nothing
}

TEST(TileRef, CountsStayCorrectAcrossThreads) {
    const TileRef shared = TileRef::allocate(Rect{.x0 = 0, .y0 = 0, .x1 = 1, .y1 = 1});
    std::vector<std::thread> threads;
    threads.reserve(8);
    for (int t = 0; t < 8; ++t) {
        threads.emplace_back([&shared] {
            for (int i = 0; i < 20000; ++i) {
                TileRef copy = shared;
                const TileRef another = copy;
                copy.reset();
            }
        });
    }
    for (std::thread& thread : threads) {
        thread.join();
    }
    EXPECT_TRUE(shared.isUnique());
}

} // namespace
} // namespace pf::image
