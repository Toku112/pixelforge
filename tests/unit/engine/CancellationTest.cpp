// Cancellation tokens and sources (engine/Cancellation.h).

#include "engine/Cancellation.h"

#include <gtest/gtest.h>

#include <atomic>
#include <thread>

namespace pf::engine {
namespace {

TEST(Cancellation, DefaultTokenIsNeverCancelled) {
    const CancellationToken token;
    EXPECT_FALSE(token.canBeCancelled());
    EXPECT_FALSE(token.isCancelled());
    EXPECT_NO_THROW(token.throwIfCancelled());
}

TEST(Cancellation, SourceCancelsEveryTokenItHandedOut) {
    CancellationSource source;
    const CancellationToken before = source.token();
    EXPECT_TRUE(before.canBeCancelled());
    EXPECT_FALSE(before.isCancelled());
    source.cancel();
    const CancellationToken after = source.token();
    EXPECT_TRUE(source.isCancelled());
    EXPECT_TRUE(before.isCancelled());
    EXPECT_TRUE(after.isCancelled());
    EXPECT_THROW(before.throwIfCancelled(), OperationCancelled);
    source.cancel(); // cancelling twice is harmless
    EXPECT_TRUE(before.isCancelled());
}

TEST(Cancellation, ParentCancelsChildrenButNotTheOtherWayRound) {
    CancellationSource document;
    const CancellationSource render(document.token());
    CancellationSource frame(render.token());
    const CancellationSource otherFrame(render.token());

    frame.cancel();
    EXPECT_TRUE(frame.isCancelled());
    EXPECT_FALSE(otherFrame.isCancelled());
    EXPECT_FALSE(render.isCancelled());
    EXPECT_FALSE(document.isCancelled());

    document.cancel();
    EXPECT_TRUE(render.isCancelled());
    EXPECT_TRUE(otherFrame.token().isCancelled());
}

TEST(Cancellation, ChildOfANeverCancelledTokenCanStillBeCancelled) {
    CancellationSource source{CancellationToken{}};
    EXPECT_FALSE(source.isCancelled());
    source.cancel();
    EXPECT_TRUE(source.token().isCancelled());
}

TEST(Cancellation, OtherThreadsSeeTheCancellation) {
    CancellationSource source;
    std::atomic<bool> started{false};
    std::thread worker([token = source.token(), &started] {
        started = true;
        while (!token.isCancelled()) {
            std::this_thread::yield();
        }
    });
    while (!started) {
        std::this_thread::yield();
    }
    source.cancel();
    worker.join(); // returns only because the worker saw the flag
    SUCCEED();
}

} // namespace
} // namespace pf::engine
