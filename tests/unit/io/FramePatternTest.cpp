// Frame numbers in file names and frame patterns (io/sequence/FramePattern.h, FORMAT_NOTES §23.1–23.2).

#include "io/sequence/FramePattern.h"

#include "io/ImageReader.h"

#include <gtest/gtest.h>

#include <filesystem>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace pf::io {
namespace {

// The value of `optional`; throws (failing the test) when there is none.
template <class T>
T need(std::optional<T> optional) {
    if (!optional) {
        throw std::runtime_error("expected a value, got none");
    }
    return std::move(*optional);
}

FrameNumberedName split(const std::string& prefix, std::int64_t frame, int digits, const std::string& suffix) {
    return {.prefix = prefix, .frame = frame, .digits = digits, .suffix = suffix};
}

TEST(FramePattern, FindsTheFrameNumberInCommonNames) {
    EXPECT_EQ(splitFrameNumber("name.1001.exr"), split("name.", 1001, 4, ".exr"));
    EXPECT_EQ(splitFrameNumber("name_1001.exr"), split("name_", 1001, 4, ".exr"));
    EXPECT_EQ(splitFrameNumber("render0007.exr"), split("render", 7, 4, ".exr")); // Blender's default
    EXPECT_EQ(splitFrameNumber("shot010_v002.1001.exr"), split("shot010_v002.", 1001, 4, ".exr"));
    EXPECT_EQ(splitFrameNumber("beauty.1001.cryptomatte.exr"), split("beauty.", 1001, 4, ".cryptomatte.exr"));
    EXPECT_EQ(splitFrameNumber("IMG_4021.JPG"), split("IMG_", 4021, 4, ".JPG"));
    EXPECT_EQ(splitFrameNumber("frame7"), split("frame", 7, 1, ""));
    EXPECT_EQ(splitFrameNumber("0001.exr"), split("", 1, 4, ".exr"));
    EXPECT_EQ(splitFrameNumber("čaša 12.exr"), split("čaša ", 12, 2, ".exr"));
}

TEST(FramePattern, MinusSignsAfterSeparatorsMakeNegativeFrames) {
    EXPECT_EQ(splitFrameNumber("name.-0005.exr"), split("name.", -5, 4, ".exr"));
    EXPECT_EQ(splitFrameNumber("name_-12.exr"), split("name_", -12, 2, ".exr"));
    EXPECT_EQ(splitFrameNumber("name -3.exr"), split("name ", -3, 1, ".exr"));
    EXPECT_EQ(splitFrameNumber("-0003.exr"), split("", -3, 4, ".exr"));
    // A dash inside a name is part of it; "-0" is no negative frame.
    EXPECT_EQ(splitFrameNumber("shot-0001.exr"), split("shot-", 1, 4, ".exr"));
    EXPECT_EQ(splitFrameNumber("name.-0000.exr"), split("name.-", 0, 4, ".exr"));
}

TEST(FramePattern, NamesWithoutAFrameNumber) {
    EXPECT_EQ(splitFrameNumber("beauty.exr"), std::nullopt);
    EXPECT_EQ(splitFrameNumber("v2.exr"), split("v", 2, 1, ".exr"));    // a number is a number
    EXPECT_EQ(splitFrameNumber("render_1234567890.exr"), std::nullopt); // 10 digits: a date or a time
    EXPECT_EQ(splitFrameNumber("render_123456789.exr"), split("render_", 123456789, 9, ".exr"));
    EXPECT_EQ(splitFrameNumber(".exr"), std::nullopt);
    EXPECT_EQ(splitFrameNumber(""), std::nullopt);
}

TEST(FramePattern, ReadsPlaceholders) {
    const FramePattern hashes = need(FramePattern::parse("/renders/shot/render.####.exr"));
    EXPECT_EQ(hashes.folder(), std::filesystem::path("/renders/shot"));
    EXPECT_EQ(hashes.prefix(), "render.");
    EXPECT_EQ(hashes.padding(), 4);
    EXPECT_EQ(hashes.suffix(), ".exr");

    EXPECT_EQ(FramePattern::parse("/r/render.@@@.exr"), FramePattern("/r", "render.", 3, ".exr"));
    EXPECT_EQ(FramePattern::parse("/r/render.%04d.exr"), FramePattern("/r", "render.", 4, ".exr"));
    EXPECT_EQ(FramePattern::parse("/r/render.%d.exr"), FramePattern("/r", "render.", 1, ".exr"));
    EXPECT_EQ(FramePattern::parse("/r/render#.exr"), FramePattern("/r", "render", 1, ".exr"));
    EXPECT_EQ(FramePattern::parse("render_#########.tif"), FramePattern("", "render_", 9, ".tif"));
}

TEST(FramePattern, OnlyTheLastPlaceholderOfTheFileNameCounts) {
    EXPECT_EQ(FramePattern::parse("/r/take#2_%03d.exr"), FramePattern("/r", "take#2_", 3, ".exr"));
    EXPECT_EQ(FramePattern::parse("/r/a%04d_b##.exr"), FramePattern("/r", "a%04d_b", 2, ".exr"));
    // A '#' in a folder name is just a character.
    EXPECT_EQ(FramePattern::parse("/renders/#1/render####.exr"), FramePattern("/renders/#1", "render", 4, ".exr"));
}

TEST(FramePattern, PathsWithoutAPlaceholderAreNoPatterns) {
    EXPECT_EQ(FramePattern::parse("/renders/render0001.exr"), std::nullopt);
    EXPECT_EQ(FramePattern::parse("/renders/####/render.exr"), std::nullopt);
    EXPECT_EQ(FramePattern::parse("/r/render.%4d.exr"), std::nullopt); // space padding is not used for files
    EXPECT_EQ(FramePattern::parse("/r/render.%00d.exr"), std::nullopt);
    EXPECT_EQ(FramePattern::parse("/r/render.%010d.exr"), std::nullopt); // longer than 9 digits
    EXPECT_EQ(FramePattern::parse("/r/render.##########.exr"), std::nullopt);
    EXPECT_EQ(FramePattern::parse(""), std::nullopt);
}

TEST(FramePattern, WritesFileNames) {
    const FramePattern pattern("/r", "render.", 4, ".exr");
    EXPECT_EQ(pattern.fileName(7), "render.0007.exr");
    EXPECT_EQ(pattern.fileName(0), "render.0000.exr");
    EXPECT_EQ(pattern.fileName(12345), "render.12345.exr");
    EXPECT_EQ(pattern.fileName(-5), "render.-0005.exr");
    EXPECT_EQ(pattern.fileNames(7), (std::vector<std::string>{"render.0007.exr"}));
    EXPECT_EQ(pattern.fileNames(-5), (std::vector<std::string>{"render.-0005.exr", "render.-005.exr"}));
    EXPECT_EQ(pattern.fileNames(-1234), (std::vector<std::string>{"render.-1234.exr"}));
    EXPECT_EQ(FramePattern("", "f", 1, "").fileNames(-3), (std::vector<std::string>{"f-3"}));
    EXPECT_THROW((void)pattern.fileName(1'000'000'000), std::out_of_range);
    EXPECT_EQ(pattern.fileNameText(), "render.####.exr");
    EXPECT_EQ(pattern.text(), pathToUtf8(std::filesystem::path("/r") / "render.####.exr"));
}

TEST(FramePattern, FindsFramesWrittenWithAnyPadding) {
    const FramePattern pattern("/r", "render.", 4, ".exr");
    EXPECT_EQ(pattern.frameOf("render.0007.exr"), 7);
    EXPECT_EQ(pattern.frameOf("render.7.exr"), 7);
    EXPECT_EQ(pattern.frameOf("render.000000007.exr"), 7);
    EXPECT_EQ(pattern.frameOf("render.12345.exr"), 12345);
    EXPECT_EQ(pattern.frameOf("render.-0005.exr"), -5);
    EXPECT_EQ(pattern.frameOf("render.-005.exr"), -5);

    EXPECT_EQ(pattern.frameOf("render.-0000.exr"), std::nullopt);
    EXPECT_EQ(pattern.frameOf("render.0007.tif"), std::nullopt);
    EXPECT_EQ(pattern.frameOf("Render.0007.exr"), std::nullopt); // names are compared exactly
    EXPECT_EQ(pattern.frameOf("render.v007.exr"), std::nullopt);
    EXPECT_EQ(pattern.frameOf("render..exr"), std::nullopt);
    EXPECT_EQ(pattern.frameOf("render.-.exr"), std::nullopt);
    EXPECT_EQ(pattern.frameOf("render.exr"), std::nullopt);
    EXPECT_EQ(pattern.frameOf("render.0000000007.exr"), std::nullopt); // 10 digits
}

TEST(FramePattern, RefusesImpossiblePatterns) {
    EXPECT_THROW(FramePattern("/r", "render.", 0, ".exr"), std::invalid_argument);
    EXPECT_THROW(FramePattern("/r", "render.", 10, ".exr"), std::invalid_argument);
    EXPECT_THROW(FramePattern("/r", "sub/render.", 4, ".exr"), std::invalid_argument);
    EXPECT_THROW(FramePattern("/r", "render.", 4, "/x.exr"), std::invalid_argument);
}

} // namespace
} // namespace pf::io
