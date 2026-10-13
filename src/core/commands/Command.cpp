#include "core/commands/Command.h"

#include "core/graph/Param.h"

#include <cctype>
#include <cstddef>
#include <optional>
#include <utility>

namespace pf::commands {
namespace {

// "graph.setValue": dot-separated parts, each a letter followed by letters and digits.
bool isCommandName(std::string_view name) {
    bool partStart = true;
    for (const char c : name) {
        const auto byte = static_cast<unsigned char>(c);
        if (c == '.') {
            if (partStart) {
                return false;
            }
            partStart = true;
        } else if (std::isalpha(byte) != 0 || (!partStart && std::isdigit(byte) != 0)) {
            partStart = false;
        } else {
            return false;
        }
    }
    return !name.empty() && !partStart;
}

[[noreturn]] void wrongParam(std::string_view key, std::string_view expected) {
    throw CommandError("\"" + std::string(key) + "\" must be " + std::string(expected));
}

} // namespace

// ---- descriptors

json::Value toJson(const Descriptor& descriptor) {
    return json::Object{{"command", descriptor.command}, {"params", descriptor.params}};
}

Descriptor descriptorFromJson(const json::Value& value) {
    if (!value.isObject()) {
        throw CommandError(R"(a command must be an object with "command" and "params")");
    }
    const json::Object& object = value.asObject();
    const json::Value* command = object.find("command");
    if (command == nullptr || !command->isString()) {
        throw CommandError("a command needs \"command\": its name as text");
    }
    Descriptor result{.command = command->asString(), .params = {}};
    if (const json::Value* params = object.find("params")) {
        if (!params->isObject()) {
            throw CommandError("\"params\" of a command must be an object");
        }
        result.params = params->asObject();
    }
    return result;
}

// ---- context

Context::Context(const CommandRegistry& commands, const graph::NodeRegistry& nodeTypes, NameMap* replayNames)
    : m_commands(&commands),
      m_nodeTypes(&nodeTypes),
      m_replayNames(replayNames) {}

graph::NodeId Context::node(const graph::Graph& graph, json::Object& params, std::string_view key) const {
    json::Value* value = params.find(key);
    if (value == nullptr) {
        throw CommandError("missing \"" + std::string(key) + "\"");
    }
    return node(graph, *value);
}

graph::NodeId Context::node(const graph::Graph& graph, json::Value& name) const {
    if (!name.isString()) {
        throw CommandError("a node must be named by text");
    }
    std::string actual = name.asString();
    if (m_replayNames != nullptr) {
        if (const auto renamed = m_replayNames->find(actual); renamed != m_replayNames->end()) {
            actual = renamed->second;
        }
    }
    const std::optional<graph::NodeId> id = graph.findNode(actual);
    if (!id) {
        throw CommandError("there is no node named '" + actual + "'");
    }
    name = std::move(actual);
    return *id;
}

std::string Context::newName(const graph::Graph& graph, const std::string& wanted) const {
    if (m_replayNames == nullptr || !graph::isIdentifier(wanted)) {
        return wanted;
    }
    std::string actual = graph.freeName(wanted);
    (*m_replayNames)[wanted] = actual;
    return actual;
}

// ---- registry

void CommandRegistry::add(CommandType type) {
    if (!isCommandName(type.name)) {
        throw std::invalid_argument("invalid command name '" + type.name + "'");
    }
    if (!type.perform) {
        throw std::invalid_argument("command '" + type.name + "' has no perform function");
    }
    if (m_types.contains(type.name)) {
        throw std::invalid_argument("command '" + type.name + "' is registered already");
    }
    std::string name = type.name;
    m_types.emplace(std::move(name), std::move(type));
}

const CommandType* CommandRegistry::find(std::string_view name) const {
    const auto found = m_types.find(name);
    return found == m_types.end() ? nullptr : &found->second;
}

std::vector<std::string> CommandRegistry::names() const {
    std::vector<std::string> result;
    result.reserve(m_types.size());
    for (const auto& [name, type] : m_types) {
        result.push_back(name);
    }
    return result;
}

// ---- performing

std::string performInPlace(graph::Graph& graph, Descriptor& descriptor, const Context& context) {
    const CommandType* type = context.commands().find(descriptor.command);
    if (type == nullptr) {
        throw CommandError("unknown command '" + descriptor.command + "'");
    }
    try {
        return type->perform(graph, descriptor.params, context);
    } catch (const CommandError&) {
        throw;
    } catch (const graph::GraphError& error) {
        throw CommandError(error.what());
    } catch (const std::invalid_argument& error) {
        throw CommandError(error.what());
    } catch (const std::out_of_range& error) {
        throw CommandError(error.what());
    } catch (const json::Error& error) {
        throw CommandError(error.what());
    }
}

Performed perform(const graph::Graph& graph, Descriptor descriptor, const Context& context) {
    Performed result{.graph = graph, .label = {}, .descriptor = std::move(descriptor)};
    result.label = performInPlace(result.graph, result.descriptor, context);
    return result;
}

// ---- parameters

namespace params {

const json::Value& required(const json::Object& params, std::string_view key) {
    const json::Value* value = params.find(key);
    if (value == nullptr) {
        throw CommandError("missing \"" + std::string(key) + "\"");
    }
    return *value;
}

const std::string& text(const json::Object& params, std::string_view key) {
    const json::Value& value = required(params, key);
    if (!value.isString()) {
        wrongParam(key, "text");
    }
    return value.asString();
}

std::int64_t integer(const json::Object& params, std::string_view key) {
    const json::Value& value = required(params, key);
    if (!value.isInt()) {
        wrongParam(key, "a whole number");
    }
    return value.asInt();
}

std::size_t index(const json::Object& params, std::string_view key) {
    const std::int64_t value = integer(params, key);
    if (value < 0) {
        wrongParam(key, "0 or more");
    }
    return static_cast<std::size_t>(value);
}

double number(const json::Object& params, std::string_view key) {
    const json::Value& value = required(params, key);
    if (!value.isNumber()) {
        wrongParam(key, "a number");
    }
    return value.asNumber();
}

bool boolean(const json::Object& params, std::string_view key) {
    const json::Value& value = required(params, key);
    if (!value.isBool()) {
        wrongParam(key, "true or false");
    }
    return value.asBool();
}

const json::Array& list(const json::Object& params, std::string_view key) {
    const json::Value& value = required(params, key);
    if (!value.isArray()) {
        wrongParam(key, "a list");
    }
    return value.asArray();
}

json::Array& list(json::Object& params, std::string_view key) {
    json::Value* value = params.find(key);
    if (value == nullptr) {
        throw CommandError("missing \"" + std::string(key) + "\"");
    }
    if (!value->isArray()) {
        wrongParam(key, "a list");
    }
    return value->asArray();
}

} // namespace params

} // namespace pf::commands
