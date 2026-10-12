// The image format registry, UTF-8 paths and file stamps (io/ImageReader.h, io/FileStamp.h).

#include "io/ImageReader.h"

#include "io/FileStamp.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>

namespace pf::io {
namespace {

ImageFormat fakeFormat(std::string name, std::vector<std::string> extensions) {
    return {.name = std::move(name),
            .extensions = std::move(extensions),
            .open = [](const std::filesystem::path& file) -> std::unique_ptr<ImageReader> {
                throw FileError("cannot open " + pathToUtf8(file) + ": fake format");
            }};
}

TEST(FormatRegistry, FindsFormatsByExtensionIgnoringCase) {
    FormatRegistry registry;
    registry.add(fakeFormat("OpenEXR", {"EXR"}));
    registry.add(fakeFormat("TIFF", {"tif", "tiff"}));
    ASSERT_NE(registry.formatFor("/renders/beauty.0001.exr"), nullptr);
    EXPECT_EQ(registry.formatFor("/renders/beauty.0001.exr")->name, "OpenEXR");
    EXPECT_EQ(registry.formatFor("C:/plates/PLATE.TIFF")->name, "TIFF");
    EXPECT_EQ(registry.formatFor("notes.txt"), nullptr);
    EXPECT_EQ(registry.formatFor("no_extension"), nullptr);
}

TEST(FormatRegistry, RefusesIncompleteOrClashingFormats) {
    FormatRegistry registry;
    registry.add(fakeFormat("OpenEXR", {"exr"}));
    EXPECT_THROW(registry.add(fakeFormat("Other EXR", {"Exr"})), std::invalid_argument);
    EXPECT_THROW(registry.add(fakeFormat("", {"png"})), std::invalid_argument);
    EXPECT_THROW(registry.add(fakeFormat("PNG", {})), std::invalid_argument);
    EXPECT_THROW(registry.add({.name = "PNG", .extensions = {"png"}, .open = {}}), std::invalid_argument);
}

TEST(FormatRegistry, OpeningExplainsWhatWentWrong) {
    const testing::TemporaryFolder folder;
    FormatRegistry registry;
    registry.add(fakeFormat("Fake", {"fake"}));
    const auto messageOf = [&](const std::filesystem::path& file) {
        try {
            (void)registry.open(file);
        } catch (const FileError& error) {
            return std::string(error.what());
        }
        return std::string("(no error)");
    };
    EXPECT_NE(messageOf(folder.file("gone.fake")).find("the file does not exist"), std::string::npos);
    EXPECT_NE(messageOf(folder.path()).find("it is not a file"), std::string::npos);
    std::ofstream(folder.file("notes.txt")) << "text";
    EXPECT_NE(messageOf(folder.file("notes.txt")).find("no image format reads .txt files"), std::string::npos);
    std::ofstream(folder.file("thing.fake")) << "x";
    EXPECT_NE(messageOf(folder.file("thing.fake")).find("fake format"), std::string::npos);
}

TEST(Paths, Utf8RoundTrips) {
    const std::string name = "Šibenik/čaša_日本.exr";
    EXPECT_EQ(pathToUtf8(pathFromUtf8(name)), name);
    EXPECT_EQ(pathToUtf8(pathFromUtf8(name).filename()), "čaša_日本.exr");
}

TEST(FileStamp, ChangesWhenTheFileIsRewritten) {
    const testing::TemporaryFolder folder;
    const std::filesystem::path file = folder.file("frame.bin");
    EXPECT_FALSE(fileStamp(file).exists);
    EXPECT_FALSE(fileStamp(folder.path()).exists); // a folder is not a file
    std::ofstream(file, std::ios::binary) << "1234";
    const FileStamp first = fileStamp(file);
    EXPECT_TRUE(first.exists);
    EXPECT_EQ(first.size, 4U);
    EXPECT_EQ(fileStamp(file), first);
    std::ofstream(file, std::ios::binary) << "123456";
    EXPECT_NE(fileStamp(file), first);
}

} // namespace
} // namespace pf::io
