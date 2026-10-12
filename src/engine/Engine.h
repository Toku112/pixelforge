#pragma once

// The engine services the app creates once at startup (CLAUDE.md §3.4–3.5, PLAN Part C items 6–7): the job
// scheduler, the memory budget, the tile pool and the node graph evaluator with its caches. Creating an Engine installs
// the process-wide tile pool as the memory of every image tile; the budget measures usage as the bytes of tiles in use.
//
// stats() gathers what the status bar shows; it is cheap and may be polled from the UI thread.

#include "engine/Evaluator.h"
#include "engine/MemoryBudget.h"
#include "engine/Scheduler.h"
#include "engine/TilePool.h"

#include <cstddef>

namespace pf::engine {

struct EngineOptions {
    std::size_t memoryLimit = MemoryBudget::defaultLimit();
};

struct EngineStats {
    MemoryBudgetStats memory;
    TilePoolStats tiles;
    SchedulerStats jobs;
    EvaluatorStats evaluation;
};

class Engine {
public:
    // Kept free tile blocks may use up to this share of the memory limit on top of it (TilePool).
    static constexpr std::size_t retainDivisor = 16;

    explicit Engine(const EngineOptions& options = {});
    // Cancels and waits for every job (Scheduler::~Scheduler).
    ~Engine();
    Engine(const Engine&) = delete;
    Engine(Engine&&) = delete;
    Engine& operator=(const Engine&) = delete;
    Engine& operator=(Engine&&) = delete;

    [[nodiscard]] Scheduler& scheduler() { return m_scheduler; }
    [[nodiscard]] MemoryBudget& memory() { return m_memory; }
    [[nodiscard]] TilePool& tilePool() { return m_tilePool; }
    [[nodiscard]] Evaluator& evaluator() { return m_evaluator; }

    // Preferences > Performance: sets the budget (evicting at once when lowered) and the pool's retain limit, and
    // gives memory back to the system when the limit went down.
    void setMemoryLimit(std::size_t bytes);
    // Gives every kept tile block back to the system (Edit > Purge).
    void releaseUnusedMemory();

    [[nodiscard]] EngineStats stats() const;

private:
    TilePool& m_tilePool;
    MemoryBudget m_memory;
    Evaluator m_evaluator; // its caches register with m_memory
    Scheduler m_scheduler; // last: destroyed first, so no job runs while the rest goes away
};

} // namespace pf::engine
