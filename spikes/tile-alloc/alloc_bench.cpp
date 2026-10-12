// Tile memory measurement for the engine (PLAN Part C item 6, follow-up of D-073). Throw-away code, never linked into
// the app. Compares where 256 × 256 float tiles get their memory:
//   system    new float[] (what core/image does today)
//   tbbmalloc oneTBB's scalable allocator (already a dependency)
//   pool      a free list of blocks per exact block size, guarded by a mutex (our own, pure C++)
//   noAlloc   the same work into tiles that already exist (the floor)
// Every allocation happens inside the parallel task that fills the tile, as the engine will do it (Image::
// overwriteTile from one oneTBB task per (tile, channel)).

#include <tbb/parallel_for.h>
#include <tbb/scalable_allocator.h>

#include <mach/mach.h>
#include <malloc/malloc.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr int tileSize = 256;

struct Rect {
    int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    int w() const { return x1 - x0; }
    int h() const { return y1 - y0; }
    std::size_t area() const { return std::size_t(w()) * std::size_t(h()); }
};

// ---- allocators

struct Allocator {
    virtual ~Allocator() = default;
    virtual const char* name() const = 0;
    virtual float* allocate(std::size_t samples) = 0;
    virtual void free(float* p, std::size_t samples) = 0;
    virtual void trim() {}
};

struct SystemAllocator final : Allocator {
    const char* name() const override { return "system"; }
    float* allocate(std::size_t samples) override { return new float[samples]; }
    void free(float* p, std::size_t) override { delete[] p; }
};

struct TbbAllocator final : Allocator {
    const char* name() const override { return "tbbmalloc"; }
    float* allocate(std::size_t samples) override {
        return static_cast<float*>(scalable_aligned_malloc(samples * sizeof(float), 64));
    }
    void free(float* p, std::size_t) override { scalable_aligned_free(p); }
    void trim() override { scalable_allocation_command(TBBMALLOC_CLEAN_ALL_BUFFERS, nullptr); }
};

// Exact-size free lists. Blocks come from the system allocator the first time and are kept after free().
struct PoolAllocator final : Allocator {
    const char* name() const override { return "pool"; }
    float* allocate(std::size_t samples) override {
        {
            const std::lock_guard lock(m_mutex);
            auto it = m_free.find(samples);
            if (it != m_free.end() && !it->second.empty()) {
                float* p = it->second.back();
                it->second.pop_back();
                return p;
            }
        }
        return new float[samples];
    }
    void free(float* p, std::size_t samples) override {
        const std::lock_guard lock(m_mutex);
        m_free[samples].push_back(p);
    }
    void trim() override {
        const std::lock_guard lock(m_mutex);
        for (auto& [size, list] : m_free) {
            for (float* p : list) {
                delete[] p;
            }
            list.clear();
        }
    }
    ~PoolAllocator() override { trim(); }

    std::mutex m_mutex;
    std::unordered_map<std::size_t, std::vector<float*>> m_free;
};

// The same free lists behind a spin lock (no sleeping in the kernel when threads collide).
struct SpinPoolAllocator final : Allocator {
    const char* name() const override { return "poolSpin"; }
    void lock() {
        while (m_lock.test_and_set(std::memory_order_acquire)) {
            while (m_lock.test(std::memory_order_relaxed)) {
            }
        }
    }
    void unlock() { m_lock.clear(std::memory_order_release); }
    float* allocate(std::size_t samples) override {
        lock();
        auto it = m_free.find(samples);
        if (it != m_free.end() && !it->second.empty()) {
            float* p = it->second.back();
            it->second.pop_back();
            unlock();
            return p;
        }
        unlock();
        return new float[samples];
    }
    void free(float* p, std::size_t samples) override {
        lock();
        m_free[samples].push_back(p);
        unlock();
    }
    void trim() override {
        lock();
        for (auto& [size, list] : m_free) {
            for (float* p : list) {
                delete[] p;
            }
            list.clear();
        }
        unlock();
    }
    ~SpinPoolAllocator() override { trim(); }

    std::atomic_flag m_lock;
    std::unordered_map<std::size_t, std::vector<float*>> m_free;
};

// Only full 256 × 256 tiles are pooled (one block size, one list); smaller edge tiles use the system allocator.
struct FullTilePoolAllocator final : Allocator {
    static constexpr std::size_t full = std::size_t(tileSize) * tileSize;
    const char* name() const override { return "poolFull"; }
    float* allocate(std::size_t samples) override {
        if (samples == full) {
            const std::lock_guard lock(m_mutex);
            if (!m_free.empty()) {
                float* p = m_free.back();
                m_free.pop_back();
                return p;
            }
        }
        return new float[samples];
    }
    void free(float* p, std::size_t samples) override {
        if (samples == full) {
            const std::lock_guard lock(m_mutex);
            m_free.push_back(p);
            return;
        }
        delete[] p;
    }
    void trim() override {
        const std::lock_guard lock(m_mutex);
        for (float* p : m_free) {
            delete[] p;
        }
        m_free.clear();
    }
    ~FullTilePoolAllocator() override { trim(); }

