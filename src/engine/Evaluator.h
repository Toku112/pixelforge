#pragma once

// Pull evaluation of the node graph with the node result cache (docs/specs/node-graph.md §5, D-075).
//
// A request asks a node for (frame, region, channels, proxy scale). The evaluator skips pass-through nodes, hashes
// the node at that frame, describes its output, takes the tiles it has cached under (hash, proxy, channel, tile) and
// renders only the missing ones: it asks the node what its inputs must deliver for those tiles, evaluates the inputs
// the same way, then lets the node render the tiles in parallel and caches them. Tiles and descriptions live in two
// caches under the memory budget, so the least recently used results go first when memory runs short.
//
// Every function runs on a job thread — never the UI thread, which is checked (nodes may read files) — and any
// number of them may run at once, on the same graph copy or on different ones. Two evaluations may compute the same
// tile at the same moment; that costs time, never correctness.

#include "core/graph/Evaluation.h"
#include "core/graph/Graph.h"
#include "core/graph/Hash.h"
#include "core/graph/NodeId.h"
#include "core/image/Image.h"
#include "core/image/Tile.h"
#include "engine/Cancellation.h"
#include "engine/LruCache.h"
#include "engine/MemoryBudget.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>

namespace pf::engine {

struct EvaluatorOptions {
    // Entry limits on top of the memory budget: constant tiles and descriptions use (almost) no memory, so the
    // budget alone would never evict them.
    std::size_t maxTileEntries = std::size_t{1} << 20;
    std::size_t maxInfoEntries = std::size_t{1} << 16;
};

struct EvaluatorStats {
    CacheStats tiles;
    CacheStats infos;
    std::uint64_t renderedTiles = 0; // (channel, tile) results computed by nodes, not taken from the cache
};

class Evaluator {
public:
    // The caches register with `budget`, which must outlive the evaluator.
    explicit Evaluator(MemoryBudget& budget, const EvaluatorOptions& options = {});

    // The pixels a request asks for: the node's display window, its data window clipped to the region grown to
    // whole tiles, and the requested channels the node has. A node that shows nothing (an unconnected Viewer input)
    // gives an empty image. Throws EvaluationError when a node fails, OperationCancelled when `token` is cancelled,
    // std::invalid_argument for an invalid proxy scale, std::out_of_range for an unknown node.
    [[nodiscard]] image::Image evaluate(const graph::Graph& graph, const graph::Request& request,
                                        const CancellationToken& token = {});
    // What the node produces at `frame` (empty for nothing).
    [[nodiscard]] graph::OutputInfo info(const graph::Graph& graph, graph::NodeId node, double frame, int proxyScale);
    // The node's hash at `frame`: equal hashes mean equal pixels. Pass-through nodes have their input's hash.
    [[nodiscard]] graph::HashValue hash(const graph::Graph& graph, graph::NodeId node, double frame);

    [[nodiscard]] EvaluatorStats stats() const;
    // Drops every cached result.
    void clear();

    // The hash of "nothing" (no connected input, nothing to show): a fixed number, like any other hash.
    static constexpr graph::HashValue emptyHash = 0x6E6F7468696E6721ULL;

private:
    class Session;

    struct TileKey {
        graph::HashValue hash = 0;
        int proxyScale = 1;
        std::string channel;
        image::TileCoord tile;
        friend bool operator==(const TileKey&, const TileKey&) = default;
    };
    struct TileKeyHash {
        std::size_t operator()(const TileKey& key) const;
    };
    struct InfoKey {
        graph::HashValue hash = 0;
        int proxyScale = 1;
        friend bool operator==(const InfoKey&, const InfoKey&) = default;
    };
    struct InfoKeyHash {
        std::size_t operator()(const InfoKey& key) const;
    };

    LruCache<TileKey, image::Image::TileContent, TileKeyHash> m_tiles;
    LruCache<InfoKey, graph::OutputInfo, InfoKeyHash> m_infos;
    std::atomic<std::uint64_t> m_renderedTiles{0};
};

} // namespace pf::engine
