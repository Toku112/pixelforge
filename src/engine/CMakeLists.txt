# engine/ — evaluation services (CLAUDE.md §3.4–3.5): job scheduler, cancellation, progress, memory budget, caches,
# tile memory. Uses core and oneTBB; no Qt.

find_package(TBB CONFIG REQUIRED)

add_library(pf_engine STATIC
    Cancellation.cpp
    Engine.cpp
    Evaluator.cpp
    MemoryBudget.cpp
    Progress.cpp
    Scheduler.cpp
    SystemMemory.cpp
    TilePool.cpp)
pf_target_defaults(pf_engine)
set_target_properties(pf_engine PROPERTIES AUTOMOC OFF)
# Public: Parallel.h is a template over oneTBB's algorithms.
target_link_libraries(pf_engine PUBLIC pf_core TBB::tbb PRIVATE TBB::tbbmalloc)