    std::mutex m_mutex;
    std::vector<float*> m_free;
};

// Full tiles pooled as in poolFull, but every block comes from (and goes back to) oneTBB's allocator, whose
// clean-up command really returns memory to the system.
struct TbbBackedPoolAllocator final : Allocator {
    static constexpr std::size_t full = std::size_t(tileSize) * tileSize;
    const char* name() const override { return "poolTbb"; }
    float* raw(std::size_t samples) {
        m_used = true;
        return static_cast<float*>(scalable_aligned_malloc(samples * sizeof(float), 64));
    }
    float* allocate(std::size_t samples) override {
        if (samples == full) {
            const std::lock_guard lock(m_mutex);
            if (!m_free.empty()) {
                float* p = m_free.back();
                m_free.pop_back();
                return p;
            }
        }
        return raw(samples);
    }
    void free(float* p, std::size_t samples) override {
        if (samples == full) {
            const std::lock_guard lock(m_mutex);
            m_free.push_back(p);
            return;
        }
        scalable_aligned_free(p);
    }
    void trim() override {
        const std::lock_guard lock(m_mutex);
        for (float* p : m_free) {
            scalable_aligned_free(p);
        }
        m_free.clear();
        if (m_used) { // oneTBB 2023.1 crashes when the clean-up runs before its allocator was ever used
            scalable_allocation_command(TBBMALLOC_CLEAN_ALL_BUFFERS, nullptr);
        }
    }
    ~TbbBackedPoolAllocator() override { trim(); }

    std::mutex m_mutex;
    std::vector<float*> m_free;
    std::atomic<bool> m_used{false};
};

// ---- images

struct Tile {
    Rect rect;
    float* samples = nullptr;
};

struct Image {
    Allocator* alloc = nullptr;
    Rect data;
    int tilesX = 0, tilesY = 0, channels = 0;
    std::vector<Tile> tiles; // channel-major

    Image(Allocator* a, int width, int height, int c) : alloc(a), data{0, 0, width, height}, channels(c) {
        tilesX = (width + tileSize - 1) / tileSize;
        tilesY = (height + tileSize - 1) / tileSize;
        tiles.resize(std::size_t(tilesX) * tilesY * c);
        for (int ch = 0; ch < c; ++ch) {
            for (int j = 0; j < tilesY; ++j) {
                for (int i = 0; i < tilesX; ++i) {
                    Tile& t = tiles[index(ch, i, j)];
                    t.rect = {i * tileSize, j * tileSize, std::min((i + 1) * tileSize, width),
                              std::min((j + 1) * tileSize, height)};
                }
            }
        }
    }
    Image(const Image&) = delete;
    Image& operator=(const Image&) = delete;
    ~Image() {
        for (Tile& t : tiles) {
            if (t.samples != nullptr) {
                alloc->free(t.samples, t.rect.area());
            }
        }
    }
    std::size_t index(int ch, int i, int j) const { return (std::size_t(ch) * tilesY + j) * tilesX + i; }
    std::size_t bytes() const {
        std::size_t b = 0;
        for (const Tile& t : tiles) {
            b += t.rect.area() * sizeof(float);
        }
        return b;
    }
};

// out = in · gain + lift. When `out` has no samples yet, each task allocates its tile first.
void grade(const Image& in, Image& out) {
    tbb::parallel_for(std::size_t(0), in.tiles.size(), [&](std::size_t k) {
        const Tile& src = in.tiles[k];
        Tile& dst = out.tiles[k];
        if (dst.samples == nullptr) {
            dst.samples = out.alloc->allocate(dst.rect.area());
        }
        const std::size_t n = src.rect.area();
        for (std::size_t i = 0; i < n; ++i) {
            dst.samples[i] = (src.samples[i] * 1.37F) + 0.02F;
        }
    });
}

void fill(Image& img) {
    tbb::parallel_for(std::size_t(0), img.tiles.size(), [&](std::size_t k) {
        Tile& t = img.tiles[k];
        if (t.samples == nullptr) {
            t.samples = img.alloc->allocate(t.rect.area());
        }
        for (std::size_t i = 0; i < t.rect.area(); ++i) {
            t.samples[i] = float(i % 97) * 0.01F;
        }
    });
}

double nowMs() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

double median(std::vector<double> v) {
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
}

// The process's physical footprint (what Activity Monitor shows as "Memory"), in MB.
std::size_t residentMB() {
    task_vm_info_data_t info{};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count);
    return std::size_t(info.phys_footprint >> 20);
}

// A viewer-style loop: each frame grades the input into a new image; the previous frame's result is released once
// the new one exists (one result alive, as a viewer holds the frame it shows).
double steadyFrames(Allocator& a, int width, int height, int frames) {
    Image input(&a, width, height, 4);
    fill(input);
    std::unique_ptr<Image> shown;
    std::vector<double> times;
    for (int f = 0; f < frames + 3; ++f) {
        const double t0 = nowMs();
        auto next = std::make_unique<Image>(&a, width, height, 4);
        grade(input, *next);
        shown = std::move(next); // frees the previous result
        if (f >= 3) {
            times.push_back(nowMs() - t0);
        }
    }
    return median(times);
}

