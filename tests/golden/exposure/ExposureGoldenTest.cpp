// Golden images of the Exposure node on render-pass-like data, through a Read node and the evaluator: catches any
// change to the maths (FORMAT_NOTES §20.2), the alpha handling, layer selection and windows on every platform.

#include "core/image/Image.h"
#include "support/golden/Golden.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <cmath>
#include <numbers>
#include <string>

namespace pf::nodes {
namespace {

using image::Image;
using image::Rect;

// A 96 × 64 frame with 4 pixels of overscan on the left and top: an HDR ramp (1/16 to 64, negative in the first
// columns) and a signed sine, both premultiplied by an alpha ramp that starts at 0; a constant blue; depth; and a
// diffuse layer without alpha.
Image renderLikeImage() {
    const Rect display{.x0 = 0, .y0 = 0, .x1 = 96, .y1 = 64};
    const Rect data{.x0 = -4, .y0 = -4, .x1 = 96, .y1 = 64};
    Image image(display, data, {"R", "G", "B", "A", "Z", "diffuse.R", "diffuse.G", "diffuse.B"});
    for (int y = data.y0; y < data.y1; ++y) {
        for (int x = data.x0; x < data.x1; ++x) {
            const double u = static_cast<double>(x - data.x0) / (data.width() - 1);
            const double v = static_cast<double>(y - data.y0) / (data.height() - 1);
            const double alpha = v;
            const double ramp = x < 4 ? -0.5 * (4 - x) : std::exp2((10.0 * u) - 4.0);
            image.setSample("R", x, y, static_cast<float>(ramp * alpha));
            image.setSample("G", x, y, static_cast<float>(1.5 * std::sin(2.0 * std::numbers::pi * u) * alpha));
            image.setSample("A", x, y, static_cast<float>(alpha));
            image.setSample("Z", x, y, static_cast<float>(5.0 + (100.0 * u)));
            image.setSample("diffuse.R", x, y, static_cast<float>(0.18 * (1.0 + u)));
            image.setSample("diffuse.G", x, y, static_cast<float>(0.5 * v));
            image.setSample("diffuse.B", x, y, static_cast<float>(-0.01 + (0.02 * u)));
        }
    }
    image.fill(image.channelIndex("B"), data, 0.3F);
    return image;
}

Image runExposure(double exposure, double offset, double gamma, const std::string& layer) {
    testing::NodeBench bench;
    const Image source = renderLikeImage();
    const graph::NodeId read = bench.read(source);
    const graph::NodeId node = bench.add("Exposure");
    bench.graph.connect(read, node, 0);
    bench.graph.setValue(node, "exposure", exposure);
    bench.graph.setValue(node, "offset", offset);
    bench.graph.setValue(node, "gamma", gamma);
    bench.graph.setValue(node, "layer", layer);
    return bench.evaluate(node, source.channels());
}

TEST(ExposureGolden, AllThreeControlsOnTheMainLayer) {
    EXPECT_TRUE(golden::matchesGolden(testing::toGolden(runExposure(1.5, 0.02, 1.8, "")), "exposure/hdr_ramp"));
}

TEST(ExposureGolden, DarkerGammaOnTheMainLayer) {
    EXPECT_TRUE(golden::matchesGolden(testing::toGolden(runExposure(-1.0, -0.05, 0.6, "")), "exposure/darker_gamma"));
}

TEST(ExposureGolden, ExposureOnlyOnAPass) {
    EXPECT_TRUE(
        golden::matchesGolden(testing::toGolden(runExposure(-2.5, 0.0, 1.0, "diffuse")), "exposure/diffuse_pass"));
}

} // namespace
} // namespace pf::nodes
