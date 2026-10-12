# engine/ — evaluation services

Everything slow runs here, never on the UI thread (CLAUDE.md §3.4–3.5, D-074). Uses `core/` and oneTBB; no Qt.

| File | What it does |
|---|---|
| `Scheduler.h` | Jobs on oneTBB worker threads with priorities (viewer > caching > render), results, progress, listing for the UI, thread rules (the UI thread and jobs never wait for jobs) |
| `Parallel.h` | `parallelFor` for work inside a job: keeps the job's priority, stops when cancelled |
| `Cancellation.h` | Cancellation sources and tokens, chainable (closing a document cancels its renders) |
| `Progress.h` | Progress of one job, written by the work, polled by the UI |
| `MemoryBudget.h` | The memory limit (default 60 % of RAM) and least-recently-used eviction across all caches |
| `LruCache.h` | A thread-safe cache of shared values under the budget (node results, frames) |
| `TilePool.h` | Memory for image tiles: reuses full tiles, returns memory to the system on request |
| `SystemMemory.h` | Installed physical memory |
| `Engine.h` | The services the app creates once at startup, and their statistics for the status bar |

Still to come here: the node result cache and evaluation (Part C item 7), the RAM frame cache and prefetching
(item 14), the disk cache (Phase 4).
