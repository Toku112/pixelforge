#include "engine/Evaluator.h"

#include "core/graph/Node.h"
#include "core/graph/NodeOp.h"
#include "core/graph/Param.h"
#include "engine/Parallel.h"
#include "engine/Scheduler.h"

#include <cmath>
#include <exception>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

namespace pf::engine {
namespace {

using graph::HashValue;
using image::ChannelSet;
using image::Image;
using image::Rect;
using image::TileCoord;

// Parallel loops and cancellation for node code, on the job's threads.
class TokenTasks final : public graph::TaskRunner {
public:
    explicit TokenTasks(const CancellationToken& token) : m_token(&token) {}

    void forEach(std::size_t count, const std::function<void(std::size_t)>& body) const override {
        parallelFor<std::size_t>(0, count, *m_token, body);
    }
    [[nodiscard]] bool isCancelled() const override { return m_token->isCancelled(); }
    void throwIfCancelled() const override { m_token->throwIfCancelled(); }

private:
    const CancellationToken* m_token;
};

// Runs node code; a failure (other than cancellation, or an error that names a node already) gets the node's name.
template <class Function>
decltype(auto) guarded(const graph::Node& node, const Function& function) {
    try {
        return function();
    } catch (const graph::EvaluationError&) {
        throw;
    } catch (const OperationCancelled&) {
        throw;
    } catch (const std::exception& error) {
        throw graph::EvaluationError(node.id(), node.name() + ": " + error.what());
    }
}

void checkNotUiThread() {
    if (isUiThread()) {
        throw std::logic_error("node evaluation never runs on the UI thread (it may read files)");
    }
}

void checkProxyScale(int proxyScale) {
    if (!graph::isValidProxyScale(proxyScale)) {
        throw std::invalid_argument("proxy scale " + std::to_string(proxyScale) + " is not 1, 2, 4, 8, 16 or 32");
    }
}

} // namespace

// One evaluation call: remembers each (node, frame) it met — parameter values, pass-through routing, hash — so a
// node read by several others is worked out once. Lives on one thread; node code it calls may fan out to others.
class Evaluator::Session {
public:
    Session(Evaluator& owner, const graph::Graph& graph, const CancellationToken& token)
        : m_owner(&owner),
          m_graph(&graph),
          m_token(&token) {}

    HashValue hashShown(graph::NodeId id, double frame) {
        NodeFrame* target = resolve(state(id, frame));
        return target == nullptr ? emptyHash : hashOf(*target);
    }

    graph::OutputInfo infoShown(graph::NodeId id, double frame, int proxyScale) {
        NodeFrame* target = resolve(state(id, frame));
        return target == nullptr ? graph::OutputInfo{} : infoOf(*target, proxyScale);
    }

    Image evaluateShown(graph::NodeId id, double frame, const Rect& region, const ChannelSet& channels,
                        int proxyScale) {
        NodeFrame* target = resolve(state(id, frame));
        return target == nullptr ? Image{} : evaluate(*target, region, channels, proxyScale);
    }

private:
    struct NodeFrame {
        std::shared_ptr<const graph::Node> node;
        double frame = 0.0;
        graph::ParamValues params;
        std::vector<std::uint8_t> connected;
        bool resolved = false;
        NodeFrame* target = nullptr; // after skipping pass-through nodes; null: nothing
        std::optional<HashValue> hash;

        [[nodiscard]] graph::NodeContext context() const { return {frame, params, connected}; }
        [[nodiscard]] const graph::NodeOp& op() const { return *node->def().op; }
        [[nodiscard]] bool isConnected(std::size_t input) const {
            return input < connected.size() && connected[input] != 0;
        }
    };

    NodeFrame& state(graph::NodeId id, double frame) {
        if (!std::isfinite(frame)) {
            throw std::invalid_argument("frame " + std::to_string(frame) + " is not a finite number");
        }
        auto& slot = m_states[{id.value, frame}];
        if (!slot) {
            auto created = std::make_unique<NodeFrame>();
            created->node = m_graph->nodePointer(id);
            created->frame = frame;
            created->params = guarded(*created->node, [&] { return created->node->valuesAt(frame); });
            for (const std::optional<graph::NodeId>& input : created->node->inputs()) {
                created->connected.push_back(input ? 1 : 0);
            }
            slot = std::move(created);
        }
        return *slot;
    }

    NodeFrame& inputState(const NodeFrame& node, std::size_t input, double frame) {
        return state(inputNode(node, input), frame);
    }

    // The node connected to `input`, which must be connected.
    static graph::NodeId inputNode(const NodeFrame& node, std::size_t input) {
        const std::optional<graph::NodeId> id = node.node->input(input);
        if (!id) {
            throw std::logic_error("input " + std::to_string(input) + " of " + node.node->name() + " is not connected");
        }
        return *id;
    }

