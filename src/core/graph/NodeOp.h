#pragma once

// The pixel work of a node type (docs/specs/node-graph.md §5). One NodeOp object serves every node of its type: it
// holds no per-node state, only what all nodes of the type share (the Read node's open-file cache). Everything a call
// needs arrives in its context. Calls run on job threads, several at once: implementations must be thread-safe.
//
// Rules for implementations:
//   - A pixel's value depends only on the parameters and the input pixels — never on the region or on which other
//     channels were requested. The evaluator caches tiles on that promise.
//   - render() fills every sample of every listed tile for every listed channel (or makes the tile constant, or
//     shares an input tile with Image::copyTile). Data passes through unclipped; NaN and infinity are kept.
//   - Throw an exception with a plain-language message when something cannot be done (the evaluator adds the node's
//     name); check tasks().throwIfCancelled() in long loops that do not use tasks().forEach().

#include "core/graph/Evaluation.h"
#include "core/graph/Hash.h"
#include "core/graph/Param.h"
#include "core/image/ChannelSet.h"
#include "core/image/Image.h"
#include "core/image/Rect.h"
#include "core/image/Tile.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <span>

namespace pf::graph {

// Parallel loops and cancellation for node code, provided by the engine (core/ knows no threads).
class TaskRunner {
public:
    TaskRunner() = default;
    virtual ~TaskRunner() = default;
    TaskRunner(const TaskRunner&) = delete;
    TaskRunner(TaskRunner&&) = delete;
    TaskRunner& operator=(const TaskRunner&) = delete;
    TaskRunner& operator=(TaskRunner&&) = delete;

    // Calls body(i) for every i in [0, count), in parallel and in no particular order. Once the work is cancelled no
    // new items start, and the call ends by throwing the engine's cancellation exception.
    virtual void forEach(std::size_t count, const std::function<void(std::size_t)>& body) const = 0;
    [[nodiscard]] virtual bool isCancelled() const = 0;
    virtual void throwIfCancelled() const = 0;
};

// A node at one frame: its parameter values there and which inputs are connected.
class NodeContext {
public:
    NodeContext(double frame, const ParamValues& params, std::span<const std::uint8_t> connected)
        : m_frame(frame),
          m_params(&params),
          m_connected(connected) {}

    [[nodiscard]] double frame() const { return m_frame; }
    [[nodiscard]] const ParamValues& params() const { return *m_params; }
    [[nodiscard]] std::size_t inputCount() const { return m_connected.size(); }
    [[nodiscard]] bool isConnected(std::size_t input) const {
        return input < m_connected.size() && m_connected[input] != 0;
    }

private:
    double m_frame;
    const ParamValues* m_params;
    std::span<const std::uint8_t> m_connected;
};

// A node at one frame and proxy scale, about to render `region` × `channels` of its output.
class RegionContext {
public:
    RegionContext(const NodeContext& node, int proxyScale, std::span<const OutputInfo> inputInfos,
                  const OutputInfo& info, const image::Rect& region, const image::ChannelSet& channels)
        : m_node(&node),
          m_proxyScale(proxyScale),
          m_inputInfos(inputInfos),
          m_info(&info),
          m_region(&region),
          m_channels(&channels) {}

