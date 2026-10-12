#pragma once

// Cancellation (CLAUDE.md §3.5: long operations are cancellable with Esc). A CancellationSource is held by whoever
// may cancel (the UI, a job, the scheduler); the work holds CancellationTokens and checks them between steps (per
// tile, per frame, per scanline block). Cancelling is a request: the work notices it at its next check and stops,
// usually by throwing OperationCancelled, which the scheduler records as a cancelled job (not a failure).
//
// Sources can be chained: a source made from a parent token is cancelled when the parent is (a render job cancels
// the frames it started; closing a document cancels everything it asked for). Tokens and sources are cheap to copy
// and may be used on any number of threads at once.

#include <atomic>
#include <exception>
#include <memory>
#include <utility>

namespace pf::engine {

// Thrown by work that stopped because its token was cancelled.
class OperationCancelled : public std::exception {
public:
    [[nodiscard]] const char* what() const noexcept override { return "operation cancelled"; }
};

namespace detail {

struct CancelState {
    std::atomic<bool> cancelled{false};
    std::shared_ptr<const CancelState> parent; // cancelled when any ancestor is

    [[nodiscard]] bool isCancelled() const noexcept;
};

} // namespace detail

// Read side: may the work go on?
class CancellationToken {
public:
    // A token that is never cancelled.
    CancellationToken() = default;

    [[nodiscard]] bool isCancelled() const noexcept { return m_state != nullptr && m_state->isCancelled(); }
    // Throws OperationCancelled when cancelled.
    void throwIfCancelled() const;
    // False for the never-cancelled token: checks may be skipped.
    [[nodiscard]] bool canBeCancelled() const noexcept { return m_state != nullptr; }

private:
    friend class CancellationSource;
    explicit CancellationToken(std::shared_ptr<const detail::CancelState> state) : m_state(std::move(state)) {}

    std::shared_ptr<const detail::CancelState> m_state;
};

// Write side: cancels every token it handed out (and the tokens of sources chained to it).
class CancellationSource {
public:
    CancellationSource();
    // Cancelled when `parent` is cancelled, or by cancel().
    explicit CancellationSource(const CancellationToken& parent);

    void cancel() noexcept;
    [[nodiscard]] bool isCancelled() const noexcept { return m_state->isCancelled(); }
    [[nodiscard]] CancellationToken token() const { return CancellationToken(m_state); }

private:
    std::shared_ptr<detail::CancelState> m_state;
};

} // namespace pf::engine
