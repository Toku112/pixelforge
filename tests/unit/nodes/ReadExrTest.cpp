// The Read node with OpenEXR files (docs/specs/exr-reading.md): through the evaluator, decoding runs on the
// engine's threads; proxy scales average blocks of the decoded pixels; a file with nothing readable is an error
// that says why.

#include "core/graph/Evaluation.h"
#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "io/ImageReader.h"
#include "io/exr/ExrReader.h"
#include "support/exr/ExrFixture.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace pf::nodes {
namespace {

using image::Image;
using image::Rect;
using testing::ExrPartSpec;
using testing::ExrSample;

// A Cycles-like frame: two parts, overscan, DWAA colour and lossless depth.
std::vector<ExrPartSpec> cyclesLikeParts() {
    std::vector<ExrPartSpec> parts(2);
    for (ExrPartSpec& part : parts) {
        part.displayWindow = {.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 200};
        part.dataWindow = {.x0 = -5, .y0 = -3, .x1 = 305, .y1 = 203};
        part.compression = 8;
    }
    parts[0].name = "ViewLayer.Combined";
    parts[0].channels = {{.name = "ViewLayer.Combined.R"},
                         {.name = "ViewLayer.Combined.G"},
                         {.name = "ViewLayer.Combined.B"},
                         {.name = "ViewLayer.Combined.A"}};
    parts[1].name = "ViewLayer.Depth";
    parts[1].channels = {{.name = "ViewLayer.Depth.Z", .type = ExrSample::Float}};
    return parts;
}

TEST(ReadExr, ReadsAnExrThroughTheGraph) {
    testing::NodeBench bench;
    const std::vector<ExrPartSpec> parts = cyclesLikeParts();
    const std::filesystem::path file = bench.folder.file("render.0001.exr");
    testing::writeExrFixture(file, parts);
    const graph::NodeId read = bench.add("Read");
    bench.graph.setValue(read, "file", io::pathToUtf8(file));

    const graph::OutputInfo info = bench.evaluator.info(bench.graph, read, 1.0, 1);
    EXPECT_EQ(info.displayWindow, parts[0].displayWindow);
    EXPECT_EQ(info.dataWindow, parts[0].dataWindow);
    EXPECT_EQ(info.channels.size(), 5U);

    const std::unique_ptr<io::ImageReader> direct = io::openExr(file);
    const image::ChannelSet channels{"ViewLayer.Combined.G", "ViewLayer.Depth.Z"};
    const Image expected = direct->read(channels, info.dataWindow, {});
    EXPECT_TRUE(testing::sameImage(bench.evaluate(read, channels), expected));
    EXPECT_TRUE(testing::matchesFixture(bench.evaluate(read, {"ViewLayer.Depth.Z"}), "ViewLayer.Depth.Z",
                                        parts[1].channels[0], parts[1].dataWindow));

    // Proxy 2: each pixel is the mean of a 2 × 2 block of the full-resolution pixels (0 outside the data window).
    const Image proxy = bench.evaluate(read, {"ViewLayer.Depth.Z"}, 1.0, 2);
    EXPECT_EQ(proxy.dataWindow(), graph::scaleForProxy(info.dataWindow, 2));
    for (const auto& [x, y] : std::vector<std::pair<int, int>>{{0, 0}, {-3, -2}, {152, 101}, {76, 50}}) {
        double sum = 0.0;
        for (int j = 0; j < 2; ++j) {
            for (int i = 0; i < 2; ++i) {
                sum += static_cast<double>(expected.sample("ViewLayer.Depth.Z", (2 * x) + i, (2 * y) + j));
            }
        }
        EXPECT_FLOAT_EQ(proxy.sample("ViewLayer.Depth.Z", x, y), static_cast<float>(sum / 4.0)) << x << ", " << y;
    }
}

TEST(ReadExr, AFileOfOnlyDeepDataIsAnErrorThatSaysWhy) {
    testing::NodeBench bench;
    ExrPartSpec deep;
    deep.storage = testing::ExrStorage::DeepScanline;
    deep.compression = 2;
    deep.channels = {{.name = "Z", .type = ExrSample::Float}};
    const std::filesystem::path file = bench.folder.file("deep.exr");
    testing::writeExrFixture(file, deep);
    const graph::NodeId read = bench.add("Read");
    bench.graph.setValue(read, "file", io::pathToUtf8(file));
    try {
        (void)bench.evaluator.info(bench.graph, read, 1.0, 1);
        FAIL() << "a deep-only file must be an error";
    } catch (const graph::EvaluationError& error) {
        EXPECT_EQ(error.node(), read);
        const std::string message = error.what();
        EXPECT_NE(message.find("deep.exr"), std::string::npos) << message;
        EXPECT_NE(message.find("holds deep data, which is not read yet"), std::string::npos) << message;
    }
}

} // namespace
} // namespace pf::nodes