    static double inputFrame(const NodeFrame& node, std::size_t input) {
        const double frame = guarded(*node.node, [&] { return node.op().inputFrame(node.context(), input); });
        if (!std::isfinite(frame)) {
            throw graph::EvaluationError(node.node->id(),
                                         node.node->name() + ": asked for a frame that is not a number");
        }
        return frame;
    }

    // The node that really computes what `node` shows, or null for nothing.
    NodeFrame* resolve(NodeFrame& node) {
        if (node.resolved) {
            return node.target;
        }
        NodeFrame* target = &node;
        if (node.node->isBypassed()) {
            target = node.isConnected(0) ? resolve(inputState(node, 0, node.frame)) : nullptr;
        } else if (const std::optional<std::size_t> input =
                       guarded(*node.node, [&] { return node.op().passThroughInput(node.context()); })) {
            target = node.isConnected(*input) ? resolve(inputState(node, *input, inputFrame(node, *input))) : nullptr;
        }
        node.resolved = true;
        node.target = target;
        return target;
    }

    HashValue hashOf(NodeFrame& node) {
        if (node.hash) {
            return *node.hash;
        }
        const graph::NodeDef& def = node.node->def();
        graph::Hasher hasher;
        hasher.addText("pf.node").addText(def.typeId).addInteger(def.version);
        for (std::size_t i = 0; i < def.params.size(); ++i) {
            if (def.params[i].affectsPixels) {
                hasher.addText(def.params[i].id);
                graph::addToHash(hasher, node.params[i]);
            }
        }
        guarded(*node.node, [&] { node.op().hashExtra(node.context(), hasher); });
        for (std::size_t i = 0; i < node.connected.size(); ++i) {
            hasher.addUnsigned(node.isConnected(i) ? hashShown(inputNode(node, i), inputFrame(node, i)) : emptyHash);
        }
        node.hash = hasher.finish();
        return *node.hash;
    }

    std::vector<graph::OutputInfo> inputInfos(NodeFrame& node, int proxyScale) {
        std::vector<graph::OutputInfo> infos(node.connected.size());
        for (std::size_t i = 0; i < infos.size(); ++i) {
            if (node.isConnected(i)) {
                infos[i] = infoShown(inputNode(node, i), inputFrame(node, i), proxyScale);
            }
        }
        return infos;
    }

    graph::OutputInfo infoOf(NodeFrame& node, int proxyScale) {
        const InfoKey key{.hash = hashOf(node), .proxyScale = proxyScale};
        if (const std::shared_ptr<const graph::OutputInfo> cached = m_owner->m_infos.find(key)) {
            return *cached;
        }
        const std::vector<graph::OutputInfo> inputs = inputInfos(node, proxyScale);
        graph::OutputInfo info =
            guarded(*node.node, [&] { return node.op().info(node.context(), proxyScale, inputs); });
        if (!image::isWithinLimits(info.displayWindow) || !image::isWithinLimits(info.dataWindow)) {
            throw graph::EvaluationError(node.node->id(), node.node->name() + ": its output lies outside the limits");
        }
        if (info.dataWindow.isEmpty()) {
            info.dataWindow = {};
        }
        std::size_t bytes = sizeof(graph::OutputInfo);
        for (const std::string& channel : info.channels) {
            bytes += channel.size();
        }
        m_owner->m_infos.insert(key, std::make_shared<const graph::OutputInfo>(info), bytes);
        return info;
    }

