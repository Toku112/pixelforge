// Pull evaluation and the node result cache (engine/Evaluator.h, docs/specs/node-graph.md §5). Uses small node types
// of its own, defined here, whose results are easy to predict and which count their work.

#include "engine/Evaluator.h"

#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"
#include "core/graph/NodeOp.h"
#include "engine/Cancellation.h"
#include "engine/MemoryBudget.h"
#include "engine/Scheduler.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace pf::engine {
namespace {

using graph::Graph;
using graph::NodeContext;
using graph::NodeDef;
using graph::NodeId;
using graph::OutputInfo;
using image::ChannelSet;
using image::Image;
using image::Rect;
using image::TileCoord;

constexpr Rect everything{.x0 = -100000, .y0 = -100000, .x1 = 100000, .y1 = 100000};

// The value the pattern node gives channel `c` (0 R, 1 G, 2 Z) at full-resolution pixel (x, y).
float pattern(std::size_t c, int x, int y, double offset) {
    return static_cast<float>((static_cast<double>(c) * 1000.0) + x + (y * 0.001) + offset);
}

std::size_t indexIn(const ChannelSet& channels, const std::string& name) {
    const std::optional<std::size_t> index = channels.indexOf(name);
    if (!index) {
        throw std::out_of_range("no channel " + name);
    }
    return *index;
}

// A generator: a width × height frame with 10 pixels of overscan left and right, channels R, G, Z holding pattern().
class PatternOp final : public graph::NodeOp {
public:
    mutable std::atomic<int> tilesRendered{0};

    [[nodiscard]] OutputInfo info(const NodeContext& node, int proxyScale,
                                  std::span<const OutputInfo> /*inputs*/) const override {
        const auto w = static_cast<int>(node.params().getInt("width"));
        const auto h = static_cast<int>(node.params().getInt("height"));
        return {.displayWindow = graph::scaleForProxy({.x0 = 0, .y0 = 0, .x1 = w, .y1 = h}, proxyScale),
                .dataWindow = graph::scaleForProxy({.x0 = -10, .y0 = 0, .x1 = w + 10, .y1 = h}, proxyScale),
                .channels = {"R", "G", "Z"}};
    }

    void render(const graph::RenderContext& context) const override {
        const double offset = context.params().getFloat("offset");
        const int p = context.proxyScale();
        const ChannelSet all{"R", "G", "Z"};
        context.forEachTile([&](TileCoord tile) {
            tilesRendered.fetch_add(1);
            for (const std::string& channel : context.channels()) {
                const std::size_t c = indexIn(all, channel);
                const image::MutableTile out =
                    context.output().overwriteTile(context.output().channelIndex(channel), tile);
                for (int y = out.rect.y0; y < out.rect.y1; ++y) {
                    for (int x = out.rect.x0; x < out.rect.x1; ++x) {
                        out.at(x, y) = pattern(c, x * p, y * p, offset);
                    }
                }
            }
        });
    }
};

// Adds `amount` to every channel; remembers what it asked its input for.
class AddOp final : public graph::NodeOp {
public:
    mutable std::atomic<int> tilesRendered{0};
    mutable std::mutex mutex;
    mutable std::vector<graph::InputRequest> requests;

    [[nodiscard]] OutputInfo info(const NodeContext& /*node*/, int /*proxyScale*/,
                                  std::span<const OutputInfo> inputs) const override {
        return inputs[0];
    }

    [[nodiscard]] graph::InputRequest inputRequest(const graph::RegionContext& context,
                                                   std::size_t index) const override {
        graph::InputRequest request = NodeOp::inputRequest(context, index);
        const std::scoped_lock lock(mutex);
        requests.push_back(request);
        return request;
    }

