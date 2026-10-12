// The Viewer node (nodes/viewer, docs/specs/node-graph.md §6).

#include "core/graph/Graph.h"
#include "core/image/Image.h"
#include "nodes/viewer/ViewerNode.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <string>

namespace pf::nodes {
namespace {

using image::Image;
using image::Rect;

Image flat(float value) {
    const Rect frame{.x0 = 0, .y0 = 0, .x1 = 32, .y1 = 32};
    Image image(frame, frame, {"R", "G", "B"});
    for (std::size_t c = 0; c < 3; ++c) {
        image.fill(c, frame, value);
    }
    return image;
}

TEST(Viewer, HasTenNumberedInputsAndNoOutput) {
    const auto def = makeViewerNodeDef();
    ASSERT_EQ(def->inputs.size(), 10U);
    EXPECT_EQ(def->inputs[0].label, "1");
    EXPECT_EQ(def->inputs[8].label, "9");
    EXPECT_EQ(def->inputs[9].label, "0");
    EXPECT_FALSE(def->hasOutput);
    for (const char* display : {"exposure", "gamma", "layer", "channel", "display", "view"}) {
        EXPECT_FALSE(def->param(display).affectsPixels) << display;
    }
}

TEST(Viewer, ShowsItsActiveInputUnchanged) {
    testing::NodeBench bench;
    const graph::NodeId one = bench.read(flat(1.0F), "one.pftest");
    const graph::NodeId two = bench.read(flat(2.0F), "two.pftest");
    const graph::NodeId viewer = bench.add("Viewer");
    bench.graph.connect(one, viewer, 0);
    bench.graph.connect(two, viewer, 1);

    EXPECT_EQ(bench.evaluate(viewer, {"R"}).sample("R", 5, 5), 1.0F);
    EXPECT_EQ(bench.evaluator.hash(bench.graph, viewer, 1.0), bench.evaluator.hash(bench.graph, one, 1.0));
    bench.graph.setValue(viewer, "activeInput", std::int64_t{1});
    EXPECT_EQ(bench.evaluate(viewer, {"R"}).sample("R", 5, 5), 2.0F);

    // Display settings never change what is computed.
    const graph::HashValue before = bench.evaluator.hash(bench.graph, viewer, 1.0);
    bench.graph.setValue(viewer, "exposure", 3.0);
    bench.graph.setValue(viewer, "gamma", 2.2);
    bench.graph.setValue(viewer, "channel", std::int64_t{static_cast<int>(ViewerChannel::Luminance)});
    bench.graph.setValue(viewer, "view", std::string("AgX"));
    EXPECT_EQ(bench.evaluator.hash(bench.graph, viewer, 1.0), before);

    // An empty input shows nothing; the viewer feeds no other node.
    bench.graph.setValue(viewer, "activeInput", std::int64_t{5});
    EXPECT_TRUE(bench.evaluate(viewer, {"R"}).channels().empty());
    const graph::NodeId exposure = bench.add("Exposure");
    EXPECT_THROW(bench.graph.connect(viewer, exposure, 0), graph::GraphError);
}

} // namespace
} // namespace pf::nodes
