// JSON forms of parameter values and keyframes (core/graph/ParamJson.h, FORMAT_NOTES §21.2).

#include "core/graph/ParamJson.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace pf::graph {
namespace {

std::vector<ParamDef> everyType() {
    return {floatParam("gain", "Gain", 1.0, 0.0, 10.0, 0.0, 4.0),
            intParam("steps", "Steps", 4, 1, 64),
            boolParam("invert", "Invert", false),
            enumParam("mode", "Mode", {{.id = "hold", .label = "Hold"}, {.id = "black", .label = "Black"}}),
            colorParam("tint", "Tint", {1.0, 1.0, 1.0, 1.0}),
            vector2Param("offset", "Offset", {0.0, 0.0}),
            vector3Param("position", "Position", {0.0, 0.0, 0.0}),
            stringParam("layer", "Layer"),
            fileParam("file", "File")};
}

TEST(ParamJson, WritesEachTypeInItsOwnForm) {
    const std::vector<ParamDef> defs = everyType();
    const std::vector<ParamValue> values = {1.5,
                                            std::int64_t{12},
                                            true,
                                            std::int64_t{1},
                                            Rgba{0.25, 0.5, 2.0, 1.0},
                                            Vec2{-3.0, 4.5},
                                            Vec3{1.0, 2.0, 3.0},
                                            std::string("diffuse"),
                                            std::string("/renders/šuma/beauty.exr")};
    const std::vector<std::string> expected = {"1.5",
                                               "12",
                                               "true",
                                               "\"black\"",
                                               "[0.25,0.5,2.0,1.0]",
                                               "[-3.0,4.5]",
                                               "[1.0,2.0,3.0]",
                                               "\"diffuse\"",
                                               "\"/renders/šuma/beauty.exr\""};
    for (std::size_t i = 0; i < defs.size(); ++i) {
        const json::Value written = toJson(defs[i], values[i]);
        EXPECT_EQ(json::write(written), expected[i]) << defs[i].id;
        EXPECT_EQ(paramValueFromJson(defs[i], json::parse(json::write(written))), values[i]) << defs[i].id;
    }
}

TEST(ParamJson, AcceptsWhatPeopleWriteByHand) {
    const std::vector<ParamDef> defs = everyType();
    EXPECT_EQ(paramValueFromJson(defs[0], 2), ParamValue{2.0});
    EXPECT_EQ(paramValueFromJson(defs[1], 7.0), ParamValue{std::int64_t{7}});
    EXPECT_EQ(paramValueFromJson(defs[3], 0), ParamValue{std::int64_t{0}});
    EXPECT_EQ(paramValueFromJson(defs[3], "hold"), ParamValue{std::int64_t{0}});
    const json::Value noAlpha = json::Array{1, 0, 0};
    EXPECT_EQ(paramValueFromJson(defs[4], noAlpha), (ParamValue{Rgba{1.0, 0.0, 0.0, 1.0}}));
    // Not clamped yet: normalized() does that when the value is set.
    EXPECT_EQ(paramValueFromJson(defs[0], 99.0), ParamValue{99.0});
}

TEST(ParamJson, RefusesValuesOfTheWrongForm) {
    const std::vector<ParamDef> defs = everyType();
    const auto refuses = [&](std::size_t def, const json::Value& value) {
        EXPECT_THROW((void)paramValueFromJson(defs[def], value), std::invalid_argument)
            << defs[def].id << " " << json::write(value);
    };
    refuses(0, "1.5");
    refuses(0, true);
    refuses(1, 1.5);
    refuses(1, 1e300);
    refuses(2, 1);
    refuses(3, "grey");
    refuses(3, 2);
    refuses(3, -1);
    refuses(4, json::Array{1, 2});
    refuses(4, json::Array{1, 2, 3, 4, 5});
    refuses(4, json::Array{1, "2", 3});
    refuses(5, json::Array{1});
    refuses(6, json::Object{});
    refuses(7, 3);
    refuses(8, nullptr);
    try {
        (void)paramValueFromJson(defs[3], "grey");
    } catch (const std::invalid_argument& error) {
        EXPECT_STREQ(error.what(), "parameter 'mode' needs one of its items, not 'grey'");
    }
}

TEST(ParamJson, KeyframesRoundTrip) {
    const anim::Keyframe linear{.frame = 12.0, .value = 0.5, .interpolation = anim::Interpolation::Linear};
    EXPECT_EQ(json::write(toJson(linear)), R"({"frame":12.0,"value":0.5,"interpolation":"linear"})");
    EXPECT_EQ(keyframeFromJson(toJson(linear)), linear);

    const anim::Keyframe bezier{.frame = -3.5,
                                .value = 2.0,
                                .interpolation = anim::Interpolation::Bezier,
                                .inSlope = 0.25,
                                .outSlope = -1.0,
                                .inWeight = 0.5,
                                .outWeight = 0.1};
    EXPECT_EQ(keyframeFromJson(json::parse(json::write(toJson(bezier)))), bezier);

    // Only frame and value are required.
    EXPECT_EQ(keyframeFromJson(json::Object{{"frame", 1}, {"value", 2}}), (anim::Keyframe{.frame = 1.0, .value = 2.0}));
    EXPECT_THROW((void)keyframeFromJson(json::Object{{"frame", 1}}), std::invalid_argument);
    EXPECT_THROW((void)keyframeFromJson(json::Object{{"frame", 1}, {"value", "x"}}), std::invalid_argument);
    EXPECT_THROW((void)keyframeFromJson(json::Object{{"frame", 1}, {"value", 2}, {"interpolation", "ease"}}),
                 std::invalid_argument);
    EXPECT_THROW((void)keyframeFromJson(json::Array{}), std::invalid_argument);
}

TEST(ParamJson, InterpolationAndExtrapolationNames) {
    for (const anim::Interpolation i : {anim::Interpolation::Constant, anim::Interpolation::Linear,
                                        anim::Interpolation::Smooth, anim::Interpolation::Bezier}) {
        EXPECT_EQ(interpolationFromString(toString(i)), i);
    }
    EXPECT_EQ(toString(anim::Interpolation::Smooth), "smooth");
    EXPECT_FALSE(interpolationFromString("Linear"));
    EXPECT_EQ(extrapolationFromString("linear"), anim::Extrapolation::Linear);
    EXPECT_EQ(toString(anim::Extrapolation::Constant), "constant");
    EXPECT_FALSE(extrapolationFromString("cycle"));
}

} // namespace
} // namespace pf::graph
