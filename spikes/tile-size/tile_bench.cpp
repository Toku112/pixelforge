// Tile-size measurement for core/image (PLAN Part C item 5). Throw-away code, never linked into the app.
//
// The storage mirrors the planned design: one float plane per channel, split into square tiles on a grid aligned to
// pixel (0, 0); edge tiles are clipped to the data window (no padding). Every operation runs on oneTBB, as the engine
// will, one task per (tile, channel). Results go to stdout; see README.md.

#include <tbb/blocked_range.h>
#include <tbb/parallel_for.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <memory>
#include <random>
#include <set>
#include <utility>
#include <vector>

namespace {

struct Rect {
    int x0 = 0, y0 = 0, x1 = 0, y1 = 0; // half-open
    int w() const { return x1 - x0; }
    int h() const { return y1 - y0; }
    bool empty() const { return x1 <= x0 || y1 <= y0; }
    std::int64_t area() const { return empty() ? 0 : std::int64_t(w()) * h(); }
};

Rect intersect(Rect a, Rect b) {
    return {std::max(a.x0, b.x0), std::max(a.y0, b.y0), std::min(a.x1, b.x1), std::min(a.y1, b.y1)};
}

int floorDiv(int a, int b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }

struct Tile {
    Rect rect; // clipped to the data window
    std::unique_ptr<float[]> samples;
};

// One channel of an image.
struct Plane {
    std::vector<Tile> tiles;
};

struct Image {
    int tileSize = 256;
    Rect data;
    int tx0 = 0, ty0 = 0, tilesX = 0, tilesY = 0;
    std::vector<Plane> planes;

