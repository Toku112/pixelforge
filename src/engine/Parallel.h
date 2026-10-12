#pragma once

// Parallel loops for work inside a job (Scheduler.h). They run on the threads of the job's arena, so they keep the
// job's priority, and they stop early when the job is cancelled.

#include "engine/Cancellation.h"

#include <tbb/blocked_range.h>
#include <tbb/parallel_for.h>
#include <tbb/task_group.h>

#include <atomic>

namespace pf::engine {

// Calls body(i) for every i in [begin, end), in parallel and in no particular order. Once `token` is cancelled, no
// new items start; if any item was skipped that way, OperationCancelled is thrown after the running ones finished.
// An exception thrown by body stops the loop the same way and is rethrown here.
template <class Index, class Body>
void parallelFor(Index begin, Index end, const CancellationToken& token, const Body& body) {
    if (!(begin < end)) {
        return;
    }
    tbb::task_group_context context;
    std::atomic<bool> skipped{false};
    tbb::parallel_for(
        tbb::blocked_range<Index>(begin, end),
        [&](const tbb::blocked_range<Index>& range) {
            for (Index i = range.begin(); i != range.end(); ++i) {
                if (token.isCancelled()) {
                    skipped.store(true, std::memory_order_relaxed);
                    context.cancel_group_execution(); // ranges not started yet are dropped
                    return;
                }
                body(i);
            }
        },
        context);
    if (skipped.load(std::memory_order_relaxed)) {
        throw OperationCancelled();
    }
}

} // namespace pf::engine
