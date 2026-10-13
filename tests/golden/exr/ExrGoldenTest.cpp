// Lossy EXR compressions decode to the same pixels everywhere and keep doing so after OpenEXR upgrades: the input
// files are committed (tests/fixtures/exr/, written once by our test writer; update-golden writes missing ones) and
// what the reader makes of them is compared with golden images. Each result also equals OpenEXR's own decoding of
// the file on the platform at hand.

#include "core/image/Image.h"
#include "io/ImageReader.h"
#include "io/exr/ExrReader.h"
#include "support/exr/ExrFixture.h"
#include "support/golden/ExrFile.h"
#include "support/golden/Golden.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <string>

namespace pf::io {
namespace {

using testing::ExrPartSpec;
using testing::ExrPattern;
using testing::ExrSample;
using testing::ExrStorage;

struct LossyCase {
    std::string name;
    int compression = 0;
    ExrStorage storage = ExrStorage::Scanline;
};

// A small render-like frame with overscan: colour in half, depth in float.
ExrPartSpec lossyPart(const LossyCase& lossy) {
    ExrPartSpec part;
    part.displayWindow = {.x0 = 0, .y0 = 0, .x1 = 40, .y1 = 32};
    part.dataWindow = {.x0 = -2, .y0 = -2, .x1 = 42, .y1 = 34};
    part.compression = lossy.compression;
    part.storage = lossy.storage;
    part.channels = {{.name = "R", .pattern = ExrPattern::Smooth},
                     {.name = "G", .pattern = ExrPattern::Smooth},
                     {.name = "B", .pattern = ExrPattern::Smooth},
                     {.name = "Z", .type = ExrSample::Float, .pattern = ExrPattern::Smooth}};
    return part;
}

class ExrLossyGolden : public ::testing::TestWithParam<LossyCase> {};

TEST_P(ExrLossyGolden, DecodesToTheGoldenImage) {
    const LossyCase& lossy = GetParam();
    const std::filesystem::path file = std::filesystem::path(PF_EXR_FIXTURES_DIR) / (lossy.name + ".exr");
    if (!std::filesystem::exists(file)) {
        ASSERT_TRUE(golden::defaultGoldenSettings().update)
            << file << " is missing; build the update-golden target to write it (then review and commit it)";
        testing::writeExrFixture(file, lossyPart(lossy));
    }
    const std::unique_ptr<ImageReader> reader = openExr(file);
    const image::Image image = reader->read(reader->info().channels, reader->info().dataWindow, {});
    const golden::Image actual = testing::toGolden(image);

    // Exactly OpenEXR's own decoding on this platform.
    golden::CompareOptions exact;
    exact.tolerance = {.absolute = 0.0, .relative = 0.0};
    const golden::Image reference = golden::readExr(file);
    const golden::CompareResult sameAsOpenExr = golden::compare(actual, reference, exact);
    EXPECT_TRUE(sameAsOpenExr.passed) << sameAsOpenExr.describe();

    // The golden image. Lossy decoders compute in float with platform-specific vector code, so results may differ
    // by a step of a half float (about 0.1 %) between platforms.
    golden::CompareOptions halfStep;
    halfStep.tolerance = {.absolute = 1e-4, .relative = 2e-3};
    EXPECT_TRUE(golden::matchesGolden(actual, "exr/" + lossy.name, halfStep));
}

INSTANTIATE_TEST_SUITE_P(LossyCompressions, ExrLossyGolden,
                         ::testing::Values(LossyCase{"pxr24", 5}, LossyCase{"b44", 6}, LossyCase{"b44a", 7},
                                           LossyCase{"dwaa", 8}, LossyCase{"dwab", 9}, LossyCase{"lj2k", 12},
                                           LossyCase{"dwaa_tiled", 8, ExrStorage::Tiled},
                                           LossyCase{"b44_tiled", 6, ExrStorage::Tiled}),
                         [](const ::testing::TestParamInfo<LossyCase>& info) { return info.param.name; });

} // namespace
} // namespace pf::io
