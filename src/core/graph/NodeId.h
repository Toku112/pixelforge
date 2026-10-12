#pragma once

// The identity of a node in a graph: unique for the graph's whole life (ids of removed nodes are not reused), so
// commands, caches and the UI can refer to a node across edits. 0 is "no node".

#include <compare>
#include <cstddef>
#include <cstdint>
#include <functional>

namespace pf::graph {

struct NodeId {
    std::uint64_t value = 0;

    [[nodiscard]] constexpr bool isValid() const { return value != 0; }
    friend constexpr auto operator<=>(const NodeId&, const NodeId&) = default;
};

} // namespace pf::graph

template <>
struct std::hash<pf::graph::NodeId> {
    std::size_t operator()(const pf::graph::NodeId& id) const noexcept { return std::hash<std::uint64_t>{}(id.value); }
};
