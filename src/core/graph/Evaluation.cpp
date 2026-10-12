#include "core/graph/Evaluation.h"

#include <stdexcept>

namespace pf::graph {

image::Rect scaleForProxy(const image::Rect& window, int proxyScale) {
    if (!isValidProxyScale(proxyScale)) {
        throw std::invalid_argument("proxy scale " + std::to_string(proxyScale) + " is not 1, 2, 4, 8, 16 or 32");
    }
    if (window.isEmpty()) {
        return {};
    }
    const auto down = [&](int v) { return image::floorDiv(v, proxyScale); };
    const auto up = [&](int v) { return -image::floorDiv(-v, proxyScale); };
    return {.x0 = down(window.x0), .y0 = down(window.y0), .x1 = up(window.x1), .y1 = up(window.y1)};
}

} // namespace pf::graph
