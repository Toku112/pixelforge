#pragma once

// Commands (CLAUDE.md §3.6, docs/specs/commands-history.md). Every change to a project is a command, written down as a
// descriptor: a command name and its parameters as JSON ("graph.setValue" {"node": "Exposure1", "param": "exposure",
// "value": 1.5}). Performing a descriptor makes the edit and gives its History label; the History keeps what changed
// (a GraphDelta) to undo and redo it, and keeps the descriptor for Actions, scripts and the crash journal. Live edits
// and replays run the same descriptors through the same code, so a replay does exactly what the original did.

#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"
#include "core/graph/NodeId.h"
#include "core/json/Json.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace pf::commands {

// A command that cannot run: an unknown command, node or parameter, a parameter of the wrong type, an edit the graph
// refuses (a loop, a name in use). The message is meant for the user.
class CommandError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct Descriptor {
    std::string command; // "graph.setValue": a namespace, a dot, a camelCase verb
    json::Object params;
    friend bool operator==(const Descriptor&, const Descriptor&) = default;
};

// {"command": "graph.setValue", "params": {...}}
[[nodiscard]] json::Value toJson(const Descriptor& descriptor);
// Throws CommandError when `value` is not a descriptor.
[[nodiscard]] Descriptor descriptorFromJson(const json::Value& value);

// Node renames made while replaying: an Action recorded with "Exposure1" plays into a graph that has an Exposure1
// already, so its node becomes "Exposure2", and the Action's later steps that name "Exposure1" mean "Exposure2".
using NameMap = std::map<std::string, std::string, std::less<>>;

class CommandRegistry;

// What a command can use while it runs.
class Context {
public:
    // `replayNames`: set while replaying (an Action, a script). Names the command reads go through the map; a node it
    // creates or renames to a name that is taken gets a free name instead of an error, recorded in the map.
    Context(const CommandRegistry& commands, const graph::NodeRegistry& nodeTypes, NameMap* replayNames = nullptr);

    [[nodiscard]] const CommandRegistry& commands() const { return *m_commands; }
    [[nodiscard]] const graph::NodeRegistry& nodeTypes() const { return *m_nodeTypes; }

    // The node `params[key]` names. The parameter is rewritten with the node's actual name (they differ during a
    // replay with renames), so the descriptor kept in the History says what was really done. Throws CommandError.
    [[nodiscard]] graph::NodeId node(const graph::Graph& graph, json::Object& params, std::string_view key) const;
    // The same for a node name held in `name` (an element of a list).
    [[nodiscard]] graph::NodeId node(const graph::Graph& graph, json::Value& name) const;
    // The name a node created or renamed to `wanted` gets: `wanted` itself; during a replay a free name when `wanted`
    // is taken (recorded in the map); otherwise taken names are left for the graph to refuse.
    [[nodiscard]] std::string newName(const graph::Graph& graph, const std::string& wanted) const;

private:
    const CommandRegistry* m_commands;
    const graph::NodeRegistry* m_nodeTypes;
    NameMap* m_replayNames;
};

// What one kind of command does.
struct CommandType {
    std::string name;
    // Performs the command on `graph`, a private copy: when it throws, the copy is dropped and nothing changes. It may
    // complete `params` (a created node's name) so that the descriptor replays exactly. Returns the History label
    // ("Set Exposure").
    std::function<std::string(graph::Graph& graph, json::Object& params, const Context& context)> perform;
    // True when a command with parameters `next` continues one with `params` as one continuous edit (dragging a
    // slider), so both make one History step. Empty: never.
    std::function<bool(const json::Object& params, const json::Object& next)> continues;
};

class CommandRegistry {
public:
    // Throws std::invalid_argument for a name in use, a name that is not "letters, dots and digits" or a missing
    // perform function.
    void add(CommandType type);
    // Null when there is no such command.
    [[nodiscard]] const CommandType* find(std::string_view name) const;
    [[nodiscard]] std::vector<std::string> names() const;

private:
    std::map<std::string, CommandType, std::less<>> m_types;
};

struct Performed {
    graph::Graph graph;    // the graph after the command
    std::string label;     // for the History panel
    Descriptor descriptor; // completed: what replays this edit exactly
};

// Performs `descriptor` on a copy of `graph`. Every error the user can cause — including the graph's own refusals
// (GraphError, std::invalid_argument, std::out_of_range) and malformed parameters — comes out as CommandError.
[[nodiscard]] Performed perform(const graph::Graph& graph, Descriptor descriptor, const Context& context);
// The same on `graph` itself, completing `descriptor`, for commands made of other commands ("group"). `graph` must be
// a private copy: after an error it is left half-edited.
std::string performInPlace(graph::Graph& graph, Descriptor& descriptor, const Context& context);

// Typed parameter access for perform functions; each throws CommandError naming the parameter.
namespace params {
[[nodiscard]] const json::Value& required(const json::Object& params, std::string_view key);
[[nodiscard]] const std::string& text(const json::Object& params, std::string_view key);
[[nodiscard]] std::int64_t integer(const json::Object& params, std::string_view key);
// A whole number ≥ 0.
[[nodiscard]] std::size_t index(const json::Object& params, std::string_view key);
[[nodiscard]] double number(const json::Object& params, std::string_view key);
[[nodiscard]] bool boolean(const json::Object& params, std::string_view key);
[[nodiscard]] const json::Array& list(const json::Object& params, std::string_view key);
[[nodiscard]] json::Array& list(json::Object& params, std::string_view key);
} // namespace params

} // namespace pf::commands
