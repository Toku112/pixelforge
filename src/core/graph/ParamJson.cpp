#include "core/graph/ParamJson.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <variant>

namespace pf::graph {
namespace {

[[noreturn]] void wrongValue(const ParamDef& def, std::string_view expected) {
    throw std::invalid_argument("parameter '" + def.id + "' needs " + std::string(expected));
}

json::Array numbers(std::span<const double> components) {
    json::Array result;
    result.reserve(components.size());
    for (const double c : components) {
        result.emplace_back(c);
    }
    return result;
}

// `count` numbers (or, with `optionalLast`, one fewer, the last then being `lastDefault`).
template <std::size_t N>
std::array<double, N> numbersFrom(const ParamDef& def, const json::Value& value, std::string_view expected,
                                  bool optionalLast = false, double lastDefault = 0.0) {
    if (!value.isArray()) {
        wrongValue(def, expected);
    }
    const json::Array& elements = value.asArray();
    const bool fullLength = elements.size() == N;
    const bool shortByOne = optionalLast && elements.size() == N - 1;
    if (!fullLength && !shortByOne) {
        wrongValue(def, expected);
    }
    std::array<double, N> result{};
    result[N - 1] = lastDefault;
    for (std::size_t i = 0; i < elements.size(); ++i) {
        if (!elements[i].isNumber()) {
            wrongValue(def, expected);
        }
        result[i] = elements[i].asNumber();
    }
    return result;
}

std::int64_t integerFrom(const ParamDef& def, const json::Value& value, std::string_view expected) {
    if (value.isInt()) {
        return value.asInt();
    }
    // 2^63 is exactly representable; every whole double below it fits in 64 bits.
    constexpr double limit = 9223372036854775808.0;
    if (value.isNumber()) {
        const double number = value.asNumber();
        if (std::trunc(number) == number && number >= -limit && number < limit) {
            return static_cast<std::int64_t>(number);
        }
    }
    wrongValue(def, expected);
}

double finite(double value) {
    if (!std::isfinite(value)) {
        throw std::invalid_argument("keyframe numbers must be finite");
    }
    return value;
}

double keyNumber(const json::Object& object, std::string_view key, std::optional<double> fallback = {}) {
    const json::Value* value = object.find(key);
    if (value == nullptr) {
        if (fallback) {
            return *fallback;
        }
        throw std::invalid_argument("a keyframe needs \"" + std::string(key) + "\"");
    }
    if (!value->isNumber()) {
        throw std::invalid_argument("keyframe \"" + std::string(key) + "\" must be a number");
    }
    return finite(value->asNumber());
}

} // namespace

json::Value toJson(const ParamDef& def, const ParamValue& value) {
    switch (def.type) {
    case ParamType::Float:
        return std::get<double>(value);
    case ParamType::Int:
        return std::get<std::int64_t>(value);
    case ParamType::Bool:
        return std::get<bool>(value);
    case ParamType::Enum: {
        const std::int64_t index = std::get<std::int64_t>(value);
        if (index >= 0 && static_cast<std::size_t>(index) < def.items.size()) {
            return def.items[static_cast<std::size_t>(index)].id;
        }
        return index;
    }
    case ParamType::Color:
        return numbers(std::get<Rgba>(value));
    case ParamType::Vector2:
        return numbers(std::get<Vec2>(value));
    case ParamType::Vector3:
        return numbers(std::get<Vec3>(value));
    case ParamType::String:
    case ParamType::File:
        return std::get<std::string>(value);
    }
    throw std::logic_error("toJson: unknown parameter type");
}

ParamValue paramValueFromJson(const ParamDef& def, const json::Value& value) {
    switch (def.type) {
    case ParamType::Float:
        if (!value.isNumber()) {
            wrongValue(def, "a number");
        }
        return value.asNumber();
    case ParamType::Int:
        return integerFrom(def, value, "a whole number");
    case ParamType::Bool:
        if (!value.isBool()) {
            wrongValue(def, "true or false");
        }
        return value.asBool();
    case ParamType::Enum: {
        if (value.isString()) {
            for (std::size_t i = 0; i < def.items.size(); ++i) {
                if (def.items[i].id == value.asString()) {
                    return static_cast<std::int64_t>(i);
                }
            }
            wrongValue(def, "one of its items, not '" + value.asString() + "'");
        }
        const std::int64_t index = integerFrom(def, value, "one of its items");
        if (index < 0 || static_cast<std::size_t>(index) >= def.items.size()) {
            wrongValue(def, "one of its items");
        }
        return index;
    }
    case ParamType::Color:
        return numbersFrom<4>(def, value, "a colour [r, g, b, a]", true, 1.0);
    case ParamType::Vector2:
        return numbersFrom<2>(def, value, "two numbers [x, y]");
    case ParamType::Vector3:
        return numbersFrom<3>(def, value, "three numbers [x, y, z]");
    case ParamType::String:
    case ParamType::File:
        if (!value.isString()) {
            wrongValue(def, "text");
        }
        return value.asString();
    }
    throw std::logic_error("paramValueFromJson: unknown parameter type");
}

std::string_view toString(anim::Interpolation interpolation) {
    switch (interpolation) {
    case anim::Interpolation::Constant:
        return "constant";
    case anim::Interpolation::Linear:
        return "linear";
    case anim::Interpolation::Smooth:
        return "smooth";
    case anim::Interpolation::Bezier:
        return "bezier";
    }
    return "linear";
}

std::optional<anim::Interpolation> interpolationFromString(std::string_view text) {
    for (const anim::Interpolation candidate : {anim::Interpolation::Constant, anim::Interpolation::Linear,
                                                anim::Interpolation::Smooth, anim::Interpolation::Bezier}) {
        if (toString(candidate) == text) {
            return candidate;
        }
    }
    return std::nullopt;
}

std::string_view toString(anim::Extrapolation extrapolation) {
    return extrapolation == anim::Extrapolation::Linear ? "linear" : "constant";
}

std::optional<anim::Extrapolation> extrapolationFromString(std::string_view text) {
    if (text == "constant") {
        return anim::Extrapolation::Constant;
    }
    if (text == "linear") {
        return anim::Extrapolation::Linear;
    }
    return std::nullopt;
}

json::Value toJson(const anim::Keyframe& key) {
    json::Object object{{"frame", key.frame}, {"value", key.value}, {"interpolation", toString(key.interpolation)}};
    if (key.interpolation == anim::Interpolation::Bezier) {
        object.set("inSlope", key.inSlope);
        object.set("outSlope", key.outSlope);
        object.set("inWeight", key.inWeight);
        object.set("outWeight", key.outWeight);
    }
    return object;
}

anim::Keyframe keyframeFromJson(const json::Value& value) {
    if (!value.isObject()) {
        throw std::invalid_argument("a keyframe must be an object");
    }
    const json::Object& object = value.asObject();
    anim::Keyframe key;
    key.frame = keyNumber(object, "frame");
    key.value = keyNumber(object, "value");
    if (const json::Value* interpolation = object.find("interpolation")) {
        const std::optional<anim::Interpolation> parsed =
            interpolation->isString() ? interpolationFromString(interpolation->asString()) : std::nullopt;
        if (!parsed) {
            throw std::invalid_argument("keyframe \"interpolation\" must be constant, linear, smooth or bezier");
        }
        key.interpolation = *parsed;
    }
    key.inSlope = keyNumber(object, "inSlope", 0.0);
    key.outSlope = keyNumber(object, "outSlope", 0.0);
    key.inWeight = keyNumber(object, "inWeight", anim::Keyframe::defaultWeight);
    key.outWeight = keyNumber(object, "outWeight", anim::Keyframe::defaultWeight);
    return key;
}

} // namespace pf::graph
