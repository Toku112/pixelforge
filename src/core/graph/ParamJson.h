#pragma once

// JSON forms of parameter values and keyframes (FORMAT_NOTES §21.2), shared by command descriptors, action files and
// (Phase 1) project files.

#include "core/anim/AnimCurve.h"
#include "core/graph/Param.h"
#include "core/json/Json.h"

#include <optional>
#include <string_view>

namespace pf::graph {

// Float: a real number; Int: an integer; Bool: true or false; Enum: the item's id ("hold"); Color: [r, g, b, a];
// Vector2 and Vector3: [x, y] and [x, y, z]; String and File: text. Throws json::Error for a number that is not
// finite.
[[nodiscard]] json::Value toJson(const ParamDef& def, const ParamValue& value);

// The reverse. Also accepts what people write by hand: an integer for a real number, a whole real number for an
// integer, an enum item's index instead of its id, a colour without alpha (alpha 1). Throws std::invalid_argument,
// naming the parameter, for anything else. The result is not clamped yet (normalized() does that).
[[nodiscard]] ParamValue paramValueFromJson(const ParamDef& def, const json::Value& value);

// "constant", "linear", "smooth", "bezier".
[[nodiscard]] std::string_view toString(anim::Interpolation interpolation);
[[nodiscard]] std::optional<anim::Interpolation> interpolationFromString(std::string_view text);
// "constant", "linear".
[[nodiscard]] std::string_view toString(anim::Extrapolation extrapolation);
[[nodiscard]] std::optional<anim::Extrapolation> extrapolationFromString(std::string_view text);

// {"frame": 12.0, "value": 0.5, "interpolation": "linear"}; a Bezier key adds "inSlope", "outSlope", "inWeight" and
// "outWeight".
[[nodiscard]] json::Value toJson(const anim::Keyframe& key);
// The reverse; the Bezier fields are optional (defaults: flat, a third of the segment). Throws std::invalid_argument.
[[nodiscard]] anim::Keyframe keyframeFromJson(const json::Value& value);

} // namespace pf::graph
