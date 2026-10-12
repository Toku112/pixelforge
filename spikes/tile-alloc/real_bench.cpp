// The same measurement as alloc_bench, on the real code: core/image's Image and engine/TilePool. Throw-away code,
// never linked into the app. Compares the default tile memory (operator new) with the tile pool for a grade into new
// images and for refilling a cache after it was emptied.

#include "core/image/Image.h"
#include "core/image/Tile.h"
#include "engine/TilePool.h"

#include <tbb/parallel_for.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <memory>
#include <vector>

namespace {

using pf::image::Image;
using pf::image::Rect;

double nowMs() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

double median(std::vector<double> v) {
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
}

Image makeInput(const Rect& window) {
    Image image(window, window, {"R", "G", "B", "A"});
    const Rect tiles = image.tileRange();
    const int count = tiles.width() * tiles.height();
    tbb::parallel_for(0, count * 4, [&](int task) {
        const pf::image::TileCoord tile{.x = tiles.x0 + ((task / 4) % tiles.width()),
                                        .y = tiles.y0 + ((task / 4) / tiles.width())};
        const pf::image::MutableTile out = image.overwriteTile(std::size_t(task % 4), tile);
        std::fill_n(out.samples, out.rect.area(), 0.5F);
    });
    return image;
}

// out = in · gain + lift into a new image, one task per (tile, channel), as a grade node will run.
std::unique_ptr<Image> grade(const Image& in) {
    auto out = std::make_unique<Image>(in.displayWindow(), in.dataWindow(), in.channels());
    const Rect tiles = in.tileRange();
    const int count = tiles.width() * tiles.height();
    tbb::parallel_for(0, count * 4, [&](int task) {
        const pf::image::TileCoord tile{.x = tiles.x0 + ((task / 4) % tiles.width()),
                                        .y = tiles.y0 + ((task / 4) / tiles.width())};
        const std::size_t channel = std::size_t(task % 4);
        const pf::image::ConstTile src = in.tile(channel, tile);
        const pf::image::MutableTile dst = out->overwriteTile(channel, tile);
        const auto n = static_cast<std::size_t>(dst.rect.area());
        for (std::size_t i = 0; i < n; ++i) {
            dst.samples[i] = (src.samples[i] * 1.37F) + 0.02F;
        }
    });
    return out;
}

double steady(const Rect& window) {
    const Image input = makeInput(window);
    std::unique_ptr<Image> shown;
    std::vector<double> times;
    for (int f = 0; f < 43; ++f) {
        const double t0 = nowMs();
        auto next = grade(input);
        shown = std::move(next);
        if (f >= 3) {
            times.push_back(nowMs() - t0);
        }
    }
    return median(times);
}

// Eleven 4K RGBA frames (1.5 GB) into a "cache", emptied, then filled again: the median refill time.
double refill() {
    const Rect k4{.x0 = 0, .y0 = 0, .x1 = 3840, .y1 = 2160};
    auto fill = [&] {
        std::vector<Image> frames;
        const double t0 = nowMs();
        for (int i = 0; i < 11; ++i) {
            frames.push_back(makeInput(k4));
        }
        return nowMs() - t0;
    };
    (void)fill();
    std::vector<double> times;
    for (int i = 0; i < 9; ++i) {
        times.push_back(fill());
    }
    return median(times);
}

} // namespace

int main() {
    const Rect k4{.x0 = 0, .y0 = 0, .x1 = 3840, .y1 = 2160};
    const Rect hd{.x0 = 0, .y0 = 0, .x1 = 1920, .y1 = 1080};
    std::printf("Real core/image + engine/TilePool, ms (median). grade: new RGBA image per frame; refill: 1.5 GB "
                "cache emptied and filled again.\n");
    std::printf("%-12s %8s %8s %9s\n", "tile memory", "4K", "1080p", "refill");
    for (int run = 0; run < 2; ++run) {
        pf::image::setTileMemoryResource(nullptr);
        std::printf("%-12s %8.2f %8.2f %9.1f\n", "operator new", steady(k4), steady(hd), refill());
        pf::engine::TilePool& pool = pf::engine::TilePool::process();
        pool.setRetainLimit(std::size_t{4} << 30);
        pf::image::setTileMemoryResource(&pool);
        std::printf("%-12s %8.2f %8.2f %9.1f\n", "TilePool", steady(k4), steady(hd), refill());
        pf::image::setTileMemoryResource(nullptr);
        pool.releaseFree();
    }
    return 0;
}
