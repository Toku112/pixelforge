// The engine services as the app wires them (engine/Engine.h): tile memory from the process pool, a budget that
// measures tile memory, caches of images evicted under it.

#include "engine/Engine.h"

#include "core/image/Image.h"
#include "engine/LruCache.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace pf::engine {
namespace {

constexpr std::size_t block = TilePool::blockBytes;

// A 512 × 256 one-channel image whose two tiles hold memory (two full blocks).
std::shared_ptr<const image::Image> twoTileImage(float value) {
    const image::Rect window{.x0 = 0, .y0 = 0, .x1 = 512, .y1 = 256};
    auto img = std::make_shared<image::Image>(window, window, image::ChannelSet{"Y"});
    for (int tx = 0; tx < 2; ++tx) {
        const image::MutableTile tile = img->overwriteTile(0, {.x = tx, .y = 0});
        std::fill_n(tile.samples, tile.rect.area(), value);
    }
    return img;
}

TEST(Engine, InstallsTheProcessTilePool) {
    Engine engine;
    EXPECT_EQ(image::tileMemoryResource(), &TilePool::process());
    EXPECT_EQ(&engine.tilePool(), &TilePool::process());
}

TEST(Engine, UsageIsTheTileMemoryInUse) {
    Engine engine;
    const std::size_t before = engine.memory().usage();
    {
        const auto img = twoTileImage(1.0F);
        EXPECT_EQ(engine.memory().usage(), before + (2 * block));
        const image::Image copy = *img; // NOLINT(performance-unnecessary-copy-initialization): shares the tiles
        EXPECT_EQ(copy.storedBytes(), 2 * block);
        EXPECT_EQ(engine.memory().usage(), before + (2 * block));
    }
    EXPECT_EQ(engine.memory().usage(), before);
}

TEST(Engine, CachedImagesAreEvictedToStayInsideTheBudget) {
    Engine engine;
    const std::size_t base = engine.memory().usage();
    engine.setMemoryLimit(base + (5 * block));   // room for two cached images, not three
    engine.tilePool().setRetainLimit(8 * block); // a tiny budget would otherwise keep no free blocks
    LruCache<int, image::Image> frames("frames", engine.memory());
    for (int frame = 1001; frame <= 1004; ++frame) {
        auto img = twoTileImage(static_cast<float>(frame));
        const std::size_t bytes = img->storedBytes();
        frames.insert(frame, std::move(img), bytes);
        EXPECT_LE(engine.memory().usage(), engine.memory().limit()) << frame;
    }
    EXPECT_FALSE(frames.contains(1001));
    EXPECT_FALSE(frames.contains(1002));
    ASSERT_TRUE(frames.contains(1004));
    EXPECT_EQ(frames.find(1004)->sample("Y", 300, 10), 1004.0F);
    EXPECT_EQ(frames.stats().entries, 2U);

    // Evicted frames' tiles wait in the pool and are reused by the next frame.
    const std::uint64_t reusedBefore = engine.tilePool().stats().reused;
    frames.insert(1005, twoTileImage(1005.0F), 2 * block);
    EXPECT_GE(engine.tilePool().stats().reused, reusedBefore + 2);
}

TEST(Engine, LoweringTheLimitEvictsAndReleasesFreeBlocks) {
    Engine engine;
    const std::size_t base = engine.memory().usage();
    engine.setMemoryLimit(base + (100 * block));
    LruCache<int, image::Image> frames("frames", engine.memory());
    for (int frame = 0; frame < 4; ++frame) {
        frames.insert(frame, twoTileImage(1.0F), 2 * block);
    }
    EXPECT_EQ(frames.stats().entries, 4U);
    engine.setMemoryLimit(base + (3 * block));
    EXPECT_EQ(frames.stats().entries, 1U);
    EXPECT_EQ(engine.tilePool().stats().bytesFree, 0U); // released to the system
    EXPECT_LE(engine.tilePool().retainLimit(), (base + (3 * block)) / Engine::retainDivisor);
}

std::vector<std::string> consumerNames(const MemoryBudgetStats& stats) {
    std::vector<std::string> names;
    names.reserve(stats.consumers.size());
    for (const ConsumerStats& consumer : stats.consumers) {
        names.push_back(consumer.name);
    }
    return names;
}

TEST(Engine, StatsGatherEverything) {
    Engine engine;
    engine.setMemoryLimit(std::size_t{1} << 30);
    LruCache<int, image::Image> frames("frames", engine.memory());
    frames.insert(1, twoTileImage(1.0F), 2 * block);
    auto job = engine.scheduler().submit({.name = "Caching"}, [](JobContext&) { return 1; });
    EXPECT_EQ(job.get(), 1);
    engine.scheduler().waitIdle();

    const EngineStats stats = engine.stats();
    EXPECT_EQ(stats.memory.limit, std::size_t{1} << 30);
    EXPECT_GE(stats.memory.usage, 2 * block);
    // The evaluator's two caches register first, at startup.
    EXPECT_EQ(consumerNames(stats.memory), (std::vector<std::string>{"Node results", "Node descriptions", "frames"}));
    EXPECT_EQ(stats.evaluation.tiles.entries, 0U);
    EXPECT_GE(stats.tiles.bytesInUse, 2 * block);
    EXPECT_EQ(stats.jobs.finished, 1U);
    EXPECT_GE(stats.jobs.threads, 1);
}

TEST(Engine, DestructionStopsRunningJobs) {
    std::atomic<bool> started{false};
    Job<void> job;
    {
        Engine engine;
        job = engine.scheduler().submit({.name = "Render"}, [&started](JobContext& context) {
            started = true;
            while (true) {
                context.throwIfCancelled();
                std::this_thread::yield();
            }
        });
        while (!started) {
            std::this_thread::yield();
        }
    }
    EXPECT_EQ(job.status(), JobStatus::Cancelled);
}

} // namespace
} // namespace pf::engine