    Image(int s, Rect dataWindow, int channels) : tileSize(s), data(dataWindow) {
        tx0 = floorDiv(data.x0, s);
        ty0 = floorDiv(data.y0, s);
        tilesX = floorDiv(data.x1 - 1, s) - tx0 + 1;
        tilesY = floorDiv(data.y1 - 1, s) - ty0 + 1;
        planes.resize(channels);
        for (Plane& p : planes) {
            p.tiles.resize(std::size_t(tilesX) * tilesY);
            for (int j = 0; j < tilesY; ++j) {
                for (int i = 0; i < tilesX; ++i) {
                    Tile& t = p.tiles[std::size_t(j) * tilesX + i];
                    const Rect cell{(tx0 + i) * s, (ty0 + j) * s, (tx0 + i + 1) * s, (ty0 + j + 1) * s};
                    t.rect = intersect(cell, data);
                    t.samples.reset(new float[std::size_t(t.rect.area())]); // uninitialised, like a fresh result
                }
            }
        }
    }
    int tileCount() const { return tilesX * tilesY; }
    const Tile* tileAt(int c, int x, int y) const {
        const int i = floorDiv(x, tileSize) - tx0;
        const int j = floorDiv(y, tileSize) - ty0;
        return &planes[c].tiles[std::size_t(j) * tilesX + i];
    }
};

// Copies `region` (clipped to the data window, zeros outside) of channel c into dst (stride = region width).
void gather(const Image& img, int c, Rect region, float* dst) {
    std::fill(dst, dst + region.area(), 0.0f);
    const Rect inside = intersect(region, img.data);
    if (inside.empty()) {
        return;
    }
    const int s = img.tileSize;
    for (int ty = floorDiv(inside.y0, s); ty <= floorDiv(inside.y1 - 1, s); ++ty) {
        for (int tx = floorDiv(inside.x0, s); tx <= floorDiv(inside.x1 - 1, s); ++tx) {
            const Tile& t = img.planes[c].tiles[std::size_t(ty - img.ty0) * img.tilesX + (tx - img.tx0)];
            const Rect part = intersect(t.rect, inside);
            for (int y = part.y0; y < part.y1; ++y) {
                const float* src = t.samples.get() + std::size_t(y - t.rect.y0) * t.rect.w() + (part.x0 - t.rect.x0);
                float* out = dst + std::size_t(y - region.y0) * region.w() + (part.x0 - region.x0);
                std::copy(src, src + part.w(), out);
            }
        }
    }
}

void fillRandom(Image& img, unsigned seed) {
    tbb::parallel_for(0, int(img.planes.size()) * img.tileCount(), [&](int task) {
        const int c = task / img.tileCount();
        Tile& t = img.planes[c].tiles[task % img.tileCount()];
        std::minstd_rand rng(seed + unsigned(task));
        std::uniform_real_distribution<float> d(0.0f, 4.0f);
        for (std::int64_t i = 0; i < t.rect.area(); ++i) {
            t.samples[i] = d(rng);
        }
    });
}

// Point operation (memory-bound): out = in * gain + lift, into freshly allocated tiles.
Image grade(const Image& in) {
    Image out(in.tileSize, in.data, int(in.planes.size()));
    tbb::parallel_for(0, int(in.planes.size()) * in.tileCount(), [&](int task) {
        const int c = task / in.tileCount();
        const Tile& a = in.planes[c].tiles[task % in.tileCount()];
        Tile& b = out.planes[c].tiles[task % in.tileCount()];
        const std::int64_t n = a.rect.area();
        const float gain = 1.7f + 0.1f * float(c), lift = 0.01f;
        for (std::int64_t i = 0; i < n; ++i) {
            b.samples[i] = a.samples[i] * gain + lift;
        }
    });
    return out;
}

// The same point operation into existing tiles (no allocation), to separate the allocator from the tiling.
void gradeInto(const Image& in, Image& out) {
    tbb::parallel_for(0, int(in.planes.size()) * in.tileCount(), [&](int task) {
        const int c = task / in.tileCount();
        const Tile& a = in.planes[c].tiles[task % in.tileCount()];
        Tile& b = out.planes[c].tiles[task % in.tileCount()];
        const std::int64_t n = a.rect.area();
        const float gain = 1.7f + 0.1f * float(c), lift = 0.01f;
        for (std::int64_t i = 0; i < n; ++i) {
            b.samples[i] = a.samples[i] * gain + lift;
        }
    });
}

// Neighbourhood operation: separable Gaussian of the given radius (2r+1 taps), per output tile from a padded input
// region gathered from the neighbouring tiles.
Image gaussian(const Image& in, int radius) {
    std::vector<float> w(std::size_t(2 * radius + 1));
    float sum = 0.0f;
    for (int i = -radius; i <= radius; ++i) {
        w[std::size_t(i + radius)] = std::exp(-0.5f * float(i * i) / (float(radius * radius) / 9.0f));
        sum += w[std::size_t(i + radius)];
    }
    for (float& v : w) {
        v /= sum;
    }
    Image out(in.tileSize, in.data, int(in.planes.size()));
    tbb::parallel_for(0, int(in.planes.size()) * in.tileCount(), [&](int task) {
        const int c = task / in.tileCount();
        Tile& b = out.planes[c].tiles[task % in.tileCount()];
        const Rect r = b.rect;
        const Rect padded{r.x0 - radius, r.y0 - radius, r.x1 + radius, r.y1 + radius};
        std::vector<float> src(std::size_t(padded.area()));
        gather(in, c, padded, src.data());
        // Horizontal pass over all padded rows, output columns only.
        std::vector<float> mid(std::size_t(padded.h()) * r.w());
        for (int y = 0; y < padded.h(); ++y) {
            const float* row = src.data() + std::size_t(y) * padded.w();
            float* o = mid.data() + std::size_t(y) * r.w();
            for (int x = 0; x < r.w(); ++x) {
                float acc = 0.0f;
                for (int k = 0; k <= 2 * radius; ++k) {
                    acc += row[x + k] * w[std::size_t(k)];
                }
                o[x] = acc;
            }
        }
        // Vertical pass.
        for (int y = 0; y < r.h(); ++y) {
            float* o = b.samples.get() + std::size_t(y) * r.w();
            std::fill(o, o + r.w(), 0.0f);
            for (int k = 0; k <= 2 * radius; ++k) {
                const float* m = mid.data() + std::size_t(y + k) * r.w();
                const float wk = w[std::size_t(k)];
                for (int x = 0; x < r.w(); ++x) {
                    o[x] += m[x] * wk;
                }
            }
        }
    });
    return out;
}

// The viewer's request: an arbitrary window copied to an interleaved RGBA float buffer (what a GPU upload needs).
void viewerCopy(const Image& img, Rect roi, std::vector<float>& rgba) {
    rgba.resize(std::size_t(roi.area()) * 4);
    const int s = img.tileSize;
    const int band0 = floorDiv(roi.y0, s), band1 = floorDiv(roi.y1 - 1, s);
    tbb::parallel_for(band0, band1 + 1, [&](int band) {
        const Rect rows = intersect(roi, Rect{roi.x0, band * s, roi.x1, (band + 1) * s});
        for (int c = 0; c < 4; ++c) {
            for (int tx = floorDiv(rows.x0, s); tx <= floorDiv(rows.x1 - 1, s); ++tx) {
                const Tile& t = *img.tileAt(c, tx * s, band * s);
                const Rect part = intersect(t.rect, rows);
                for (int y = part.y0; y < part.y1; ++y) {
                    const float* src = t.samples.get() + std::size_t(y - t.rect.y0) * t.rect.w() +
                                       (part.x0 - t.rect.x0);
                    float* dst = rgba.data() + (std::size_t(y - roi.y0) * roi.w() + (part.x0 - roi.x0)) * 4 + c;
                    for (int x = 0; x < part.w(); ++x) {
                        dst[std::size_t(x) * 4] = src[x];
                    }
                }
            }
        }
    });
}

// A decoder's output (interleaved RGBA scanlines) scattered into tiles.
void ingest(const std::vector<float>& rgba, Image& img) {
    tbb::parallel_for(0, 4 * img.tileCount(), [&](int task) {
        const int c = task / img.tileCount();
        Tile& t = img.planes[c].tiles[task % img.tileCount()];
        for (int y = t.rect.y0; y < t.rect.y1; ++y) {
            const float* src = rgba.data() + (std::size_t(y - img.data.y0) * img.data.w() + (t.rect.x0 - img.data.x0)) * 4 + c;
            float* dst = t.samples.get() + std::size_t(y - t.rect.y0) * t.rect.w();
            for (int x = 0; x < t.rect.w(); ++x) {
                dst[x] = src[std::size_t(x) * 4];
            }
        }
    });
}

// Grade restricted to the tiles touching `roi` (a zoomed-in viewer). Returns pixels computed.
std::int64_t gradeRoi(const Image& in, Image& out, Rect roi) {
    const int s = in.tileSize;
    std::vector<std::pair<int, int>> tiles;
    for (int ty = floorDiv(roi.y0, s); ty <= floorDiv(roi.y1 - 1, s); ++ty) {
        for (int tx = floorDiv(roi.x0, s); tx <= floorDiv(roi.x1 - 1, s); ++tx) {
            tiles.emplace_back(tx, ty);
        }
    }
    std::int64_t pixels = 0;
    for (auto [tx, ty] : tiles) {
        pixels += in.tileAt(0, tx * s, ty * s)->rect.area();
    }
    tbb::parallel_for(0, int(tiles.size()) * 4, [&](int task) {
        const int c = task % 4;
        const auto [tx, ty] = tiles[std::size_t(task / 4)];
        const Tile& a = *in.tileAt(c, tx * s, ty * s);
        const Tile& b = *out.tileAt(c, tx * s, ty * s);
        for (std::int64_t i = 0; i < a.rect.area(); ++i) {
            b.samples[i] = a.samples[i] * 1.7f + 0.01f;
        }
    });
    return pixels * 4;
}

double medianMs(const std::function<void()>& fn, int runs = 15) {
    fn(); // warm-up
    fn();
    std::vector<double> t;
    for (int i = 0; i < runs; ++i) {
        const auto a = std::chrono::steady_clock::now();
        fn();
        const auto b = std::chrono::steady_clock::now();
        t.push_back(std::chrono::duration<double, std::milli>(b - a).count());
    }
    std::sort(t.begin(), t.end());
    return t[t.size() / 2];
}

// Bytes of undo data (whole tiles, 4 channels) for a brush stroke: a random walk of dabs.
std::int64_t strokeUndoBytes(int s, Rect canvas, int diameter, int length, unsigned seed, std::int64_t* painted) {
    std::minstd_rand rng(seed);
    std::uniform_real_distribution<float> turn(-0.4f, 0.4f);
    float x = float(canvas.w()) / 2, y = float(canvas.h()) / 2, angle = 0.3f;
    std::set<std::pair<int, int>> tiles;
    std::set<std::pair<int, int>> pixels;
    const int r = diameter / 2;
    for (int step = 0; step < length; step += std::max(1, diameter / 4)) {
        angle += turn(rng);
        x += std::cos(angle) * float(std::max(1, diameter / 4));
        y += std::sin(angle) * float(std::max(1, diameter / 4));
        const Rect dab = intersect(Rect{int(x) - r, int(y) - r, int(x) + r + 1, int(y) + r + 1}, canvas);
        for (int ty = floorDiv(dab.y0, s); ty <= floorDiv(dab.y1 - 1, s); ++ty) {
            for (int tx = floorDiv(dab.x0, s); tx <= floorDiv(dab.x1 - 1, s); ++tx) {
                tiles.emplace(tx, ty);
            }
        }
        if (painted != nullptr) {
            for (int py = dab.y0; py < dab.y1; ++py) {
                for (int px = dab.x0; px < dab.x1; ++px) {
                    if ((px - int(x)) * (px - int(x)) + (py - int(y)) * (py - int(y)) <= r * r) {
                        pixels.emplace(px, py);
                    }
                }
            }
        }
    }
    std::int64_t bytes = 0;
    for (auto [tx, ty] : tiles) {
        bytes += intersect(Rect{tx * s, ty * s, (tx + 1) * s, (ty + 1) * s}, canvas).area() * 4 * 4;
    }
    if (painted != nullptr) {
        *painted = std::int64_t(pixels.size()) * 4 * 4;
    }
    return bytes;
}

} // namespace

