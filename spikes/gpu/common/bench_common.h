// Shared helpers for the GPU-layer spike: test images, CPU references, timing, result printing.
// Both backends use exactly the same images, kernels and checks so their numbers compare fairly.
#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace spike {

constexpr int k8kW = 7680, k8kH = 4320;   // "8K" UHD
constexpr int k4kW = 3840, k4kH = 2160;   // "4K" UHD
constexpr int kTile = 4096, kTilesPerSide = 4;  // 16384² as 16 tiles
constexpr int kBlurRadius = 64;           // 129 taps
constexpr int kGradeRepeats = 20;
constexpr int kBlurRepeats = 10;
constexpr int kTransferRepeats = 5;

inline double nowMs()
{
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

inline double median(std::vector<double> v)
{
    std::sort(v.begin(), v.end());
    return v.empty() ? 0.0 : v[v.size() / 2];
}

inline double gbPerSec(double bytes, double ms) { return ms > 0 ? bytes / (ms * 1e6) : 0.0; }

inline float hashNoise(uint32_t x)  // deterministic white noise in [-1, 1)
{
    x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
    return float(x >> 8) / float(1u << 23) - 1.0f;
}

// Deterministic scene-linear RGBA test image with HDR values up to ~8, some negatives and render-like noise
// (a perfectly smooth image would be squeezed by Apple GPUs' lossless texture compression and flatter the numbers).
inline std::vector<float> makeTestImage(int w, int h)
{
    std::vector<float> px(size_t(w) * size_t(h) * 4);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const float u = float(x) / float(w), v = float(y) / float(h);
            const uint32_t i = uint32_t(y) * uint32_t(w) + uint32_t(x);
            float* p = &px[size_t(i) * 4];
            p[0] = 8.0f * u * u * (1.0f + 0.1f * hashNoise(i * 3u));
            p[1] = 0.5f + 0.5f * std::sin(40.0f * u + 25.0f * v) + 0.05f * hashNoise(i * 3u + 1u);
            p[2] = v - 0.05f + 0.05f * hashNoise(i * 3u + 2u);  // some negative values at the top rows
            p[3] = 1.0f;
        }
    }
    return px;
}

// Time per iteration of a GPU workload without the fixed cost of a frame: run(n) records n iterations in one
// frame and waits; result = (best run(N) − best run(1)) / (N − 1), best of 3.
template <typename Run>
double perIterationMs(Run&& run, int n)
{
    run(1);  // warm-up (pipeline creation, first-use costs)
    double one = 1e30, many = 1e30;
    for (int t = 0; t < 3; ++t) {
        one = std::min(one, run(1));
        many = std::min(many, run(n));
    }
    return (many - one) / double(n - 1);
}

// ---- Grade kernel (B4): out = sign(c)·|c|^gamma, c = M·(in·exposure)·gain + offset; alpha untouched.
struct GradeParams {
    float m[3][4] = {{0.9f, 0.08f, 0.02f, 0}, {0.05f, 0.9f, 0.05f, 0}, {0.02f, 0.08f, 0.9f, 0}};
    float exposure = 1.5f, gain = 1.1f, offset = 0.01f, gamma = 0.9f;  // the 4th vec4 of the uniform block
};

inline std::array<float, 4> cpuGrade(const float* in, const GradeParams& g)
{
    std::array<float, 4> out{};
    for (int r = 0; r < 3; ++r) {
        float c = 0;
        for (int k = 0; k < 3; ++k) c += g.m[r][k] * in[k] * g.exposure;
        c = c * g.gain + g.offset;
        out[size_t(r)] = std::copysign(std::pow(std::fabs(c), g.gamma), c);
    }
    out[3] = in[3];
    return out;
}

// ---- Gaussian weights (B5), normalised, sigma = radius / 3.
inline std::vector<float> gaussianWeights(int radius)
{
    std::vector<float> w(size_t(2 * radius + 1));
    const double sigma = radius / 3.0;
    double sum = 0;
    for (int i = -radius; i <= radius; ++i) {
        const double v = std::exp(-0.5 * (i * i) / (sigma * sigma));
        w[size_t(i + radius)] = float(v);
        sum += v;
    }
    for (float& v : w) v = float(v / sum);
    return w;
}

// Horizontal-then-vertical blur of one output pixel on the CPU, clamp-to-edge, for spot checks.
inline std::array<float, 4> cpuBlurHV(const std::vector<float>& img, int w, int h, int x, int y,
                                      const std::vector<float>& wts, int radius)
{
    std::array<float, 4> acc{};
    for (int j = -radius; j <= radius; ++j) {
        const int yy = std::clamp(y + j, 0, h - 1);
        std::array<float, 4> row{};
        for (int i = -radius; i <= radius; ++i) {
            const int xx = std::clamp(x + i, 0, w - 1);
            const float* p = &img[(size_t(yy) * size_t(w) + size_t(xx)) * 4];
            for (int c = 0; c < 4; ++c) row[size_t(c)] += wts[size_t(i + radius)] * p[c];
        }
        for (int c = 0; c < 4; ++c) acc[size_t(c)] += wts[size_t(j + radius)] * row[size_t(c)];
    }
    return acc;
}

inline float maxAbsDiff(const float* a, const float* b, int n)
{
    float m = 0;
    for (int i = 0; i < n; ++i) m = std::max(m, std::fabs(a[i] - b[i]));
    return m;
}

// Spot-check positions used by both backends.
inline std::vector<std::pair<int, int>> checkPoints(int w, int h)
{
    return {{0, 0}, {w - 1, h - 1}, {w / 2, h / 2}, {17, h - 3}, {w - 5, 11}, {w / 3, 2 * h / 3}};
}

inline void report(const char* id, const std::string& what, const std::string& value)
{
    std::printf("%-4s %-58s %s\n", id, what.c_str(), value.c_str());
    std::fflush(stdout);
}

inline std::string fmt(const char* f, double a, double b = 0, double c = 0)
{
    char buf[256];
    std::snprintf(buf, sizeof buf, f, a, b, c);
    return buf;
}

}  // namespace spike
