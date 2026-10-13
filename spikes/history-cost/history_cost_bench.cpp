// How long the History takes per edit as graphs grow (PLAN Part C item 8, docs/DECISIONS.md D-076). Every edit
// copies the graph's node table, edits the copy and compares the two tables, so the cost grows with the node count;
// this measures how much, against the 16 ms the UI thread may spend per event (CLAUDE.md §3.5).

#include "core/commands/GraphCommands.h"
#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"
#include "core/graph/NodeOp.h"
#include "core/history/History.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

namespace {

using namespace pf;
using Clock = std::chrono::steady_clock;

class NothingOp final : public graph::NodeOp {
public:
    [[nodiscard]] graph::OutputInfo info(const graph::NodeContext& /*node*/, int /*proxyScale*/,
                                         std::span<const graph::OutputInfo> /*inputs*/) const override {
        return {};
    }
    void render(const graph::RenderContext& /*context*/) const override {}
};

// A grade-like node: one input, a dozen parameters (Exposure has four, a full grade node about this many).
std::shared_ptr<const graph::NodeDef> gradeType() {
    graph::NodeDef def{.typeId = "Grade", .label = "Grade", .category = "Color", .op = std::make_shared<NothingOp>()};
    def.inputs.push_back({.id = "source", .label = "Source"});
    for (const char* id : {"exposure", "offset", "gamma", "lift", "gain", "saturation", "contrast", "pivot"}) {
        def.params.push_back(graph::floatParam(id, id, 0.0, -100.0, 100.0, -1.0, 1.0));
    }
    def.params.push_back(graph::colorParam("tint", "Tint", {1.0, 1.0, 1.0, 1.0}));
    def.params.push_back(graph::stringParam("layer", "Layer"));
    return std::make_shared<const graph::NodeDef>(std::move(def));
}

struct Stats {
    double median = 0.0;
    double worst = 0.0;
};

template <typename F>
Stats measure(int runs, F&& f) {
    std::vector<double> ms;
    ms.reserve(static_cast<std::size_t>(runs));
    for (int i = 0; i < runs; ++i) {
        const auto start = Clock::now();
        f(i);
        ms.push_back(std::chrono::duration<double, std::milli>(Clock::now() - start).count());
    }
    std::ranges::sort(ms);
    return {.median = ms[ms.size() / 2], .worst = ms.back()};
}

} // namespace

int main() {
    graph::NodeRegistry types;
    types.add(gradeType());
    commands::CommandRegistry commands;
    commands::registerBuiltinCommands(commands);

    std::printf("%-7s %-24s %-24s %-24s %-24s\n", "nodes", "new step ms (worst)", "drag step ms (worst)",
                "undo+redo ms (worst)", "jump 50 steps ms (worst)");
    for (const int count : {10, 100, 1000, 5000}) {
        // A chain of `count` grade nodes, built through the History (as a user or a script would).
        history::History history(commands, types);
        history.setMaxStates(history::History::defaultMaxStates);
        for (int i = 0; i < count; ++i) {
            (void)history.execute(commands::addNode("Grade"));
            if (i > 0) {
                (void)history.execute(commands::connect("Grade" + std::to_string(i), "Grade" + std::to_string(i + 1), 0));
            }
        }
        const std::string middle = "Grade" + std::to_string(count / 2);
        const auto node = [&]() -> const graph::Node& { return history.graph().node(*history.graph().findNode(middle)); };

        const Stats step = measure(200, [&](int i) {
            (void)history.execute(commands::setValue(node(), "exposure", 0.01 * (i + 1)));
        });
        (void)history.execute(commands::setValue(node(), "gamma", 0.5));
        const Stats drag = measure(200, [&](int i) {
            (void)history.execute(commands::setValue(node(), "gamma", 0.5 + 0.001 * (i + 1)), history::Merge::Continue);
        });
        const Stats undoRedo = measure(200, [&](int) {
            history.undo();
            history.redo();
        });
        const std::size_t last = history.size() - 1;
        const Stats jump = measure(100, [&](int i) { history.goTo(i % 2 == 0 ? 1 : last); });
        std::printf("%-7d %8.4f (%8.4f)       %8.4f (%8.4f)       %8.4f (%8.4f)       %8.4f (%8.4f)\n", count,
                    step.median, step.worst, drag.median, drag.worst, undoRedo.median, undoRedo.worst, jump.median,
                    jump.worst);
    }
    return 0;
}
