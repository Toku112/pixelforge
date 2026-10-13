#include "support/exr/ExrFixture.h"

#include <Imath/ImathBox.h>
#include <Imath/half.h>
#include <OpenEXR/ImfChannelList.h>
#include <OpenEXR/ImfCompression.h>
#include <OpenEXR/ImfDeepFrameBuffer.h>
#include <OpenEXR/ImfDeepScanLineOutputPart.h>
#include <OpenEXR/ImfFrameBuffer.h>
#include <OpenEXR/ImfHeader.h>
#include <OpenEXR/ImfMultiPartOutputFile.h>
#include <OpenEXR/ImfMultiView.h>
#include <OpenEXR/ImfOutputPart.h>
#include <OpenEXR/ImfPartType.h>
#include <OpenEXR/ImfStandardAttributes.h>
#include <OpenEXR/ImfTileDescription.h>
#include <OpenEXR/ImfTiledOutputPart.h>

#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <exception>
#include <fstream>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <utility>

namespace pf::testing {
namespace {

std::uint32_t nameSeed(std::string_view name) {
    std::uint32_t hash = 2166136261U; // FNV-1a
    for (const char c : name) {
        hash = (hash ^ static_cast<unsigned char>(c)) * 16777619U;
    }
    return hash;
}

std::uint32_t mix(std::uint32_t value) {
    value ^= value >> 16U;
    value *= 0x7FEB352DU;
    value ^= value >> 15U;
    value *= 0x846CA68BU;
    value ^= value >> 16U;
    return value;
}

std::uint32_t pixelHash(std::string_view name, int x, int y) {
    return mix(nameSeed(name) ^ mix(static_cast<std::uint32_t>(x) * 0x9E3779B1U) ^
               mix(static_cast<std::uint32_t>(y) * 0x85EBCA77U));
}

std::uint32_t uintValue(std::string_view name, int x, int y) {
    return pixelHash(name, x, y);
}

// The value before it is stored in the channel's type.
float floatValue(const ExrChannelSpec& channel, int x, int y) {
    if (channel.pattern == ExrPattern::IdBits) {
        std::uint32_t bits = pixelHash(channel.name, x, y);
        const std::uint32_t exponent = (bits >> 23U) & 0xFFU;
        if (exponent == 0 || exponent == 0xFF) {
            bits ^= 0x40000000U; // a normal, finite float
        }
        return std::bit_cast<float>(bits);
    }
    if (channel.pattern == ExrPattern::ValuesAndSpecials) {
        switch (((x + (3 * y)) % 17 + 17) % 17) {
        case 0:
            return std::numeric_limits<float>::quiet_NaN();
        case 5:
            return std::numeric_limits<float>::infinity();
        case 9:
            return -std::numeric_limits<float>::infinity();
        default:
            break;
        }
    }
    const double phase = static_cast<double>(nameSeed(channel.name) % 997U) / 997.0;
    if (channel.pattern == ExrPattern::Smooth) {
        const double gradient = (0.05 + (0.02 * x)) * (0.7 + (0.3 * std::sin((0.11 * y) + (phase * 6.283))));
        const double dx = x - 20.0 - (10.0 * phase);
        const double dy = y - 15.0;
        return static_cast<float>(gradient + (40.0 * std::exp(-((dx * dx) + (dy * dy)) / 18.0)));
    }
    const double t = (x * 0.173) + (y * 0.291) + (phase * 6.283);
    const int scale = ((((x + y + static_cast<int>(nameSeed(channel.name) % 11U)) % 11) + 11) % 11) - 5;
    return static_cast<float>(((3.0 * std::sin(t)) + std::cos(t * 0.37)) * std::exp2(scale));
}

Imf::PixelType pixelType(ExrSample type) {
    switch (type) {
    case ExrSample::UInt:
        return Imf::UINT;
    case ExrSample::Half:
        return Imf::HALF;
    case ExrSample::Float:
        break;
    }
    return Imf::FLOAT;
}

std::size_t sampleBytes(ExrSample type) {
    return type == ExrSample::Half ? 2 : 4;
}

Imath::Box2i toBox(const image::Rect& rect) {
    return {Imath::V2i(rect.x0, rect.y0), Imath::V2i(rect.x1 - 1, rect.y1 - 1)};
}

// One channel's samples over a window, at the channel's sampling, stored in its type.
struct Plane {
    std::vector<std::byte> bytes;
};

Plane makePlane(const ExrChannelSpec& channel, const image::Rect& window) {
    const int width = window.width() / channel.xSampling;
    const int height = window.height() / channel.ySampling;
    const std::size_t size = sampleBytes(channel.type);
    Plane plane{std::vector<std::byte>(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * size)};
    std::byte* out = plane.bytes.data();
    for (int j = 0; j < height; ++j) {
        for (int i = 0; i < width; ++i) {
            const int x = window.x0 + (i * channel.xSampling);
            const int y = window.y0 + (j * channel.ySampling);
            if (channel.type == ExrSample::UInt) {
                const std::uint32_t value = uintValue(channel.name, x, y);
                std::memcpy(out, &value, size);
            } else if (channel.type == ExrSample::Half) {
                const Imath::half value(floatValue(channel, x, y));
                const std::uint16_t bits = value.bits();
                std::memcpy(out, &bits, size);
            } else {
                const float value = floatValue(channel, x, y);
                std::memcpy(out, &value, size);
            }
            out += size;
        }
    }
    return plane;
}

Imf::FrameBuffer frameBuffer(const ExrPartSpec& spec, const image::Rect& window, std::vector<Plane>& planes) {
    Imf::FrameBuffer buffer;
    planes.clear();
    planes.reserve(spec.channels.size());
    for (const ExrChannelSpec& channel : spec.channels) {
        planes.push_back(makePlane(channel, window));
        const std::size_t size = sampleBytes(channel.type);
        const std::size_t rowBytes = size * static_cast<std::size_t>(window.width() / channel.xSampling);
        buffer.insert(channel.name, Imf::Slice::Make(pixelType(channel.type), planes.back().bytes.data(), toBox(window),
                                                     size, rowBytes, channel.xSampling, channel.ySampling));
    }
    return buffer;
}

Imf::LineOrder lineOrderOf(ExrLineOrder order) {
    switch (order) {
    case ExrLineOrder::DecreasingY:
        return Imf::DECREASING_Y;
    case ExrLineOrder::RandomY:
        return Imf::RANDOM_Y;
    case ExrLineOrder::IncreasingY:
        break;
    }
    return Imf::INCREASING_Y;
}

Imf::LevelMode levelModeOf(ExrLevels levels) {
    switch (levels) {
    case ExrLevels::Mipmap:
        return Imf::MIPMAP_LEVELS;
    case ExrLevels::Ripmap:
        return Imf::RIPMAP_LEVELS;
    case ExrLevels::One:
        break;
    }
    return Imf::ONE_LEVEL;
}

Imf::Header makeHeader(const ExrPartSpec& spec, bool multiPart) {
    Imf::Header header(toBox(spec.displayWindow), toBox(spec.dataWindow));
    header.compression() = static_cast<Imf::Compression>(spec.compression);
    header.lineOrder() = lineOrderOf(spec.lineOrder);
    if (!spec.name.empty() || multiPart) {
        header.setName(spec.name);
    }
    if (!spec.view.empty()) {
        header.setView(spec.view);
    }
    if (!spec.multiView.empty()) {
        Imf::addMultiView(header, Imf::StringVector(spec.multiView.begin(), spec.multiView.end()));
    }
    for (const ExrChannelSpec& channel : spec.channels) {
        header.channels().insert(channel.name,
                                 Imf::Channel(pixelType(channel.type), channel.xSampling, channel.ySampling));
    }
    switch (spec.storage) {
    case ExrStorage::Scanline:
        header.setType(Imf::SCANLINEIMAGE);
        break;
    case ExrStorage::Tiled: {
        header.setType(Imf::TILEDIMAGE);
        header.setTileDescription(Imf::TileDescription(
            static_cast<unsigned>(spec.tileWidth), static_cast<unsigned>(spec.tileHeight), levelModeOf(spec.levels)));
        break;
    }
    case ExrStorage::DeepScanline:
        header.setType(Imf::DEEPSCANLINE);
        break;
    }
    if (spec.decorate) {
        spec.decorate(header);
    }
    return header;
}

void writeScanline(Imf::MultiPartOutputFile& file, int index, const ExrPartSpec& spec) {
    Imf::OutputPart part(file, index);
    std::vector<Plane> planes;
    part.setFrameBuffer(frameBuffer(spec, spec.dataWindow, planes));
    part.writePixels(spec.dataWindow.height());
}

void writeTiled(Imf::MultiPartOutputFile& file, int index, const ExrPartSpec& spec) {
    Imf::TiledOutputPart part(file, index);
    const auto writeLevel = [&](int lx, int ly) {
        const Imath::Box2i box = part.dataWindowForLevel(lx, ly);
        const image::Rect window{.x0 = box.min.x, .y0 = box.min.y, .x1 = box.max.x + 1, .y1 = box.max.y + 1};
        std::vector<Plane> planes;
        part.setFrameBuffer(frameBuffer(spec, window, planes));
        std::vector<std::pair<int, int>> tiles;
        for (int ty = 0; ty < part.numYTiles(ly); ++ty) {
            for (int tx = 0; tx < part.numXTiles(lx); ++tx) {
                tiles.emplace_back(tx, ty);
            }
        }
        if (spec.lineOrder == ExrLineOrder::RandomY) {
            std::uint32_t state = 12345;
            for (std::size_t i = tiles.size(); i > 1; --i) { // a fixed shuffle
                state = mix(state + 1);
                std::swap(tiles[i - 1], tiles[state % i]);
            }
        }
        for (const auto& [tx, ty] : tiles) {
            part.writeTile(tx, ty, lx, ly);
        }
    };
    if (spec.levels == ExrLevels::Ripmap) {
        for (int ly = 0; ly < part.numYLevels(); ++ly) {
            for (int lx = 0; lx < part.numXLevels(); ++lx) {
                writeLevel(lx, ly);
            }
        }
    } else {
        for (int level = 0; level < part.numLevels(); ++level) {
            writeLevel(level, level);
        }
    }
}

// Deep data: 0, 1 or 2 samples per pixel, each channel's samples following the pattern.
void writeDeep(Imf::MultiPartOutputFile& file, int index, const ExrPartSpec& spec) {
    Imf::DeepScanLineOutputPart part(file, index);
    const image::Rect& window = spec.dataWindow;
    const auto pixels = static_cast<std::size_t>(window.area());
    std::vector<unsigned> counts(pixels);
    for (int y = window.y0; y < window.y1; ++y) {
        for (int x = window.x0; x < window.x1; ++x) {
            counts[(static_cast<std::size_t>(y - window.y0) * static_cast<std::size_t>(window.width())) +
                   static_cast<std::size_t>(x - window.x0)] = static_cast<unsigned>(((x + y) % 3 + 3) % 3);
        }
    }
    std::vector<std::vector<float>> samples(spec.channels.size(), std::vector<float>(pixels * 2));
    std::vector<std::vector<char*>> pointers(spec.channels.size(), std::vector<char*>(pixels));
    Imf::DeepFrameBuffer buffer;
    buffer.insertSampleCountSlice(Imf::Slice::Make(Imf::UINT, counts.data(), toBox(window), sizeof(unsigned),
                                                   sizeof(unsigned) * static_cast<std::size_t>(window.width())));
    for (std::size_t c = 0; c < spec.channels.size(); ++c) {
        for (std::size_t i = 0; i < pixels; ++i) {
            samples[c][2 * i] = 0.25F * static_cast<float>(i % 7);
            samples[c][(2 * i) + 1] = 0.5F;
            pointers[c][i] = reinterpret_cast<char*>(&samples[c][2 * i]); // NOLINT(*-reinterpret-cast)
        }
        // Deep samples are written as float here; the channel is declared float in the spec. The slice's base is
        // where pixel (0, 0)'s pointer would be.
        const std::ptrdiff_t origin =
            (static_cast<std::ptrdiff_t>(window.y0) * window.width()) + static_cast<std::ptrdiff_t>(window.x0);
        char* base = reinterpret_cast<char*>(pointers[c].data()) - // NOLINT(*-reinterpret-cast): OpenEXR's slice
                     (origin * static_cast<std::ptrdiff_t>(sizeof(char*)));
        buffer.insert(spec.channels[c].name,
                      Imf::DeepSlice(Imf::FLOAT, base, sizeof(char*),
                                     sizeof(char*) * static_cast<std::size_t>(window.width()), sizeof(float)));
    }
    part.setFrameBuffer(buffer);
    part.writePixels(window.height());
}

} // namespace

void writeExrFixture(const std::filesystem::path& file, std::span<const ExrPartSpec> parts) {
    if (file.has_parent_path()) {
        std::filesystem::create_directories(file.parent_path());
    }
    const bool multiPart = parts.size() > 1;
    std::vector<Imf::Header> headers;
    headers.reserve(parts.size());
    for (const ExrPartSpec& part : parts) {
        headers.push_back(makeHeader(part, multiPart));
    }
    const std::u8string name = file.u8string();
    Imf::MultiPartOutputFile out(std::string(name.begin(), name.end()).c_str(), headers.data(),
                                 static_cast<int>(headers.size()));
    for (std::size_t i = 0; i < parts.size(); ++i) {
        switch (parts[i].storage) {
        case ExrStorage::Scanline:
            writeScanline(out, static_cast<int>(i), parts[i]);
            break;
        case ExrStorage::Tiled:
            writeTiled(out, static_cast<int>(i), parts[i]);
            break;
        case ExrStorage::DeepScanline:
            writeDeep(out, static_cast<int>(i), parts[i]);
            break;
        }
    }
}

void writeExrFixture(const std::filesystem::path& file, const ExrPartSpec& part) {
    writeExrFixture(file, std::span<const ExrPartSpec>(&part, 1));
}

float exrFixtureValue(const ExrChannelSpec& channel, int x, int y) {
    switch (channel.type) {
    case ExrSample::UInt:
        return static_cast<float>(uintValue(channel.name, x, y));
    case ExrSample::Half:
        return static_cast<float>(Imath::half(floatValue(channel, x, y)));
    case ExrSample::Float:
        break;
    }
    return floatValue(channel, x, y);
}

namespace {

bool sameSample(float a, float b) {
    return std::bit_cast<std::uint32_t>(a) == std::bit_cast<std::uint32_t>(b) || (std::isnan(a) && std::isnan(b));
}

// Every sample of one channel over the image's data window, row by row (fast: no lookup per sample).
std::vector<float> samplesOf(const image::Image& image, std::size_t channel) {
    const image::Rect& data = image.dataWindow();
    std::vector<float> samples(static_cast<std::size_t>(data.area()));
    image.read(channel, data, samples, static_cast<std::size_t>(data.width()));
    return samples;
}

} // namespace

::testing::AssertionResult matchesFixture(const image::Image& image, std::string_view name,
                                          const ExrChannelSpec& channel, const image::Rect& stored) {
    if (!image.hasChannel(name)) {
        return ::testing::AssertionFailure() << "the image has no channel " << name;
    }
    const image::Rect& data = image.dataWindow();
    const std::vector<float> samples = samplesOf(image, image.channelIndex(name));
    std::size_t wrong = 0;
    std::ostringstream first;
    std::size_t i = 0;
    for (int y = data.y0; y < data.y1; ++y) {
        for (int x = data.x0; x < data.x1; ++x, ++i) {
            const float expected = stored.contains(x, y) ? exrFixtureValue(channel, x, y) : 0.0F;
            if (!sameSample(samples[i], expected) && wrong++ == 0) {
                first << " first at (" << x << ", " << y << "): " << samples[i] << " instead of " << expected;
            }
        }
    }
    if (wrong > 0) {
        return ::testing::AssertionFailure() << name << ": " << wrong << " wrong samples;" << first.str();
    }
    return ::testing::AssertionSuccess();
}

::testing::AssertionResult sameImage(const image::Image& actual, const image::Image& expected) {
    if (actual.displayWindow() != expected.displayWindow() || actual.dataWindow() != expected.dataWindow()) {
        return ::testing::AssertionFailure() << "windows differ: " << image::toString(actual.dataWindow())
                                             << " instead of " << image::toString(expected.dataWindow());
    }
    if (actual.channels() != expected.channels()) {
        return ::testing::AssertionFailure() << "channels differ";
    }
    const image::Rect& data = actual.dataWindow();
    for (std::size_t c = 0; c < actual.channelCount(); ++c) {
        const std::vector<float> a = samplesOf(actual, c);
        const std::vector<float> e = samplesOf(expected, c);
        for (std::size_t i = 0; i < a.size(); ++i) {
            if (!sameSample(a[i], e[i])) {
                const auto width = static_cast<std::size_t>(data.width());
                return ::testing::AssertionFailure()
                       << actual.channels()[c] << " differs at (" << data.x0 + static_cast<int>(i % width) << ", "
                       << data.y0 + static_cast<int>(i / width) << "): " << a[i] << " instead of " << e[i];
            }
        }
    }
    return ::testing::AssertionSuccess();
}

io::ParallelFor testThreads(int threads) {
    return io::ParallelFor([threads](std::size_t count, const io::ParallelFor::Body& body) {
        std::atomic<std::size_t> next{0};
        std::mutex mutex;
        std::exception_ptr failure;
        std::vector<std::thread> workers;
        workers.reserve(static_cast<std::size_t>(threads));
        for (int t = 0; t < threads; ++t) {
            workers.emplace_back([&] {
                for (std::size_t i = next++; i < count; i = next++) {
                    try {
                        body(i);
                    } catch (...) {
                        const std::scoped_lock lock(mutex);
                        if (!failure) {
                            failure = std::current_exception();
                        }
                    }
                }
            });
        }
        for (std::thread& worker : workers) {
            worker.join();
        }
        if (failure) {
            std::rethrow_exception(failure);
        }
    });
}

std::vector<std::uint8_t> readBytes(const std::filesystem::path& file) {
    std::ifstream in(file, std::ios::binary);
    std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (!in.good() && !in.eof()) {
        throw std::runtime_error("cannot read the test file " + file.string());
    }
    return bytes;
}

void writeBytes(const std::filesystem::path& file, std::span<const std::uint8_t> bytes) {
    std::ofstream out(file, std::ios::binary | std::ios::trunc);
    out.write(reinterpret_cast<const char*>(bytes.data()), // NOLINT(*-reinterpret-cast): bytes as chars
              static_cast<std::streamsize>(bytes.size()));
    if (!out) {
        throw std::runtime_error("cannot write the test file " + file.string());
    }
}

} // namespace pf::testing
