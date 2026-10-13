// EXR header attributes as metadata (FORMAT_NOTES §22.5): every attribute type OpenEXR defines, with its typed value
// and display text, read through the EXR reader from a file OpenEXR wrote.

#include "io/exr/ExrMetadata.h"

#include "io/ImageReader.h"
#include "io/Metadata.h"
#include "io/exr/ExrReader.h"
#include "support/exr/ExrFixture.h"
#include "support/nodes/TestBench.h"

#include <Imath/ImathBox.h>
#include <Imath/ImathMatrix.h>
#include <Imath/ImathVec.h>
#include <OpenEXR/ImfBoxAttribute.h>
#include <OpenEXR/ImfDoubleAttribute.h>
#include <OpenEXR/ImfFloatAttribute.h>
#include <OpenEXR/ImfFloatVectorAttribute.h>
#include <OpenEXR/ImfHeader.h>
#include <OpenEXR/ImfIntAttribute.h>
#include <OpenEXR/ImfMatrixAttribute.h>
#include <OpenEXR/ImfPreviewImage.h>
#include <OpenEXR/ImfStandardAttributes.h>
#include <OpenEXR/ImfStringAttribute.h>
#include <OpenEXR/ImfStringVectorAttribute.h>
#include <OpenEXR/ImfVecAttribute.h>
#include <gtest/gtest.h>

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace pf::io {
namespace {

void decorate(Imf::Header& header) {
    header.insert("comments", Imf::StringAttribute("Rendered in Blender"));
    header.insert("frames", Imf::IntAttribute(42));
    header.insert("exposure", Imf::FloatAttribute(0.64F));
    header.insert("focus", Imf::DoubleAttribute(1.0 / 3.0));
    header.insert("offset", Imf::V2iAttribute(Imath::V2i(3, -4)));
    header.insert("centre", Imf::V2fAttribute(Imath::V2f(0.5F, 0.25F)));
    header.insert("position", Imf::V3fAttribute(Imath::V3f(1.0F, 2.5F, -3.0F)));
    header.insert("crop", Imf::Box2iAttribute(Imath::Box2i(Imath::V2i(0, 0), Imath::V2i(1919, 1079))));
    header.insert("worldToCamera", Imf::M44fAttribute(Imath::M44f()));
    header.insert("names", Imf::StringVectorAttribute(Imf::StringVector{"left", "right"}));
    header.insert("weights", Imf::FloatVectorAttribute(Imf::FloatVector{0.5F, 1.5F}));
    Imf::addChromaticities(header, Imf::Chromaticities()); // Rec. 709 primaries, D65 white
    Imf::addFramesPerSecond(header, Imf::Rational(24000, 1001));
    Imf::addTimeCode(header, Imf::TimeCode(1, 2, 3, 4));
    Imf::addKeyCode(header, Imf::KeyCode(1, 2, 3, 4, 5, 4, 64));
    Imf::addEnvmap(header, Imf::ENVMAP_LATLONG);
    header.setPreviewImage(Imf::PreviewImage(4, 3));
}

const MetadataEntry& entry(const MetadataGroup& group, const std::string& name) {
    const MetadataEntry* found = group.find(name);
    if (found == nullptr) {
        throw std::runtime_error("no metadata entry " + name);
    }
    return *found;
}

// A tiled single-part file with an attribute of every type (decorate()), read back as metadata.
class ExrMetadataOfEveryType : public ::testing::Test {
protected:
    void SetUp() override {
        testing::ExrPartSpec part;
        part.storage = testing::ExrStorage::Tiled;
        part.channels = {{.name = "R"}, {.name = "Z", .type = testing::ExrSample::Float}};
        part.decorate = decorate;
        testing::writeExrFixture(m_folder.file("meta.exr"), part);
        m_reader = openExr(m_folder.file("meta.exr"));
        ASSERT_EQ(m_reader->info().metadata.size(), 1U);
    }

    [[nodiscard]] const MetadataGroup& group() const { return m_reader->info().metadata[0]; }

    // The entry's type and text.
    [[nodiscard]] ::testing::AssertionResult has(const std::string& name, const std::string& type,
                                                 const std::string& text) const {
        const MetadataEntry* found = group().find(name);
        if (found == nullptr) {
            return ::testing::AssertionFailure() << "no entry " << name;
        }
        if (found->type != type || found->text != text) {
            return ::testing::AssertionFailure() << name << ": " << found->type << " '" << found->text << "'";
        }
        return ::testing::AssertionSuccess();
    }

private:
    testing::TemporaryFolder m_folder;
    std::unique_ptr<ImageReader> m_reader;
};

TEST_F(ExrMetadataOfEveryType, NumbersAndText) {
    EXPECT_EQ(group().name, "");
    EXPECT_TRUE(has("comments", "string", "Rendered in Blender"));
    EXPECT_EQ(std::get<std::string>(entry(group(), "comments").value), "Rendered in Blender");
    EXPECT_TRUE(has("frames", "int", "42"));
    EXPECT_EQ(std::get<std::int64_t>(entry(group(), "frames").value), 42);
    EXPECT_TRUE(has("exposure", "float", "0.64"));
    EXPECT_EQ(std::get<double>(entry(group(), "exposure").value), static_cast<double>(0.64F));
    EXPECT_TRUE(has("focus", "double", "0.3333333333333333"));
    EXPECT_TRUE(has("names", "stringvector", "left, right"));
    EXPECT_EQ(std::get<std::vector<std::string>>(entry(group(), "names").value),
              (std::vector<std::string>{"left", "right"}));
    EXPECT_TRUE(has("weights", "floatvector", "0.5, 1.5"));
}

TEST_F(ExrMetadataOfEveryType, VectorsBoxesAndMatrices) {
    EXPECT_TRUE(has("offset", "v2i", "(3, -4)"));
    EXPECT_EQ(std::get<std::vector<double>>(entry(group(), "offset").value), (std::vector<double>{3.0, -4.0}));
    EXPECT_TRUE(has("centre", "v2f", "(0.5, 0.25)"));
    EXPECT_TRUE(has("position", "v3f", "(1, 2.5, -3)"));
    EXPECT_TRUE(has("crop", "box2i", "(0, 0) – (1919, 1079)"));
    EXPECT_EQ(std::get<std::vector<double>>(entry(group(), "crop").value), (std::vector<double>{0, 0, 1919, 1079}));
    EXPECT_TRUE(has("worldToCamera", "m44f", "[1, 0, 0, 0; 0, 1, 0, 0; 0, 0, 1, 0; 0, 0, 0, 1]"));
    EXPECT_EQ(std::get<std::vector<double>>(entry(group(), "worldToCamera").value).size(), 16U);
    EXPECT_TRUE(has("chromaticities", "chromaticities",
                    "red (0.64, 0.33), green (0.3, 0.6), blue (0.15, 0.06), white (0.3127, 0.329)"));
    EXPECT_EQ(std::get<std::vector<double>>(entry(group(), "chromaticities").value).size(), 8U);
}

TEST_F(ExrMetadataOfEveryType, FilmAndTimeAttributes) {
    EXPECT_TRUE(has("framesPerSecond", "rational", "24000/1001"));
    EXPECT_EQ(std::get<std::vector<double>>(entry(group(), "framesPerSecond").value),
              (std::vector<double>{24000.0, 1001.0}));
    EXPECT_TRUE(has("timeCode", "timecode", "01:02:03:04"));
    EXPECT_TRUE(has("keyCode", "keycode",
                    "manufacturer 1, film type 2, prefix 3, count 4, perforation offset 5, 4 perforations per frame, "
                    "64 perforations per count"));
    EXPECT_TRUE(has("envmap", "envmap", "latitude-longitude"));
    EXPECT_TRUE(has("preview", "preview", "preview image, 4 × 3"));
    EXPECT_TRUE(std::holds_alternative<std::monostate>(entry(group(), "preview").value));
}

TEST_F(ExrMetadataOfEveryType, TheHeadersOwnAttributes) {
    EXPECT_TRUE(has("compression", "compression", "ZIP"));
    EXPECT_TRUE(has("lineOrder", "lineOrder", "increasing Y"));
    EXPECT_TRUE(has("dataWindow", "box2i", "(0, 0) – (63, 47)"));
    EXPECT_TRUE(has("channels", "chlist", "R (half), Z (float)"));
    EXPECT_TRUE(has("tiles", "tiledesc", "32 × 16 tiles, one level"));
    EXPECT_TRUE(has("pixelAspectRatio", "float", "1"));
}

TEST(ExrMetadata, PartsHaveTheirOwnGroups) {
    const testing::TemporaryFolder folder;
    std::vector<testing::ExrPartSpec> parts(2);
    parts[0].name = "ViewLayer.Combined";
    parts[0].channels = {{.name = "ViewLayer.Combined.R"}};
    parts[0].decorate = [](Imf::Header& header) {
        header.insert("colorInteropID", Imf::StringAttribute("lin_rec709_scene"));
    };
    parts[1].name = "ViewLayer.Depth";
    parts[1].channels = {{.name = "ViewLayer.Depth.Z", .type = testing::ExrSample::Float}};
    parts[1].decorate = [](Imf::Header& header) { header.insert("colorInteropID", Imf::StringAttribute("data")); };
    testing::writeExrFixture(folder.file("parts.exr"), parts);

    const std::unique_ptr<ImageReader> reader = openExr(folder.file("parts.exr"));
    const std::vector<MetadataGroup>& groups = reader->info().metadata;
    ASSERT_EQ(groups.size(), 2U);
    EXPECT_EQ(groups[0].name, "ViewLayer.Combined");
    EXPECT_EQ(entry(groups[0], "colorInteropID").text, "lin_rec709_scene");
    EXPECT_EQ(groups[1].name, "ViewLayer.Depth");
    EXPECT_EQ(entry(groups[1], "colorInteropID").text, "data");
    EXPECT_EQ(entry(groups[1], "name").text, "ViewLayer.Depth");
    EXPECT_EQ(groups[1].find("missing"), nullptr);
}

TEST(ExrMetadata, NamesOfCompressionsAndTimeCodes) {
    EXPECT_EQ(exr::compressionName(0), "None");
    EXPECT_EQ(exr::compressionName(8), "DWAA");
    EXPECT_EQ(exr::compressionName(10), "HTJ2K256");
    EXPECT_EQ(exr::compressionName(13), "ZSTD");
    EXPECT_EQ(exr::compressionName(14), "unknown (14)");
    EXPECT_EQ(exr::compressionName(-1), "unknown (-1)");
    // 23:59:58:29, drop-frame: BCD digits, bit 6 set.
    const std::uint32_t bits = (0x23U << 24U) | (0x59U << 16U) | (0x58U << 8U) | 0x29U | (1U << 6U);
    EXPECT_EQ(exr::timeCodeText(bits), "23:59:58;29");
    EXPECT_EQ(exr::timeCodeText(0), "00:00:00:00");
}

} // namespace
} // namespace pf::io
