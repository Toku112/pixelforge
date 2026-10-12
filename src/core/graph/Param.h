#pragma once

// Node parameters (docs/specs/node-graph.md §3): typed values with limits, defaults and flags. A parameter's data in a
// node (its static value and animation) is a ParamState (Node.h); the values of all of a node's parameters at one
// frame are a ParamValues, which is what node code reads.

#include "core/graph/Hash.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace pf::graph {

enum class ParamType : std::uint8_t { Float, Int, Bool, Enum, Color, Vector2, Vector3, String, File };

using Vec2 = std::array<double, 2>;
using Vec3 = std::array<double, 3>;
using Rgba = std::array<double, 4>;

// A parameter value. The alternative of each type: Float → double; Int, and Enum (the item's index) → std::int64_t;
// Bool → bool; Color → Rgba; Vector2 → Vec2; Vector3 → Vec3; String and File (a path) → std::string, UTF-8.
using ParamValue = std::variant<double, std::int64_t, bool, Rgba, Vec2, Vec3, std::string>;

[[nodiscard]] std::string_view toString(ParamType type);

// Numeric components: Float, Int, Bool and Enum 1, Vector2 2, Vector3 3, Color 4 (R, G, B, A); 0 for String and
// File.
[[nodiscard]] std::size_t componentCount(ParamType type);
[[nodiscard]] inline bool isNumeric(ParamType type) {
    return componentCount(type) > 0;
}

struct EnumItem {
    std::string id;    // stable, stored in files ("hold")
    std::string label; // shown in menus ("Hold")
};

struct ParamDef {
    std::string id;    // stable, stored in project files, descriptors and hashes: a letter, then letters/digits/_
    std::string label; // shown in panels
    ParamType type = ParamType::Float;
    ParamValue defaultValue = 0.0;
    // Hard limits for every numeric component: values are clamped into them, also where animation overshoots.
    double minimum = -std::numeric_limits<double>::infinity();
    double maximum = std::numeric_limits<double>::infinity();
    // The range a panel's slider covers; typed values may go beyond it, up to the hard limits.
    double sliderMinimum = 0.0;
    double sliderMaximum = 1.0;
    std::vector<EnumItem> items; // Enum only
    bool animatable = true;      // numeric parameters only; text never animates (docs/specs/node-graph.md §3)
    bool affectsPixels = true;   // false: a display setting, left out of hashes
};

// Definitions for each type, with the usual flags; adjust fields afterwards where needed.
[[nodiscard]] ParamDef floatParam(std::string id, std::string label, double defaultValue, double minimum,
                                  double maximum, double sliderMinimum, double sliderMaximum);
[[nodiscard]] ParamDef intParam(std::string id, std::string label, std::int64_t defaultValue, std::int64_t minimum,
                                std::int64_t maximum);
[[nodiscard]] ParamDef boolParam(std::string id, std::string label, bool defaultValue);
[[nodiscard]] ParamDef enumParam(std::string id, std::string label, std::vector<EnumItem> items,
                                 std::int64_t defaultIndex = 0);
[[nodiscard]] ParamDef colorParam(std::string id, std::string label, Rgba defaultValue);
[[nodiscard]] ParamDef vector2Param(std::string id, std::string label, Vec2 defaultValue);
[[nodiscard]] ParamDef vector3Param(std::string id, std::string label, Vec3 defaultValue);
[[nodiscard]] ParamDef stringParam(std::string id, std::string label, std::string defaultValue = {});
[[nodiscard]] ParamDef fileParam(std::string id, std::string label);

// True for "a letter or _, then letters, digits or _" (ASCII): parameter ids and node names.
[[nodiscard]] bool isIdentifier(std::string_view text);

// Throws std::invalid_argument when a definition is inconsistent: an id that is not an identifier, a default of the
// wrong alternative or outside the limits, limits the wrong way round, an Enum without items, animated text.
void validate(const ParamDef& def);

// `value` checked against `def`: throws std::invalid_argument for the wrong alternative or a number that is not
// finite. Numbers are clamped into the limits and enum indices into the item range.
[[nodiscard]] ParamValue normalized(const ParamDef& def, ParamValue value);

// The numeric components of a value (empty for text).
[[nodiscard]] std::vector<double> componentsOf(const ParamValue& value);
// Back from components (as many as the type has): Int and Enum round to the nearest integer, Bool is "≥ 0.5", then
// the value is normalized.
[[nodiscard]] ParamValue fromComponents(const ParamDef& def, std::span<const double> components);

void addToHash(Hasher& hasher, const ParamValue& value);

// For messages and tests: "1.5", "true", "(0.1, 0.2, 0.3, 1)", "\"text\"".
[[nodiscard]] std::string toString(const ParamValue& value);

// The values of a node's parameters at one frame, in the order of their definitions. Typed getters throw
// std::out_of_range for an unknown id and std::logic_error for the wrong type (both are bugs in node code).
class ParamValues {
public:
    ParamValues() = default;
    // `defs` must outlive this object (they belong to the node's NodeDef). Values must already be normalized.
    ParamValues(std::span<const ParamDef> defs, std::vector<ParamValue> values);

    [[nodiscard]] std::size_t size() const { return m_values.size(); }
    [[nodiscard]] const ParamValue& operator[](std::size_t index) const { return m_values[index]; }
    [[nodiscard]] const ParamValue& get(std::string_view id) const;

    [[nodiscard]] double getFloat(std::string_view id) const;
    [[nodiscard]] std::int64_t getInt(std::string_view id) const; // Int and Enum
    [[nodiscard]] bool getBool(std::string_view id) const;
    [[nodiscard]] Rgba getColor(std::string_view id) const;
    [[nodiscard]] Vec2 getVector2(std::string_view id) const;
    [[nodiscard]] Vec3 getVector3(std::string_view id) const;
    [[nodiscard]] const std::string& getString(std::string_view id) const; // String and File

private:
    std::span<const ParamDef> m_defs;
    std::vector<ParamValue> m_values;
};

} // namespace pf::graph
