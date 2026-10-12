#pragma once

// Progress of one job, written by the work on any thread and read by the UI (progress bars, the status bar). The UI
// polls it (a timer, a few times a second) rather than being called for every step, so busy work never floods the UI
// thread. All functions may run on any number of threads at once.

#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>

namespace pf::engine {

class Progress {
public:
    // The number of steps (frames, tiles, bytes…). 0, the start value, means "unknown": the UI shows a busy bar.
    void setTotal(std::uint64_t steps) noexcept { m_total.store(steps, std::memory_order_relaxed); }
    // Marks `steps` more steps as done.
    void advance(std::uint64_t steps = 1) noexcept { m_done.fetch_add(steps, std::memory_order_relaxed); }
    void setDone(std::uint64_t steps) noexcept { m_done.store(steps, std::memory_order_relaxed); }

    [[nodiscard]] std::uint64_t total() const noexcept { return m_total.load(std::memory_order_relaxed); }
    [[nodiscard]] std::uint64_t done() const noexcept { return m_done.load(std::memory_order_relaxed); }
    // done / total in [0, 1]; nothing while the total is unknown.
    [[nodiscard]] std::optional<double> fraction() const noexcept;

    // A short description of the current step ("Reading frame 1004"), shown next to the bar.
    void setStatus(std::string status);
    [[nodiscard]] std::string status() const;

private:
    std::atomic<std::uint64_t> m_total{0};
    std::atomic<std::uint64_t> m_done{0};
    mutable std::mutex m_statusMutex;
    std::string m_status;
};

} // namespace pf::engine
