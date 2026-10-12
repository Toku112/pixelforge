// The Shuffle node (nodes/shuffle, docs/specs/node-graph.md §6).

#include "core/image/Image.h"
#include "nodes/shuffle/ShuffleNode.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <array>
#include <string>

namespace pf::nodes {
namespace {

using image::ChannelSet;
using image::Image;
using image::Rect;
using Kind = ShuffleSource::Kind;

const ChannelSet renderChannels{"R",   "G",   "B",    "A",    "diffuse.R", "diffuse.G", "diffuse.B", "depth.Z", "N.X",
                                "N.Y", "N.Z", "uv.U", "uv.V", "matte.R",   "matte.G",   "matte.B",   "matte.A"};

const std::array<std::string, 4> automatic{"", "", "", ""};

ShuffleSource channel(std::string name) {
    return {.kind = Kind::Channel, .channel = std::move(name)};
}

TEST(ShuffleRouting, ColourPassesGoToRgbAndKeepTheAlpha) {
    const ShuffleRouting routing = shuffleRouting(renderChannels, "diffuse", "", automatic);
    EXPECT_EQ(routing.outputs, (std::array<std::string, 4>{"R", "G", "B", "A"}));
    EXPECT_EQ(routing.sources[0], channel("diffuse.R"));
    EXPECT_EQ(routing.sources[1], channel("diffuse.G"));
    EXPECT_EQ(routing.sources[2], channel("diffuse.B"));
    EXPECT_EQ(routing.sources[3].kind, Kind::Keep);
}

TEST(ShuffleRouting, LayersWithTheirOwnAlpha) {
    const ShuffleRouting routing = shuffleRouting(renderChannels, "matte", "", automatic);
    EXPECT_EQ(routing.sources[3], channel("matte.A"));
}

TEST(ShuffleRouting, SinglePassesShowAsGrey) {
    const ShuffleRouting routing = shuffleRouting(renderChannels, "depth", "", automatic);
    for (std::size_t k = 0; k < 3; ++k) {
        EXPECT_EQ(routing.sources[k], channel("depth.Z"));
    }
    EXPECT_EQ(routing.sources[3].kind, Kind::Keep);
}

TEST(ShuffleRouting, VectorsAndTwoChannelPasses) {
    const ShuffleRouting normals = shuffleRouting(renderChannels, "N", "", automatic);
    EXPECT_EQ(normals.sources[0], channel("N.X"));
    EXPECT_EQ(normals.sources[1], channel("N.Y"));
    EXPECT_EQ(normals.sources[2], channel("N.Z"));
    const ShuffleRouting uv = shuffleRouting(renderChannels, "uv", "", automatic);
    EXPECT_EQ(uv.sources[0], channel("uv.U"));
    EXPECT_EQ(uv.sources[1], channel("uv.V"));
    EXPECT_EQ(uv.sources[2].kind, Kind::Zero);
}

TEST(ShuffleRouting, ExplicitChoicesAndOtherOutputLayers) {
    const ShuffleRouting routing = shuffleRouting(renderChannels, "N", "copy", {"Z", "0", "1", "W"});
    EXPECT_EQ(routing.outputs, (std::array<std::string, 4>{"copy.R", "copy.G", "copy.B", "copy.A"}));
    EXPECT_EQ(routing.sources[0], channel("N.Z"));
    EXPECT_EQ(routing.sources[1].kind, Kind::Zero);
    EXPECT_EQ(routing.sources[2].kind, Kind::One);
    EXPECT_EQ(routing.sources[3], channel("N.W")); // missing: reads as 0
}

TEST(ShuffleRouting, AMissingLayerChangesNothing) {
    const ShuffleRouting routing = shuffleRouting(renderChannels, "nothing", "", automatic);
    for (const ShuffleSource& source : routing.sources) {
        EXPECT_EQ(source.kind, Kind::Keep);
    }
}

// A 300 × 300 beauty with a diffuse and a depth pass; every channel holds its own values.
Image passesImage() {
    const Rect frame{.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 300};
    Image source(frame, frame, {"R", "G", "B", "A", "diffuse.R", "diffuse.G", "diffuse.B", "depth.Z"});
    for (std::size_t c = 0; c < source.channelCount(); ++c) {
        for (int y = 0; y < 300; y += 3) {
            for (int x = 0; x < 300; x += 3) {
                source.setSample(source.channels()[c], x, y, static_cast<float>(c) + (0.001F * static_cast<float>(x)));
            }
        }
    }
    return source;
}

TEST(Shuffle, NodeRoutesChannelsWithoutCopyingPixels) {
    testing::NodeBench bench;
    const Image source = passesImage();
    const graph::NodeId read = bench.read(source);
    const graph::NodeId shuffle = bench.add("Shuffle");
    bench.graph.connect(read, shuffle, 0);
    bench.graph.setValue(shuffle, "inLayer", std::string("diffuse"));
    bench.graph.setValue(shuffle, "blue", std::string("1"));
    bench.graph.setValue(shuffle, "alpha", std::string("X")); // the layer has no X: 0

    const ChannelSet all = image::unite(source.channels(), {"R", "G", "B", "A"});
    const Image input = bench.evaluate(read, source.channels());
    const Image result = bench.evaluate(shuffle, all);
    EXPECT_EQ(result.channels(), source.channels());
    EXPECT_EQ(result.sample("R", 30, 30), source.sample("diffuse.R", 30, 30));
    EXPECT_EQ(result.sample("G", 30, 30), source.sample("diffuse.G", 30, 30));
    EXPECT_EQ(result.sample("B", 30, 30), 1.0F);
    EXPECT_EQ(result.sample("A", 30, 30), 0.0F);
    EXPECT_EQ(result.sample("depth.Z", 30, 30), source.sample("depth.Z", 30, 30));
    EXPECT_EQ(result.sample("diffuse.R", 30, 30), source.sample("diffuse.R", 30, 30));
    // Shared tiles: the shuffled red is the input's diffuse red, the same memory.
    EXPECT_EQ(result.tile(result.channelIndex("R"), {.x = 1, .y = 1}).samples,
              input.tile(input.channelIndex("diffuse.R"), {.x = 1, .y = 1}).samples);

    // Asking for red alone reads only diffuse.R from the file.
    testing::NodeBench fresh;
    const graph::NodeId read2 = fresh.read(source);
    const graph::NodeId shuffle2 = fresh.add("Shuffle");
    fresh.graph.connect(read2, shuffle2, 0);
    fresh.graph.setValue(shuffle2, "inLayer", std::string("diffuse"));
    (void)fresh.evaluate(shuffle2, {"R"});
    EXPECT_EQ(fresh.counters->channelsRead, 1);
}

TEST(Shuffle, NewOutputLayersAreAdded) {
    testing::NodeBench bench;
    const Rect frame{.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 64};
    Image source(frame, frame, {"R", "G", "B", "A", "depth.Z"});
    source.fill(source.channelIndex("depth.Z"), frame, 12.5F);
    const graph::NodeId read = bench.read(source);
    const graph::NodeId shuffle = bench.add("Shuffle");
    bench.graph.connect(read, shuffle, 0);
    bench.graph.setValue(shuffle, "inLayer", std::string("depth"));
    bench.graph.setValue(shuffle, "outLayer", std::string("zview"));
    const Image result = bench.evaluate(shuffle, {"R", "zview.R", "zview.G", "zview.B", "zview.A"});
    EXPECT_EQ(result.channels(), (ChannelSet{"R", "zview.R", "zview.G", "zview.B"}));
    EXPECT_EQ(result.sample("zview.G", 3, 3), 12.5F);
}

TEST(Shuffle, UnconnectedGivesNothing) {
    testing::NodeBench bench;
    const graph::NodeId shuffle = bench.add("Shuffle");
    bench.graph.setValue(shuffle, "red", std::string("1"));
    EXPECT_TRUE(bench.evaluate(shuffle, {"R"}).channels().empty());
}

} // namespace
} // namespace pf::nodes
