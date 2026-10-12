#pragma once

// Background work (CLAUDE.md §3.5, PLAN Part C item 6, D-074). Everything slow — decoding, evaluating nodes, filling
// caches, rendering — runs as a job on oneTBB worker threads, never on the UI thread. A job is a function with a
// priority, a cancellation token and a progress record; submitting returns a Job handle that can cancel it, read its
// progress and (off the UI thread) wait for its result.
//
// Priorities: a free thread always starts the waiting job of the highest priority. Running work is not interrupted,
// so long work is cut into pieces (tiles, frames) that check their token. Parallel loops inside a job (parallelFor,
// or any oneTBB algorithm) run at the job's priority.
//
// Thread rules, checked at run time: the UI thread never waits for a job (it gets results through onFinished, passed
// on to the UI thread by the UI layer) and a job never waits for another job (each waiting job would hold a thread;
// with every thread waiting, nothing would run). Nested parallelism inside a job is the way to split its work.

#include "engine/Cancellation.h"
#include "engine/Progress.h"

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace pf::engine {

// Highest first: the viewer (the user is looking at it), caching (prefetching frames for playback), rendering (the
// render queue).
enum class Priority : std::uint8_t { Viewer, Caching, Render };
inline constexpr std::size_t priorityCount = 3;

enum class JobStatus : std::uint8_t {
    Queued,    // waiting for a thread
    Running,   //
    Finished,  // the function returned
    Cancelled, // cancelled before it started, or it threw OperationCancelled
    Failed,    // it threw another exception
};

[[nodiscard]] constexpr bool isDone(JobStatus status) {
    return status == JobStatus::Finished || status == JobStatus::Cancelled || status == JobStatus::Failed;
}

// ---- thread roles

// Declares the UI thread (the app does this at startup). Waiting on it throws std::logic_error.
void setUiThread(std::thread::id id = std::this_thread::get_id()) noexcept;
[[nodiscard]] bool isUiThread() noexcept;
// True inside a job's function (on a scheduler thread).
[[nodiscard]] bool isJobThread() noexcept;

// What a job's function receives.
class JobContext {
public:
    JobContext(CancellationToken token, Progress& progress, Priority priority)
        : m_token(std::move(token)),
          m_progress(&progress),
          m_priority(priority) {}

    [[nodiscard]] const CancellationToken& token() const { return m_token; }
    [[nodiscard]] bool isCancelled() const { return m_token.isCancelled(); }
    void throwIfCancelled() const { m_token.throwIfCancelled(); }
    [[nodiscard]] Progress& progress() const { return *m_progress; }
    [[nodiscard]] Priority priority() const { return m_priority; }

private:
    CancellationToken m_token;
    Progress* m_progress;
    Priority m_priority;
};

namespace detail {

// The shared state of one job, without its result type.
class JobControl {
public:
    JobControl(std::uint64_t id, std::string name, Priority priority, const CancellationToken& parent,
               std::function<void(JobStatus)> onFinished);
    virtual ~JobControl() = default;
    JobControl(const JobControl&) = delete;
    JobControl(JobControl&&) = delete;
    JobControl& operator=(const JobControl&) = delete;
    JobControl& operator=(JobControl&&) = delete;

    [[nodiscard]] std::uint64_t id() const { return m_id; }
    [[nodiscard]] const std::string& name() const { return m_name; }
    [[nodiscard]] Priority priority() const { return m_priority; }
    [[nodiscard]] JobStatus status() const { return m_status.load(std::memory_order_acquire); }
    [[nodiscard]] Progress& progress() { return m_progress; }
    [[nodiscard]] const Progress& progress() const { return m_progress; }
    // The message of the exception a failed job threw.
    [[nodiscard]] std::string error() const;

    void cancel() noexcept { m_cancel.cancel(); }
    // Blocks until the job is done and its onFinished has returned. Throws std::logic_error on the UI thread or in
    // a job (see the thread rules above). The scheduler's jobs() and stats() may still count the job as running for
    // a moment; Scheduler::waitIdle() waits for those too.
    void wait() const;
    // As wait(), giving up after `timeout`; true when the job is done.
    [[nodiscard]] bool waitFor(std::chrono::milliseconds timeout) const;
    // Throws OperationCancelled for a cancelled job and the job's own exception for a failed one.
    void rethrowIfUnsuccessful() const;

    // Run by the scheduler on a worker thread: runs the function (unless cancelled), records the outcome, calls
    // onFinished and wakes the waiters. Returns the final status.
    JobStatus execute();

protected:
    virtual void run(JobContext& context) = 0;

private:
    static void checkMayWait();

    const std::uint64_t m_id;
    const std::string m_name;
    const Priority m_priority;
    CancellationSource m_cancel;
    Progress m_progress;
    std::function<void(JobStatus)> m_onFinished;
    std::atomic<JobStatus> m_status{JobStatus::Queued};

    mutable std::mutex m_mutex;
    mutable std::condition_variable m_completedChanged;
    bool m_completed = false;     // done and onFinished returned (guarded by m_mutex)
    std::exception_ptr m_failure; // set before m_status becomes Failed
};

template <class T>
class JobResult : public JobControl {
public:
    using JobControl::JobControl;
    // Throws std::logic_error unless the job finished.
    [[nodiscard]] const T& value() const {
        if (!m_value) {
            throw std::logic_error("the job has no result");
        }
        return *m_value;
    }

protected:
    std::optional<T> m_value;
};

template <>
class JobResult<void> : public JobControl {
public:
    using JobControl::JobControl;
};

template <class T, class F>
class JobState final : public JobResult<T> {
public:
    template <class G>
    JobState(std::uint64_t id, std::string name, Priority priority, const CancellationToken& parent,
             std::function<void(JobStatus)> onFinished, G&& function)
        : JobResult<T>(id, std::move(name), priority, parent, std::move(onFinished)),
          m_function(std::forward<G>(function)) {}

private:
    void run(JobContext& context) override {
        if constexpr (std::is_void_v<T>) {
            m_function(context);
        } else {
            this->m_value.emplace(m_function(context));
        }
    }

    F m_function;
};

} // namespace detail

// A handle to a submitted job; copies refer to the same job. A default-constructed handle refers to none.
template <class T>
class Job {
public:
    Job() = default;
    explicit Job(std::shared_ptr<detail::JobResult<T>> state) : m_state(std::move(state)) {}

    [[nodiscard]] bool isValid() const { return m_state != nullptr; }
    [[nodiscard]] std::uint64_t id() const { return m_state->id(); }
    [[nodiscard]] JobStatus status() const { return m_state->status(); }
    [[nodiscard]] bool isDone() const { return engine::isDone(status()); }
    [[nodiscard]] const Progress& progress() const { return m_state->progress(); }
    [[nodiscard]] std::string error() const { return m_state->error(); }

    // Asks the job to stop: a queued job never runs, a running one stops at its next check.
    void cancel() const { m_state->cancel(); }
    // See detail::JobControl::wait(): never on the UI thread or inside a job.
    void wait() const { m_state->wait(); }
    [[nodiscard]] bool waitFor(std::chrono::milliseconds timeout) const { return m_state->waitFor(timeout); }

    // Waits, then returns the result. Throws OperationCancelled for a cancelled job and rethrows the exception of a
    // failed one.
    decltype(auto) get() const {
        wait();
        m_state->rethrowIfUnsuccessful();
        if constexpr (!std::is_void_v<T>) {
            return m_state->value();
        }
    }

private:
    std::shared_ptr<detail::JobResult<T>> m_state;
};

struct JobOptions {
    // Shown to the user while the job is queued or running (jobs()); empty for internal work, which is not listed.
    std::string name;
    Priority priority = Priority::Render;
    // The job is cancelled when this token is.
    CancellationToken parent;
    // Called on the worker thread once the job is done, whatever its status, before waiters wake. Must be quick and
    // must not throw; the UI layer uses it to post the result to the UI thread.
    std::function<void(JobStatus)> onFinished;
};

// A listed job, as the UI shows it.
struct JobInfo {
    std::uint64_t id = 0;
    std::string name;
    Priority priority = Priority::Render;
    JobStatus status = JobStatus::Queued;
    std::optional<double> fraction; // nothing while the total is unknown
    std::string statusText;
};

// For the status bar.
struct SchedulerStats {
    int threads = 0;                                  // threads that run jobs: one per core, less the UI thread
    std::array<std::size_t, priorityCount> queued{};  // per Priority
    std::array<std::size_t, priorityCount> running{}; // per Priority
    std::uint64_t finished = 0;
    std::uint64_t cancelled = 0;
    std::uint64_t failed = 0;
};

class Scheduler {
public:
    // Jobs run on oneTBB's worker threads, one per core less one (the UI thread keeps a core). The total can be
    // lowered process-wide with tbb::global_control (tests do).
    Scheduler();
    // Cancels every job and waits until running ones have stopped (the only wait allowed on the UI thread: at
    // shutdown, when jobs stop at their next cancellation check).
    ~Scheduler();
    Scheduler(const Scheduler&) = delete;
    Scheduler(Scheduler&&) = delete;
    Scheduler& operator=(const Scheduler&) = delete;
    Scheduler& operator=(Scheduler&&) = delete;

    // Runs `function(JobContext&)` on a worker thread. Its return value (or void) becomes the job's result.
    template <class F>
    auto submit(JobOptions options, F&& function) {
        using Function = std::decay_t<F>;
        using Result = std::invoke_result_t<Function&, JobContext&>;
        auto state = std::make_shared<detail::JobState<Result, Function>>(
            nextJobId(), std::move(options.name), options.priority, options.parent, std::move(options.onFinished),
            std::forward<F>(function));
        enqueue(state);
        return Job<Result>(std::move(state));
    }

    [[nodiscard]] static int threadCount();
    // Named jobs that are queued or running, oldest first.
    [[nodiscard]] std::vector<JobInfo> jobs() const;
    [[nodiscard]] SchedulerStats stats() const;

    // Cancels every queued and running job.
    void cancelAll();
    // Blocks until no job is queued or running. Never on the UI thread or inside a job.
    void waitIdle() const;

private:
    struct Impl;

    [[nodiscard]] std::uint64_t nextJobId();
    void enqueue(std::shared_ptr<detail::JobControl> job);

    std::unique_ptr<Impl> m_impl;
};

} // namespace pf::engine
