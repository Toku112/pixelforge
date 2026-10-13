// The Read node with image sequences (nodes/read, docs/specs/sequences.md §4–5, FORMAT_NOTES §23.4–23.5): which file
// shows at which frame, frame range and offset, hold/loop/bounce/black outside the range, missing frames, and frames
// that appear, change or disappear on disk. Frames are the tests' own .pftest files; each frame's R holds its frame
// number.

#include "core/anim/FrameRange.h"
#include "core/graph/Evaluation.h"
#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "io/ImageReader.h"
#include "io/exr/ExrReader.h"
#include "io/sequence/Sequence.h"
#include "nodes/read/ReadNode.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <initializer_list>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace pf::nodes {
namespace {

using image::ChannelSet;
using image::Image;
using image::Rect;

constexpr Rect frameWindow{.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 200};

// A frame: R = value, G = 0.25, A = 1, depth.Z = 100 + value; 20 pixels of overscan on the right.
Image frameImage(float value) {
    Image image(frameWindow, {.x0 = 0, .y0 = 0, .x1 = 320, .y1 = 200}, {"R", "G", "A", "depth.Z"});
    image.fill(image.channelIndex("R"), image.dataWindow(), value);
    image.fill(image.channelIndex("G"), image.dataWindow(), 0.25F);
    image.fill(image.channelIndex("A"), image.dataWindow(), 1.0F);
    image.fill(image.channelIndex("depth.Z"), image.dataWindow(), 100.0F + value);
    return image;
}

class ReadSequence : public ::testing::Test {
public:
    testing::NodeBench bench;
    graph::NodeId read = bench.add("Read");

    // Writes frames as "<prefix><frame, 4 digits><suffix>".
    void writeFrames(std::initializer_list<std::int64_t> frames, const std::string& prefix = "render.",
                     const std::string& suffix = ".pftest") const {
        for (const std::int64_t frame : frames) {
            writeFrame(frame, io::FramePattern("", prefix, 4, suffix).fileName(frame));
        }
    }
    void writeFrame(std::int64_t frame, const std::string& name, float value = NAN) const {
        testing::writeTestImage(bench.folder.file(name),
                                frameImage(std::isnan(value) ? static_cast<float>(frame) : value));
    }

    void usePattern(const std::string& pattern = "render.####.pftest") {
        bench.graph.setValue(read, "file", io::pathToUtf8(bench.folder.file(pattern)));
    }
    void set(const std::string& param, graph::ParamValue value) { bench.graph.setValue(read, param, std::move(value)); }

    // R at the middle of the frame shown at comp frame `frame`; NaN for an empty (black) frame.
    float shownAt(double frame) {
        const Image image = bench.evaluate(read, {"R"}, frame);
        return image.dataWindow().isEmpty() ? NAN : image.sample("R", 150, 100);
    }
    std::vector<float> shownAt(std::initializer_list<double> frames) {
        std::vector<float> result;
        for (const double frame : frames) {
            result.push_back(shownAt(frame));
        }
        return result;
    }