    Image evaluate(NodeFrame& node, const Rect& region, const ChannelSet& channels, int proxyScale) {
        const HashValue hash = hashOf(node);
        const graph::OutputInfo info = infoOf(node, proxyScale);
        const Rect window = image::intersect(image::alignOut(region, image::tileSize), info.dataWindow);
        const ChannelSet wanted = image::intersect(channels, info.channels);
        Image output(info.displayWindow, window, wanted);
        if (window.isEmpty() || wanted.empty()) {
            return output;
        }
        m_token->throwIfCancelled();

        // Take what the cache has; note which tiles and channels are missing.
        const Rect range = output.tileRange();
        std::vector<TileCoord> tiles;
        for (int ty = range.y0; ty < range.y1; ++ty) {
            for (int tx = range.x0; tx < range.x1; ++tx) {
                tiles.push_back({.x = tx, .y = ty});
            }
        }
        const std::size_t channelCount = wanted.size();
        std::vector<std::shared_ptr<const Image::TileContent>> cached(tiles.size() * channelCount);
        std::vector<std::uint8_t> tileMissing(tiles.size(), 0);
        std::vector<std::uint8_t> channelMissing(channelCount, 0);
        for (std::size_t t = 0; t < tiles.size(); ++t) {
            for (std::size_t c = 0; c < channelCount; ++c) {
                auto& slot = cached[(t * channelCount) + c];
                slot = m_owner->m_tiles.find(
                    {.hash = hash, .proxyScale = proxyScale, .channel = wanted[c], .tile = tiles[t]});
                if (!slot) {
                    tileMissing[t] = 1;
                    channelMissing[c] = 1;
                }
            }
        }
        std::vector<TileCoord> missingTiles;
        Rect renderRegion;
        for (std::size_t t = 0; t < tiles.size(); ++t) {
            if (tileMissing[t] != 0) {
                missingTiles.push_back(tiles[t]);
                renderRegion = image::unite(renderRegion, image::intersect(image::tileCell(tiles[t]), window));
            }
        }
        ChannelSet missingChannels;
        for (std::size_t c = 0; c < channelCount; ++c) {
            if (channelMissing[c] != 0) {
                missingChannels.insert(wanted[c]);
            }
        }
        for (std::size_t t = 0; t < tiles.size(); ++t) {
            for (std::size_t c = 0; c < channelCount; ++c) {
                if (tileMissing[t] == 0 || channelMissing[c] == 0) {
                    output.setTileContent(c, tiles[t], *cached[(t * channelCount) + c]);
                }
            }
        }
        if (missingTiles.empty()) {
            return output;
        }

        // Evaluate what the inputs must deliver for the missing tiles, then render them.
        const std::vector<graph::OutputInfo> infos = inputInfos(node, proxyScale);
        const graph::NodeContext context = node.context();
        const graph::RegionContext regionContext(context, proxyScale, infos, info, renderRegion, missingChannels);
        std::vector<Image> inputs(node.connected.size());
        for (std::size_t i = 0; i < inputs.size(); ++i) {
            if (!node.isConnected(i)) {
                continue;
            }
            const graph::InputRequest request =
                guarded(*node.node, [&] { return node.op().inputRequest(regionContext, i); });
            inputs[i] = evaluateShown(inputNode(node, i), request.frame, request.region, request.channels, proxyScale);
        }
        m_token->throwIfCancelled();
        const TokenTasks tasks(*m_token);
        const graph::RenderContext renderContext(regionContext, inputs, output, missingTiles, tasks);
        guarded(*node.node, [&] { node.op().render(renderContext); });

        for (const TileCoord& tile : missingTiles) {
            for (const std::string& channel : missingChannels) {
                Image::TileContent content = output.tileContent(output.channelIndex(channel), tile);
                const std::size_t bytes =
                    content.storage ? static_cast<std::size_t>(content.storage->rect().area()) * sizeof(float) : 0;
                m_owner->m_tiles.insert({.hash = hash, .proxyScale = proxyScale, .channel = channel, .tile = tile},
                                        std::make_shared<const Image::TileContent>(std::move(content)), bytes);
            }
        }
        m_owner->m_renderedTiles.fetch_add(missingTiles.size() * missingChannels.size(), std::memory_order_relaxed);
        return output;
    }

    Evaluator* m_owner;
    const graph::Graph* m_graph;
    const CancellationToken* m_token;
    std::map<std::pair<std::uint64_t, double>, std::unique_ptr<NodeFrame>> m_states;
};

std::size_t Evaluator::TileKeyHash::operator()(const TileKey& key) const {
    graph::Hasher hasher;
    hasher.addUnsigned(key.hash)
        .addInteger(key.proxyScale)
        .addText(key.channel)
        .addInteger(key.tile.x)
        .addInteger(key.tile.y);
    return static_cast<std::size_t>(hasher.finish());
}

std::size_t Evaluator::InfoKeyHash::operator()(const InfoKey& key) const {
    graph::Hasher hasher;
    hasher.addUnsigned(key.hash).addInteger(key.proxyScale);
    return static_cast<std::size_t>(hasher.finish());
}

Evaluator::Evaluator(MemoryBudget& budget, const EvaluatorOptions& options)
    : m_tiles("Node results", budget, options.maxTileEntries),
      m_infos("Node descriptions", budget, options.maxInfoEntries) {}

Image Evaluator::evaluate(const graph::Graph& graph, const graph::Request& request, const CancellationToken& token) {
    checkNotUiThread();
    checkProxyScale(request.proxyScale);
    Session session(*this, graph, token);
    return session.evaluateShown(request.node, request.frame, request.region, request.channels, request.proxyScale);
}

graph::OutputInfo Evaluator::info(const graph::Graph& graph, graph::NodeId node, double frame, int proxyScale) {
    checkNotUiThread();
    checkProxyScale(proxyScale);
    const CancellationToken never;
    Session session(*this, graph, never);
    return session.infoShown(node, frame, proxyScale);
}

graph::HashValue Evaluator::hash(const graph::Graph& graph, graph::NodeId node, double frame) {
    checkNotUiThread();
    const CancellationToken never;
    Session session(*this, graph, never);
    return session.hashShown(node, frame);
}

EvaluatorStats Evaluator::stats() const {
    return {.tiles = m_tiles.stats(),
            .infos = m_infos.stats(),
            .renderedTiles = m_renderedTiles.load(std::memory_order_relaxed)};
}

void Evaluator::clear() {
    m_tiles.clear();
    m_infos.clear();
}

} // namespace pf::engine
