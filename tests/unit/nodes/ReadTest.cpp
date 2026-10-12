// The Read node (nodes/read, docs/specs/node-graph.md §6), reading the tests' own .pftest files.

#include "core/graph/Evaluation.h"
#include "core/image/Image.h"
#include "io/ImageReader.h"
#include "nodes/read/ReadNode.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>

namespace pf::nodes {
namespace {

using image::ChannelSet;
using image::Image;
using image::Rect;

// A 600 × 300 frame with 6 pixels of overscan on the left; R is a ramp in x, Z a ramp in y.
Image rampImage(float scale = 1.0F) {
    const Rect display{.x0 = 0, .y0 = 0, .x1 = 600, .y1 = 300};
    const Rect data{.x0 = -6, .y0 = 0, .x1 = 600, .y1 = 300};
    Image image(display, data, {"R", "G", "Z"});
    for (int y = data.y0; y < data.y1; ++y) {
        for (int x = data.x0; x < data.x1; ++x) {
            image.setSample("R", x, y, scale * static_cast<float>(x));
            image.setSample("Z", x, y, static_cast<float>(y));
        }
    }
    image.fill(image.channelIndex("G"), data, 0.5F);
    return image;
}

TEST(Read, ReadsTheFile) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(rampImage());
    const graph::OutputInfo info = bench.evaluator.info(bench.graph, read, 1.0, 1);
    EXPECT_EQ(info.displayWindow, (Rect{.x0 = 0, .y0 = 0, .x1 = 600, .y1 = 300}));
    EXPECT_EQ(info.dataWindow, (Rect{.x0 = -6, .y0 = 0, .x1 = 600, .y1 = 300}));
    EXPECT_EQ(info.channels, (ChannelSet{"R", "G", "Z"}));

    const Image result = bench.evaluate(read, {"R", "Z"});
    EXPECT_EQ(result.sample("R", -6, 10), -6.0F);
    EXPECT_EQ(result.sample("R", 599, 10), 599.0F);
    EXPECT_EQ(result.sample("Z", 3, 299), 299.0F);
    EXPECT_EQ(bench.counters->channelsRead, 2); // G was not asked for
}

TEST(Read, ReadsOnlyWhatIsAskedAndCachesIt) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(rampImage());
    const Rect corner{.x0 = 0, .y0 = 0, .x1 = 10, .y1 = 10};
    (void)bench.evaluator.evaluate(bench.graph, {.node = read, .region = corner, .channels = {"G"}});
    EXPECT_EQ(bench.counters->reads, 1);
    EXPECT_EQ(bench.counters->channelsRead, 1);
    (void)bench.evaluator.evaluate(bench.graph, {.node = read, .region = corner, .channels = {"G"}});
    EXPECT_EQ(bench.counters->reads, 1); // from the cache
    EXPECT_EQ(bench.counters->opens, 1); // the open file is kept
}

TEST(Read, AnEmptyPathGivesNothing) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.add("Read");
    EXPECT_TRUE(bench.evaluate(read, {"R"}).channels().empty());
}

TEST(Read, FilesThatCannotBeOpenedAreErrorsNamingTheNode) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.add("Read");
    bench.graph.setValue(read, "file", io::pathToUtf8(bench.folder.file("missing.pftest")));
    try {
        (void)bench.evaluate(read, {"R"});
        FAIL() << "reading a missing file should fail";
    } catch (const graph::EvaluationError& error) {
        EXPECT_EQ(error.node(), read);
        const std::string message = error.what();
        EXPECT_EQ(message.rfind("Read1: cannot open ", 0), 0U) << message;
        EXPECT_NE(message.find("the file does not exist"), std::string::npos) << message;
    }

    const std::filesystem::path unknown = bench.folder.file("notes.txt");
    std::ofstream(unknown) << "not an image";
    bench.graph.setValue(read, "file", io::pathToUtf8(unknown));
    try {
        (void)bench.evaluate(read, {"R"});
        FAIL() << "reading a text file should fail";
    } catch (const graph::EvaluationError& error) {
        EXPECT_NE(std::string(error.what()).find("no image format reads .txt files"), std::string::npos);
    }
}

TEST(Read, ARewrittenFileIsReadAgain) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(rampImage(), "frame.pftest");
    EXPECT_EQ(bench.evaluate(read, {"R"}).sample("R", 100, 0), 100.0F);
    const graph::HashValue before = bench.evaluator.hash(bench.graph, read, 1.0);

    // The renderer writes the frame again (different pixels, a bigger file, a later time).
    Image rerender = rampImage(2.0F);
    rerender.addChannel("B", 0.25F);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    testing::writeTestImage(bench.folder.file("frame.pftest"), rerender);

    EXPECT_NE(bench.evaluator.hash(bench.graph, read, 1.0), before);
    const Image result = bench.evaluate(read, {"R", "B"});
    EXPECT_EQ(result.sample("R", 100, 0), 200.0F);
    EXPECT_EQ(result.sample("B", 100, 0), 0.25F);
    EXPECT_EQ(bench.counters->opens, 2);
}

TEST(Read, ProxyScalesAverageBlocks) {
    testing::NodeBench bench;
    const graph::NodeId read = bench.read(rampImage());
    const graph::OutputInfo info = bench.evaluator.info(bench.graph, read, 1.0, 4);
    EXPECT_EQ(info.displayWindow, (Rect{.x0 = 0, .y0 = 0, .x1 = 150, .y1 = 75}));
    EXPECT_EQ(info.dataWindow, (Rect{.x0 = -2, .y0 = 0, .x1 = 150, .y1 = 75}));

    const Image quarter = bench.evaluate(read, {"R", "Z"}, 1.0, 4);
    // Pixel 10 covers full-resolution x 40 … 43: the average of the ramp is 41.5.
    EXPECT_FLOAT_EQ(quarter.sample("R", 10, 3), 41.5F);
    EXPECT_FLOAT_EQ(quarter.sample("Z", 10, 3), 13.5F);
    // Pixel −2 covers x −8 … −5, of which only −6 and −5 exist: (−6 − 5 + 0 + 0) / 4.
    EXPECT_FLOAT_EQ(quarter.sample("R", -2, 0), -2.75F);
}

TEST(Read, PathsWithAnyCharacters) {
    testing::NodeBench bench;
    std::filesystem::create_directories(bench.folder.file("Šibenik render"));
    const graph::NodeId read = bench.read(rampImage(), "Šibenik render/čaša 01.pftest");
    EXPECT_EQ(bench.evaluate(read, {"G"}).sample("G", 1, 1), 0.5F);
}

} // namespace
} // namespace pf::nodes
