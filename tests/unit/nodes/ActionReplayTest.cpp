// A comp built with the real nodes while recording, saved as an action file, played into a new project with its own
// evaluator: the replayed comp renders the same pixels at every frame (CLAUDE.md §5, "recordable as an Action and
// replays identically"; docs/specs/commands-history.md §7).

#include "core/actions/Action.h"
#include "core/commands/GraphCommands.h"
#include "core/history/History.h"
#include "core/image/Image.h"
#include "io/ImageReader.h"
#include "support/graph/TestTypes.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <bit>
#include <cmath>
#include <cstdint>
#include <string>

namespace pf::nodes {
namespace {

using history::History;
using history::Merge;

const graph::Node& nodeNamed(const History& history, std::string_view name) {
    return testing::nodeNamed(history.graph(), name);
}

image::Image plate() {
    constexpr image::Rect frame{.x0 = 0, .y0 = 0, .x1 = 320, .y1 = 180};
    image::Image image(frame, frame, {"R", "G", "B", "A"});
    for (int y = frame.y0; y < frame.y1; ++y) {
        for (int x = frame.x0; x < frame.x1; ++x) {
            image.setSample("R", x, y, static_cast<float>(x) / 40.0F); // up to 8: above white
            image.setSample("G", x, y, (static_cast<float>(y) / 180.0F) - 0.25F);
            image.setSample("B", x, y, 0.5F);
            image.setSample("A", x, y, 1.0F);
        }
    }
    return image;
}

// Bit for bit the same samples (every 5th column of every 3rd row of the plate), with the same data window.
::testing::AssertionResult samePixels(const image::Image& expected, const image::Image& actual) {
    if (actual.dataWindow() != expected.dataWindow()) {
        return ::testing::AssertionFailure() << "different data windows";
    }
    for (const char* channel : {"R", "G", "B", "A"}) {
        for (int y = 0; y < 180; y += 3) {
            for (int x = 0; x < 320; x += 5) {
                if (std::bit_cast<std::uint32_t>(actual.sample(channel, x, y)) !=
                    std::bit_cast<std::uint32_t>(expected.sample(channel, x, y))) {
                    return ::testing::AssertionFailure() << channel << " differs at (" << x << ", " << y << ")";
                }
            }
        }
    }
    return ::testing::AssertionSuccess();
}

TEST(ActionReplay, AReplayedCompRendersTheSamePixels) {
    testing::NodeBench bench;
    const std::string file = io::pathToUtf8(bench.folder.file("plate čž.pftest"));
    testing::writeTestImage(bench.folder.file("plate čž.pftest"), plate());
    const commands::CommandRegistry commands = testing::builtinCommands();

    History history(commands, bench.types);
    actions::Recorder recorder(history);
    (void)history.execute(commands::addNode("Read"));
    (void)history.execute(commands::setValue(nodeNamed(history, "Read1"), "file", std::string(file)));
    (void)history.execute(
        commands::group("Add Exposure", {commands::addNode("Exposure"), commands::connect("Read1", "Exposure1", 0)}));
    for (const double stops : {0.25, 0.5, 0.75, 1.25}) {
        (void)history.execute(commands::setValue(nodeNamed(history, "Exposure1"), "exposure", stops),
                              stops == 0.25 ? Merge::No : Merge::Continue);
    }
    (void)history.execute(commands::setKey("Exposure1", "gamma", 0, {.frame = 1.0, .value = 1.0}));
    (void)history.execute(commands::setKey(
        "Exposure1", "gamma", 0, {.frame = 10.0, .value = 2.2, .interpolation = anim::Interpolation::Smooth}));
    (void)history.execute(commands::setValue(nodeNamed(history, "Exposure1"), "offset", -0.05, 5.0));
    (void)history.execute(commands::addNode("Viewer"));
    (void)history.execute(commands::connect("Exposure1", "Viewer1", 0));
    recorder.stop();
    EXPECT_EQ(recorder.steps().size(), 9U);

    // Saved as a file and read back, then played into a new project with its own evaluator and cache.
    const actions::Action loaded = actions::actionFromJson(
        json::parse(json::write(actions::toJson(recorder.action("Grade plate")), {.indent = 2})));
    testing::NodeBench other;
    History replay(commands, other.types);
    EXPECT_EQ(actions::play(loaded, replay), 9U);
    ASSERT_TRUE(testing::sameGraph(history.graph(), replay.graph()));

    bench.graph = history.graph();
    other.graph = replay.graph();
    const image::ChannelSet channels({"R", "G", "B", "A"});
    for (const double frame : {1.0, 3.0, 5.0, 7.5, 10.0, 20.0}) {
        const image::Image expected = bench.evaluate(testing::nodeId(bench.graph, "Viewer1"), channels, frame);
        const image::Image actual = other.evaluate(testing::nodeId(other.graph, "Viewer1"), channels, frame);
        ASSERT_TRUE(samePixels(expected, actual)) << "frame " << frame;
    }
    // The grade really is applied (not two equally empty results).
    const image::Image graded = bench.evaluate(testing::nodeId(bench.graph, "Viewer1"), channels, 1.0);
    EXPECT_NEAR(graded.sample("B", 0, 0), (0.5 * std::exp2(1.25)) - 0.05, 1e-6); // gamma 1 at frame 1
}

} // namespace
} // namespace pf::nodes