// A chain of five grade nodes on one frame: every intermediate result is freed when the next node has used it.
double chain(Allocator& a, int width, int height, int runs) {
    Image input(&a, width, height, 4);
    fill(input);
    std::vector<double> times;
    for (int r = 0; r < runs + 3; ++r) {
        const double t0 = nowMs();
        auto current = std::make_unique<Image>(&a, width, height, 4);
        grade(input, *current);
        for (int node = 1; node < 5; ++node) {
            auto next = std::make_unique<Image>(&a, width, height, 4);
            grade(*current, *next);
            current = std::move(next);
        }
        if (r >= 3) {
            times.push_back(nowMs() - t0);
        }
    }
    return median(times);
}

// The floor: the same grade into an image whose tiles already exist.
double noAlloc(int width, int height, int frames) {
    SystemAllocator a;
    Image input(&a, width, height, 4);
    Image out(&a, width, height, 4);
    fill(input);
    fill(out);
    std::vector<double> times;
    for (int f = 0; f < frames + 3; ++f) {
        const double t0 = nowMs();
        grade(input, out);
        if (f >= 3) {
            times.push_back(nowMs() - t0);
        }
    }
    return median(times);
}

// Fill a cache: 1.5 GB of tiles (eleven 4K RGBA frames), release them all, then fill again. Reports both fill times
// and the resident memory after the release (what the allocator keeps), and after trim().
void cacheCycle(Allocator& a, double& firstMs, double& againMs, std::size_t& keptMB, std::size_t& trimmedMB) {
    const std::size_t base = residentMB();
    auto fillMany = [&] {
        std::vector<std::unique_ptr<Image>> frames;
        const double t0 = nowMs();
        for (int i = 0; i < 11; ++i) {
            frames.push_back(std::make_unique<Image>(&a, 3840, 2160, 4));
            fill(*frames.back());
        }
        return std::pair{nowMs() - t0, std::move(frames)};
    };
    {
        auto [ms, frames] = fillMany();
        firstMs = ms;
    }
    keptMB = residentMB() - std::min(residentMB(), base);
    {
        auto [ms, frames] = fillMany();
        againMs = ms;
    }
    a.trim();
    malloc_zone_pressure_relief(nullptr, 0); // ask the system allocator to give free memory back
    trimmedMB = residentMB() - std::min(residentMB(), base);
}

} // namespace

int main(int argc, char** argv) {
    const std::string only = argc > 1 ? argv[1] : "";
    std::printf("Times in ms, median. 4 channels (RGBA float32), 256x256 tiles, oneTBB default arena.\n\n");
    std::printf("%-10s %9s %9s %9s %9s %9s %9s %8s %8s\n", "allocator", "4K", "1080p", "chain4K", "chain1080",
                "cache1st", "cacheAgain", "keptMB", "trimMB");
    std::printf("%-10s %9.2f %9.2f %9s %9s\n", "noAlloc", noAlloc(3840, 2160, 40), noAlloc(1920, 1080, 40), "-", "-");

    std::vector<std::unique_ptr<Allocator>> allocators;
    allocators.push_back(std::make_unique<SystemAllocator>());
    allocators.push_back(std::make_unique<TbbAllocator>());
    allocators.push_back(std::make_unique<PoolAllocator>());
    allocators.push_back(std::make_unique<SpinPoolAllocator>());
    allocators.push_back(std::make_unique<FullTilePoolAllocator>());
    allocators.push_back(std::make_unique<TbbBackedPoolAllocator>());
    for (auto& a : allocators) {
        if (!only.empty() && only != a->name()) {
            continue;
        }
        const double k4 = steadyFrames(*a, 3840, 2160, 40);
        const double hd = steadyFrames(*a, 1920, 1080, 40);
        const double c4 = chain(*a, 3840, 2160, 20);
        const double chd = chain(*a, 1920, 1080, 20);
        a->trim();
        double first = 0, again = 0;
        std::size_t kept = 0, trimmed = 0;
        cacheCycle(*a, first, again, kept, trimmed);
        std::printf("%-10s %9.2f %9.2f %9.2f %9.2f %9.1f %9.1f %8zu %8zu\n", a->name(), k4, hd, c4, chd, first, again,
                    kept, trimmed);
    }
    std::printf("\n4K/1080p: grade into a new image per frame, previous result released. chain: five grade nodes,\n"
                "intermediates released. cache: fill eleven 4K RGBA frames (1.5 GB), release, fill again; keptMB =\n"
                "memory footprint the allocator keeps after the release (as Activity Monitor\n"
                "shows it), trimMB = after trim() and the system allocator's pressure relief.\n");
    return 0;
}
