// EXR reading speed on real renders (PLAN Part C item 9): our reader (io/exr, on OpenEXRCore) on one thread and on
// all cores through oneTBB, against OpenEXR's own high-level reader with its thread pool. Throw-away code.
//
// Usage: exr_read_bench <file.exr> [more frames…]

#include "core/image/Image.h"
#include "io/ImageReader.h"
#include "io/exr/ExrReader.h"

#include <OpenEXR/ImfChannelList.h>
#include <OpenEXR/ImfFrameBuffer.h>
#include <OpenEXR/ImfHeader.h>
#include <OpenEXR/ImfInputPart.h>
#include <OpenEXR/ImfMultiPartInputFile.h>
#include <OpenEXR/ImfThreading.h>
#include <tbb/parallel_for.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;

double ms(Clock::duration d) {
    return std::chrono::duration<double, std::milli>(d).count();
}

// The best of `runs` timings of `work` (first run included: files are in the OS cache after the first frame).
double best(int runs, const std::function<void()>& work) {
    double fastest = 1e30;
    for (int i = 0; i < runs; ++i) {
        const auto start = Clock::now();
        work();
        fastest = std::min(fastest, ms(Clock::now() - start));
    }
    return fastest;
}

const pf::io::ParallelFor tbbLoop([](std::size_t count, const pf::io::ParallelFor::Body& body) {
    tbb::parallel_for(std::size_t{0}, count, [&](std::size_t i) { body(i); });
});

pf::image::ChannelSet layer(const pf::io::ImageFileInfo& info, const std::string& name) {
    return info.channels.inLayer(name);
}

// OpenEXR's own reader: the given channels of every part that has them, as float.
void openExrRead(const std::string& file, const pf::image::ChannelSet& channels) {
    Imf::MultiPartInputFile input(file.c_str());
    for (int p = 0; p < input.parts(); ++p) {
        const Imf::Header& header = input.header(p);
        const Imath::Box2i dw = header.dataWindow();
        const std::size_t width = static_cast<std::size_t>(dw.max.x - dw.min.x + 1);
        const std::size_t height = static_cast<std::size_t>(dw.max.y - dw.min.y + 1);
        std::vector<std::vector<float>> planes;
        Imf::FrameBuffer buffer;
        for (auto it = header.channels().begin(); it != header.channels().end(); ++it) {
            if (!channels.contains(it.name())) {
                continue;
            }
            planes.emplace_back(width * height);
            buffer.insert(it.name(), Imf::Slice::Make(Imf::FLOAT, planes.back().data(), dw, sizeof(float),
                                                      sizeof(float) * width));
        }
        if (planes.empty()) {
            continue;
        }
        Imf::InputPart part(input, p);
        part.setFrameBuffer(buffer);
        part.readPixels(dw.min.y, dw.max.y);
    }
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: exr_read_bench <file.exr> [more frames]\n");
        return 1;
    }
    const unsigned cores = std::thread::hardware_concurrency();
    Imf::setGlobalThreadCount(static_cast<int>(cores));
    std::printf("cores: %u\n", cores);
    const std::string file = argv[1];
    const auto reader = pf::io::openExr(file);
    const pf::io::ImageFileInfo& info = reader->info();
    std::printf("%s: %d x %d, %zu parts, %zu channels\n", file.c_str(), info.displayWindow.width(),
                info.displayWindow.height(), info.metadata.size(), info.channels.size());

    std::printf("open (header only): %.3f ms\n", best(20, [&] { (void)pf::io::openExr(file); }));

    struct Case {
        const char* name;
        pf::image::ChannelSet channels;
    };
    const std::vector<Case> cases{{"beauty (Combined RGBA)", layer(info, "ViewLayer.Combined")},
                                  {"depth (one channel)", layer(info, "ViewLayer.Depth")},
                                  {"position (XYZ)", layer(info, "ViewLayer.Position")},
                                  {"everything", info.channels}};
    for (const Case& c : cases) {
        const double serial = best(5, [&] { (void)reader->read(c.channels, info.dataWindow, {}); });
        const double parallel = best(10, [&] { (void)reader->read(c.channels, info.dataWindow, tbbLoop); });
        const double reference = best(5, [&] { openExrRead(file, c.channels); });
        std::printf("%-24s ours 1 thread %7.2f ms | ours all cores %6.2f ms | OpenEXR C++ (%u threads) %7.2f ms\n",
                    c.name, serial, parallel, cores, reference);
    }

    // A sequence: open + read the beauty of every frame given, as playback-cache filling does.
    if (argc > 2) {
        const auto start = Clock::now();
        for (int i = 1; i < argc; ++i) {
            const auto frame = pf::io::openExr(argv[i]);
            (void)frame->read(layer(frame->info(), "ViewLayer.Combined"), frame->info().dataWindow, tbbLoop);
        }
        const double total = ms(Clock::now() - start);
        std::printf("sequence: %d frames, open + beauty, %.1f ms per frame (%.0f fps)\n", argc - 1,
                    total / (argc - 1), 1000.0 * (argc - 1) / total);
    }
    return 0;
}
