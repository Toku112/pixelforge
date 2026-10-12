# Tile memory measurement (PLAN Part C item 6)

Throw-away code that decides where image tiles get their memory. Never linked into the app. Follow-up of the
tile-size spike (`spikes/tile-size`), which found that fresh 256 × 256 tiles from the system allocator make a
memory-bound grade ~50 % slower. The decision and its reasons are in `docs/DECISIONS.md` D-074.

Two programs:

- `alloc_bench` imitates the tile storage and compares allocators in isolation. Every allocation happens inside the
  parallel task that fills the tile, as in the engine.
- `real_bench` runs the same kind of work on the real code (`core/image` + `engine/TilePool`), linked from a built
  main release preset.

| Allocator (`alloc_bench`) | What it is |
|---|---|
| `system` | `new float[]` — what `core/image` did before |
| `tbbmalloc` | oneTBB's scalable allocator (part of oneTBB, already a dependency) |
| `pool` / `poolSpin` | free lists per exact block size, behind a mutex / a spin lock |
| `poolFull` | only full 256 × 256 tiles are kept for reuse; smaller edge tiles use the system allocator |
| `poolTbb` | `poolFull`, but every block comes from and goes back to oneTBB's allocator — **the chosen design** |

## Build and run (macOS)

```
cmake --build --preset macos-release
cmake -S spikes/tile-alloc -B spikes/tile-alloc/build -G Ninja -DCMAKE_PREFIX_PATH=$PWD/build/vcpkg_installed/arm64-osx-pf -DPF_BUILD_DIR=$PWD/build/macos-release -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0
cmake --build spikes/tile-alloc/build
spikes/tile-alloc/build/alloc_bench poolTbb
spikes/tile-alloc/build/real_bench
```

`alloc_bench <name>` runs one allocator per process (a process's earlier allocations would distort the next one's
memory numbers); without a name it runs all of them.

## Results

Apple M5 Pro (6 + 12 cores, 48 GB), macOS 26, release, 2026-10-12. Raw output in `results/`. The machine's timings
moved by ±20 % between runs; the table shows one representative run, the conclusions hold across all runs.

| | 4K grade | refill 1.5 GB | memory kept after release | after clean-up |
|---|---|---|---|---|
| no allocation (floor) | 1.04 ms | — | — | — |
| system | 2.46 ms | 36 ms | 906 MB | 1127 MB |
| tbbmalloc | 1.55 ms | 96 ms | 1026 MB | **0 MB** |
| pool | 2.01 ms | 22 ms | 1007 MB | 1007 MB |
| poolTbb (chosen) | 1.69 ms | **20 ms** | 1463 MB (kept on purpose) | **0 MB** |

On the real code (`real_bench`, six runs): a 4K RGBA grade into a new image takes **1.15–1.21 ms with the tile pool**
against 1.52–1.92 ms with `operator new`; refilling a 1.5 GB cache 6.5–6.8 ms against 8.3–9.3 ms; 1080p is the same
within noise (0.34–0.40 ms against 0.41–0.66 ms).

What the numbers say, in short:

- **Once memory is being recycled, every allocator is about as fast** for per-frame work; the system allocator is the
  slowest and the most erratic.
- **Refilling a cache after it was emptied** (what playback does all the time) is 2× faster with a pool than with the
  system allocator, and 4–5× faster than with oneTBB's allocator alone.
- **Only oneTBB's allocator really gives memory back to macOS.** The system allocator keeps about 1 GB charged to the
  app after everything was freed, even after its "pressure relief" call; oneTBB's clean-up command brings it to 0.
  A memory budget that the user sets in Preferences must be able to give memory back, so the pool's blocks come from
  oneTBB's allocator.
- **One lock is enough.** The mutex and spin-lock pools differ by less than the noise.
- **Edge tiles need no pool:** they are a small share of the memory (16 % at 1080p, 11 % at 4K).
- **oneTBB 2023.1 bug:** its clean-up command (`TBBMALLOC_CLEAN_ALL_BUFFERS`) crashes when it runs before the
  allocator was ever used. The pool only calls it after its first allocation.
