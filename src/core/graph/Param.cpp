#include "core/graph/Param.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <set>
#include <stdexcept>
#include <string>
#include <system_error>
#include <type_traits>
#include <utility>

namespace pf::graph {
namespace {

// The ParamValue alternative each type uses.
std::size_t alternativeOf(ParamType type) {
    switch (type) {
    case ParamType::Float:
        return 0;
    case ParamType::Int:
    case ParamType::Enum:
        return 1;
    case ParamType::Bool:
        return 2;
    case ParamType::Color:
        return 3;
    case ParamType::Vector2:
        return 4;
    case ParamType::Vector3:
        return 5;
    case ParamType::String:
    case ParamType::File:
        break;
    }
    return 6;
}

std::string describe(const ParamDef& def) {
    return "parameter '" + def.id + "' (" + std::string(toString(def.type)) + ")";
}

double clampNumber(const ParamDef& def, double value) {
    if (!std::isfinite(value)) {
        throw std::invalid_argument(describe(def) + " got a value that is not a finite number");
    }
    return std::clamp(value, def.minimum, def.maximum);
}

// Integers stay well inside the range where doubles are exact and std::llround is defined.
constexpr double integerLimit = 4503599627370496.0; // 2^52

std::int64_t clampInteger(double lo, double hi, double value) {
    const double clamped = std::clamp(value, std::max(lo, -integerLimit), std::min(hi, integerLimit));
    return std::llround(clamped);
}

std::int64_t clampInteger(const ParamDef& def, std::int64_t value) {
    if (def.type == ParamType::Enum) {
        return std::clamp<std::int64_t>(value, 0, static_cast<std::int64_t>(def.items.size()) - 1);
    }
    return clampInteger(std::ceil(def.minimum), std::floor(def.maximum), static_cast<double>(value));
}

template <std::size_t N>
std::array<double, N> clampArray(const ParamDef& def, std::array<double, N> values) {
    for (double& v : values) {
        v = clampNumber(def, v);
    }
    return values;
}

void appendNumber(std::string& out, double value) {
    std::array<char, 32> buffer{};
    const auto [end, error] = std::to_chars(buffer.data(), buffer.data() + buffer.size(), value);
    out.append(buffer.data(), error == std::errc{} ? end : buffer.data());
}

template <std::size_t N>
std::string arrayToString(const std::array<double, N>& values) {
    std::string out = "(";
    for (std::size_t i = 0; i < N; ++i) {
        if (i > 0) {
            out += ", ";
        }
        appendNumber(out, values[i]);
    }
    return out + ")";
}

ParamDef numericDef(std::string id, std::string label, ParamType type, ParamValue defaultValue) {
    return {.id = std::move(id), .label = std::move(label), .type = type, .defaultValue = std::move(defaultValue)};
}

} // namespace

std::string_view toString(ParamType type) {
    switch (type) {
    case ParamType::Float:
        return "float";
    case ParamType::Int:
        return "int";
    case ParamType::Bool:
        return "bool";
    case ParamType::Enum:
        return "enum";
    case ParamType::Color:
        return "colour";
    case ParamType::Vector2:
        return "2D vector";
    case ParamType::Vector3:
        return "3D vector";
    case ParamType::String:
        return "string";
    case ParamType::File:
        break;
    }
    return "file";
}

std::size_t componentCount(ParamType type) {
    switch (type) {
    case ParamType::Float:
    case ParamType::Int:
    case ParamType::Bool:
    case ParamType::Enum:
        return 1;
    case ParamType::Color:
        return 4;
    case ParamType::Vector2:
        return 2;
    case ParamType::Vector3:
        return 3;
    case ParamType::String:
    case ParamType::File:
        break;
    }
    return 0;
}

ParamDef floatParam(std::string id, std::string label, double defaultValue, double minimum, double maximum,
                    double sliderMinimum, double sliderMaximum) {
    ParamDef def = numericDef(std::move(id), std::move(label), ParamType::Float, defaultValue);
    def.minimum = minimum;
    def.maximum = maximum;
    def.sliderMinimum = sliderMinimum;
    def.sliderMaximum = sliderMaximum;
    return def;
}

ParamDef intParam(std::string id, std::string label, std::int64_t defaultValue, std::int64_t minimum,
                  std::int64_t maximum) {
    ParamDef def = numericDef(std::move(id), std::move(label), ParamType::Int, defaultValue);
    def.minimum = static_cast<double>(minimum);
    def.maximum = static_cast<double>(maximum);
    def.sliderMinimum = def.minimum;
    def.sliderMaximum = def.maximum;
    return def;
}

ParamDef boolParam(std::string id, std::string label, bool defaultValue) {
    ParamDef def = numericDef(std::move(id), std::move(label), ParamType::Bool, defaultValue);
    def.minimum = 0.0;
    def.maximum = 1.0;
    return def;
}

ParamDef enumParam(std::string id, std::string label, std::vector<EnumItem> items, std::int64_t defaultIndex) {
    ParamDef def = numericDef(std::move(id), std::move(label), ParamType::Enum, defaultIndex);
    def.minimum = 0.0;
    def.maximum = items.empty() ? 0.0 : static_cast<double>(items.size() - 1);
    def.items = std::move(items);
    return def;
}

ParamDef colorParam(std::string id, std::string label, Rgba defaultValue) {
    return numericDef(std::move(id), std::move(label), ParamType::Color, defaultValue);
}

ParamDef vector2Param(std::string id, std::string label, Vec2 defaultValue) {
    return numericDef(std::move(id), std::move(label), ParamType::Vector2, defaultValue);
}

ParamDef vector3Param(std::string id, std::string label, Vec3 defaultValue) {
    return numericDef(std::move(id), std::move(label), ParamType::Vector3, defaultValue);
}

ParamDef stringParam(std::string id, std::string label, std::string defaultValue) {
    return {.id = std::move(id),
            .label = std::move(label),
            .type = ParamType::String,
            .defaultValue = std::move(defaultValue),
            .animatable = false};
}

ParamDef fileParam(std::string id, std::string label) {
    return {.id = std::move(id),
            .label = std::move(label),
            .type = ParamType::File,
            .defaultValue = std::string{},
            .animatable = false};
}

bool isIdentifier(std::string_view text) {
    const auto isLetter = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; };
    const auto isDigit = [](char c) { return c >= '0' && c <= '9'; };
    return !text.empty() && isLetter(text.front()) &&
           std::ranges::all_of(text, [&](char c) { return isLetter(c) || isDigit(c); });
}

