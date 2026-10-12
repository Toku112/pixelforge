#pragma once

// Exposure (docs/specs/node-graph.md §6, FORMAT_NOTES §20.2): the image editor's Exposure adjustment as a node, on
// scene-linear float. Changes the colour channels (R, G, B, Y) of one layer; alpha and data passes pass through.

#include "core/graph/NodeDef.h"

#include <memory>
#include <string_view>

namespace pf::nodes {

inline constexpr std::string_view exposureTypeId = "Exposure";

struct ExposureSettings {
    double exposure = 0.0; // stops
    double offset = 0.0;
    double gamma = 1.0;

    // True at the neutral settings, where the node changes nothing.
    [[nodiscard]] bool isNeutral() const { return exposure == 0.0 && offset == 0.0 && gamma == 1.0; }
};

// The adjustment of one straight (un-premultiplied) colour value: v · 2^exposure + offset, then the power 1/gamma,
// mirrored for negative values.
[[nodiscard]] float applyExposure(float value, const ExposureSettings& settings);

// The adjustment of one premultiplied colour value with its alpha: exposure alone scales the premultiplied value;
// offset and gamma work on straight colour (divided by alpha and multiplied back; where alpha is 0 the value is
// used as it is).
[[nodiscard]] float applyExposurePremultiplied(float value, float alpha, const ExposureSettings& settings);

[[nodiscard]] std::shared_ptr<const graph::NodeDef> makeExposureNodeDef();

} // namespace pf::nodes