    void render(const graph::RenderContext& context) const override {
        const auto amount = static_cast<float>(context.params().getFloat("amount"));
        context.forEachTile([&](TileCoord tile) {
            tilesRendered.fetch_add(1);
            for (const std::string& channel : context.channels()) {
                const image::ConstTile in = context.input(0).tile(context.input(0).channelIndex(channel), tile);
                const image::MutableTile out =
                    context.output().overwriteTile(context.output().channelIndex(channel), tile);
                for (int y = out.rect.y0; y < out.rect.y1; ++y) {
                    for (int x = out.rect.x0; x < out.rect.x1; ++x) {
                        out.at(x, y) = in.at(x, y) + amount;
                    }
                }
            }
        });
    }
};

// A horizontal box blur of `radius` pixels: needs its input `radius` pixels further left and right.
class BlurOp final : public graph::NodeOp {
public:
    [[nodiscard]] OutputInfo info(const NodeContext& /*node*/, int /*proxyScale*/,
                                  std::span<const OutputInfo> inputs) const override {
        return inputs[0];
    }

    [[nodiscard]] graph::InputRequest inputRequest(const graph::RegionContext& context,
                                                   std::size_t /*index*/) const override {
        const auto r = static_cast<int>(context.params().getInt("radius"));
        return {.frame = context.frame(),
                .region = image::pad(context.region(), r, 0, r, 0),
                .channels = context.channels()};
    }

    void render(const graph::RenderContext& context) const override {
        const auto r = static_cast<int>(context.params().getInt("radius"));
        const Image& input = context.input(0);
        context.forEachTile([&](TileCoord tile) {
            for (const std::string& channel : context.channels()) {
                const image::MutableTile out =
                    context.output().overwriteTile(context.output().channelIndex(channel), tile);
                const Rect source = image::pad(out.rect, r, 0, r, 0);
                std::vector<float> row(static_cast<std::size_t>(source.width()));
                for (int y = out.rect.y0; y < out.rect.y1; ++y) {
                    input.read(input.channelIndex(channel), {.x0 = source.x0, .y0 = y, .x1 = source.x1, .y1 = y + 1},
                               row, row.size());
                    for (int x = out.rect.x0; x < out.rect.x1; ++x) {
                        float sum = 0.0F;
                        for (int i = -r; i <= r; ++i) {
                            sum += row[static_cast<std::size_t>(x + i - source.x0)];
                        }
                        out.at(x, y) = sum / static_cast<float>((2 * r) + 1);
                    }
                }
            }
        });
    }
};

// Shows its input `offset` frames later.
class TimeOffsetOp final : public graph::NodeOp {
public:
    [[nodiscard]] double inputFrame(const NodeContext& node, std::size_t /*index*/) const override {
        return node.frame() + static_cast<double>(node.params().getInt("offset"));
    }
    [[nodiscard]] OutputInfo info(const NodeContext& /*node*/, int /*proxyScale*/,
                                  std::span<const OutputInfo> inputs) const override {
        return inputs[0];
    }
    void render(const graph::RenderContext& context) const override {
        context.forEachTile([&](TileCoord tile) {
            for (const std::string& channel : context.channels()) {
                context.output().copyTile(context.output().channelIndex(channel), tile, context.input(0),
                                          context.input(0).channelIndex(channel));
            }
        });
    }
};

// Describes itself, then fails to render; or calls `onRender` first (to cancel mid-way).
class FailOp final : public graph::NodeOp {
public:
    std::function<void()> onRender;

    [[nodiscard]] OutputInfo info(const NodeContext& /*node*/, int /*proxyScale*/,
                                  std::span<const OutputInfo> /*inputs*/) const override {
        return {.displayWindow = {.x0 = 0, .y0 = 0, .x1 = 512, .y1 = 512},
                .dataWindow = {.x0 = 0, .y0 = 0, .x1 = 512, .y1 = 512},
                .channels = {"R"}};
    }
    void render(const graph::RenderContext& context) const override {
        if (onRender) {
            onRender();
            context.forEachTile([&](TileCoord tile) { context.output().setTileConstant(0, tile, 1.0F); });
            return;
        }
        throw std::runtime_error("this node always fails");
    }
};

// Shows a number from the outside world (as the Read node shows a file on disk), looked at once per frame and
// evaluation in prepare(); `afterPrepare` lets a test change the world in the middle of an evaluation.
class WorldOp final : public graph::NodeOp {
public:
    class Seen final : public graph::PreparedFrame {
    public:
        explicit Seen(int seenValue) : value(seenValue) {}
        int value;
    };

    mutable std::atomic<int> world{1};
    mutable std::atomic<int> prepares{0};
    std::function<void()> afterPrepare;

