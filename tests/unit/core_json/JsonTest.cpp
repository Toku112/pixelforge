// JSON values, writing and strict reading (core/json/Json.h, FORMAT_NOTES §21.1).

#include "core/json/Json.h"

#include <gtest/gtest.h>

#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <limits>
#include <random>
#include <string>

namespace pf::json {
namespace {

TEST(Json, ValuesKeepTheirTypes) {
    EXPECT_TRUE(Value().isNull());
    EXPECT_TRUE(Value(nullptr).isNull());
    EXPECT_EQ(Value(true).asBool(), true);
    EXPECT_EQ(Value(42).asInt(), 42);
    EXPECT_EQ(Value(std::size_t{7}).asInt(), 7);
    EXPECT_EQ(Value(2.5).asNumber(), 2.5);
    EXPECT_EQ(Value(3).asNumber(), 3.0);
    EXPECT_EQ(Value("text").asString(), "text");
    EXPECT_EQ(Value(std::string_view("view")).asString(), "view");
    EXPECT_EQ(Value(Array{1, 2}).asArray().size(), 2U);
    EXPECT_EQ(Value(Object{{"a", 1}}).asObject().size(), 1U);

    EXPECT_NE(Value(1), Value(1.0)); // an integer is not a real number
    EXPECT_THROW((void)Value("text").asInt(), Error);
    EXPECT_THROW((void)Value(1.5).asInt(), Error);
    EXPECT_THROW((void)Value(1).asString(), Error);
    EXPECT_THROW((void)Value().asBool(), Error);
    EXPECT_THROW((void)Value(Array{}).asObject(), Error);
    EXPECT_THROW((void)Value(std::numeric_limits<std::uint64_t>::max()), Error);
}

TEST(Json, ObjectsKeepOrderAndUniqueKeys) {
    Object object{{"b", 1}, {"a", 2}, {"b", 3}};
    ASSERT_EQ(object.size(), 2U);
    EXPECT_EQ(object.at("b"), Value(3));
    object.set("c", "x");
    object.set("a", 4);
    EXPECT_EQ(write(object), R"({"b":3,"a":4,"c":"x"})");
    EXPECT_TRUE(object.contains("c"));
    EXPECT_EQ(object.find("missing"), nullptr);
    EXPECT_THROW((void)object.at("missing"), Error);
    EXPECT_TRUE(object.erase("b"));
    EXPECT_FALSE(object.erase("b"));
    EXPECT_EQ(write(object), R"({"a":4,"c":"x"})");

    // Equal whatever the order; different values or keys are not.
    EXPECT_EQ((Object{{"x", 1}, {"y", 2}}), (Object{{"y", 2}, {"x", 1}}));
    EXPECT_NE((Object{{"x", 1}, {"y", 2}}), (Object{{"x", 1}, {"y", 3}}));
    EXPECT_NE((Object{{"x", 1}}), (Object{{"x", 1}, {"y", 2}}));
}

TEST(Json, WritesCompactAndIndented) {
    const Value value = Object{{"command", "graph.setValue"},
                               {"params", Object{{"node", "Exposure1"},
                                                 {"value", Array{0.5, 1.0, 2, -0.25}},
                                                 {"empty", Array{}},
                                                 {"none", Object{}},
                                                 {"nested", Array{Object{{"x", nullptr}}, true}}}}};
    EXPECT_EQ(write(value), R"({"command":"graph.setValue","params":{"node":"Exposure1","value":[0.5,1.0,2,-0.25],)"
                            R"("empty":[],"none":{},"nested":[{"x":null},true]}})");
    EXPECT_EQ(write(value, {.indent = 2}), R"({
  "command": "graph.setValue",
  "params": {
    "node": "Exposure1",
    "value": [0.5, 1.0, 2, -0.25],
    "empty": [],
    "none": {},
    "nested": [
      {
        "x": null
      },
      true
    ]
  }
})");
    EXPECT_EQ(parse(write(value, {.indent = 4})), value);
}

TEST(Json, RealNumbersAlwaysReadBackAsRealNumbers) {
    EXPECT_EQ(write(1.0), "1.0");
    EXPECT_EQ(write(-0.0), "-0.0");
    EXPECT_EQ(write(0.1), "0.1");
    EXPECT_EQ(write(1e21), "1e+21");
    EXPECT_EQ(write(2.5e-7), "2.5e-07");
    EXPECT_EQ(parse("1.0"), Value(1.0));
    EXPECT_EQ(parse("1E2"), Value(100.0));
    EXPECT_EQ(parse("-0"), Value(0));
    EXPECT_TRUE(std::signbit(parse("-0.0").asNumber()));
    EXPECT_THROW((void)write(std::numeric_limits<double>::quiet_NaN()), Error);
    EXPECT_THROW((void)write(std::numeric_limits<double>::infinity()), Error);
}

TEST(Json, IntegersRoundTripExactly) {
    for (const std::int64_t n : {std::int64_t{0}, std::int64_t{-1}, std::numeric_limits<std::int64_t>::min(),
                                 std::numeric_limits<std::int64_t>::max()}) {
        EXPECT_EQ(parse(write(n)), Value(n));
    }
    // Beyond 64 bits an integer is read as a real number.
    EXPECT_EQ(parse("9223372036854775808"), Value(9223372036854775808.0));
}

TEST(Json, EveryFiniteDoubleRoundTripsBitForBit) {
    std::mt19937_64 random(20261013);
    const std::array special = {std::numeric_limits<double>::min(),
                                std::numeric_limits<double>::denorm_min(),
                                std::numeric_limits<double>::max(),
                                std::numeric_limits<double>::lowest(),
                                std::numeric_limits<double>::epsilon(),
                                1.0 / 3.0,
                                0.1 + 0.2,
                                123456789.125,
                                -2.2250738585072011e-308,
                                9007199254740993.0};
    for (const double value : special) {
        const double back = parse(write(value)).asNumber();
        EXPECT_EQ(std::bit_cast<std::uint64_t>(back), std::bit_cast<std::uint64_t>(value)) << write(value);
    }
    int checked = 0;
    while (checked < 20000) {
        const auto value = std::bit_cast<double>(random());
        if (!std::isfinite(value)) {
            continue;
        }
        const std::string text = write(value);
        const double back = parse(text).asNumber();
        ASSERT_EQ(std::bit_cast<std::uint64_t>(back), std::bit_cast<std::uint64_t>(value)) << text;
        ++checked;
    }
}

TEST(Json, TextIsEscapedAndUtf8IsKept) {
    const std::string tricky = "quote\" backslash\\ slash/ tab\t newline\n\x01 čćžšđ 日本 😀";
    EXPECT_EQ(write(tricky), "\"quote\\\" backslash\\\\ slash/ tab\\t newline\\n\\u0001 čćžšđ 日本 😀\"");
    EXPECT_EQ(parse(write(tricky)).asString(), tricky);
    EXPECT_EQ(parse(R"("\u00e9\u65e5\ud83d\ude00\/\b\f\r")").asString(), "é日😀/\b\f\r");
    EXPECT_EQ(parse(R"("\u0000")").asString(), std::string(1, '\0'));
    EXPECT_THROW((void)write(std::string("bad \xC3\x28")), Error);
    EXPECT_THROW((void)write(std::string("\xED\xA0\x80")), Error); // an encoded surrogate
}

TEST(Json, ReadsWhitespaceAndAByteOrderMark) {
    EXPECT_EQ(parse(" \t\r\n[ 1 ,\n 2 ] \n"), Value(Array{1, 2}));
    EXPECT_EQ(parse("\xEF\xBB\xBF{\"a\":true}"), Value(Object{{"a", true}}));
}

bool parses(const std::string& text) {
    try {
        (void)parse(text);
        return true;
    } catch (const Error&) {
        return false;
    }
}

void expectInvalid(const std::string& text) {
    EXPECT_FALSE(parses(text)) << text;
}

TEST(Json, RefusesEverythingThatIsNotStrictJson) {
    for (const char* text : {"",
                             " ",
                             "[1,]",
                             R"({"a":1,})",
                             "[1 2]",
                             "// comment\n1",
                             "/* c */ 1",
                             "'single'",
                             "01",
                             "1.",
                             ".5",
                             "-",
                             "+1",
                             "1e",
                             "1e+",
                             "NaN",
                             "Infinity",
                             "-Infinity",
                             "tru",
                             "nul",
                             R"("open)",
                             R"("bad \x escape")",
                             R"("\u12")",
                             R"("\udc00")",
                             R"("\ud800")",
                             R"("\ud800\u0041")",
                             R"({"a" 1})",
                             "{a:1}",
                             R"({"a":1}x)",
                             "[1]]",
                             R"({"a":1,"a":2})",
                             "1e400",
                             "-1e400",
                             "[\"tab\tinside\"]"}) {
        expectInvalid(text);
    }
    expectInvalid("\"\xFF\"");             // not UTF-8
    expectInvalid("\"\xC0\xAF\"");         // overlong
    expectInvalid("\"\xF4\x90\x80\x80\""); // above U+10FFFF
    expectInvalid("\"\xE2\x82\"");         // cut short
}

TEST(Json, ErrorsNameTheLineAndColumn) {
    try {
        (void)parse("{\n  \"a\": 1,\n  \"b\": tru\n}");
        FAIL() << "no error";
    } catch (const Error& error) {
        EXPECT_STREQ(error.what(), "JSON line 3, column 8: expected a value");
    }
    try {
        (void)parse("{\"č\": 1, \"č\": 2}");
        FAIL() << "no error";
    } catch (const Error& error) {
        EXPECT_STREQ(error.what(), "JSON line 1, column 10: the key \"č\" appears twice");
    }
}

TEST(Json, NestingIsLimited) {
    const auto nested = [](int depth) {
        return std::string(static_cast<std::size_t>(depth), '[') + std::string(static_cast<std::size_t>(depth), ']');
    };
    EXPECT_TRUE(parses(nested(maxDepth)));
    EXPECT_FALSE(parses(nested(maxDepth + 1)));
    EXPECT_FALSE(parses(std::string(100000, '[')));
}

} // namespace
} // namespace pf::json
