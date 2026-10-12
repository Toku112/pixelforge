#include "core/graph/NodeDef.h"

#include <set>
#include <stdexcept>
#include <utility>

namespace pf::graph {

std::optional<std::size_t> NodeDef::paramIndex(std::string_view id) const {
    for (std::size_t i = 0; i < params.size(); ++i) {
        if (params[i].id == id) {
            return i;
        }
    }
    return std::nullopt;
}

const ParamDef& NodeDef::param(std::string_view id) const {
    const std::optional<std::size_t> index = paramIndex(id);
    if (!index) {
        throw std::out_of_range("node type '" + typeId + "' has no parameter '" + std::string(id) + "'");
    }
    return params[*index];
}

void validate(const NodeDef& def) {
    const std::string what = "node type '" + def.typeId + "'";
    if (!isIdentifier(def.typeId)) {
        throw std::invalid_argument(what + ": the type id must be a letter or _, then letters, digits or _");
    }
    if (def.version < 1 || def.label.empty() || def.category.empty() || !def.op) {
        throw std::invalid_argument(what + " needs a version of at least 1, a label, a category and an op");
    }
    std::set<std::string_view> ports;
    for (const PortDef& port : def.inputs) {
        if (!isIdentifier(port.id) || port.label.empty() || !ports.insert(port.id).second) {
            throw std::invalid_argument(what + ": input '" + port.id + "' is invalid, unlabelled or repeated");
        }
    }
    std::set<std::string_view> params;
    for (const ParamDef& param : def.params) {
        validate(param);
        if (!params.insert(param.id).second) {
            throw std::invalid_argument(what + ": parameter '" + param.id + "' is repeated");
        }
    }
}

void NodeRegistry::add(std::shared_ptr<const NodeDef> def) {
    if (!def) {
        throw std::invalid_argument("NodeRegistry::add: no definition");
    }
    validate(*def);
    if (m_types.contains(def->typeId)) {
        throw std::invalid_argument("node type '" + def->typeId + "' is registered already");
    }
    const std::string id = def->typeId;
    m_types.emplace(id, std::move(def));
}

std::shared_ptr<const NodeDef> NodeRegistry::find(std::string_view typeId) const {
    const auto found = m_types.find(typeId);
    return found == m_types.end() ? nullptr : found->second;
}

std::vector<std::shared_ptr<const NodeDef>> NodeRegistry::types() const {
    std::vector<std::shared_ptr<const NodeDef>> result;
    result.reserve(m_types.size());
    for (const auto& [id, def] : m_types) {
        result.push_back(def);
    }
    return result;
}

} // namespace pf::graph