int main() {
    const Rect uhd{0, 0, 3840, 2160};
    const Rect hd{0, 0, 1920, 1080};
    const Rect viewRoi{517, 233, 517 + 1920, 233 + 1080};
    std::vector<float> decoded(std::size_t(uhd.area()) * 4);
    std::minstd_rand fillRng(7);
    for (float& v : decoded) {
        v = float(fillRng() % 1000) / 250.0f;
    }

    std::printf("Times in ms, median of 15 runs, oneTBB default arena. 4 channels unless noted.\n\n");
    std::printf("%-6s %8s %8s %8s %8s %8s %8s %9s %9s %8s %8s %9s %9s\n", "tile", "tasks4K", "grade4K", "noAlloc", "grade1080",
                "1thr4K", "gauss4", "gauss32", "viewCopy", "ingest", "roiMs", "roiWaste", "undo/paint");
    for (int s : {64, 128, 256, 512}) {
        Image a(s, uhd, 4);
        fillRandom(a, 1);
        Image a1080(s, hd, 4);
        fillRandom(a1080, 2);

        const double tGrade = medianMs([&] { const Image o = grade(a); });
        Image reuse(s, uhd, 4);
        const double tNoAlloc = medianMs([&] { gradeInto(a, reuse); });
        const double tGrade1080 = medianMs([&] { const Image o = grade(a1080); });
        double tGrade1;
        {
            tbb::task_arena single(1);
            tGrade1 = single.execute([&] { return medianMs([&] { const Image o = grade(a); }, 7); });
        }
        const double tGauss4 = medianMs([&] { const Image o = gaussian(a, 4); }, 7);
        const double tGauss32 = medianMs([&] { const Image o = gaussian(a, 32); }, 5);
        std::vector<float> view;
        const double tView = medianMs([&] { viewerCopy(a, viewRoi, view); });
        Image target(s, uhd, 4);
        const double tIngest = medianMs([&] { ingest(decoded, target); });

        // Zoomed viewer: 480×270 windows at random positions; computed pixels vs requested pixels.
        Image roiOut(s, uhd, 4);
        std::minstd_rand rng(11);
        std::vector<Rect> rois;
        for (int i = 0; i < 100; ++i) {
            const int x = int(rng() % (3840 - 480)), y = int(rng() % (2160 - 270));
            rois.push_back({x, y, x + 480, y + 270});
        }
        std::int64_t computed = 0;
        const double tRoi = medianMs([&] {
            computed = 0;
            for (const Rect& r : rois) {
                computed += gradeRoi(a, roiOut, r);
            }
        }, 7) / double(rois.size());
        const double roiWaste = double(computed) / double(std::int64_t(480) * 270 * 4 * std::int64_t(rois.size()));

        // Undo data for 20 strokes (60 px brush, 1500 px long) on a 6000×4000 still, vs the pixels painted.
        std::int64_t undo = 0, painted = 0;
        for (unsigned k = 0; k < 20; ++k) {
            std::int64_t p = 0;
            undo += strokeUndoBytes(s, Rect{0, 0, 6000, 4000}, 60, 1500, 100 + k, &p);
            painted += p;
        }

        std::printf("%-6d %8d %8.2f %8.2f %8.2f %8.1f %8.2f %9.2f %9.2f %8.2f %8.3f %8.2fx %8.2fx\n", s,
                    a.tileCount() * 4, tGrade, tNoAlloc, tGrade1080, tGrade1, tGauss4, tGauss32, tView, tIngest, tRoi,
                    roiWaste, double(undo) / double(painted));
    }
    std::printf("\ntasks4K: (tile, channel) tasks for a 3840×2160 RGBA image. grade4K: out = in * gain + lift into\n"
                "new tiles; noAlloc: the same into existing tiles. 1thr4K: grade4K on one thread.\n"
                "gauss4/gauss32: separable Gaussian, radius 4 / 32, per output tile from a padded gather.\n"
                "viewCopy: 1920×1080 window at (517, 233) to interleaved RGBA float. ingest: interleaved 4K RGBA\n"
                "scanlines into tiles. roiMs/roiWaste: grade of a 480×270 window (zoomed viewer), ms per window and\n"
                "computed/requested pixels. undo/paint: whole-tile undo bytes / painted-pixel bytes, 60 px brush.\n");
    return 0;
}