    // The message of the evaluation error at `frame`.
    std::string errorAt(double frame) {
        try {
            (void)bench.evaluate(read, {"R"}, frame);
        } catch (const graph::EvaluationError& error) {
            EXPECT_EQ(error.node(), read);
            return error.what();
        }
        ADD_FAILURE() << "frame " << frame << " should fail";
        return {};
    }
};

std::vector<float> values(std::initializer_list<float> list) {
    return list;
}

// Compares with NaN equal to NaN (black frames).
void expectShown(const std::vector<float>& actual, const std::vector<float>& expected) {
    ASSERT_EQ(actual.size(), expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i) {
        if (std::isnan(expected[i])) {
            EXPECT_TRUE(std::isnan(actual[i])) << "position " << i << " shows " << actual[i] << ", not black";
        } else {
            EXPECT_EQ(actual[i], expected[i]) << "position " << i;
        }
    }
}

TEST_F(ReadSequence, PlaysTheFramesOfAPattern) {
    writeFrames({1, 2, 3, 4, 5});
    usePattern();
    expectShown(shownAt({1, 2, 3, 4, 5}), values({1, 2, 3, 4, 5}));
    // Every frame is read once and then comes from the cache.
    EXPECT_EQ(bench.counters->opens, 5);
    expectShown(shownAt({5, 4, 3, 2, 1}), values({5, 4, 3, 2, 1}));
    EXPECT_EQ(bench.counters->opens, 5);
    EXPECT_EQ(bench.counters->reads, 5);

    const graph::OutputInfo info = bench.evaluator.info(bench.graph, read, 3.0, 1);
    EXPECT_EQ(info.displayWindow, frameWindow);
    EXPECT_EQ(info.dataWindow, (Rect{.x0 = 0, .y0 = 0, .x1 = 320, .y1 = 200}));
    EXPECT_EQ(info.channels, (ChannelSet{"R", "G", "A", "depth.Z"}));
}

TEST_F(ReadSequence, EveryPlaceholderAndNamingStyleWorks) {
    writeFrames({1, 2}, "a_", ".pftest");
    writeFrames({1, 2}, "b", ".pftest");
    writeFrame(1, "c.1.pftest");
    writeFrame(2, "c.2.pftest");
    for (const char* pattern : {"a_####.pftest", "a_@@@@.pftest", "a_%04d.pftest", "b####.pftest", "c.#.pftest",
                                "c.%d.pftest", "c.####.pftest"}) {
        usePattern(pattern);
        expectShown(shownAt({1, 2}), values({1, 2}));
    }
}

TEST_F(ReadSequence, CompFramesRoundToTheNearestWholeFrame) {
    writeFrames({1, 2, 3});
    usePattern();
    expectShown(shownAt({1.49, 1.5, 2.2, 2.7}), values({1, 2, 2, 3}));
}

TEST_F(ReadSequence, HoldsTheEndFramesByDefault) {
    writeFrames({3, 4, 5});
    usePattern();
    expectShown(shownAt({-10, 2, 3, 5, 6, 1000}), values({3, 3, 3, 5, 5, 5}));
    // Held frames show the very same file: same hash, no extra reading.
    EXPECT_EQ(bench.evaluator.hash(bench.graph, read, 2.0), bench.evaluator.hash(bench.graph, read, 3.0));
    EXPECT_NE(bench.evaluator.hash(bench.graph, read, 4.0), bench.evaluator.hash(bench.graph, read, 3.0));
    EXPECT_EQ(bench.counters->reads, 2);
}

TEST_F(ReadSequence, LoopsAndBounces) {
    writeFrames({1, 2, 3});
    usePattern();
    set("before", std::int64_t{1}); // loop
    set("after", std::int64_t{1});
    expectShown(shownAt({-1, 0, 1, 2, 3, 4, 5, 6, 7}), values({2, 3, 1, 2, 3, 1, 2, 3, 1}));
    set("before", std::int64_t{2}); // bounce
    set("after", std::int64_t{2});
    expectShown(shownAt({-1, 0, 1, 2, 3, 4, 5, 6, 7}), values({3, 2, 1, 2, 3, 2, 1, 2, 3}));
}

TEST_F(ReadSequence, BlackFramesKeepTheSequencesSizeAndChannels) {
    writeFrames({1, 2});
    usePattern();
    set("before", std::int64_t{3}); // black
    set("after", std::int64_t{3});
    expectShown(shownAt({0, 1, 2, 3}), values({NAN, 1, 2, NAN}));
    const graph::OutputInfo info = bench.evaluator.info(bench.graph, read, 3.0, 2);
    EXPECT_EQ(info.displayWindow, (Rect{.x0 = 0, .y0 = 0, .x1 = 150, .y1 = 100}));
    EXPECT_TRUE(info.dataWindow.isEmpty());
    EXPECT_EQ(info.channels, (ChannelSet{"R", "G", "A", "depth.Z"}));
    const Image black = bench.evaluate(read, {"R", "A"}, 3.0);
    EXPECT_EQ(black.displayWindow(), frameWindow);
    EXPECT_EQ(black.sample("A", 10, 10), 0.0F);
}

TEST_F(ReadSequence, ACustomRangeAndAnOffset) {
    writeFrames({1, 2, 3, 4, 5, 6});
    usePattern();
    set("autoRange", false);
    set("first", std::int64_t{2});
    set("last", std::int64_t{4});
    expectShown(shownAt({1, 2, 4, 5}), values({2, 2, 4, 4}));
    set("first", std::int64_t{5}); // the wrong way round: read as 4–5
    expectShown(shownAt({3, 4, 5, 6}), values({4, 4, 5, 5}));

    set("autoRange", true);
    set("offset", std::int64_t{100}); // file frame 1 at comp frame 101
    expectShown(shownAt({100, 101, 103, 106, 200}), values({1, 1, 3, 6, 6}));
    set("offset", std::int64_t{-3});
    expectShown(shownAt({-2, 0, 3}), values({1, 3, 6}));
}

TEST_F(ReadSequence, MissingFramesShowACheckerboardByDefault) {
    writeFrames({1, 2, 4});
    usePattern();
    const Image checker = bench.evaluate(read, {"R", "G", "A", "depth.Z"}, 3.0);
    EXPECT_EQ(checker.displayWindow(), frameWindow);
    EXPECT_EQ(checker.dataWindow(), frameWindow); // the display window: no overscan
    EXPECT_EQ(checker.sample("R", 0, 0), 0.4F);
    EXPECT_EQ(checker.sample("R", 63, 63), 0.4F);
    EXPECT_EQ(checker.sample("R", 64, 0), 0.1F);
    EXPECT_EQ(checker.sample("G", 0, 64), 0.1F);
    EXPECT_EQ(checker.sample("G", 64, 64), 0.4F);
    EXPECT_EQ(checker.sample("A", 100, 100), 1.0F);
    EXPECT_EQ(checker.sample("depth.Z", 100, 100), 0.0F);
    // Missing frames that take their size from the same frame share one result.
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    writeFrames({8});
    EXPECT_EQ(bench.evaluator.hash(bench.graph, read, 5.0), bench.evaluator.hash(bench.graph, read, 6.0));
    EXPECT_EQ(bench.counters->reads, 0);
}

TEST_F(ReadSequence, AProxyCheckerboardIsTheAveragedFullOne) {
    writeFrames({1, 3});
    usePattern();
    const Image full = bench.evaluate(read, {"R"}, 2.0);
    for (const int p : {2, 4, 8, 16, 32}) {
        const Image proxy = bench.evaluate(read, {"R"}, 2.0, p);
        // Proxy pixels inside the full frame (the last column or row may reach beyond it).
        for (int y = 0; (y + 1) * p <= frameWindow.y1; ++y) {
            for (int x = 0; (x + 1) * p <= frameWindow.x1; ++x) {
                double sum = 0.0;
                for (int j = y * p; j < (y + 1) * p; ++j) {
                    for (int i = x * p; i < (x + 1) * p; ++i) {
                        sum += static_cast<double>(full.sample("R", i, j));
                    }
                }
                ASSERT_FLOAT_EQ(proxy.sample("R", x, y), static_cast<float>(sum / (p * p)))
                    << p << " at " << x << ", " << y;
            }
        }
    }
}

TEST_F(ReadSequence, MissingFramesCanHoldTheFrameBefore) {
    writeFrames({2, 3, 6});
    usePattern();
    set("missing", std::int64_t{1}); // hold previous
    expectShown(shownAt({3, 4, 5, 6}), values({3, 3, 3, 6}));
    EXPECT_EQ(bench.evaluator.hash(bench.graph, read, 5.0), bench.evaluator.hash(bench.graph, read, 3.0));

    // At the start of a custom range there is nothing before: the next frame of the range.
    set("autoRange", false);
    set("first", std::int64_t{4});
    set("last", std::int64_t{7});
    expectShown(shownAt({4, 5, 7}), values({6, 6, 6}));
    set("last", std::int64_t{5});
    EXPECT_NE(errorAt(4.0).find("none of the frames 4–5 of render.####.pftest exist"), std::string::npos)
        << errorAt(4.0);
}

TEST_F(ReadSequence, MissingFramesCanBeBlackOrErrors) {
    writeFrames({1, 3});
    usePattern();
    set("missing", std::int64_t{2}); // black
    expectShown(shownAt({1, 2, 3}), values({1, NAN, 3}));
    set("missing", std::int64_t{0}); // error
    const std::string message = errorAt(2.0);
    EXPECT_EQ(
        message.rfind("Read1: frame 2 of render.####.pftest is missing (render.0002.pftest does not exist in ", 0), 0U)
        << message;
    expectShown(shownAt({1, 3}), values({1, 3}));
}

TEST_F(ReadSequence, ASequenceWithoutFilesIsAnError) {
    usePattern();
    std::string message = errorAt(1.0);
    EXPECT_EQ(message.rfind("Read1: no files match render.####.pftest in ", 0), 0U) << message;
    bench.graph.setValue(read, "file", io::pathToUtf8(bench.folder.file("missing/render.####.pftest")));
    message = errorAt(1.0);
    EXPECT_NE(message.find("cannot read the folder"), std::string::npos) << message;
    EXPECT_NE(message.find("it does not exist"), std::string::npos) << message;
}

TEST_F(ReadSequence, FollowsTheDiskAsFramesAreRendered) {
    writeFrames({1, 2, 4});
    usePattern();
    // 3 is missing (a dark checkerboard square at the middle), 5 and 6 hold 4.
    expectShown(shownAt({3, 4, 5, 6}), values({0.1F, 4, 4, 4}));

    // The renderer fills the gap and goes on with frames 5 and 6; the range follows.
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    writeFrames({3, 5, 6});
    expectShown(shownAt({3, 4, 5, 6}), values({3, 4, 5, 6}));

    // Frame 2 is rendered again; frame 4 is deleted.
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    writeFrame(2, "render.0002.pftest", 20.0F);
    std::filesystem::remove(bench.folder.file("render.0004.pftest"));
    expectShown(shownAt({2, 4}), values({20, 0.1F}));
    // Unchanged frames stay cached: every file was read once.
    expectShown(shownAt({1, 3, 5, 6}), values({1, 3, 5, 6}));
    EXPECT_EQ(bench.counters->reads, 6);
}

TEST_F(ReadSequence, NegativeFrames) {
    writeFrame(-2, "render.-0002.pftest");
    writeFrame(-1, "render.-001.pftest"); // C-style padding
    writeFrame(0, "render.0000.pftest");
    writeFrame(1, "render.0001.pftest");
    usePattern();
    expectShown(shownAt({-3, -2, -1, 0, 1}), values({-2, -2, -1, 0, 1}));

    // Blender without a separator.
    writeFrame(-1, "shot-0001.pftest");
    writeFrame(0, "shot0000.pftest");
    usePattern("shot####.pftest");
    expectShown(shownAt({-1, 0}), values({-1, 0}));
}

TEST_F(ReadSequence, AStillShowsAtEveryFrameWhateverTheSettings) {
    writeFrame(7, "still.pftest");
    usePattern("still.pftest");
    set("autoRange", false);
    set("first", std::int64_t{1});
    set("last", std::int64_t{2});
    set("before", std::int64_t{3});
    set("after", std::int64_t{3});
    expectShown(shownAt({-5, 1, 2, 50}), values({7, 7, 7, 7}));
    EXPECT_EQ(bench.evaluator.hash(bench.graph, read, -5.0), bench.evaluator.hash(bench.graph, read, 50.0));
}

TEST_F(ReadSequence, FoldersWithAnyCharacters) {
    std::filesystem::create_directories(bench.folder.file("Šibenik #2/čaše"));
    writeFrame(1, "Šibenik #2/čaše/kadar_0001.pftest");
    writeFrame(2, "Šibenik #2/čaše/kadar_0002.pftest");
    usePattern("Šibenik #2/čaše/kadar_####.pftest");
    expectShown(shownAt({1, 2}), values({1, 2}));
}

TEST_F(ReadSequence, TheOwnersCyclesSequence) {
    const std::filesystem::path folder = std::filesystem::path(PF_SOURCE_DIR) / "blender render";
    if (!std::filesystem::exists(folder / "render0001.exr")) {
        GTEST_SKIP() << "the owner's render is not on this machine";
    }
    const std::optional<io::Sequence> detected = io::detectSequence(folder / "render0007.exr");
    if (!detected) {
        FAIL() << "the owner's frames should form a sequence";
    }
    const io::Sequence& sequence = *detected;
    EXPECT_EQ(sequence.pattern().fileNameText(), "render####.exr");
    EXPECT_EQ(sequence.range(), (anim::FrameRange{.first = 1, .last = 20}));
    EXPECT_TRUE(sequence.missing({.first = 1, .last = 20}).empty());

    bench.graph.setValue(read, "file", sequence.pattern().text());
    for (const double frame : {1.0, 7.0, 20.0}) {
        const Image depth = bench.evaluate(read, {"ViewLayer.Depth.Z"}, frame);
        const std::unique_ptr<io::ImageReader> direct =
            io::openExr(folder / sequence.pattern().fileName(static_cast<std::int64_t>(frame)));
        const Image expected =
            direct->read({"ViewLayer.Depth.Z"}, {.x0 = 900, .y0 = 500, .x1 = 901, .y1 = 501}, io::ParallelFor());
        EXPECT_EQ(depth.sample("ViewLayer.Depth.Z", 900, 500), expected.sample("ViewLayer.Depth.Z", 900, 500))
            << "frame " << frame;
    }
}

} // namespace
} // namespace pf::nodes
