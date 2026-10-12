// Parameters (core/graph/Param.h): definitions, checking, clamping, components and hashing of values.

#include "core/graph/Param.h"

#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace pf::graph {
namespace {

TEST(Param, ComponentCounts) {
    EXPECT_EQ(componentCount(ParamType::Float), 1U);
    EXPECT_EQ(componentCount(ParamType::Int), 1U);
    EXPECT_EQ(componentCount(ParamType::Bool), 1U);
    EXPECT_EQ(componentCount(ParamType::Enum), 1U);
    EXPECT_EQ(componentCount(ParamType::Vector2), 2U);
    EXPECT_EQ(componentCount(ParamType::Vector3), 3U);
    EXPECT_EQ(componentCount(ParamType::Color), 4U);
    EXPECT_EQ(componentCount(ParamType::String), 0U);
    EXPECT_EQ(componentCount(ParamType::File), 0U);
}

TEST(Param, Identifiers) {
    EXPECT_TRUE(isIdentifier("exposure"));
    EXPECT_TRUE(isIdentifier("_private2"));
    EXPECT_TRUE(isIdentifier("Read1"));
    EXPECT_FALSE(isIdentifier(""));
    EXPECT_FALSE(isIdentifier("2nd"));
    EXPECT_FALSE(isIdentifier("key light"));
    EXPECT_FALSE(isIdentifier("a.b"));
    EXPECT_FALSE(isIdentifier("sjena\xC4\x8D")); // ASCII only
}

TEST(Param, FactoriesMakeValidDefinitions) {
    for (const ParamDef& def :
         {floatParam("exposure", "Exposure", 0.0, -20.0, 20.0, -20.0, 20.0), intParam("radius", "Radius", 3, 0, 100),
          boolParam("invert", "Invert", false),
          enumParam("mode", "Mode", {{.id = "hold", .label = "Hold"}, {.id = "loop", .label = "Loop"}}, 1),
          colorParam("tint", "Tint", {1.0, 0.5, 0.25, 1.0}), vector2Param("centre", "Centre", {0.5, 0.5}),
          vector3Param("position", "Position", {0.0, 1.0, 2.0}), stringParam("layer", "Layer"),
          fileParam("file", "File")}) {
        EXPECT_NO_THROW(validate(def)) << def.id;
    }
    EXPECT_FALSE(stringParam("layer", "Layer").animatable);
    EXPECT_FALSE(fileParam("file", "File").animatable);
}

TEST(Param, InconsistentDefinitionsAreRefused) {
    EXPECT_THROW(validate(floatParam("bad id", "Bad", 0.0, 0.0, 1.0, 0.0, 1.0)), std::invalid_argument);
    EXPECT_THROW(validate(floatParam("x", "", 0.0, 0.0, 1.0, 0.0, 1.0)), std::invalid_argument);
    EXPECT_THROW(validate(floatParam("x", "X", 2.0, 0.0, 1.0, 0.0, 1.0)), std::invalid_argument); // default outside
    EXPECT_THROW(validate(floatParam("x", "X", 0.5, 1.0, 0.0, 0.0, 1.0)), std::invalid_argument); // limits reversed
    ParamDef wrongType = floatParam("x", "X", 0.0, 0.0, 1.0, 0.0, 1.0);
    wrongType.defaultValue = std::int64_t{0};
    EXPECT_THROW(validate(wrongType), std::invalid_argument);
    EXPECT_THROW(validate(enumParam("mode", "Mode", {})), std::invalid_argument);
    EXPECT_THROW(validate(enumParam("mode", "Mode", {{.id = "a", .label = "A"}, {.id = "a", .label = "A again"}})),
                 std::invalid_argument);
    ParamDef animatedText = stringParam("layer", "Layer");
    animatedText.animatable = true;
    EXPECT_THROW(validate(animatedText), std::invalid_argument);
}

TEST(Param, ValuesAreCheckedAndClamped) {
    const ParamDef exposure = floatParam("exposure", "Exposure", 0.0, -20.0, 20.0, -20.0, 20.0);
    EXPECT_EQ(normalized(exposure, 25.0), ParamValue{20.0});
    EXPECT_EQ(normalized(exposure, -1.5), ParamValue{-1.5});
    EXPECT_THROW((void)normalized(exposure, std::numeric_limits<double>::quiet_NaN()), std::invalid_argument);
    EXPECT_THROW((void)normalized(exposure, std::numeric_limits<double>::infinity()), std::invalid_argument);
    EXPECT_THROW((void)normalized(exposure, std::int64_t{1}), std::invalid_argument);
    EXPECT_THROW((void)normalized(exposure, std::string("1")), std::invalid_argument);

    const ParamDef radius = intParam("radius", "Radius", 3, 0, 100);
    EXPECT_EQ(normalized(radius, std::int64_t{-4}), ParamValue{std::int64_t{0}});
    EXPECT_EQ(normalized(radius, std::int64_t{101}), ParamValue{std::int64_t{100}});

    const ParamDef mode = enumParam("mode", "Mode", {{.id = "a", .label = "A"}, {.id = "b", .label = "B"}});
    EXPECT_EQ(normalized(mode, std::int64_t{7}), ParamValue{std::int64_t{1}});

    ParamDef tint = colorParam("tint", "Tint", {1.0, 1.0, 1.0, 1.0});
    tint.minimum = 0.0;
    EXPECT_EQ(normalized(tint, Rgba{-1.0, 2.0, 0.5, 1.0}), (ParamValue{Rgba{0.0, 2.0, 0.5, 1.0}}));
}

TEST(Param, ComponentsRoundTrip) {
    const ParamDef radius = intParam("radius", "Radius", 3, 0, 100);
    const std::vector<double> half{2.5};
    const std::vector<double> below{-0.4};
    EXPECT_EQ(fromComponents(radius, half), ParamValue{std::int64_t{3}}); // to nearest, half away from zero
    EXPECT_EQ(fromComponents(radius, below), ParamValue{std::int64_t{0}});

    const ParamDef invert = boolParam("invert", "Invert", false);
    const std::vector<double> justBelow{0.49};
    const std::vector<double> atHalf{0.5};
    EXPECT_EQ(fromComponents(invert, justBelow), ParamValue{false});
    EXPECT_EQ(fromComponents(invert, atHalf), ParamValue{true});

    const ParamDef position = vector3Param("position", "Position", {0.0, 0.0, 0.0});
    const ParamValue value = Vec3{1.0, -2.0, 3.5};
    EXPECT_EQ(fromComponents(position, componentsOf(value)), value);
    EXPECT_TRUE(componentsOf(ParamValue{std::string("text")}).empty());
    EXPECT_THROW((void)fromComponents(position, half), std::invalid_argument);
}

TEST(Param, ValuesHashByContent) {
    const auto hashOf = [](const ParamValue& value) {
        Hasher hasher;
        addToHash(hasher, value);
        return hasher.finish();
    };
    EXPECT_EQ(hashOf(1.5), hashOf(1.5));
    EXPECT_NE(hashOf(1.5), hashOf(1.25));
    EXPECT_EQ(hashOf(0.0), hashOf(-0.0));
    EXPECT_NE(hashOf(1.0), hashOf(std::int64_t{1})); // the type is part of the hash
    EXPECT_NE(hashOf(std::string("ab")), hashOf(std::string("ba")));
    EXPECT_NE(hashOf(Vec2{1.0, 2.0}), hashOf(Vec2{2.0, 1.0}));
}

TEST(Param, ValuesForNodeCode) {
    const std::vector<ParamDef> defs{floatParam("gain", "Gain", 1.0, 0.0, 10.0, 0.0, 10.0),
                                     stringParam("layer", "Layer", "diffuse")};
    const ParamValues values(defs, {2.0, std::string("diffuse")});
    EXPECT_EQ(values.getFloat("gain"), 2.0);
    EXPECT_EQ(values.getString("layer"), "diffuse");
    EXPECT_THROW((void)values.getFloat("layer"), std::logic_error);
    EXPECT_THROW((void)values.get("missing"), std::out_of_range);
    EXPECT_THROW(ParamValues(defs, {2.0}), std::invalid_argument);
}

TEST(Param, ValuesPrintReadably) {
    EXPECT_EQ(toString(ParamValue{1.5}), "1.5");
    EXPECT_EQ(toString(ParamValue{std::int64_t{-3}}), "-3");
    EXPECT_EQ(toString(ParamValue{true}), "true");
    EXPECT_EQ(toString(ParamValue{Rgba{0.25, 0.5, 1.0, 1.0}}), "(0.25, 0.5, 1, 1)");
    EXPECT_EQ(toString(ParamValue{std::string("beauty")}), "\"beauty\"");
}

} // namespace
} // namespace pf::graph
