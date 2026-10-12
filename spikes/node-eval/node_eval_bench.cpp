// Timing of node graph evaluation (PLAN Part C item 7, CLAUDE.md §5 performance: a live parameter change must
// preview in under 100 ms at 1080p). Throw-away measurement, never linked into the app.
//
// A render-like frame (RGBA + 3 colour passes + depth = 14 channels) sits in memory behind a fake image format, so
// file reading does not disturb the numbers (that is measured with EXR in item 9). Each case changes a parameter
// and evaluates the viewer's request — the RGBA layer over the whole frame — the way the viewer will.

#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"
#include "core/image/Image.h"
#include "engine/Engine.h"
#include "io/ImageReader.h"
#include "nodes/Builtins.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

namespace {

using namespace pf;
using Clock = std::chrono::steady_clock;

image::Image renderLikeFrame(int width, int height) {
    const image::Rect frame{.x0 = 0, .y0 = 0, .x1 = width, .y1 = height};
    image::Image image(frame, frame,
                       {"R", "G", "B", "A", "diffuse.R", "diffuse.G", "diffuse.B", "glossy.R", "glossy.G", "glossy.B",
                        "emission.R", "emission.G", "emission.B", "depth.Z"});
    std::vector<float> row(static_cast<std::size_t>(width));
    for (std::size_t c = 0; c < image.channelCount(); ++c) {
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                row[static_cast<std::size_t>(x)] = static_cast<float>(c + 1) * 0.01F * static_cast<float>(x % 97) +
                                                   0.001F * static_cast<float>(y % 89);
            }
            image.write(c, {.x0 = 0, .y0 = y, .x1 = width, .y1 = y + 1}, row, row.size());
        }
    }
    return image;
}

class MemoryReader final : public io::ImageReader {
public:
    explicit MemoryReader(image::Image image)
        : m_image(std::move(image)),
          m_info{.displayWindow = m_image.displayWindow(),
                 .dataWindow = m_image.dataWindow(),
                 .channels = m_image.channels()} {}
    [[nodiscard]] const io::ImageFileInfo& info() const override { return m_info; }
    [[nodiscard]] image::Image read(const image::ChannelSet& channels, const image::Rect& region) const override {
        const image::Rect window = image::intersect(region, m_image.dataWindow());
        const image::ChannelSet wanted = image::intersect(channels, m_image.channels());
        image::Image result(m_image.displayWindow(), window, wanted);
        const image::Rect tiles = result.tileRange();
        for (const std::string& channel : wanted) {
            for (int ty = tiles.y0; ty < tiles.y1; ++ty) {
                for (int tx = tiles.x0; tx < tiles.x1; ++tx) {
                    result.copyTile(result.channelIndex(channel), {.x = tx, .y = ty}, m_image,
                                    m_image.channelIndex(channel));
                }
            }
        }
        return result;
    }

private:
    image::Image m_image;
    io::ImageFileInfo m_info;
};

struct Stats {
    double median = 0.0;
    double worst = 0.0;
};

template <class Step>
Stats measure(int runs, const Step& step) {
    std::vector<double> ms;
    for (int i = 0; i < runs; ++i) {
        const auto start = Clock::now();
        step(i);
        ms.push_back(std::chrono::duration<double, std::milli>(Clock::now() - start).count());
    }
    std::ranges::sort(ms);
    return {.median = ms[ms.size() / 2], .worst = ms.back()};
}

void report(const char* what, const Stats& stats) {
    std::printf("  %-58s median %7.2f ms   worst %7.2f ms\n", what, stats.median, stats.worst);
}

void run(int width, int height, engine::Engine& engine) {
    std::printf("%d x %d, 14 channels, viewer asks for RGBA\n", width, height);
    auto formats = std::make_shared<io::FormatRegistry>();
    // The registry checks that the file exists, so give it a real (empty) file; the reader ignores its contents.
    const std::filesystem::path file =
        std::filesystem::temp_directory_path() / ("pf_node_eval_" + std::to_string(width) + ".mem");
    std::ofstream(file) << "";
    const std::string realPath = io::pathToUtf8(file);
    auto frame = std::make_shared<image::Image>(renderLikeFrame(width, height));
    formats->add({.name = "Memory",
                  .extensions = {"mem"},
                  .open = [frame](const std::filesystem::path&) { return std::make_unique<MemoryReader>(*frame); }});
    graph::NodeRegistry types;
    nodes::registerBuiltinNodes(types, formats);

    graph::Graph g;
    const graph::NodeId read = g.addNode(types.find("Read"));
    g.setValue(read, "file", realPath);
    const graph::NodeId shuffle = g.addNode(types.find("Shuffle"));
    g.connect(read, shuffle, 0);
    g.setValue(shuffle, "inLayer", std::string("diffuse"));
    std::vector<graph::NodeId> chain;
    graph::NodeId previous = shuffle;
    for (int i = 0; i < 5; ++i) {
        const graph::NodeId exposure = g.addNode(types.find("Exposure"));
        g.connect(previous, exposure, 0);
        g.setValue(exposure, "exposure", 0.1 * (i + 1));
        g.setValue(exposure, "gamma", 1.1);
        chain.push_back(exposure);
        previous = exposure;
    }
    const graph::NodeId viewer = g.addNode(types.find("Viewer"));
    g.connect(previous, viewer, 0);

    engine::Evaluator& evaluator = engine.evaluator();
    const image::ChannelSet rgba{"R", "G", "B", "A"};
    const auto view = [&](const graph::Graph& graph) {
        return evaluator.evaluate(graph, {.node = viewer, .region = {.x0 = 0, .y0 = 0, .x1 = width, .y1 = height},
                                          .channels = rgba});
    };

    report("first view (read + shuffle + 5 exposures, nothing cached)", measure(1, [&](int) { (void)view(g); }));
    report("same view again (all from the cache)", measure(20, [&](int) { (void)view(g); }));
    report("drag the last Exposure's slider (1 node recomputed)", measure(50, [&](int i) {
               g.setValue(chain.back(), "exposure", 0.5 + (0.01 * i));
               (void)view(g);
           }));
    report("drag the first Exposure's slider (5 nodes recomputed)", measure(50, [&](int i) {
               g.setValue(chain.front(), "offset", 0.001 * i);
               (void)view(g);
           }));
    report("same, at proxy 2", measure(50, [&](int i) {
               g.setValue(chain.front(), "offset", 0.2 + (0.001 * i));
               (void)evaluator.evaluate(g, {.node = viewer, .region = {.x0 = 0, .y0 = 0, .x1 = width, .y1 = height},
                                            .channels = rgba, .proxyScale = 2});
           }));
    report("alternate two passes + move last slider (upstream cached)", measure(20, [&](int i) {
               g.setValue(shuffle, "inLayer", std::string(i % 2 == 0 ? "glossy" : "emission"));
               g.setValue(chain.back(), "exposure", 3.0 + (0.01 * i)); // a new value each time: no cache hit
               (void)view(g);
           }));
    const engine::EngineStats stats = engine.stats();
    std::printf("  memory: %.0f MB in tiles, %zu cached tiles (%.0f MB), budget %.1f GB\n",
                static_cast<double>(stats.tiles.bytesInUse) / 1048576.0, stats.evaluation.tiles.entries,
                static_cast<double>(stats.evaluation.tiles.bytes) / 1048576.0,
                static_cast<double>(stats.memory.limit) / 1073741824.0);
    std::filesystem::remove(file);
}

} // namespace

int main() {
    pf::engine::Engine engine;
    run(1920, 1080, engine);
    engine.evaluator().clear();
    run(3840, 2160, engine);
    return 0;
}
