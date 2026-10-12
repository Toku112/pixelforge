#include "engine/Scheduler.h"

#include <tbb/global_control.h>
#include <tbb/task_arena.h>

#include <algorithm>
#include <atomic>
#include <stdexcept>
#include <unordered_map>

namespace pf::engine {

namespace {

std::atomic<std::thread::id>& uiThread() {
    static std::atomic<std::thread::id> id{};
    return id;
}

// > 0 while this thread runs a job's function.
int& jobDepth() {
    thread_local int depth = 0;
    return depth;
}

// One oneTBB arena per priority. oneTBB gives free worker threads to the arena of the highest priority that has work,
// and parallel algorithms called inside a job run in the job's arena, so nested work keeps the job's priority.
tbb::task_arena::priority arenaPriority(Priority priority) {
    switch (priority) {
    case Priority::Viewer:
        return tbb::task_arena::priority::high;
    case Priority::Caching:
        return tbb::task_arena::priority::normal;
    case Priority::Render:
        return tbb::task_arena::priority::low;
    }
    return tbb::task_arena::priority::low;
}

std::size_t index(Priority priority) {
    return static_cast<std::size_t>(priority);
}

} // namespace

void setUiThread(std::thread::id id) noexcept {
    uiThread().store(id, std::memory_order_relaxed);
}

bool isUiThread() noexcept {
    return std::this_thread::get_id() == uiThread().load(std::memory_order_relaxed);
}

bool isJobThread() noexcept {
    return jobDepth() > 0;
}

// ---- JobControl

namespace detail {

JobControl::JobControl(std::uint64_t id, std::string name, Priority priority, const CancellationToken& parent,
                       std::function<void(JobStatus)> onFinished)
    : m_id(id),
      m_name(std::move(name)),
      m_priority(priority),
      m_cancel(parent),
      m_onFinished(std::move(onFinished)) {}

std::string JobControl::error() const {
    if (status() != JobStatus::Failed) {
        return {};
    }
    try {
        std::rethrow_exception(m_failure);
    } catch (const std::exception& e) {
        return e.what();
    } catch (...) {
        return "unknown error";
    }
}

void JobControl::checkMayWait() {
    if (isUiThread()) {
        throw std::logic_error("the UI thread must not wait for a background job (CLAUDE.md §3.5)");
    }
    if (isJobThread()) {
        throw std::logic_error("a job must not wait for another job; split its work with parallelFor instead");
    }
}

void JobControl::wait() const {
    checkMayWait();
    std::unique_lock lock(m_mutex);
    m_completedChanged.wait(lock, [this] { return m_completed; });
}

bool JobControl::waitFor(std::chrono::milliseconds timeout) const {
    checkMayWait();
    std::unique_lock lock(m_mutex);
    return m_completedChanged.wait_for(lock, timeout, [this] { return m_completed; });
}

void JobControl::rethrowIfUnsuccessful() const {
    switch (status()) {
    case JobStatus::Cancelled:
        throw OperationCancelled();
    case JobStatus::Failed:
        std::rethrow_exception(m_failure);
    default:
        break;
    }
}

JobStatus JobControl::execute() {
    JobStatus outcome = JobStatus::Cancelled;
    if (!m_cancel.isCancelled()) {
        m_status.store(JobStatus::Running, std::memory_order_release);
        JobContext context(m_cancel.token(), m_progress, m_priority);
        ++jobDepth();
        try {
            run(context);
            outcome = JobStatus::Finished;
        } catch (const OperationCancelled&) {
            outcome = JobStatus::Cancelled;
        } catch (...) {
            m_failure = std::current_exception();
            outcome = JobStatus::Failed;
        }
        --jobDepth();
    }
    // Release: the result and m_failure are visible to whoever sees the final status.
    m_status.store(outcome, std::memory_order_release);
    if (m_onFinished) {
        // A callback must not throw; one that does must not take the worker thread down with it.
        try {
            m_onFinished(outcome);
        } catch (...) { // NOLINT(bugprone-empty-catch)
        }
    }
    {
        const std::scoped_lock lock(m_mutex);
        m_completed = true;
    }
    m_completedChanged.notify_all();
    return outcome;
}

} // namespace detail

// ---- Scheduler

struct Scheduler::Impl {
    Impl() {
        for (std::size_t p = 0; p < priorityCount; ++p) {
            // No slots reserved for outside threads: jobs are only enqueued, nobody outside joins an arena.
            arenas[p].initialize(tbb::task_arena::automatic, 0, arenaPriority(static_cast<Priority>(p)));
        }
    }

