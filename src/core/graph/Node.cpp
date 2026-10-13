#include "core/graph/Node.h"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace pf::graph {

bool ParamState::isAnimated() const {
    return std::ranges::any_of(curves, [](const anim::AnimCurve& curve) { return !curve.empty(); });
}

Node::Node(NodeId id, std::string name, std::shared_ptr<const NodeDef> def)
    : m_id(id),
      m_name(std::move(name)),
      m_def(std::move(def)) {
    if (!m_def) {
        throw std::invalid_argument("a node needs a node type");
    }
    m_inputs.resize(m_def->inputs.size());
    m_params.reserve(m_def->params.size());
    for (const ParamDef& param : m_def->params) {
        m_params.push_back({.value = param.defaultValue, .curves = {}});
    }
}

std::size_t Node::paramIndex(std::string_view id) const {
    const std::optional<std::size_t> index = m_def->paramIndex(id);
    if (!index) {
        throw std::out_of_range("node '" + m_name + "' has no parameter '" + std::string(id) + "'");
    }
    return *index;
}

ParamValue Node::valueAt(std::size_t param, double frame) const {
    const ParamState& state = m_params.at(param);
    if (!state.isAnimated()) {
        return state.value;
    }
    const ParamDef& def = m_def->params[param];
    std::vector<double> components = componentsOf(state.value);
    for (std::size_t c = 0; c < components.size() && c < state.curves.size(); ++c) {
        if (!state.curves[c].empty()) {
            components[c] = state.curves[c].value(frame);
        }
    }
    return fromComponents(def, components);
}

bool operator==(const Node& a, const Node& b) {
    return a.m_id == b.m_id && a.m_name == b.m_name && a.m_def == b.m_def && a.m_inputs == b.m_inputs &&
           a.m_params == b.m_params && a.m_bypassed == b.m_bypassed && a.m_position == b.m_position;
}

ParamValues Node::valuesAt(double frame) const {
    std::vector<ParamValue> values;
    values.reserve(m_params.size());
    for (std::size_t i = 0; i < m_params.size(); ++i) {
        values.push_back(valueAt(i, frame));
    }
    return {m_def->params, std::move(values)};
}

} // namespace pf::graph
