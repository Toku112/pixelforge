// Golden assertions (support/golden/Golden.h): file layout, failure output and update mode, in a temporary folder.

#include "support/golden/Golden.h"

#include "support/golden/ExrFile.h"

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <string>

namespace pf::golden {
namespace {

class GoldenTest : public ::testing::Test {
protected:
    void SetUp() override {
        const ::testing::TestInfo* test = ::testing::UnitTest::GetInstance()->current_test_info();
        m_root = std::filesystem::path(::testing::TempDir()) / (std::string("pf_golden_") + test->name());
        std::filesystem::remove_all(m_root);
        m_settings = {.expectedRoot = m_root / "expected", .outputRoot = m_root / "output", .update = false};
    }
    void TearDown() override { std::filesystem::remove_all(m_root); }

    [[nodiscard]] GoldenSettings settings(bool update = false) const {
        GoldenSettings result = m_settings;
        result.update = update;
        return result;
    }
    [[nodiscard]] std::filesystem::path expectedPath() const {
        return m_settings.expectedRoot / "feature" / "case.expected.exr";
    }
    [[nodiscard]] std::filesystem::path actualPath() const {
        return m_settings.outputRoot / "feature" / "case.actual.exr";
    }
    [[nodiscard]] std::filesystem::path differencePath() const {
        return m_settings.outputRoot / "feature" / "case.diff.exr";
    }

private:
    std::filesystem::path m_root;
    GoldenSettings m_settings;
};

Image ramp(float scale) {
    const Box frame{.minX = 0, .minY = 0, .maxX = 7, .maxY = 3};
    Image image = Image::create(frame, frame, {"R", "Z"});
    for (std::size_t i = 0; i < image.pixelCount(); ++i) {
        image.channel("R").samples[i] = scale * static_cast<float>(i);
        image.channel("Z").samples[i] = 100.0F;
    }
    return image;
}

TEST_F(GoldenTest, MissingExpectedImageFailsAndWritesTheActualOne) {
    const ::testing::AssertionResult result = matchesGolden(ramp(1.0F), "feature/case", {}, settings());
    EXPECT_FALSE(result);
    const std::string message = result.message();
    EXPECT_NE(message.find("there is no expected image"), std::string::npos) << message;
    EXPECT_NE(message.find("update-golden"), std::string::npos) << message;
    EXPECT_FALSE(std::filesystem::exists(expectedPath()));
    ASSERT_TRUE(std::filesystem::exists(actualPath()));
    EXPECT_EQ(readExr(actualPath()).channel("R").samples, ramp(1.0F).channel("R").samples);
}

TEST_F(GoldenTest, UpdateModeCreatesTheExpectedImage) {
    EXPECT_TRUE(matchesGolden(ramp(1.0F), "feature/case", {}, settings(true)));
    ASSERT_TRUE(std::filesystem::exists(expectedPath()));
    EXPECT_TRUE(matchesGolden(ramp(1.0F), "feature/case", {}, settings()));
    EXPECT_FALSE(std::filesystem::exists(actualPath()));
}

TEST_F(GoldenTest, MismatchFailsAndWritesTheActualAndDifferenceImages) {
    writeExr(expectedPath(), ramp(1.0F));
    const ::testing::AssertionResult result = matchesGolden(ramp(1.01F), "feature/case", {}, settings());
    EXPECT_FALSE(result);
    const std::string message = result.message();
    EXPECT_NE(message.find("golden feature/case differs from"), std::string::npos) << message;
    EXPECT_NE(message.find("R: 31 of 32 samples over tolerance"), std::string::npos) << message;
    EXPECT_NE(message.find("difference image:"), std::string::npos) << message;

    const Image difference = readExr(differencePath());
    EXPECT_NEAR(difference.channel("R").samples[31], 0.31F, 1e-5F); // |31 × 1.01 − 31| in float
    EXPECT_EQ(difference.channel("Z").samples[31], 0.0F);
    EXPECT_EQ(difference.channel("golden.failed").samples[0], 0.0F);
    EXPECT_EQ(difference.channel("golden.failed").samples[31], 1.0F);
    EXPECT_EQ(readExr(actualPath()).channel("R").samples, ramp(1.01F).channel("R").samples);
    EXPECT_EQ(readExr(expectedPath()).channel("R").samples, ramp(1.0F).channel("R").samples); // untouched
}

TEST_F(GoldenTest, StructuralMismatchWritesNoDifferenceImage) {
    writeExr(expectedPath(), ramp(1.0F));
    Image actual = ramp(1.0F);
    actual.addChannel("G");
    const ::testing::AssertionResult result = matchesGolden(actual, "feature/case", {}, settings());
    EXPECT_FALSE(result);
    EXPECT_NE(std::string(result.message()).find("unexpected channel 'G'"), std::string::npos);
    EXPECT_TRUE(std::filesystem::exists(actualPath()));
    EXPECT_FALSE(std::filesystem::exists(differencePath()));
}

TEST_F(GoldenTest, UpdateModeRewritesAMismatchingExpectedImage) {
    writeExr(expectedPath(), ramp(1.0F));
    EXPECT_TRUE(matchesGolden(ramp(2.0F), "feature/case", {}, settings(true)));
    EXPECT_EQ(readExr(expectedPath()).channel("R").samples, ramp(2.0F).channel("R").samples);
    EXPECT_FALSE(std::filesystem::exists(actualPath()));
}

TEST_F(GoldenTest, UpdateModeLeavesAMatchingExpectedImageAlone) {
    writeExr(expectedPath(), ramp(1.0F));
    const auto written = std::filesystem::last_write_time(expectedPath());
    Image withinTolerance = ramp(1.0F);
    withinTolerance.channel("R").samples[3] += 1e-5F;
    EXPECT_TRUE(matchesGolden(withinTolerance, "feature/case", {}, settings(true)));
    EXPECT_EQ(std::filesystem::last_write_time(expectedPath()), written);
    EXPECT_EQ(readExr(expectedPath()).channel("R").samples, ramp(1.0F).channel("R").samples);
}

TEST_F(GoldenTest, PassingRemovesTheOutputOfAnEarlierFailure) {
    writeExr(expectedPath(), ramp(1.0F));
    EXPECT_FALSE(matchesGolden(ramp(1.5F), "feature/case", {}, settings()));
    ASSERT_TRUE(std::filesystem::exists(actualPath()));
    ASSERT_TRUE(std::filesystem::exists(differencePath()));
    EXPECT_TRUE(matchesGolden(ramp(1.0F), "feature/case", {}, settings()));
    EXPECT_FALSE(std::filesystem::exists(actualPath()));
    EXPECT_FALSE(std::filesystem::exists(differencePath()));
}

TEST_F(GoldenTest, ComparisonOptionsApply) {
    writeExr(expectedPath(), ramp(1.0F));
    CompareOptions loose;
    loose.tolerance.absolute = 1.0;
    EXPECT_TRUE(matchesGolden(ramp(1.01F), "feature/case", loose, settings()));
}

TEST_F(GoldenTest, UnreadableExpectedImageFails) {
    std::filesystem::create_directories(expectedPath().parent_path());
    std::ofstream(expectedPath(), std::ios::binary) << "not an EXR file";
    const ::testing::AssertionResult result = matchesGolden(ramp(1.0F), "feature/case", {}, settings());
    EXPECT_FALSE(result);
    EXPECT_NE(std::string(result.message()).find("cannot read EXR"), std::string::npos) << result.message();
}

TEST_F(GoldenTest, RejectsInvalidCaseIds) {
    for (const char* caseId : {"", "case", "feature/", "/case", "a/b/c", "../case", "feature/../case", "feature/ca se",
                               "feature/case.exr"}) {
        const ::testing::AssertionResult result = matchesGolden(ramp(1.0F), caseId, {}, settings(true));
        EXPECT_FALSE(result) << caseId;
        EXPECT_NE(std::string(result.message()).find("invalid golden case id"), std::string::npos) << caseId;
    }
}

TEST(GoldenSettingsTest, DefaultsPointIntoTheSourceAndBuildTrees) {
    const GoldenSettings defaults = defaultGoldenSettings();
    EXPECT_TRUE(std::filesystem::is_directory(defaults.expectedRoot)) << defaults.expectedRoot;
    EXPECT_EQ(defaults.expectedRoot.filename(), "golden");
    EXPECT_EQ(defaults.outputRoot.filename(), "golden-output");
}

} // namespace
} // namespace pf::golden