    [[nodiscard]] std::shared_ptr<const graph::PreparedFrame> prepare(const NodeContext& /*node*/) const override {
        prepares.fetch_add(1);
        auto now = std::make_shared<const Seen>(world.load());
        if (afterPrepare) {
            afterPrepare();
        }
        return now;
    }
    void hashExtra(const NodeContext& node, graph::Hasher& hasher) const override { hasher.addInteger(seen(node)); }
    [[nodiscard]] OutputInfo info(const NodeContext& node, int /*proxyScale*/,
                                  std::span<const OutputInfo> /*inputs*/) const override {
        (void)seen(node);
        return {.displayWindow = {.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 64},
                .dataWindow = {.x0 = 0, .y0 = 0, .x1 = 64, .y1 = 64},
                .channels = {"R"}};
    }
    void render(const graph::RenderContext& context) const override {
        const auto value = static_cast<float>(seen(context.node()));
        context.forEachTile([&](TileCoord tile) { context.output().setTileConstant(0, tile, value); });
    }

private:
    static int seen(const NodeContext& node) {
        const auto* found = dynamic_cast<const Seen*>(node.prepared());
        if (found == nullptr) {
            throw std::logic_error("not prepared");
        }
        return found->value;
    }
};

std::shared_ptr<const NodeDef> makeDef(const std::string& id, std::size_t inputCount,
                                       std::vector<graph::ParamDef> params, std::shared_ptr<const graph::NodeOp> op) {
    std::vector<graph::PortDef> inputs;
    inputs.reserve(inputCount);
    for (std::size_t i = 0; i < inputCount; ++i) {
        inputs.push_back({.id = "input" + std::to_string(i), .label = std::to_string(i)});
    }
    auto def = std::make_shared<const NodeDef>(NodeDef{.typeId = id,
                                                       .version = 1,
                                                       .label = id,
                                                       .category = "Test",
                                                       .inputs = std::move(inputs),
                                                       .hasOutput = true,
                                                       .params = std::move(params),
                                                       .op = std::move(op)});
    graph::validate(*def);
    return def;
}

graph::ParamDef displayOnly(graph::ParamDef def) {
    def.affectsPixels = false;
    return def;
}

class EvaluatorTest : public ::testing::Test {
public:
    std::shared_ptr<PatternOp> patternOp = std::make_shared<PatternOp>();
    std::shared_ptr<AddOp> addOp = std::make_shared<AddOp>();
    std::shared_ptr<FailOp> failOp = std::make_shared<FailOp>();

    std::shared_ptr<const NodeDef> patternType =
        makeDef("Pattern", 0,
                {graph::floatParam("offset", "Offset", 0.0, -1e6, 1e6, 0.0, 1.0),
                 graph::intParam("width", "Width", 600, 1, 100000), graph::intParam("height", "Height", 400, 1, 100000),
                 displayOnly(graph::floatParam("note", "Note", 0.0, -1e6, 1e6, 0.0, 1.0))},
                patternOp);
    std::shared_ptr<const NodeDef> addType =
        makeDef("Add", 1, {graph::floatParam("amount", "Amount", 0.0, -1e6, 1e6, 0.0, 1.0)}, addOp);
    std::shared_ptr<const NodeDef> blurType =
        makeDef("Blur", 1, {graph::intParam("radius", "Radius", 1, 0, 64)}, std::make_shared<BlurOp>());
    std::shared_ptr<const NodeDef> offsetType = makeDef(
        "TimeOffset", 1, {graph::intParam("offset", "Offset", 0, -1000, 1000)}, std::make_shared<TimeOffsetOp>());
    std::shared_ptr<const NodeDef> failType = makeDef("Fail", 0, {}, failOp);
    std::shared_ptr<WorldOp> worldOp = std::make_shared<WorldOp>();
    std::shared_ptr<const NodeDef> worldType = makeDef("World", 0, {}, worldOp);

    MemoryBudget budget{std::size_t{1} << 40};
    Evaluator evaluator{budget};
    Graph graph;