    [[nodiscard]] const NodeContext& node() const { return *m_node; }
    [[nodiscard]] double frame() const { return m_node->frame(); }
    [[nodiscard]] const ParamValues& params() const { return m_node->params(); }
    [[nodiscard]] int proxyScale() const { return m_proxyScale; }
    // The description of input `index` (empty when it is not connected).
    [[nodiscard]] const OutputInfo& inputInfo(std::size_t index) const { return m_inputInfos[index]; }
    [[nodiscard]] std::span<const OutputInfo> inputInfos() const { return m_inputInfos; }
    // This node's output description, from info().
    [[nodiscard]] const OutputInfo& info() const { return *m_info; }
    // What is being rendered: the bounding box of the tiles, inside the output's data window.
    [[nodiscard]] const image::Rect& region() const { return *m_region; }
    // The channels being rendered; all of them are in info().channels.
    [[nodiscard]] const image::ChannelSet& channels() const { return *m_channels; }

private:
    const NodeContext* m_node;
    int m_proxyScale;
    std::span<const OutputInfo> m_inputInfos;
    const OutputInfo* m_info;
    const image::Rect* m_region;
    const image::ChannelSet* m_channels;
};

// Everything render() works with.
class RenderContext : public RegionContext {
public:
    RenderContext(const RegionContext& region, std::span<const image::Image> inputs, image::Image& output,
                  std::span<const image::TileCoord> tiles, const TaskRunner& tasks)
        : RegionContext(region),
          m_inputs(inputs),
          m_output(&output),
          m_tiles(tiles),
          m_tasks(&tasks) {}

    // What input `index` delivered for its InputRequest: its windows and the channels it has of those requested.
    // An unconnected input is an empty image.
    [[nodiscard]] const image::Image& input(std::size_t index) const { return m_inputs[index]; }
    // The image to fill: display and data window from info() (the data window clipped to whole requested tiles),
    // channels(). Tiles not listed in tiles() are filled already and must be left alone.
    [[nodiscard]] image::Image& output() const { return *m_output; }
    [[nodiscard]] std::span<const image::TileCoord> tiles() const { return m_tiles; }
    [[nodiscard]] const TaskRunner& tasks() const { return *m_tasks; }

    // Calls body(tile) for every tile to render, in parallel.
    template <class Body>
    void forEachTile(const Body& body) const {
        m_tasks->forEach(m_tiles.size(), [&](std::size_t i) { body(m_tiles[i]); });
    }

private:
    std::span<const image::Image> m_inputs;
    image::Image* m_output;
    std::span<const image::TileCoord> m_tiles;
    const TaskRunner* m_tasks;
};

class NodeOp {
public:
    NodeOp() = default;
    virtual ~NodeOp() = default;
    NodeOp(const NodeOp&) = delete;
    NodeOp(NodeOp&&) = delete;
    NodeOp& operator=(const NodeOp&) = delete;
    NodeOp& operator=(NodeOp&&) = delete;

    // ---- the same at every proxy scale; used for hashing and routing

    // An input this node hands on unchanged at this frame (the Viewer's active input, Exposure at neutral
    // settings). The evaluator then skips the node: its hash, description and pixels are that input's, at the
    // frame inputFrame() gives. An unconnected input gives nothing.
    [[nodiscard]] virtual std::optional<std::size_t> passThroughInput(const NodeContext& /*node*/) const {
        return std::nullopt;
    }
    // The frame input `index` is read at. Default: the same frame.
    [[nodiscard]] virtual double inputFrame(const NodeContext& node, std::size_t /*index*/) const {
        return node.frame();
    }
    // Adds anything the output depends on besides the type, the pixel-affecting parameters and the inputs (the Read
    // node adds the file's size and modification time). May read files.
    virtual void hashExtra(const NodeContext& /*node*/, Hasher& /*hasher*/) const {}

    // ---- per proxy scale

    // The output description, from the parameters and the inputs' descriptions (empty for unconnected inputs).
    [[nodiscard]] virtual OutputInfo info(const NodeContext& node, int proxyScale,
                                          std::span<const OutputInfo> inputs) const = 0;
    // What input `index` must deliver to render context.region() × context.channels(). Default: the same frame,
    // region and channels (a point operation).
    [[nodiscard]] virtual InputRequest inputRequest(const RegionContext& context, std::size_t index) const {
        return {.frame = inputFrame(context.node(), index), .region = context.region(), .channels = context.channels()};
    }
    virtual void render(const RenderContext& context) const = 0;
};

} // namespace pf::graph
