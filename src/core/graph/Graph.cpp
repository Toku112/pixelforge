#include "core/graph/Graph.h"

#include <algorithm>
#include <utility>

namespace pf::graph {
namespace {

// The default key type for new keys: Linear, as in the image editor's timeline; Bool and Enum keys switch.
anim::Interpolation keyTypeFor(const ParamDef& def, anim::Interpolation wanted) {
    if (def.type == ParamType::Bool || def.type == ParamType::Enum) {
        return anim::Interpolation::Constant;
    }
    return wanted;
}

void checkAnimatable(const Node& node, const ParamDef& def) {
    if (!def.animatable || !isNumeric(def.type)) {
        throw std::invalid_argument("parameter '" + def.id + "' of node '" + node.name() + "' cannot be animated");
    }
}

} // namespace

NodeId Graph::addNode(std::shared_ptr<const NodeDef> def, std::string name) {
    if (!def) {
        throw std::invalid_argument("Graph::addNode: no node type");
    }
    if (name.empty()) {
        name = uniqueName(*def);
    } else {
        checkName(name, NodeId{});
    }
    const NodeId id{++m_lastId};
    m_nodes.emplace(id, std::make_shared<const Node>(id, std::move(name), std::move(def)));
    return id;
}

void Graph::removeNode(NodeId id) {
    if (m_nodes.erase(id) == 0) {
        throw std::out_of_range("no node with id " + std::to_string(id.value));
    }
    for (const Connection& connection : outputsOf(id)) {
        edit(connection.target).m_inputs[connection.input].reset();
    }
}

const Node& Graph::node(NodeId id) const {
    return *nodePointer(id);
}

std::shared_ptr<const Node> Graph::nodePointer(NodeId id) const {
    const auto found = m_nodes.find(id);
    if (found == m_nodes.end()) {
        throw std::out_of_range("no node with id " + std::to_string(id.value));
    }
    return found->second;
}

std::vector<NodeId> Graph::nodeIds() const {
    std::vector<NodeId> ids;
    ids.reserve(m_nodes.size());
    for (const auto& [id, node] : m_nodes) {
        ids.push_back(id);
    }
    return ids;
}

std::optional<NodeId> Graph::findNode(std::string_view name) const {
    for (const auto& [id, node] : m_nodes) {
        if (node->name() == name) {
            return id;
        }
    }
    return std::nullopt;
}

void Graph::renameNode(NodeId id, std::string name) {
    (void)node(id);
    checkName(name, id);
    edit(id).m_name = std::move(name);
}

void Graph::setBypassed(NodeId id, bool bypassed) {
    edit(id).m_bypassed = bypassed;
}

void Graph::setPosition(NodeId id, NodePosition position) {
    edit(id).m_position = position;
}

void Graph::connect(NodeId source, NodeId target, std::size_t input) {
    const Node& from = node(source);
    const Node& to = node(target);
    if (input >= to.inputs().size()) {
        throw std::out_of_range("node '" + to.name() + "' has no input " + std::to_string(input));
    }
    if (!from.def().hasOutput) {
        throw GraphError("'" + from.name() + "' has no output to connect");
    }
    if (wouldCreateLoop(source, target)) {
        throw GraphError("connecting '" + from.name() + "' into '" + to.name() + "' would make a loop");
    }
    edit(target).m_inputs[input] = source;
}

void Graph::disconnect(NodeId target, std::size_t input) {
    if (input >= node(target).inputs().size()) {
        throw std::out_of_range("node '" + node(target).name() + "' has no input " + std::to_string(input));
    }
    edit(target).m_inputs[input].reset();
}

bool Graph::wouldCreateLoop(NodeId source, NodeId target) const {
    // A loop appears when `target` is `source` or lies upstream of it.
    std::vector<NodeId> pending{source};
    std::vector<NodeId> seen;
    while (!pending.empty()) {
        const NodeId current = pending.back();
        pending.pop_back();
        if (current == target) {
            return true;
        }
        if (std::ranges::find(seen, current) != seen.end()) {
            continue;
        }
        seen.push_back(current);
        for (const std::optional<NodeId>& upstream : node(current).inputs()) {
            if (upstream) {
                pending.push_back(*upstream);
            }
        }
    }
    return false;
}

std::vector<Connection> Graph::outputsOf(NodeId source) const {
    std::vector<Connection> result;
    for (const auto& [id, node] : m_nodes) {
        const std::span<const std::optional<NodeId>> inputs = node->inputs();
        for (std::size_t i = 0; i < inputs.size(); ++i) {
            if (inputs[i] == source) {
                result.push_back({.source = source, .target = id, .input = i});
            }
        }
    }
    return result;
}

void Graph::setValue(NodeId id, std::string_view param, ParamValue value) {
    Node& target = edit(id);
    const std::size_t index = target.paramIndex(param);
    target.m_params[index].value = normalized(target.def().params[index], std::move(value));
}

void Graph::setValueAt(NodeId id, std::string_view param, double frame, ParamValue value) {
    Node& target = edit(id);
    const std::size_t index = target.paramIndex(param);
    const ParamDef& def = target.def().params[index];
    ParamState& state = target.m_params[index];
    value = normalized(def, std::move(value));
    if (!state.isAnimated()) {
        state.value = std::move(value);
        return;
    }
    const std::vector<double> components = componentsOf(value);
    for (std::size_t c = 0; c < components.size(); ++c) {
        anim::AnimCurve& curve = state.curves[c];
        anim::Keyframe key{.frame = frame, .value = components[c], .interpolation = anim::Interpolation::Linear};
        if (const std::optional<std::size_t> existing = curve.findKey(frame)) {
            key = curve.keys()[*existing];
            key.value = components[c];
        }
        key.interpolation = keyTypeFor(def, key.interpolation);
        curve.setKey(key);
    }
}

void Graph::setKey(NodeId id, std::string_view param, std::size_t component, const anim::Keyframe& key) {
    Node& target = edit(id);
    const std::size_t index = target.paramIndex(param);
    const ParamDef& def = target.def().params[index];
    checkAnimatable(target, def);
    const std::size_t count = componentCount(def.type);
    if (component >= count) {
        throw std::out_of_range("parameter '" + def.id + "' has no component " + std::to_string(component));
    }
    ParamState& state = target.m_params[index];
    if (state.curves.empty()) {
        state.curves.resize(count);
    }
    anim::Keyframe stored = key;
    stored.value = std::clamp(key.value, def.minimum, def.maximum);
    stored.interpolation = keyTypeFor(def, key.interpolation);
    state.curves[component].setKey(stored);
}

bool Graph::removeKey(NodeId id, std::string_view param, std::size_t component, double frame) {
    const Node& current = node(id);
    const std::size_t index = current.paramIndex(param);
    const ParamState& state = current.paramState(index);
    if (component >= state.curves.size() || !state.curves[component].findKey(frame)) {
        return false;
    }
    ParamState& edited = edit(id).m_params[index];
    edited.curves[component].removeKey(frame);
    if (!edited.isAnimated()) {
        edited.curves.clear();
    }
    return true;
}

void Graph::removeAnimation(NodeId id, std::string_view param, double frame) {
    const Node& current = node(id);
    const std::size_t index = current.paramIndex(param);
    ParamValue value = current.valueAt(index, frame);
    ParamState& state = edit(id).m_params[index];
    state.value = std::move(value);
    state.curves.clear();
}

void Graph::setExtrapolation(NodeId id, std::string_view param, anim::Extrapolation before, anim::Extrapolation after) {
    const Node& current = node(id);
    const std::size_t index = current.paramIndex(param);
    if (!current.paramState(index).isAnimated()) {
        throw std::invalid_argument("parameter '" + std::string(param) + "' of node '" + current.name() +
                                    "' is not animated");
    }
    for (anim::AnimCurve& curve : edit(id).m_params[index].curves) {
        curve.setExtrapolation(before, after);
    }
}

Node& Graph::edit(NodeId id) {
    const auto found = m_nodes.find(id);
    if (found == m_nodes.end()) {
        throw std::out_of_range("no node with id " + std::to_string(id.value));
    }
    auto copy = std::make_shared<Node>(*found->second);
    Node& result = *copy;
    found->second = std::move(copy);
    return result;
}

std::string Graph::uniqueName(const NodeDef& def) const {
    std::string base;
    for (const char c : def.label) {
        if (isIdentifier(std::string(1, c)) || (c >= '0' && c <= '9')) {
            base += c;
        }
    }
    if (!isIdentifier(base)) {
        base = "Node";
    }
    for (std::uint64_t n = 1;; ++n) {
        std::string candidate = base + std::to_string(n);
        if (!findNode(candidate)) {
            return candidate;
        }
    }
}

void Graph::checkName(std::string_view name, NodeId except) const {
    if (!isIdentifier(name)) {
        throw GraphError("node names use letters, digits and _, and start with a letter or _: '" + std::string(name) +
                         "'");
    }
    const std::optional<NodeId> existing = findNode(name);
    if (existing && *existing != except) {
        throw GraphError("a node named '" + std::string(name) + "' exists already");
    }
}

} // namespace pf::graph