    void run(const std::shared_ptr<detail::JobControl>& job) {
        const std::size_t p = index(job->priority());
        {
            const std::scoped_lock lock(mutex);
            --stats.queued[p];
            ++stats.running[p];
        }
        const JobStatus outcome = job->execute();
        // The last use of the scheduler by this task; the destructor may run as soon as the lock is released.
        const std::scoped_lock lock(mutex);
        --stats.running[p];
        switch (outcome) {
        case JobStatus::Finished:
            ++stats.finished;
            break;
        case JobStatus::Cancelled:
            ++stats.cancelled;
            break;
        default:
            ++stats.failed;
            break;
        }
        active.erase(job->id());
        --outstanding;
        if (outstanding == 0) {
            idle.notify_all(); // under the lock: the scheduler may be destroyed right after the waiter wakes
        }
    }

    void waitIdle() {
        std::unique_lock lock(mutex);
        idle.wait(lock, [this] { return outstanding == 0; });
    }

    std::array<tbb::task_arena, priorityCount> arenas;
    std::atomic<std::uint64_t> nextId{1};

    mutable std::mutex mutex;
    std::condition_variable idle;
    std::size_t outstanding = 0; // jobs queued or running
    bool shuttingDown = false;
    SchedulerStats stats;
    std::unordered_map<std::uint64_t, std::shared_ptr<detail::JobControl>> active;
};

Scheduler::Scheduler() : m_impl(std::make_unique<Impl>()) {}

Scheduler::~Scheduler() {
    {
        const std::scoped_lock lock(m_impl->mutex);
        m_impl->shuttingDown = true;
    }
    cancelAll();
    m_impl->waitIdle();
}

std::uint64_t Scheduler::nextJobId() {
    return m_impl->nextId.fetch_add(1, std::memory_order_relaxed);
}

void Scheduler::enqueue(std::shared_ptr<detail::JobControl> job) {
    const std::size_t p = index(job->priority());
    {
        const std::scoped_lock lock(m_impl->mutex);
        if (m_impl->shuttingDown) {
            job->cancel(); // still runs through the arena (and its onFinished), but does no work
        }
        ++m_impl->outstanding;
        ++m_impl->stats.queued[p];
        m_impl->active.emplace(job->id(), job);
    }
    m_impl->arenas[p].enqueue([impl = m_impl.get(), job = std::move(job)] { impl->run(job); });
}

int Scheduler::threadCount() {
    // oneTBB starts one worker fewer than its parallelism limit, keeping a slot for an outside thread; no outside
    // thread joins our arenas, so jobs get the workers.
    const auto parallelism =
        static_cast<int>(tbb::global_control::active_value(tbb::global_control::max_allowed_parallelism));
    return std::max(1, parallelism - 1);
}

std::vector<JobInfo> Scheduler::jobs() const {
    std::vector<JobInfo> result;
    {
        const std::scoped_lock lock(m_impl->mutex);
        for (const auto& [id, job] : m_impl->active) {
            if (job->name().empty()) {
                continue;
            }
            result.push_back({.id = id,
                              .name = job->name(),
                              .priority = job->priority(),
                              .status = job->status(),
                              .fraction = job->progress().fraction(),
                              .statusText = job->progress().status()});
        }
    }
    std::ranges::sort(result, {}, &JobInfo::id);
    return result;
}

SchedulerStats Scheduler::stats() const {
    SchedulerStats result;
    {
        const std::scoped_lock lock(m_impl->mutex);
        result = m_impl->stats;
    }
    result.threads = threadCount();
    return result;
}

void Scheduler::cancelAll() {
    const std::scoped_lock lock(m_impl->mutex);
    for (const auto& [id, job] : m_impl->active) {
        job->cancel();
    }
}

void Scheduler::waitIdle() const {
    if (isUiThread()) {
        throw std::logic_error("the UI thread must not wait for background jobs (CLAUDE.md §3.5)");
    }
    if (isJobThread()) {
        throw std::logic_error("a job must not wait for other jobs");
    }
    m_impl->waitIdle();
}

} // namespace pf::engine