void validate(const ParamDef& def) {
    if (!isIdentifier(def.id)) {
        throw std::invalid_argument("parameter id '" + def.id + "' must be a letter or _, then letters, digits or _");
    }
    if (def.label.empty()) {
        throw std::invalid_argument(describe(def) + " has no label");
    }
    if (def.defaultValue.index() != alternativeOf(def.type)) {
        throw std::invalid_argument(describe(def) + " has a default of the wrong type");
    }
    if (!isNumeric(def.type)) {
        if (def.animatable) {
            throw std::invalid_argument(describe(def) + ": text parameters cannot be animated");
        }
        return;
    }
    if (!(def.minimum <= def.maximum) || !(def.sliderMinimum <= def.sliderMaximum)) {
        throw std::invalid_argument(describe(def) + " has limits the wrong way round");
    }
    if (def.type == ParamType::Enum) {
        if (def.items.empty()) {
            throw std::invalid_argument(describe(def) + " has no items");
        }
        std::set<std::string_view> ids;
        for (const EnumItem& item : def.items) {
            if (!isIdentifier(item.id) || !ids.insert(item.id).second) {
                throw std::invalid_argument(describe(def) + ": item id '" + item.id + "' is invalid or repeated");
            }
        }
    }
    if (normalized(def, def.defaultValue) != def.defaultValue) {
        throw std::invalid_argument(describe(def) + " has a default outside its limits");
    }
}

ParamValue normalized(const ParamDef& def, ParamValue value) {
    if (value.index() != alternativeOf(def.type)) {
        throw std::invalid_argument(describe(def) + " cannot take the value " + toString(value));
    }
    switch (def.type) {
    case ParamType::Float:
        return clampNumber(def, std::get<double>(value));
    case ParamType::Int:
    case ParamType::Enum:
        return clampInteger(def, std::get<std::int64_t>(value));
    case ParamType::Color:
        return clampArray(def, std::get<Rgba>(value));
    case ParamType::Vector2:
        return clampArray(def, std::get<Vec2>(value));
    case ParamType::Vector3:
        return clampArray(def, std::get<Vec3>(value));
    case ParamType::Bool:
    case ParamType::String:
    case ParamType::File:
        break;
    }
    return value;
}

std::vector<double> componentsOf(const ParamValue& value) {
    return std::visit(
        [](const auto& v) -> std::vector<double> {
            using T = std::decay_t<decltype(v)>;
            if constexpr (std::is_same_v<T, double>) {
                return {v};
            } else if constexpr (std::is_same_v<T, std::int64_t>) {
                return {static_cast<double>(v)};
            } else if constexpr (std::is_same_v<T, bool>) {
                return {v ? 1.0 : 0.0};
            } else if constexpr (std::is_same_v<T, std::string>) {
                return {};
            } else {
                return {v.begin(), v.end()};
            }
        },
        value);
}

