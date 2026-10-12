#pragma once

// What the evaluator is asked and what it answers with (docs/specs/node-graph.md §5): requests, output descriptions,
// errors, and proxy scales.

#include "core/graph/NodeId.h"
#include "core/image/ChannelSet.h"
#include "core/image/Rect.h"

#include <stdexcept>
#include <string>

namespace pf::graph {

// What a node produces at one frame and proxy scale (windows already scaled). An empty description (no channels,
// empty windows) is "nothing", what an unconnected input gives.
struct OutputInfo {
    image::Rect displayWindow;
    image::Rect dataWindow;
    image::ChannelSet channels;

    friend bool operator==(const OutputInfo&, const OutputInfo&) = default;
};

// What one input must deliver so that a node can render a region (region of interest propagation).
struct InputRequest {
    double frame = 0.0;
    image::Rect region;
    image::ChannelSet channels;
};

// A request for pixels: a node's output at a frame, over a region (in proxy-scaled pixels), for some channels.
struct Request {
    NodeId node;
    double frame = 0.0;
    image::Rect region;
    image::ChannelSet channels;
    int proxyScale = 1;
};

// An evaluation that failed in a node: the message names the node; `node` lets the UI mark it.
class EvaluationError : public std::runtime_error {
public:
    EvaluationError(NodeId node, const std::string& message) : std::runtime_error(message), m_node(node) {}
    [[nodiscard]] NodeId node() const { return m_node; }

private:
    NodeId m_node;
};

// Proxy scales divide the resolution: 1 (full), 2, 4, 8, 16 or 32.
inline constexpr int maxProxyScale = 32;
[[nodiscard]] constexpr bool isValidProxyScale(int scale) {
    return scale >= 1 && scale <= maxProxyScale && (scale & (scale - 1)) == 0;
}

// A full-resolution window at a proxy scale: left/top edges rounded down, right/bottom edges rounded up, so the
// scaled window covers every pixel the full one touches. Empty stays empty.
[[nodiscard]] image::Rect scaleForProxy(const image::Rect& window, int proxyScale);

} // namespace pf::graph
