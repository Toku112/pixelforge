#include "core/commands/GraphCommands.h"

#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"
#include "core/graph/NodeId.h"
#include "core/graph/ParamJson.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>

namespace pf::commands {
namespace {

using graph::Graph;
using graph::NodeId;

// ---- reading parameters

graph::NodePosition positionFrom(const json::Object& params, std::string_view key) {
    const json::Array& xy = params::list(params, key);
    if (xy.size() != 2 || !xy[0].isNumber() || !xy[1].isNumber()) {
        throw CommandError("\"" + std::string(key) + "\" must be two numbers [x, y]");
    }
    const graph::NodePosition position{.x = xy[0].asNumber(), .y = xy[1].asNumber()};
    if (!std::isfinite(position.x) || !std::isfinite(position.y)) {
        throw CommandError("\"" + std::string(key) + "\" must be finite");
    }
    return position;
}

json::Value positionJson(graph::NodePosition position) {
    return json::Array{position.x, position.y};
}

// A parameter of a node, as named by "param".
struct ParamRef {
    NodeId node;
    std::string id;
    const graph::ParamDef* def = nullptr;
};

ParamRef paramFrom(const Graph& graph, json::Object& params, const Context& context) {
    ParamRef ref;
    ref.node = context.node(graph, params, "node");
    ref.id = params::text(params, "param");
    const graph::Node& node = graph.node(ref.node);
    ref.def = &node.def().params[node.paramIndex(ref.id)];
    return ref;
}

std::optional<double> optionalFrame(const json::Object& params) {
    if (!params.contains("frame")) {
        return std::nullopt;
    }
    return params::number(params, "frame");
}

anim::Extrapolation extrapolationFrom(const json::Object& params, std::string_view key) {
    const std::optional<anim::Extrapolation> result = graph::extrapolationFromString(params::text(params, key));
    if (!result) {
        throw CommandError("\"" + std::string(key) + "\" must be constant or linear");
    }
    return *result;
}

bool sameValue(const json::Object& a, const json::Object& b, std::string_view key) {
    const json::Value* x = a.find(key);
    const json::Value* y = b.find(key);
    return x != nullptr && y != nullptr && *x == *y;
}

// Both without the key, or both with equal values.
bool sameOptional(const json::Object& a, const json::Object& b, std::string_view key) {
    const json::Value* x = a.find(key);
    const json::Value* y = b.find(key);
    if (x == nullptr || y == nullptr) {
        return x == y;
    }
    return x->isNumber() && y->isNumber() ? x->asNumber() == y->asNumber() : *x == *y;
}

// ---- the commands

std::string performAddNode(Graph& graph, json::Object& params, const Context& context) {
    const std::string type = params::text(params, "type");
    std::shared_ptr<const graph::NodeDef> def = context.nodeTypes().find(type);
    if (!def) {
        throw CommandError("there is no node type '" + type + "'");
    }
    std::string name;
    if (params.contains("name")) {
        name = context.newName(graph, params::text(params, "name"));
    }
    std::optional<graph::NodePosition> position;
    if (params.contains("position")) {
        position = positionFrom(params, "position");
    }
    std::string label = "Add " + def->label;
    const NodeId id = graph.addNode(std::move(def), name);
    if (position) {
        graph.setPosition(id, *position);
    }
    params.set("name", graph.node(id).name());
    return label;
}

std::string performRemoveNodes(Graph& graph, json::Object& params, const Context& context) {
    std::vector<NodeId> ids;
    for (json::Value& name : params::list(params, "nodes")) {
        const NodeId id = context.node(graph, name);
        if (std::ranges::find(ids, id) == ids.end()) {
            ids.push_back(id);
        }
    }
    for (const NodeId id : ids) {
        graph.removeNode(id);
    }
    return ids.size() == 1 ? "Delete Node" : "Delete Nodes";
}

std::string performConnect(Graph& graph, json::Object& params, const Context& context) {
    const NodeId source = context.node(graph, params, "source");
    const NodeId target = context.node(graph, params, "target");
    graph.connect(source, target, params::index(params, "input"));
    return "Connect";
}

std::string performDisconnect(Graph& graph, json::Object& params, const Context& context) {
    const NodeId target = context.node(graph, params, "target");
    graph.disconnect(target, params::index(params, "input"));
    return "Disconnect";
}

std::string performRenameNode(Graph& graph, json::Object& params, const Context& context) {
    const NodeId id = context.node(graph, params, "node");
    const std::string wanted = params::text(params, "name");
    if (graph.node(id).name() != wanted) {
        const std::string name = context.newName(graph, wanted);
        graph.renameNode(id, name);
        params.set("name", name);
    }
    return "Rename Node";
}

std::string performSetBypassed(Graph& graph, json::Object& params, const Context& context) {
    const NodeId id = context.node(graph, params, "node");
    const bool bypassed = params::boolean(params, "bypassed");
    graph.setBypassed(id, bypassed);
    return bypassed ? "Bypass Node" : "Enable Node";
}

std::string performMoveNodes(Graph& graph, json::Object& params, const Context& context) {
    json::Array& nodes = params::list(params, "nodes");
    for (json::Value& entry : nodes) {
        if (!entry.isObject()) {
            throw CommandError(R"(each of "nodes" must be {"node": name, "position": [x, y]})");
        }
        json::Object& move = entry.asObject();
        const NodeId id = context.node(graph, move, "node");
        graph.setPosition(id, positionFrom(move, "position"));
    }
    return nodes.size() == 1 ? "Move Node" : "Move Nodes";
}

std::string performSetValue(Graph& graph, json::Object& params, const Context& context) {
    const ParamRef ref = paramFrom(graph, params, context);
    graph::ParamValue value = graph::paramValueFromJson(*ref.def, params::required(params, "value"));
    params.set("value", graph::toJson(*ref.def, value));
    if (const std::optional<double> frame = optionalFrame(params)) {
        graph.setValueAt(ref.node, ref.id, *frame, std::move(value));
    } else {
        graph.setValue(ref.node, ref.id, std::move(value));
    }
    return "Set " + ref.def->label;
}

std::string performSetKey(Graph& graph, json::Object& params, const Context& context) {
    const ParamRef ref = paramFrom(graph, params, context);
    const anim::Keyframe key = graph::keyframeFromJson(params::required(params, "key"));
    graph.setKey(ref.node, ref.id, params::index(params, "component"), key);
    params.set("key", graph::toJson(key));
    return "Set Keyframe: " + ref.def->label;
}

std::string performRemoveKey(Graph& graph, json::Object& params, const Context& context) {
    const ParamRef ref = paramFrom(graph, params, context);
    (void)graph.removeKey(ref.node, ref.id, params::index(params, "component"), params::number(params, "frame"));
    return "Delete Keyframe: " + ref.def->label;
}

std::string performRemoveAnimation(Graph& graph, json::Object& params, const Context& context) {
    const ParamRef ref = paramFrom(graph, params, context);
    graph.removeAnimation(ref.node, ref.id, params::number(params, "frame"));
    return "Delete Animation: " + ref.def->label;
}

std::string performSetExtrapolation(Graph& graph, json::Object& params, const Context& context) {
    const ParamRef ref = paramFrom(graph, params, context);
    graph.setExtrapolation(ref.node, ref.id, extrapolationFrom(params, "before"), extrapolationFrom(params, "after"));
    return "Set Extrapolation: " + ref.def->label;
}

std::string performGroup(Graph& graph, json::Object& params, const Context& context) {
    std::string label = params::text(params, "label");
    for (json::Value& step : params::list(params, "steps")) {
        Descriptor descriptor = descriptorFromJson(step);
        (void)performInPlace(graph, descriptor, context);
        step = toJson(descriptor);
    }
    return label;
}

// ---- continuous edits

bool continuesSetValue(const json::Object& params, const json::Object& next) {
    return sameValue(params, next, "node") && sameValue(params, next, "param") && sameOptional(params, next, "frame");
}

bool continuesSetKey(const json::Object& params, const json::Object& next) {
    if (!sameValue(params, next, "node") || !sameValue(params, next, "param") ||
        !sameValue(params, next, "component")) {
        return false;
    }
    const json::Value* a = params.find("key");
    const json::Value* b = next.find("key");
    return a != nullptr && b != nullptr && a->isObject() && b->isObject() &&
           sameOptional(a->asObject(), b->asObject(), "frame");
}

// The same nodes, in the same order.
bool continuesMoveNodes(const json::Object& params, const json::Object& next) {
    const json::Value* a = params.find("nodes");
    const json::Value* b = next.find("nodes");
    if (a == nullptr || b == nullptr || !a->isArray() || !b->isArray() || a->asArray().size() != b->asArray().size()) {
        return false;
    }
    for (std::size_t i = 0; i < a->asArray().size(); ++i) {
        const json::Value& x = a->asArray()[i];
        const json::Value& y = b->asArray()[i];
        if (!x.isObject() || !y.isObject() || !sameValue(x.asObject(), y.asObject(), "node")) {
            return false;
        }
    }
    return true;
}

json::Object nodeParam(std::string_view node, std::string_view param) {
    return json::Object{{"node", node}, {"param", param}};
}

} // namespace

void registerBuiltinCommands(CommandRegistry& registry) {
    registry.add({.name = "graph.addNode", .perform = performAddNode, .continues = {}});
    registry.add({.name = "graph.removeNodes", .perform = performRemoveNodes, .continues = {}});
    registry.add({.name = "graph.connect", .perform = performConnect, .continues = {}});
    registry.add({.name = "graph.disconnect", .perform = performDisconnect, .continues = {}});
    registry.add({.name = "graph.renameNode", .perform = performRenameNode, .continues = {}});
    registry.add({.name = "graph.setBypassed", .perform = performSetBypassed, .continues = {}});
    registry.add({.name = "graph.moveNodes", .perform = performMoveNodes, .continues = continuesMoveNodes});
    registry.add({.name = "graph.setValue", .perform = performSetValue, .continues = continuesSetValue});
    registry.add({.name = "graph.setKey", .perform = performSetKey, .continues = continuesSetKey});
    registry.add({.name = "graph.removeKey", .perform = performRemoveKey, .continues = {}});
    registry.add({.name = "graph.removeAnimation", .perform = performRemoveAnimation, .continues = {}});
    registry.add({.name = "graph.setExtrapolation", .perform = performSetExtrapolation, .continues = {}});
    registry.add({.name = "group", .perform = performGroup, .continues = {}});
}

Descriptor addNode(std::string_view type, std::string_view name, std::optional<graph::NodePosition> position) {
    json::Object params{{"type", type}};
    if (!name.empty()) {
        params.set("name", name);
    }
    if (position) {
        params.set("position", positionJson(*position));
    }
    return {.command = "graph.addNode", .params = std::move(params)};
}

Descriptor removeNodes(const std::vector<std::string>& nodes) {
    json::Array names(nodes.begin(), nodes.end());
    return {.command = "graph.removeNodes", .params = {{"nodes", std::move(names)}}};
}

Descriptor connect(std::string_view source, std::string_view target, std::size_t input) {
    return {.command = "graph.connect", .params = {{"source", source}, {"target", target}, {"input", input}}};
}

Descriptor disconnect(std::string_view target, std::size_t input) {
    return {.command = "graph.disconnect", .params = {{"target", target}, {"input", input}}};
}

Descriptor renameNode(std::string_view node, std::string_view name) {
    return {.command = "graph.renameNode", .params = {{"node", node}, {"name", name}}};
}

Descriptor setBypassed(std::string_view node, bool bypassed) {
    return {.command = "graph.setBypassed", .params = {{"node", node}, {"bypassed", bypassed}}};
}

Descriptor moveNodes(const std::vector<std::pair<std::string, graph::NodePosition>>& positions) {
    json::Array nodes;
    nodes.reserve(positions.size());
    for (const auto& [node, position] : positions) {
        nodes.emplace_back(json::Object{{"node", node}, {"position", positionJson(position)}});
    }
    return {.command = "graph.moveNodes", .params = {{"nodes", std::move(nodes)}}};
}

Descriptor setValue(const graph::Node& node, std::string_view param, const graph::ParamValue& value,
                    std::optional<double> frame) {
    json::Object params = nodeParam(node.name(), param);
    params.set("value", graph::toJson(node.def().param(param), value));
    if (frame) {
        params.set("frame", *frame);
    }
    return {.command = "graph.setValue", .params = std::move(params)};
}

Descriptor setKey(std::string_view node, std::string_view param, std::size_t component, const anim::Keyframe& key) {
    json::Object params = nodeParam(node, param);
    params.set("component", component);
    params.set("key", graph::toJson(key));
    return {.command = "graph.setKey", .params = std::move(params)};
}

Descriptor removeKey(std::string_view node, std::string_view param, std::size_t component, double frame) {
    json::Object params = nodeParam(node, param);
    params.set("component", component);
    params.set("frame", frame);
    return {.command = "graph.removeKey", .params = std::move(params)};
}

Descriptor removeAnimation(std::string_view node, std::string_view param, double frame) {
    json::Object params = nodeParam(node, param);
    params.set("frame", frame);
    return {.command = "graph.removeAnimation", .params = std::move(params)};
}

Descriptor setExtrapolation(std::string_view node, std::string_view param, anim::Extrapolation before,
                            anim::Extrapolation after) {
    json::Object params = nodeParam(node, param);
    params.set("before", graph::toString(before));
    params.set("after", graph::toString(after));
    return {.command = "graph.setExtrapolation", .params = std::move(params)};
}

Descriptor group(std::string_view label, const std::vector<Descriptor>& steps) {
    json::Array list;
    list.reserve(steps.size());
    for (const Descriptor& step : steps) {
        list.push_back(toJson(step));
    }
    return {.command = "group", .params = {{"label", label}, {"steps", std::move(list)}}};
}

} // namespace pf::commands