    Image evaluate(NodeId node, const Rect& region = everything, const ChannelSet& channels = {"R", "G", "Z"},
                   double frame = 1.0, int proxyScale = 1) {
        return evaluator.evaluate(
            graph, {.node = node, .frame = frame, .region = region, .channels = channels, .proxyScale = proxyScale});
    }

    std::uint64_t rendered() const { return evaluator.stats().renderedTiles; }
};

// Checks every 7th pixel of every channel against pattern() + `add`.
void expectPattern(const Image& image, double offset, float add = 0.0F) {
    const ChannelSet all{"R", "G", "Z"};
    const Rect& data = image.dataWindow();
    for (const std::string& channel : image.channels()) {
        const std::size_t c = indexIn(all, channel);
        for (int y = data.y0; y < data.y1; y += 7) {
            for (int x = data.x0; x < data.x1; x += 7) {
                ASSERT_FLOAT_EQ(image.sample(channel, x, y), pattern(c, x, y, offset) + add)
                    << channel << " at (" << x << ", " << y << ")";
            }
        }
    }
}

TEST_F(EvaluatorTest, PullsPixelsThroughAChain) {
    const NodeId source = graph.addNode(patternType);
    const NodeId add1 = graph.addNode(addType);
    const NodeId add2 = graph.addNode(addType);
    graph.connect(source, add1, 0);
    graph.connect(add1, add2, 0);
    graph.setValue(add1, "amount", 1.0);
    graph.setValue(add2, "amount", 2.0);

    const Image result = evaluate(add2);
    EXPECT_EQ(result.displayWindow(), (Rect{.x0 = 0, .y0 = 0, .x1 = 600, .y1 = 400}));
    EXPECT_EQ(result.dataWindow(), (Rect{.x0 = -10, .y0 = 0, .x1 = 610, .y1 = 400}));
    EXPECT_EQ(result.channels(), (ChannelSet{"R", "G", "Z"}));
    expectPattern(result, 0.0, 3.0F);
}

TEST_F(EvaluatorTest, AnswersWithTheRequestedRegionAndChannels) {
    const NodeId source = graph.addNode(patternType);
    // A region inside one tile comes back as that whole tile; channels the node lacks are left out.
    const Image result = evaluate(source, {.x0 = 300, .y0 = 10, .x1 = 310, .y1 = 20}, {"G", "missing"});
    EXPECT_EQ(result.dataWindow(), (Rect{.x0 = 256, .y0 = 0, .x1 = 512, .y1 = 256}));
    EXPECT_EQ(result.channels(), (ChannelSet{"G"}));
    expectPattern(result, 0.0);

    // Outside the data window: no pixels.
    const Image outside = evaluate(source, {.x0 = 5000, .y0 = 0, .x1 = 5100, .y1 = 100});
    EXPECT_TRUE(outside.dataWindow().isEmpty());
    EXPECT_EQ(outside.displayWindow(), (Rect{.x0 = 0, .y0 = 0, .x1 = 600, .y1 = 400}));
}

TEST_F(EvaluatorTest, CachedTilesAreNotRenderedAgain) {
    const NodeId source = graph.addNode(patternType);
    const NodeId add = graph.addNode(addType);
    graph.connect(source, add, 0);
    graph.setValue(add, "amount", 1.0);

    const Image first = evaluate(add);
    const std::uint64_t afterFirst = rendered();
    EXPECT_EQ(afterFirst, 8U * 3U * 2U); // 4 × 2 tiles (the overscan reaches tile −1), 3 channels, 2 nodes
    const Image second = evaluate(add);
    EXPECT_EQ(rendered(), afterFirst);
    // The cached tiles are shared, not copied.
    EXPECT_EQ(second.tile(0, {.x = 1, .y = 1}).samples, first.tile(0, {.x = 1, .y = 1}).samples);
    expectPattern(second, 0.0, 1.0F);
}

TEST_F(EvaluatorTest, AParameterChangeRecomputesOnlyWhatDependsOnIt) {
    const NodeId source = graph.addNode(patternType);
    const NodeId add1 = graph.addNode(addType);
    const NodeId add2 = graph.addNode(addType);
    graph.connect(source, add1, 0);
    graph.connect(add1, add2, 0);
    graph.setValue(add1, "amount", 1.0);
    graph.setValue(add2, "amount", 1.0);
    (void)evaluate(add2);
    const int patternTiles = patternOp->tilesRendered;
    const int addTiles = addOp->tilesRendered;

    graph.setValue(add2, "amount", 5.0);
    expectPattern(evaluate(add2), 0.0, 6.0F);
    EXPECT_EQ(patternOp->tilesRendered, patternTiles);
    EXPECT_EQ(addOp->tilesRendered, addTiles + 8); // only add2's eight tiles

    // A display setting changes no hash, so nothing is rendered again.
    const graph::HashValue before = evaluator.hash(graph, add2, 1.0);
    graph.setValue(source, "note", 42.0);
    EXPECT_EQ(evaluator.hash(graph, add2, 1.0), before);
    const std::uint64_t count = rendered();
    (void)evaluate(add2);
    EXPECT_EQ(rendered(), count);
}

TEST_F(EvaluatorTest, IdenticalWorkSharesResults) {
    const NodeId source = graph.addNode(patternType);
    const NodeId add1 = graph.addNode(addType);
    const NodeId add2 = graph.addNode(addType);
    graph.connect(source, add1, 0);
    graph.connect(source, add2, 0);
    graph.setValue(add1, "amount", 2.0);
    graph.setValue(add2, "amount", 2.0);
    EXPECT_EQ(evaluator.hash(graph, add1, 1.0), evaluator.hash(graph, add2, 1.0));
    (void)evaluate(add1);
    const std::uint64_t count = rendered();
    expectPattern(evaluate(add2), 0.0, 2.0F);
    EXPECT_EQ(rendered(), count);

    // Names and positions are not part of the hash.
    graph.renameNode(add2, "Renamed");
    graph.setPosition(add2, {.x = 100.0, .y = -50.0});
    EXPECT_EQ(evaluator.hash(graph, add1, 1.0), evaluator.hash(graph, add2, 1.0));
}

TEST_F(EvaluatorTest, OnlyMissingTilesAreRendered) {
    const NodeId source = graph.addNode(patternType);
    (void)evaluate(source, {.x0 = 0, .y0 = 0, .x1 = 100, .y1 = 100}); // tile (0, 0)
    EXPECT_EQ(patternOp->tilesRendered, 1);
    (void)evaluate(source, {.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 100}); // tiles (0, 0) and (1, 0)
    EXPECT_EQ(patternOp->tilesRendered, 2);
    // A channel not cached yet renders that channel only, for the tiles asked.
    const std::uint64_t count = rendered();
    (void)evaluate(source, {.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 100}, {"R", "G"});
    EXPECT_EQ(rendered(), count);
}

TEST_F(EvaluatorTest, RegionsOfInterestPropagateUpstream) {
    const NodeId source = graph.addNode(patternType);
    const NodeId blur = graph.addNode(blurType);
    const NodeId add = graph.addNode(addType);
    graph.connect(source, blur, 0);
    graph.connect(blur, add, 0);
    graph.setValue(blur, "radius", std::int64_t{3});

    // One tile of the blur needs its input three pixels wider on each side.
    const Image part = evaluate(add, {.x0 = 300, .y0 = 0, .x1 = 301, .y1 = 1}, {"R"});
    ASSERT_EQ(addOp->requests.size(), 1U);
    EXPECT_EQ(addOp->requests[0].region, (Rect{.x0 = 256, .y0 = 0, .x1 = 512, .y1 = 256}));
    EXPECT_EQ(addOp->requests[0].channels, (ChannelSet{"R"}));
    EXPECT_EQ(patternOp->tilesRendered, 3); // tiles (0, 0), (1, 0) and (2, 0) hold [253, 515)

    // The blurred tile equals the same tile of a blur computed over the whole image: a pixel's value never depends
    // on the region asked for.
    const Image whole = [&] {
        Evaluator fresh(budget);
        return fresh.evaluate(graph, {.node = add, .frame = 1.0, .region = everything, .channels = {"R"}});
    }();
    for (int y = 0; y < 256; y += 5) {
        for (int x = 256; x < 512; ++x) {
            ASSERT_EQ(part.sample("R", x, y), whole.sample("R", x, y));
        }
    }
    // Spot-check the maths: the average of x − 3 … x + 3 of a ramp in x is x.
    EXPECT_NEAR(part.sample("R", 400, 0), pattern(0, 400, 0, 0.0), 1e-3);
}

TEST_F(EvaluatorTest, BypassedNodesPassTheirFirstInputThrough) {
    const NodeId source = graph.addNode(patternType);
    const NodeId add = graph.addNode(addType);
    graph.connect(source, add, 0);
    graph.setValue(add, "amount", 7.0);
    graph.setBypassed(add, true);
    EXPECT_EQ(evaluator.hash(graph, add, 1.0), evaluator.hash(graph, source, 1.0));
    expectPattern(evaluate(add), 0.0);
    EXPECT_EQ(addOp->tilesRendered, 0);
}

TEST_F(EvaluatorTest, PreparedFramesGiveTheHashAndThePixelsTheSameAnswer) {
    const NodeId world = graph.addNode(worldType);
    // The world changes right after the node looked at it: this evaluation still shows what it saw, and caches it
    // under the hash of what it saw.
    worldOp->afterPrepare = [&] { worldOp->world = 2; };
    EXPECT_EQ(evaluate(world, everything, {"R"}).sample("R", 5, 5), 1.0F);
    EXPECT_EQ(worldOp->prepares, 1);
    worldOp->afterPrepare = nullptr;
    // The next evaluation sees the change; going back reuses the first result.
    EXPECT_EQ(evaluate(world, everything, {"R"}).sample("R", 5, 5), 2.0F);
    worldOp->world = 1;
    EXPECT_EQ(evaluate(world, everything, {"R"}).sample("R", 5, 5), 1.0F);
    EXPECT_EQ(rendered(), 2U);

    // Once per frame and evaluation; not for bypassed nodes.
    EXPECT_EQ(worldOp->prepares, 3);
    (void)evaluator.info(graph, world, 2.0, 1);
    EXPECT_EQ(worldOp->prepares, 4);
    graph.setBypassed(world, true);
    EXPECT_TRUE(evaluate(world).channels().empty());
    EXPECT_EQ(worldOp->prepares, 4);
}

TEST_F(EvaluatorTest, UnconnectedInputsGiveNothing) {
    const NodeId add = graph.addNode(addType);
    const Image result = evaluate(add);
    EXPECT_TRUE(result.channels().empty());
    EXPECT_TRUE(result.dataWindow().isEmpty());
    EXPECT_EQ(evaluator.info(graph, add, 1.0, 1), OutputInfo{});

    // A bypassed node without inputs shows nothing.
    const NodeId source = graph.addNode(patternType);
    graph.setBypassed(source, true);
    EXPECT_EQ(evaluator.hash(graph, source, 1.0), Evaluator::emptyHash);
}

TEST_F(EvaluatorTest, AnimatedParametersChangeTheResultPerFrame) {
    const NodeId source = graph.addNode(patternType);
    const NodeId add = graph.addNode(addType);
    graph.connect(source, add, 0);
    graph.setKey(add, "amount", 0, {.frame = 1.0, .value = 0.0});
    graph.setKey(add, "amount", 0, {.frame = 11.0, .value = 10.0});

    expectPattern(evaluate(add, everything, {"R"}, 6.0), 0.0, 5.0F);
    expectPattern(evaluate(add, everything, {"R"}, 11.0), 0.0, 10.0F);
    EXPECT_NE(evaluator.hash(graph, add, 6.0), evaluator.hash(graph, add, 11.0));
    // The source is not animated: one result serves every frame.
    EXPECT_EQ(evaluator.hash(graph, source, 6.0), evaluator.hash(graph, source, 11.0));
    EXPECT_EQ(patternOp->tilesRendered, 8);
    // Frames after the last key hold its value: same hash as the last key.
    EXPECT_EQ(evaluator.hash(graph, add, 20.0), evaluator.hash(graph, add, 11.0));
}

TEST_F(EvaluatorTest, NodesReadTheirInputsAtOtherFrames) {
    const NodeId source = graph.addNode(patternType);
    graph.setKey(source, "offset", 0, {.frame = 0.0, .value = 0.0});
    graph.setKey(source, "offset", 0, {.frame = 100.0, .value = 100.0});
    const NodeId later = graph.addNode(offsetType);
    graph.connect(source, later, 0);
    graph.setValue(later, "offset", std::int64_t{5});

    expectPattern(evaluate(later, everything, {"G"}, 10.0), 15.0);
    EXPECT_NE(evaluator.hash(graph, later, 10.0), evaluator.hash(graph, later, 11.0));
}

TEST_F(EvaluatorTest, ProxyScalesDivideTheResolution) {
    const NodeId source = graph.addNode(patternType);
    const Image half = evaluate(source, everything, {"R"}, 1.0, 2);
    EXPECT_EQ(half.displayWindow(), (Rect{.x0 = 0, .y0 = 0, .x1 = 300, .y1 = 200}));
    EXPECT_EQ(half.dataWindow(), (Rect{.x0 = -5, .y0 = 0, .x1 = 305, .y1 = 200}));
    EXPECT_FLOAT_EQ(half.sample("R", 100, 50), pattern(0, 200, 100, 0.0));
    // Each proxy scale has its own cache entries.
    const Image full = evaluate(source, everything, {"R"}, 1.0, 1);
    EXPECT_FLOAT_EQ(full.sample("R", 100, 50), pattern(0, 100, 50, 0.0));

    EXPECT_THROW((void)evaluate(source, everything, {"R"}, 1.0, 3), std::invalid_argument);
    EXPECT_EQ(graph::scaleForProxy({.x0 = -3, .y0 = 0, .x1 = 1081, .y1 = 1080}, 16),
              (Rect{.x0 = -1, .y0 = 0, .x1 = 68, .y1 = 68}));
}

TEST_F(EvaluatorTest, FailuresNameTheNodeAndAreNotCached) {
    const NodeId fail = graph.addNode(failType, "Broken");
    const NodeId add = graph.addNode(addType);
    graph.connect(fail, add, 0);
    try {
        (void)evaluate(add, everything, {"R"});
        FAIL() << "the evaluation should have failed";
    } catch (const graph::EvaluationError& error) {
        EXPECT_EQ(error.node(), fail);
        EXPECT_EQ(std::string(error.what()), "Broken: this node always fails");
    }
    EXPECT_EQ(evaluator.stats().tiles.entries, 0U);
    EXPECT_THROW((void)evaluate(add, everything, {"R"}), graph::EvaluationError);
}

TEST_F(EvaluatorTest, CancelledWorkStops) {
    const NodeId source = graph.addNode(patternType);
    CancellationSource cancel;
    cancel.cancel();
    EXPECT_THROW(
        (void)evaluator.evaluate(graph, {.node = source, .region = everything, .channels = {"R"}}, cancel.token()),
        OperationCancelled);
    EXPECT_EQ(patternOp->tilesRendered, 0);

    // Cancelled while rendering: the remaining tiles never start and nothing of the node is cached.
    CancellationSource midway;
    failOp->onRender = [&] { midway.cancel(); };
    const NodeId fail = graph.addNode(failType);
    EXPECT_THROW(
        (void)evaluator.evaluate(graph, {.node = fail, .region = everything, .channels = {"R"}}, midway.token()),
        OperationCancelled);
    EXPECT_EQ(evaluator.stats().tiles.entries, 0U);
}

TEST_F(EvaluatorTest, NeverRunsOnTheUiThread) {
    const NodeId source = graph.addNode(patternType);
    setUiThread();
    EXPECT_THROW((void)evaluate(source), std::logic_error);
    EXPECT_THROW((void)evaluator.hash(graph, source, 1.0), std::logic_error);
    setUiThread(std::thread::id{}); // no UI thread again, for the other tests
}

TEST_F(EvaluatorTest, EditsAfterACopyDoNotReachTheCopy) {
    const NodeId source = graph.addNode(patternType);
    const NodeId add = graph.addNode(addType);
    graph.connect(source, add, 0);
    graph.setValue(add, "amount", 1.0);
    const Graph snapshot = graph; // what a background job evaluates
    graph.setValue(add, "amount", 9.0);
    graph.disconnect(add, 0);
    expectPattern(evaluator.evaluate(snapshot, {.node = add, .region = everything, .channels = {"R"}}), 0.0, 1.0F);
    EXPECT_TRUE(evaluate(add).channels().empty());
}

TEST_F(EvaluatorTest, SeveralThreadsCanEvaluateAtOnce) {
    const NodeId source = graph.addNode(patternType);
    const NodeId blur = graph.addNode(blurType);
    const NodeId add = graph.addNode(addType);
    graph.connect(source, blur, 0);
    graph.connect(blur, add, 0);
    graph.setValue(add, "amount", 0.5);
    const Image reference = [&] {
        Evaluator fresh(budget);
        return fresh.evaluate(graph, {.node = add, .region = everything, .channels = {"R", "G", "Z"}});
    }();
    constexpr int threadCount = 8;
    std::vector<std::thread> threads;
    threads.reserve(threadCount);
    std::atomic<int> mismatches{0};
    for (int t = 0; t < threadCount; ++t) {
        threads.emplace_back([&, t] {
            const Rect region = Rect::fromSize(t * 70, t * 40, 200, 200);
            const Image result =
                evaluator.evaluate(graph, {.node = add, .region = region, .channels = {"R", "G", "Z"}});
            for (const std::string& channel : result.channels()) {
                for (int y = region.y0; y < std::min(region.y1, 400); y += 3) {
                    for (int x = region.x0; x < std::min(region.x1, 610); x += 3) {
                        if (result.sample(channel, x, y) != reference.sample(channel, x, y)) {
                            ++mismatches;
                        }
                    }
                }
            }
        });
    }
    for (std::thread& thread : threads) {
        thread.join();
    }
    EXPECT_EQ(mismatches, 0);
}

TEST(Evaluator, TheMemoryBudgetLimitsTheCache) {
    // Without a probe the budget counts the caches' own bytes.
    MemoryBudget small(std::size_t{4} << 20);
    Evaluator evaluator(small);
    auto patternOp = std::make_shared<PatternOp>();
    const auto patternType = makeDef("Pattern", 0,
                                     {graph::floatParam("offset", "Offset", 0.0, -1e6, 1e6, 0.0, 1.0),
                                      graph::intParam("width", "Width", 2000, 1, 100000),
                                      graph::intParam("height", "Height", 1000, 1, 100000)},
                                     patternOp);
    Graph graph;
    const NodeId source = graph.addNode(patternType);
    // 50 different results of ~24 MB each: the cache never holds more than the limit, and every result is right.
    for (int i = 0; i < 50; ++i) {
        graph.setValue(source, "offset", static_cast<double>(i));
        const Image result =
            evaluator.evaluate(graph, {.node = source, .region = everything, .channels = {"R", "G", "Z"}});
        EXPECT_FLOAT_EQ(result.sample("G", 1500, 900), pattern(1, 1500, 900, i));
        EXPECT_LE(evaluator.stats().tiles.bytes, small.limit());
    }
    EXPECT_GT(evaluator.stats().tiles.evictions, 0U);
}

TEST(Evaluator, EntryLimitsBoundResultsThatUseNoMemory) {
    MemoryBudget budget(std::size_t{1} << 40);
    Evaluator evaluator(budget, {.maxTileEntries = 4, .maxInfoEntries = 2});
    auto patternOp = std::make_shared<PatternOp>();
    const auto patternType = makeDef("Pattern", 0,
                                     {graph::floatParam("offset", "Offset", 0.0, -1e6, 1e6, 0.0, 1.0),
                                      graph::intParam("width", "Width", 600, 1, 100000),
                                      graph::intParam("height", "Height", 400, 1, 100000)},
                                     patternOp);
    Graph graph;
    const NodeId source = graph.addNode(patternType);
    for (int i = 0; i < 5; ++i) {
        graph.setValue(source, "offset", static_cast<double>(i));
        (void)evaluator.evaluate(graph, {.node = source, .region = everything, .channels = {"R"}});
    }
    EXPECT_LE(evaluator.stats().tiles.entries, 4U);
    EXPECT_LE(evaluator.stats().infos.entries, 2U);
}

} // namespace
} // namespace pf::engine
