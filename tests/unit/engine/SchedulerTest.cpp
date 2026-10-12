// The job scheduler (engine/Scheduler.h) and parallel loops (engine/Parallel.h).

#include "engine/Scheduler.h"

#include "engine/Parallel.h"

#include <gtest/gtest.h>
#include <tbb/global_control.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace pf::engine {
namespace {

using namespace std::chrono_literals;

// A gate that jobs wait at until the test opens it (lets a test hold worker threads busy).
class Gate {
public:
    void wait() {
        std::unique_lock lock(m_mutex);
        m_changed.wait(lock, [this] { return m_open; });
    }
    void open() {
        {
            const std::scoped_lock lock(m_mutex);
            m_open = true;
        }
        m_changed.notify_all();
    }

private:
    std::mutex m_mutex;
    std::condition_variable m_changed;
    bool m_open = false;
};

// Spins until `condition` holds; fails the test after a generous timeout instead of hanging.
template <class Condition>
bool eventually(Condition condition) {
    const auto deadline = std::chrono::steady_clock::now() + 20s;
    while (!condition()) {
        if (std::chrono::steady_clock::now() > deadline) {
            return false;
        }
        std::this_thread::sleep_for(1ms);
    }
    return true;
}

// True when f() throws an Exception (EXPECT_THROW, but light enough for the complexity limit of clang-tidy).
template <class Exception, class F>
bool throws(F&& f) {
    try {
        std::forward<F>(f)();
    } catch (const Exception&) {
        return true;
    } catch (...) {
        return false;
    }
    return false;
}

// Restores "no UI thread" after a test declared one.
struct UiThreadScope {
    UiThreadScope() { setUiThread(); }
    ~UiThreadScope() { setUiThread(std::thread::id{}); }
    UiThreadScope(const UiThreadScope&) = delete;
    UiThreadScope(UiThreadScope&&) = delete;
    UiThreadScope& operator=(const UiThreadScope&) = delete;
    UiThreadScope& operator=(UiThreadScope&&) = delete;
};

TEST(Scheduler, RunsAJobOnAWorkerThreadAndReturnsItsResult) {
    Scheduler scheduler;
    const std::thread::id caller = std::this_thread::get_id();
    const Job<std::thread::id> job = scheduler.submit({}, [](JobContext&) { return std::this_thread::get_id(); });
    EXPECT_NE(job.get(), caller);
    EXPECT_EQ(job.status(), JobStatus::Finished);
    EXPECT_TRUE(job.isDone());

    const Job<int> answer = scheduler.submit({.priority = Priority::Viewer}, [](JobContext& context) {
        EXPECT_EQ(context.priority(), Priority::Viewer);
        EXPECT_TRUE(isJobThread());
        return 42;
    });
    EXPECT_EQ(answer.get(), 42);
    EXPECT_FALSE(isJobThread());
}

TEST(Scheduler, VoidJobs) {
    Scheduler scheduler;
    std::atomic<int> runs{0};
    const Job<void> job = scheduler.submit({}, [&runs](JobContext&) { ++runs; });
    job.get();
    EXPECT_EQ(runs, 1);
    EXPECT_EQ(job.status(), JobStatus::Finished);
}

TEST(Scheduler, JobsGetDistinctIncreasingIds) {
    Scheduler scheduler;
    const auto a = scheduler.submit({}, [](JobContext&) {});
    const auto b = scheduler.submit({}, [](JobContext&) {});
    EXPECT_LT(a.id(), b.id());
    scheduler.waitIdle();
}

TEST(Scheduler, AFailedJobKeepsItsException) {
    Scheduler scheduler;
    const Job<int> job = scheduler.submit({}, [](JobContext&) -> int { throw std::runtime_error("disk on fire"); });
    job.wait();
    EXPECT_EQ(job.status(), JobStatus::Failed);
    EXPECT_EQ(job.error(), "disk on fire");
    EXPECT_TRUE(throws<std::runtime_error>([&] { (void)job.get(); }));
    scheduler.waitIdle();
    EXPECT_EQ(scheduler.stats().failed, 1U);
}

TEST(Scheduler, AJobCancelledBeforeItStartsNeverRuns) {
    const tbb::global_control oneWorker(tbb::global_control::max_allowed_parallelism, 2);
    Scheduler scheduler;
    ASSERT_EQ(Scheduler::threadCount(), 1);
    Gate gate;
    std::atomic<bool> gateStarted{false};
    auto blocker = scheduler.submit({}, [&](JobContext&) {
        gateStarted = true;
        gate.wait();
    });
    ASSERT_TRUE(eventually([&] { return gateStarted.load(); }));

    std::atomic<bool> ran{false};
    auto queued = scheduler.submit({}, [&ran](JobContext&) { ran = true; });
    EXPECT_EQ(queued.status(), JobStatus::Queued);
    queued.cancel();
    gate.open();
    queued.wait();
    EXPECT_EQ(queued.status(), JobStatus::Cancelled);
    EXPECT_FALSE(ran);
    EXPECT_TRUE(throws<OperationCancelled>([&] { queued.get(); }));
    blocker.get();
}

TEST(Scheduler, ARunningJobStopsAtItsNextCheck) {
    Scheduler scheduler;
    std::atomic<bool> started{false};
    const Job<int> job = scheduler.submit({}, [&started](JobContext& context) {
        started = true;
        while (true) {
            context.throwIfCancelled();
            std::this_thread::sleep_for(100us);
        }
        return 0;
    });
    ASSERT_TRUE(eventually([&] { return started.load(); }));
    EXPECT_EQ(job.status(), JobStatus::Running);
    job.cancel();
    job.wait();
    EXPECT_EQ(job.status(), JobStatus::Cancelled);
    EXPECT_TRUE(throws<OperationCancelled>([&] { (void)job.get(); }));
    scheduler.waitIdle(); // statistics are updated just after waiters wake
    EXPECT_EQ(scheduler.stats().cancelled, 1U);
}

TEST(Scheduler, CancellingTheParentCancelsTheJob) {
    Scheduler scheduler;
    CancellationSource document;
    std::atomic<bool> started{false};
    auto job = scheduler.submit({.parent = document.token()}, [&started](JobContext& context) {
        started = true;
        while (!context.isCancelled()) {
            std::this_thread::sleep_for(100us);
        }
        context.throwIfCancelled();
    });
    ASSERT_TRUE(eventually([&] { return started.load(); }));
    document.cancel();
    job.wait();
    EXPECT_EQ(job.status(), JobStatus::Cancelled);
}

TEST(Scheduler, OnFinishedRunsOnceBeforeWaitReturns) {
    Scheduler scheduler;
    std::atomic<int> calls{0};
    std::atomic<JobStatus> seen{JobStatus::Queued};
    auto job = scheduler.submit({.onFinished =
                                     [&](JobStatus status) {
                                         ++calls;
                                         seen = status;
                                     }},
                                [](JobContext&) { return 7; });
    EXPECT_EQ(job.get(), 7);
    EXPECT_EQ(calls, 1);
    EXPECT_EQ(seen, JobStatus::Finished);

    // Also for failures and cancellations.
    auto failing = scheduler.submit({.onFinished = [&](JobStatus status) { seen = status; }},
                                    [](JobContext&) { throw std::logic_error("no"); });
    failing.wait();
    EXPECT_EQ(seen, JobStatus::Failed);
}

TEST(Scheduler, AThrowingOnFinishedDoesNotBreakTheJob) {
    Scheduler scheduler;
    auto job = scheduler.submit({.onFinished = [](JobStatus) { throw std::runtime_error("callback bug"); }},
                                [](JobContext&) { return 1; });
    EXPECT_EQ(job.get(), 1);
    scheduler.waitIdle();
}

TEST(Scheduler, HigherPrioritiesOvertakeQueuedWork) {
    // One worker thread: it is held by a render job while more work queues up behind it.
    const tbb::global_control oneWorker(tbb::global_control::max_allowed_parallelism, 2);
    Scheduler scheduler;
    Gate gate;
    std::atomic<bool> gateStarted{false};
    auto blocker = scheduler.submit({.priority = Priority::Render}, [&](JobContext&) {
        gateStarted = true;
        gate.wait();
    });
    ASSERT_TRUE(eventually([&] { return gateStarted.load(); }));

    std::mutex orderMutex;
    std::vector<Priority> order;
    auto record = [&](JobContext& context) {
        const std::scoped_lock lock(orderMutex);
        order.push_back(context.priority());
    };
    for (int i = 0; i < 6; ++i) {
        (void)scheduler.submit({.priority = Priority::Render}, record);
    }
    (void)scheduler.submit({.priority = Priority::Caching}, record);
    (void)scheduler.submit({.priority = Priority::Viewer}, record);
    gate.open();
    scheduler.waitIdle();

    ASSERT_EQ(order.size(), 8U);
    EXPECT_EQ(order[0], Priority::Viewer);
    EXPECT_EQ(order[1], Priority::Caching);
    EXPECT_TRUE(std::all_of(order.begin() + 2, order.end(), [](Priority p) { return p == Priority::Render; }));
}

TEST(Scheduler, NamedJobsAreListedWithTheirProgress) {
    Scheduler scheduler;
    Gate gate;
    std::atomic<bool> started{false};
    auto named = scheduler.submit({.name = "Reading frames", .priority = Priority::Caching}, [&](JobContext& context) {
        context.progress().setTotal(10);
        context.progress().advance(4);
        context.progress().setStatus("frame 1004");
        started = true;
        gate.wait();
    });
    auto internal = scheduler.submit({}, [&](JobContext&) { gate.wait(); });
    ASSERT_TRUE(eventually([&] { return started.load(); }));

    const std::vector<JobInfo> listed = scheduler.jobs();
    ASSERT_EQ(listed.size(), 1U);
    const JobInfo& info = listed[0];
    EXPECT_EQ(info.id, named.id());
    EXPECT_EQ(info.name, "Reading frames");
    EXPECT_EQ(info.priority, Priority::Caching);
    EXPECT_EQ(info.status, JobStatus::Running);
    EXPECT_EQ(info.fraction, std::optional(0.4));
    EXPECT_EQ(info.statusText, "frame 1004");

    gate.open();
    named.get();
    internal.get();
    scheduler.waitIdle();
    EXPECT_TRUE(scheduler.jobs().empty());
}

TEST(Scheduler, StatsCountJobsByStateAndPriority) {
    const tbb::global_control oneWorker(tbb::global_control::max_allowed_parallelism, 2);
    Scheduler scheduler;
    Gate gate;
    std::atomic<bool> started{false};
    auto running = scheduler.submit({.priority = Priority::Caching}, [&](JobContext&) {
        started = true;
        gate.wait();
    });
    ASSERT_TRUE(eventually([&] { return started.load(); }));
    auto queued = scheduler.submit({.priority = Priority::Render}, [](JobContext&) {});

    SchedulerStats stats = scheduler.stats();
    EXPECT_EQ(stats.threads, 1);
    EXPECT_EQ(stats.running[static_cast<std::size_t>(Priority::Caching)], 1U);
    EXPECT_EQ(stats.queued[static_cast<std::size_t>(Priority::Render)], 1U);
    EXPECT_EQ(stats.queued[static_cast<std::size_t>(Priority::Viewer)], 0U);

    gate.open();
    scheduler.waitIdle();
    stats = scheduler.stats();
    EXPECT_EQ(stats.running, (std::array<std::size_t, priorityCount>{}));
    EXPECT_EQ(stats.queued, (std::array<std::size_t, priorityCount>{}));
    EXPECT_EQ(stats.finished, 2U);
}

TEST(Scheduler, TheUiThreadMayNotWait) {
    Scheduler scheduler;
    auto job = scheduler.submit({}, [](JobContext&) { return 1; });
    {
        const UiThreadScope ui;
        EXPECT_TRUE(isUiThread());
        EXPECT_TRUE(throws<std::logic_error>([&] { job.wait(); }));
        EXPECT_TRUE(throws<std::logic_error>([&] { (void)job.get(); }));
        EXPECT_TRUE(throws<std::logic_error>([&] { (void)job.waitFor(1ms); }));
        EXPECT_TRUE(throws<std::logic_error>([&] { scheduler.waitIdle(); }));
    }
    EXPECT_FALSE(isUiThread());
    EXPECT_EQ(job.get(), 1);
}

TEST(Scheduler, AJobMayNotWaitForAnotherJob) {
    Scheduler scheduler;
    auto first = scheduler.submit({}, [](JobContext&) { return 1; });
    auto second = scheduler.submit({}, [&](JobContext&) {
        try {
            first.wait();
        } catch (const std::logic_error&) {
            return true;
        }
        return false;
    });
    EXPECT_TRUE(second.get());
}

TEST(Scheduler, WaitForGivesUp) {
    Scheduler scheduler;
    Gate gate;
    auto job = scheduler.submit({}, [&](JobContext&) { gate.wait(); });
    EXPECT_FALSE(job.waitFor(5ms));
    gate.open();
    EXPECT_TRUE(job.waitFor(20s));
}

TEST(Scheduler, DestructionCancelsAndWaitsForEveryJob) {
    std::atomic<bool> started{false};
    std::atomic<bool> stopped{false};
    Job<void> running;
    Job<void> lateJob;
    std::atomic<bool> lateJobRan{false};
    {
        Scheduler scheduler;
        running = scheduler.submit({}, [&](JobContext& context) {
            started = true;
            while (!context.isCancelled()) {
                std::this_thread::sleep_for(100us);
            }
            // Work submitted while the scheduler shuts down is cancelled at once.
            lateJob = scheduler.submit({}, [&](JobContext&) { lateJobRan = true; });
            stopped = true;
        });
        ASSERT_TRUE(eventually([&] { return started.load(); }));
    }
    EXPECT_TRUE(stopped);
    EXPECT_EQ(running.status(), JobStatus::Finished); // it returned normally after seeing the cancellation
    ASSERT_TRUE(lateJob.isValid());
    EXPECT_EQ(lateJob.status(), JobStatus::Cancelled);
    EXPECT_FALSE(lateJobRan);
}

TEST(Scheduler, ManyJobsFromManyThreads) {
    Scheduler scheduler;
    constexpr int perThread = 500;
    std::vector<std::thread> submitters;
    submitters.reserve(4);
    std::mutex jobsMutex;
    std::vector<Job<int>> jobs;
    for (int t = 0; t < 4; ++t) {
        submitters.emplace_back([&, t] {
            for (int i = 0; i < perThread; ++i) {
                const int value = (t * perThread) + i;
                auto job = scheduler.submit({.priority = static_cast<Priority>(i % 3)},
                                            [value](JobContext&) { return value * 2; });
                const std::scoped_lock lock(jobsMutex);
                jobs.push_back(job);
            }
        });
    }
    for (std::thread& thread : submitters) {
        thread.join();
    }
    scheduler.waitIdle();
    long long sum = 0;
    for (const Job<int>& job : jobs) {
        sum += job.get();
    }
    constexpr long long n = 4LL * perThread;
    EXPECT_EQ(sum, n * (n - 1));
    EXPECT_EQ(scheduler.stats().finished, static_cast<std::uint64_t>(n));
}

// ---- parallelFor

TEST(ParallelFor, VisitsEveryIndexOnce) {
    std::vector<std::atomic<int>> visits(1000);
    parallelFor(std::size_t{0}, visits.size(), CancellationToken{}, [&](std::size_t i) { ++visits[i]; });
    EXPECT_TRUE(std::ranges::all_of(visits, [](const std::atomic<int>& v) { return v == 1; }));
    parallelFor(5, 5, CancellationToken{}, [](int) { FAIL(); }); // empty range
}

TEST(ParallelFor, StopsWhenCancelled) {
    CancellationSource source;
    std::atomic<int> done{0};
    EXPECT_THROW(parallelFor(0, 100000, source.token(),
                             [&](int i) {
                                 if (i == 10) {
                                     source.cancel();
                                 }
                                 ++done;
                             }),
                 OperationCancelled);
    EXPECT_LT(done, 100000);
}

TEST(ParallelFor, CompletingBeforeACancellationIsNotAnError) {
    CancellationSource source;
    std::atomic<int> done{0};
    parallelFor(0, 100, source.token(), [&](int) { ++done; });
    source.cancel();
    EXPECT_EQ(done, 100);
}

TEST(ParallelFor, RethrowsTheBodysException) {
    EXPECT_THROW(parallelFor(0, 1000, CancellationToken{},
                             [](int i) {
                                 if (i == 500) {
                                     throw std::runtime_error("bad tile");
                                 }
                             }),
                 std::runtime_error);
}

TEST(ParallelFor, InsideAJobFollowsTheJobsCancellation) {
    Scheduler scheduler;
    CancellationSource esc; // the user pressing Esc while the loop runs
    std::atomic<int> done{0};
    auto job = scheduler.submit({.priority = Priority::Viewer, .parent = esc.token()}, [&](JobContext& context) {
        parallelFor(0, 1 << 20, context.token(), [&](int) {
            if (++done == 1000) {
                esc.cancel();
            }
        });
    });
    job.wait();
    EXPECT_EQ(job.status(), JobStatus::Cancelled);
    EXPECT_LT(done, 1 << 20);
}

} // namespace
} // namespace pf::engine
