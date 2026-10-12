// Job progress (engine/Progress.h).

#include "engine/Progress.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace pf::engine {
namespace {

TEST(Progress, UnknownTotalHasNoFraction) {
    Progress progress;
    progress.advance(5);
    EXPECT_FALSE(progress.fraction().has_value());
    EXPECT_EQ(progress.done(), 5U);
}

TEST(Progress, FractionIsDoneOverTotalClampedToOne) {
    Progress progress;
    progress.setTotal(8);
    EXPECT_EQ(progress.fraction(), std::optional(0.0));
    progress.advance(2);
    EXPECT_EQ(progress.fraction(), std::optional(0.25));
    progress.setDone(8);
    EXPECT_EQ(progress.fraction(), std::optional(1.0));
    progress.advance(3); // more steps than announced: still shown as complete
    EXPECT_EQ(progress.fraction(), std::optional(1.0));
}

TEST(Progress, Status) {
    Progress progress;
    EXPECT_EQ(progress.status(), "");
    progress.setStatus("Reading frame 1004");
    EXPECT_EQ(progress.status(), "Reading frame 1004");
}

TEST(Progress, StepsFromManyThreadsAddUp) {
    Progress progress;
    progress.setTotal(std::uint64_t{8} * 10000);
    std::vector<std::thread> threads;
    threads.reserve(8);
    for (int t = 0; t < 8; ++t) {
        threads.emplace_back([&progress, t] {
            for (int i = 0; i < 10000; ++i) {
                progress.advance();
                if (i % 1000 == 0) {
                    progress.setStatus("thread " + std::to_string(t));
                    (void)progress.status();
                }
            }
        });
    }
    for (std::thread& thread : threads) {
        thread.join();
    }
    EXPECT_EQ(progress.done(), 80000U);
    EXPECT_EQ(progress.fraction(), std::optional(1.0));
}

} // namespace
} // namespace pf::engine
