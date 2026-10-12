// EXR reading and writing of the golden harness (support/golden/ExrFile.h).

#include "support/golden/ExrFile.h"

#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>

namespace pf::golden {
namespace {

class ExrFileTest : public ::testing::Test {
protected:
    void SetUp() override {
        const ::testing::TestInfo* test = ::testing::UnitTest::GetInstance()->current_test_info();
        m_folder = std::filesystem::path(::testing::TempDir()) / (std::string("pf_exr_") + test->name());
        std::filesystem::remove_all(m_folder);
    }
    void TearDown() override { std::filesystem::remove_all(m_folder); }

    [[nodiscard]] const std::filesystem::path& folder() const { return m_folder; }

private:
    std::filesystem::path m_folder;
};

// Overscan (data window larger than the frame on two sides, smaller on the others), negative coordinates, HDR,
// negative and non-finite values, and render-pass channel names.
Image sampleImage() {
    Image image =
        Image::create({.minX = 0, .minY = 0, .maxX = 15, .maxY = 7}, {.minX = -3, .minY = -2, .maxX = 12, .maxY = 9},
                      {"R", "G", "B", "A", "diffuse_direct.R"});
    for (std::size_t i = 0; i < image.pixelCount(); ++i) {
        const auto t = static_cast<float>(i);
        image.channel("R").samples[i] = 0.001F * t * t;     // up to about 36
        image.channel("G").samples[i] = 0.5F - (0.01F * t); // crosses zero
        image.channel("B").samples[i] = std::sin(t);
        image.channel("A").samples[i] = 1.0F;
        image.channel("diffuse_direct.R").samples[i] = 1.0e6F + t;
    }
    image.channel("A").samples[5] = std::numeric_limits<float>::quiet_NaN();
    image.channel("A").samples[6] = std::numeric_limits<float>::infinity();
    image.channel("A").samples[7] = -std::numeric_limits<float>::infinity();
    return image;
}

bool sameSample(float a, float b) {
    return (std::isnan(a) && std::isnan(b)) || a == b;
}

TEST_F(ExrFileTest, FloatRoundTripIsExact) {
    const Image written = sampleImage();
    const std::filesystem::path path = folder() / "nested" / "folder" / "image.exr"; // parents are created
    writeExr(path, written);
    const Image read = readExr(path);

    EXPECT_EQ(read.displayWindow, written.displayWindow);
    EXPECT_EQ(read.dataWindow, written.dataWindow);
    ASSERT_EQ(read.channels.size(), written.channels.size());
    for (const Channel& channel : written.channels) {
        const Channel* readChannel = read.find(channel.name);
        ASSERT_NE(readChannel, nullptr) << channel.name;
        ASSERT_EQ(readChannel->samples.size(), channel.samples.size());
        for (std::size_t i = 0; i < channel.samples.size(); ++i) {
            EXPECT_TRUE(sameSample(readChannel->samples[i], channel.samples[i]))
                << channel.name << " sample " << i << ": " << readChannel->samples[i] << " vs " << channel.samples[i];
        }
    }
    EXPECT_FALSE(std::filesystem::exists(path.string() + ".partial"));
}

TEST_F(ExrFileTest, HalfRoundTripKeepsHalfPrecision) {
    Image written = sampleImage();
    written.channels.pop_back(); // 1e6 is beyond the half range
    const std::filesystem::path path = folder() / "half.exr";
    writeExr(path, written, SampleType::Half);
    const Image read = readExr(path);
    for (const Channel& channel : written.channels) {
        const Channel& readChannel = read.channel(channel.name);
        for (std::size_t i = 0; i < channel.samples.size(); ++i) {
            const float value = channel.samples[i];
            if (!std::isfinite(value)) {
                EXPECT_TRUE(sameSample(readChannel.samples[i], value)) << channel.name << " sample " << i;
                continue;
            }
            // Half keeps 11 significant bits; tiny values become subnormal (absolute steps of about 6e-8).
            EXPECT_NEAR(readChannel.samples[i], value, (std::abs(value) * 4.9e-4F) + 6e-8F)
                << channel.name << " sample " << i;
        }
    }
}

TEST_F(ExrFileTest, ReplacesAnExistingFile) {
    const std::filesystem::path path = folder() / "image.exr";
    writeExr(path, sampleImage());
    Image smaller = Image::create({.minX = 0, .minY = 0, .maxX = 1, .maxY = 1},
                                  {.minX = 0, .minY = 0, .maxX = 1, .maxY = 1}, {"Y"});
    smaller.channel("Y").samples = {1.0F, 2.0F, 3.0F, 4.0F};
    writeExr(path, smaller);
    const Image read = readExr(path);
    ASSERT_EQ(read.channels.size(), 1U);
    EXPECT_EQ(read.channel("Y").samples, smaller.channel("Y").samples);
}

TEST_F(ExrFileTest, MissingFileThrowsWithItsPath) {
    const std::filesystem::path path = folder() / "missing.exr";
    try {
        static_cast<void>(readExr(path));
        FAIL() << "readExr did not throw";
    } catch (const std::runtime_error& error) {
        const std::string message = error.what();
        EXPECT_NE(message.find("missing.exr"), std::string::npos) << message;
        EXPECT_NE(message.find("does not exist"), std::string::npos) << message;
    }
}

TEST_F(ExrFileTest, GarbageFileThrows) {
    std::filesystem::create_directories(folder());
    const std::filesystem::path path = folder() / "garbage.exr";
    std::ofstream(path, std::ios::binary) << "this is not an EXR file";
    EXPECT_THROW(static_cast<void>(readExr(path)), std::runtime_error);
}

TEST_F(ExrFileTest, TruncatedFileThrows) {
    const std::filesystem::path path = folder() / "truncated.exr";
    writeExr(path, sampleImage());
    const auto size = std::filesystem::file_size(path);
    for (const auto keep : {size / 2, size - 1, std::uintmax_t{40}}) {
        writeExr(path, sampleImage());
        std::filesystem::resize_file(path, keep);
        EXPECT_THROW(static_cast<void>(readExr(path)), std::runtime_error) << "kept " << keep << " of " << size;
    }
}

TEST_F(ExrFileTest, RejectsChannelsWithTheWrongSampleCount) {
    Image image = sampleImage();
    image.channel("G").samples.pop_back();
    const std::filesystem::path path = folder() / "bad.exr";
    EXPECT_THROW(writeExr(path, image), std::runtime_error);
    EXPECT_FALSE(std::filesystem::exists(path));
}

} // namespace
} // namespace pf::golden
