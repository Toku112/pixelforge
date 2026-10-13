#pragma once

// Actions (docs/specs/commands-history.md §7): a recorded list of command descriptors that can be played again, on
// the same project or another one. Item 8 of PLAN Part C has recording, playing and the file form; the Actions panel
// (sets, button mode, dialogs per step, insert stop…) is PLAN B19.

#include "core/commands/Command.h"
#include "core/history/History.h"
#include "core/json/Json.h"

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace pf::actions {

struct Action {
    std::string name;
    std::vector<commands::Descriptor> steps;
    friend bool operator==(const Action&, const Action&) = default;
};

// A step of an action that could not run, or a file that is not an action.
class ActionError : public std::runtime_error {
public:
    ActionError(const std::string& message, std::size_t step) : std::runtime_error(message), m_step(step) {}
    // The step (counting from 0) that failed; for a file that is not an action, the step that is not a command.
    [[nodiscard]] std::size_t step() const { return m_step; }

private:
    std::size_t m_step;
};

// The file form (FORMAT_NOTES §21.4): {"format": "pixelforge-action", "version": 1, "name": …, "steps": [descriptors]}.
[[nodiscard]] json::Value toJson(const Action& action);
// Throws ActionError for anything else, and for a newer version than this program reads.
[[nodiscard]] Action actionFromJson(const json::Value& value);

// Records what a History executes, from construction until destruction (or stop()). An edit merged into the step
// before it (a slider drag) updates the recorded step, so a drag records as one step with its final value. Undo and
// redo are not recorded, as in the image editor: undone steps stay in the recording.
class Recorder {
public:
    // `history` must outlive the recorder, or stop() must be called first.
    explicit Recorder(history::History& history);
    Recorder(const Recorder&) = delete;
    Recorder(Recorder&&) = delete;
    Recorder& operator=(const Recorder&) = delete;
    Recorder& operator=(Recorder&&) = delete;
    ~Recorder();

    void stop();
    [[nodiscard]] bool isRecording() const { return m_history != nullptr; }
    [[nodiscard]] const std::vector<commands::Descriptor>& steps() const { return m_steps; }
    [[nodiscard]] Action action(std::string name) const { return {.name = std::move(name), .steps = m_steps}; }

private:
    history::History* m_history;
    std::uint64_t m_observer = 0;
    std::vector<commands::Descriptor> m_steps;
};

// Plays every step of `action` into `history`, each one its own History step. A node the action creates under a name
// that is taken gets a free name, and the action's later steps follow it there. Steps that change nothing record
// nothing. Stops at the first step that fails with an ActionError naming it; the steps before stay done (and
// undoable). Returns the number of History steps recorded.
std::size_t play(const Action& action, history::History& history);

} // namespace pf::actions
