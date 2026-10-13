#include "core/history/History.h"

#include <algorithm>
#include <iterator>
#include <stdexcept>

namespace pf::history {

History::History(const commands::CommandRegistry& commands, const graph::NodeRegistry& nodeTypes, graph::Graph initial,
                 std::string openingLabel)
    : m_commands(&commands),
      m_nodeTypes(&nodeTypes),
      m_graph(std::move(initial)),
      m_opening(m_graph),
      m_base(m_graph),
      m_openingLabel(std::move(openingLabel)),
      m_openingId(m_nextId++) {}

bool History::execute(commands::Descriptor descriptor, Merge merge, commands::NameMap* replayNames) {
    const commands::Context context(*m_commands, *m_nodeTypes, replayNames);
    commands::Performed performed = commands::perform(m_graph, std::move(descriptor), context);
    const graph::GraphDelta delta = graph::GraphDelta::between(m_graph, performed.graph);
    if (merge == Merge::Continue && tryMerge(performed, delta)) {
        return !delta.empty();
    }
    if (delta.empty()) {
        return false;
    }

    // Entries after the current one are dropped; from the opening state everything goes, and the steps start again
    // from it.
    if (m_current == 0) {
        m_steps.clear();
        m_base = m_opening;
        m_trimmed = false;
    } else {
        m_steps.erase(m_steps.begin() + static_cast<std::ptrdiff_t>(m_current), m_steps.end());
    }
    // Applying the delta (rather than taking performed.graph) keeps the nodes that did not really change as the
    // very same objects, which undo checks.
    m_graph.apply(delta);
    m_steps.push_back({.id = m_nextId++,
                       .label = std::move(performed.label),
                       .descriptor = std::move(performed.descriptor),
                       .delta = delta});
    m_current = m_steps.size();
    m_mergeOpen = true;
    m_toggleBack.reset();
    trim();
    notify({.kind = ChangeKind::Executed, .descriptor = &m_steps.back().descriptor});
    return true;
}

bool History::tryMerge(commands::Performed& performed, const graph::GraphDelta& delta) {
    if (!m_mergeOpen || m_current == 0 || m_current != m_steps.size()) {
        return false;
    }
    Step& step = m_steps.back();
    const commands::CommandType* type = m_commands->find(step.descriptor.command);
    if (type == nullptr || !type->continues || step.descriptor.command != performed.descriptor.command ||
        !type->continues(step.descriptor.params, performed.descriptor.params)) {
        return false;
    }
    if (delta.empty()) {
        return true; // the drag did not change anything this time: nothing to add
    }
    m_graph.apply(delta);
    step.delta.append(delta);
    step.descriptor = std::move(performed.descriptor);
    step.label = std::move(performed.label);
    m_toggleBack.reset();
    notify({.kind = ChangeKind::Merged, .descriptor = &step.descriptor});
    return true;
}

bool History::canUndo() const {
    return m_current > (m_trimmed ? 1U : 0U);
}

bool History::canRedo() const {
    return m_current < m_steps.size();
}

void History::undo() {
    if (canUndo()) {
        goTo(m_current - 1);
    }
}

void History::redo() {
    if (canRedo()) {
        goTo(m_current + 1);
    }
}

std::string History::undoLabel() const {
    return canUndo() ? m_steps[m_current - 1].label : std::string();
}

std::string History::redoLabel() const {
    return canRedo() ? m_steps[m_current].label : std::string();
}

void History::goTo(std::size_t index) {
    if (index >= size()) {
        throw std::out_of_range("History: no entry " + std::to_string(index));
    }
    moveTo(index);
    m_mergeOpen = false;
    m_toggleBack.reset();
    notify({.kind = ChangeKind::Moved, .descriptor = nullptr});
}

void History::toggleLastState() {
    std::optional<std::size_t> target;
    if (m_toggleBack) {
        target = indexOf(*m_toggleBack);
    }
    if (!target) {
        if (!canUndo()) {
            return;
        }
        target = m_current - 1;
    }
    const std::uint64_t back = entryId(m_current);
    moveTo(*target);
    m_mergeOpen = false;
    m_toggleBack = back;
    notify({.kind = ChangeKind::Moved, .descriptor = nullptr});
}

void History::moveTo(std::size_t target) {
    if (target == m_current) {
        return;
    }
    if (target == 0) {
        m_graph.restore(m_opening);
        m_current = 0;
        return;
    }
    if (m_current == 0) {
        // From the opening state, steps replay from the state before the oldest step (the same unless old steps were
        // dropped).
        m_graph.restore(m_base);
    }
    while (m_current < target) {
        m_graph.apply(m_steps[m_current].delta);
        ++m_current;
    }
    while (m_current > target) {
        m_graph.revert(m_steps[m_current - 1].delta);
        --m_current;
    }
}

void History::trim() {
    while (m_steps.size() > m_maxStates) {
        if (m_current == 1) {
            // The current entry is the oldest step: keep it, drop the newest undone step instead.
            m_steps.pop_back();
            continue;
        }
        m_base.apply(m_steps.front().delta);
        m_steps.pop_front();
        m_trimmed = true;
        if (m_current > 0) {
            --m_current;
        }
    }
    if (m_toggleBack && !indexOf(*m_toggleBack)) {
        m_toggleBack.reset();
    }
}

std::vector<Entry> History::entries() const {
    const auto stateOf = [&](std::size_t index) {
        if (index < m_current) {
            return EntryState::Past;
        }
        return index == m_current ? EntryState::Current : EntryState::Future;
    };
    std::vector<Entry> result;
    result.reserve(size());
    result.push_back({.id = m_openingId, .label = m_openingLabel, .isOpeningState = true, .state = stateOf(0)});
    for (std::size_t i = 0; i < m_steps.size(); ++i) {
        result.push_back(
            {.id = m_steps[i].id, .label = m_steps[i].label, .isOpeningState = false, .state = stateOf(i + 1)});
    }
    return result;
}

const commands::Descriptor* History::descriptor(std::size_t index) const {
    if (index >= size()) {
        throw std::out_of_range("History: no entry " + std::to_string(index));
    }
    return index == 0 ? nullptr : &m_steps[index - 1].descriptor;
}

void History::setMaxStates(std::size_t count) {
    m_maxStates = std::clamp<std::size_t>(count, 1, maxMaxStates);
    const std::size_t before = m_steps.size();
    trim();
    if (m_steps.size() != before) {
        notify({.kind = ChangeKind::Trimmed, .descriptor = nullptr});
    }
}

std::uint64_t History::addObserver(Observer observer) {
    const std::uint64_t id = m_nextObserverId++;
    m_observers.emplace_back(id, std::move(observer));
    return id;
}

void History::removeObserver(std::uint64_t id) {
    std::erase_if(m_observers, [&](const auto& entry) { return entry.first == id; });
}

std::optional<std::size_t> History::indexOf(std::uint64_t entryId) const {
    if (entryId == m_openingId) {
        return 0;
    }
    const auto found = std::ranges::find(m_steps, entryId, &Step::id);
    if (found == m_steps.end()) {
        return std::nullopt;
    }
    return static_cast<std::size_t>(std::distance(m_steps.begin(), found)) + 1;
}

std::uint64_t History::entryId(std::size_t index) const {
    return index == 0 ? m_openingId : m_steps[index - 1].id;
}

void History::notify(const Change& change) {
    // A copy: an observer may add or remove observers.
    const std::vector<std::pair<std::uint64_t, Observer>> observers = m_observers;
    for (const auto& [id, observer] : observers) {
        observer(change);
    }
}

} // namespace pf::history
