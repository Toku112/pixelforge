#pragma once

// Golden-image assertions for GoogleTest (tests/README.md):
//
//     EXPECT_TRUE(pf::golden::matchesGolden(result, "exposure/hdr_ramp"));
//
// compares `result` with tests/golden/exposure/hdr_ramp.expected.exr. On a mismatch it writes the actual image and a
// difference image to <build>/golden-output/exposure/hdr_ramp.{actual,diff}.exr and fails with a description. In
// update mode (environment variable PF_GOLDEN_UPDATE=1, set by the update-golden target) a missing or mismatching
// expected image is rewritten from the actual one instead; review those changes with git before committing.

#include "support/golden/Compare.h"
#include "support/golden/GoldenImage.h"

#include <gtest/gtest.h>

#include <filesystem>
#include <string_view>

namespace pf::golden {

struct GoldenSettings {
    std::filesystem::path expectedRoot; // holds <feature>/<case>.expected.exr
    std::filesystem::path outputRoot;   // receives <feature>/<case>.actual.exr and .diff.exr on failure
    bool update = false;
};

// tests/golden in the source tree, golden-output in the build folder, update mode from PF_GOLDEN_UPDATE.
[[nodiscard]] GoldenSettings defaultGoldenSettings();

// `caseId` is "<feature>/<case>": letters, digits, '_' and '-' on both sides of one '/'.
[[nodiscard]] ::testing::AssertionResult matchesGolden(const Image& actual, std::string_view caseId,
                                                       const CompareOptions& options = {},
                                                       const GoldenSettings& settings = defaultGoldenSettings());

} // namespace pf::golden
