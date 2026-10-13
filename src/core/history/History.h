#pragma once

// Undo, redo and the History panel's model for one project's graph (CLAUDE.md §3.6, docs/specs/commands-history.md
// §4–6). Every change goes through execute(): it performs a command descriptor, and the step it records keeps the
// descriptor, its label and the nodes that changed (a GraphDelta), so undo and redo swap shared nodes back and forth
// without recomputing anything.
//
// Entries: the opening state ("New", "Open") first, then one per step. Clicking an entry moves there; executing while
// an earlier entry is current drops the entries after it. When there are more steps than the limit (Preferences,
// default 50), the oldest are dropped; the opening state stays reachable, and undo stops at the oldest step left.
//
// Lives on the UI thread and is not thread-safe. Background work evaluates a copy of graph().

#include "core/commands/Command.h"
#include "core/graph/Graph.h"
#include "core/graph/GraphDelta.h"
#include "core/graph/NodeDef.h"

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace pf::history {

// Whether an executed command may join the step before it, making one continuous edit (dragging a slider or a node).
enum class Merge : std::uint8_t {
    No,       // a new step: a click, a typed value, the first change of a drag
    Continue, // the drag goes on: joins the current step when it was the last thing executed and its command says
              // the new one continues it (CommandType::continues); otherwise a new step
};

enum class EntryState : std::uint8_t { Past, Current, Future }; // future entries (undone) are shown dimmed

struct Entry {
    std::uint64_t id = 0; // stable while the entry exists
    std::string label;
    bool isOpeningState = false; // the first entry
    EntryState state = EntryState::Past;
};

enum class ChangeKind : std::uint8_t {
    Executed, // a new step
    Merged,   // the current step took in a continuing edit
    Moved,    // undo, redo, a click on an entry, toggle last state
    Trimmed,  // the limit changed and steps were dropped
};

struct Change {
    ChangeKind kind = ChangeKind::Executed;
    // Executed and Merged: the step's descriptor as it now stands (valid until the next change).
    const commands::Descriptor* descriptor = nullptr;
};

class History {
public:
    static constexpr std::size_t defaultMaxStates = 50;
    static constexpr std::size_t maxMaxStates = 1000;

    // Both registries must outlive the History.
    History(const commands::CommandRegistry& commands, const graph::NodeRegistry& nodeTypes, graph::Graph initial = {},
            std::string openingLabel = "New");
    History(const History&) = delete;
    History(History&&) = delete;
    History& operator=(const History&) = delete;
    History& operator=(History&&) = delete;
    ~History() = default;

    [[nodiscard]] const graph::Graph& graph() const { return m_graph; }

    // Performs `descriptor` and records it as a new step after the current entry (or merges it, see Merge). Returns
    // false, recording nothing, when the command changed nothing. Throws commands::CommandError, changing nothing,
    // when it cannot run. `replayNames`: see commands::Context.
    bool execute(commands::Descriptor descriptor, Merge merge = Merge::No, commands::NameMap* replayNames = nullptr);

    [[nodiscard]] bool canUndo() const;
    [[nodiscard]] bool canRedo() const;
    // Each does nothing when it cannot.
    void undo();
    void redo();
    // For Edit > Undo <label> / Redo <label>; empty when not possible.
    [[nodiscard]] std::string undoLabel() const;
    [[nodiscard]] std::string redoLabel() const;
    // Moves to entry `index` (a click in the History panel). Throws std::out_of_range.
    void goTo(std::size_t index);
    // Edit > Toggle Last State: back to the previous entry, and on the next toggle forward again.
    void toggleLastState();

    // Entries, the opening state included.
    [[nodiscard]] std::size_t size() const { return m_steps.size() + 1; }
    [[nodiscard]] std::size_t currentIndex() const { return m_current; }
    [[nodiscard]] std::vector<Entry> entries() const;
    // The descriptor of entry `index`; null for the opening state. Throws std::out_of_range.
    [[nodiscard]] const commands::Descriptor* descriptor(std::size_t index) const;

    [[nodiscard]] std::size_t maxStates() const { return m_maxStates; }
    // Clamped into 1–1000. Drops the oldest steps over the limit, never the current one (undone steps go first when
    // the current entry is the oldest step).
    void setMaxStates(std::size_t count);

    using Observer = std::function<void(const Change&)>;
    // Called after every change, on this thread. Returns an id for removeObserver().
    std::uint64_t addObserver(Observer observer);
    void removeObserver(std::uint64_t id);

private:
    struct Step {
        std::uint64_t id = 0;
        std::string label;
        commands::Descriptor descriptor;
        graph::GraphDelta delta;
    };

    [[nodiscard]] bool tryMerge(commands::Performed& performed, const graph::GraphDelta& delta);
    void moveTo(std::size_t target);
    void trim();
    [[nodiscard]] std::optional<std::size_t> indexOf(std::uint64_t entryId) const;
    [[nodiscard]] std::uint64_t entryId(std::size_t index) const;
    void notify(const Change& change);

    const commands::CommandRegistry* m_commands;
    const graph::NodeRegistry* m_nodeTypes;
    graph::Graph m_graph;
    graph::Graph m_opening;     // entry 0
    graph::Graph m_base;        // the state before m_steps.front(): m_opening until old steps are dropped
    std::uint64_t m_nextId = 1; // entry ids
    std::string m_openingLabel;
    std::uint64_t m_openingId;
    std::deque<Step> m_steps; // entry i ≥ 1 is m_steps[i - 1]
    std::size_t m_current = 0;
    bool m_trimmed = false;   // steps between the opening state and m_steps.front() were dropped
    bool m_mergeOpen = false; // the current step was the last thing executed
    std::optional<std::uint64_t> m_toggleBack;
    std::size_t m_maxStates = defaultMaxStates;
    std::vector<std::pair<std::uint64_t, Observer>> m_observers;
    std::uint64_t m_nextObserverId = 1;
};

} // namespace pf::history
