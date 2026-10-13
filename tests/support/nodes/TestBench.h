#pragma once

// Test support for nodes: a small image file format of our own (".pftest", tests only), a temporary folder, and a
// bench holding the format registry (the built-in formats and .pftest), the built-in node types, a memory budget and
// an evaluator.

#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"
#include "core/image/ChannelSet.h"
#include "core/image/Image.h"
#include "engine/Evaluator.h"
#include "engine/MemoryBudget.h"
#include "io/ImageReader.h"
#include "support/golden/GoldenImage.h"

#include <atomic>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>

namespace pf::testing {

// Writes `image` as a .pftest file: its windows, channel names and every sample of the data window, as float32.
void writeTestImage(const std::filesystem::path& file, const image::Image& image);

// The .pftest format. Its readers count what they do, so tests can check that a Read node opened and read only
// what it needed.
struct TestFormatCounters {
    std::atomic<int> opens{0};
    std::atomic<int> reads{0};
    std::atomic<int> channelsRead{0};
};
[[nodiscard]] io::ImageFormat testImageFormat(std::shared_ptr<TestFormatCounters> counters);

// A folder under the system's temporary folder, deleted with everything in it when the object goes.
class TemporaryFolder {
public:
    TemporaryFolder();
    ~TemporaryFolder();
    TemporaryFolder(const TemporaryFolder&) = delete;
    TemporaryFolder(TemporaryFolder&&) = delete;
    TemporaryFolder& operator=(const TemporaryFolder&) = delete;
    TemporaryFolder& operator=(TemporaryFolder&&) = delete;

    [[nodiscard]] const std::filesystem::path& path() const { return m_path; }
    // `name` (UTF-8) inside the folder.
    [[nodiscard]] std::filesystem::path file(std::string_view name) const;

private:
    std::filesystem::path m_path;
};

struct NodeBench {
    NodeBench();

    std::shared_ptr<TestFormatCounters> counters = std::make_shared<TestFormatCounters>();
    std::shared_ptr<io::FormatRegistry> formats = std::make_shared<io::FormatRegistry>();
    graph::NodeRegistry types;
    engine::MemoryBudget budget{std::size_t{1} << 40};
    engine::Evaluator evaluator{budget};
    TemporaryFolder folder;
    graph::Graph graph;

    // Adds a node of a built-in type.
    graph::NodeId add(std::string_view typeId);
    // Writes `image` to `name` in the folder and adds a Read node for it.
    graph::NodeId read(const image::Image& image, std::string_view name = "input.pftest");
    // Everything the node shows at `frame`.
    [[nodiscard]] image::Image evaluate(graph::NodeId node, const image::ChannelSet& channels, double frame = 1.0,
                                        int proxyScale = 1);
};

// The engine's image as the golden harness's image (same windows, channels and samples).
[[nodiscard]] golden::Image toGolden(const image::Image& image);

} // namespace pf::testing
