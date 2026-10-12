#include "engine/Cancellation.h"

#include <utility>

namespace pf::engine {

bool detail::CancelState::isCancelled() const noexcept {
    // Acquire: whatever the canceller did before cancel() is visible to work that sees the flag.
    for (const CancelState* state = this; state != nullptr; state = state->parent.get()) {
        if (state->cancelled.load(std::memory_order_acquire)) {
            return true;
        }
    }
    return false;
}

void CancellationToken::throwIfCancelled() const {
    if (isCancelled()) {
        throw OperationCancelled();
    }
}

CancellationSource::CancellationSource() : m_state(std::make_shared<detail::CancelState>()) {}

CancellationSource::CancellationSource(const CancellationToken& parent) : CancellationSource() {
    m_state->parent = parent.m_state;
}

void CancellationSource::cancel() noexcept {
    m_state->cancelled.store(true, std::memory_order_release);
}

} // namespace pf::engine