ParamValue fromComponents(const ParamDef& def, std::span<const double> components) {
    if (components.size() != componentCount(def.type)) {
        throw std::invalid_argument(describe(def) + " has " + std::to_string(componentCount(def.type)) +
                                    " components, got " + std::to_string(components.size()));
    }
    const auto array = [&]<std::size_t N>(std::array<double, N> out) {
        std::ranges::copy(components, out.begin());
        return normalized(def, out);
    };
    switch (def.type) {
    case ParamType::Float:
        return normalized(def, components[0]);
    case ParamType::Int:
    case ParamType::Enum:
        if (!std::isfinite(components[0])) {
            throw std::invalid_argument(describe(def) + " got a value that is not a finite number");
        }
        return normalized(def, clampInteger(def.minimum, def.maximum, components[0]));
    case ParamType::Bool:
        return components[0] >= 0.5;
    case ParamType::Color:
        return array(Rgba{});
    case ParamType::Vector2:
        return array(Vec2{});
    case ParamType::Vector3:
        return array(Vec3{});
    case ParamType::String:
    case ParamType::File:
        break;
    }
    throw std::invalid_argument(describe(def) + " has no numeric components");
}

void addToHash(Hasher& hasher, const ParamValue& value) {
    hasher.addUnsigned(value.index());
    std::visit(
        [&](const auto& v) {
            using T = std::decay_t<decltype(v)>;
            if constexpr (std::is_same_v<T, double>) {
                hasher.addNumber(v);
            } else if constexpr (std::is_same_v<T, std::int64_t>) {
                hasher.addInteger(v);
            } else if constexpr (std::is_same_v<T, bool>) {
                hasher.addBool(v);
            } else if constexpr (std::is_same_v<T, std::string>) {
                hasher.addText(v);
            } else {
                for (const double component : v) {
                    hasher.addNumber(component);
                }
            }
        },
        value);
}

std::string toString(const ParamValue& value) {
    return std::visit(
        [](const auto& v) -> std::string {
            using T = std::decay_t<decltype(v)>;
            if constexpr (std::is_same_v<T, double>) {
                std::string out;
                appendNumber(out, v);
                return out;
            } else if constexpr (std::is_same_v<T, std::int64_t>) {
                return std::to_string(v);
            } else if constexpr (std::is_same_v<T, bool>) {
                return v ? "true" : "false";
            } else if constexpr (std::is_same_v<T, std::string>) {
                return "\"" + v + "\"";
            } else {
                return arrayToString(v);
            }
        },
        value);
}

ParamValues::ParamValues(std::span<const ParamDef> defs, std::vector<ParamValue> values)
    : m_defs(defs),
      m_values(std::move(values)) {
    if (m_defs.size() != m_values.size()) {
        throw std::invalid_argument("ParamValues: " + std::to_string(m_values.size()) + " values for " +
                                    std::to_string(m_defs.size()) + " parameters");
    }
}

const ParamValue& ParamValues::get(std::string_view id) const {
    for (std::size_t i = 0; i < m_defs.size(); ++i) {
        if (m_defs[i].id == id) {
            return m_values[i];
        }
    }
    throw std::out_of_range("no parameter '" + std::string(id) + "'");
}

namespace {

template <class T>
const T& typed(const ParamValue& value, std::string_view id) {
    const T* found = std::get_if<T>(&value);
    if (found == nullptr) {
        throw std::logic_error("parameter '" + std::string(id) + "' read as the wrong type");
    }
    return *found;
}

} // namespace

double ParamValues::getFloat(std::string_view id) const {
    return typed<double>(get(id), id);
}

std::int64_t ParamValues::getInt(std::string_view id) const {
    return typed<std::int64_t>(get(id), id);
}

bool ParamValues::getBool(std::string_view id) const {
    return typed<bool>(get(id), id);
}

Rgba ParamValues::getColor(std::string_view id) const {
    return typed<Rgba>(get(id), id);
}

Vec2 ParamValues::getVector2(std::string_view id) const {
    return typed<Vec2>(get(id), id);
}

Vec3 ParamValues::getVector3(std::string_view id) const {
    return typed<Vec3>(get(id), id);
}

const std::string& ParamValues::getString(std::string_view id) const {
    return typed<std::string>(get(id), id);
}

} // namespace pf::graph
