# Node evaluation timing (PLAN Part C item 7)

Throw-away code that checks the node graph core against the Definition of Done's speed rule (CLAUDE.md §5: a live
parameter change previews in under 100 ms at 1080p). Never linked into the app. Decisions in `docs/DECISIONS.md`
D-075.

`node_eval_bench` builds the graph Read → Shuffle (picks the diffuse pass) → 5 × Exposure → Viewer over a render-like
frame of 14 channels (RGBA, diffuse, glossy, emission, depth) held in memory behind a fake image format — file reading
is measured with OpenEXR in item 9 — and times what the viewer will ask for: the RGBA layer of the whole frame. It
uses the real engine (tile pool, memory budget at 60 % of RAM) and the real node code.

## Build and run (macOS)

```
cmake --build --preset macos-release
cmake -S spikes/node-eval -B spikes/node-eval/build -G Ninja -DPF_BUILD_DIR=$PWD/build/macos-release -DCMAKE_PREFIX_PATH=$PWD/build/vcpkg_installed/arm64-osx-pf -DCMAKE_OSX_SYSROOT=macosx
cmake --build spikes/node-eval/build
spikes/node-eval/build/node_eval_bench
```

## Results

Apple M5 Pro (6 + 12 cores, 48 GB), macOS 26, release, 2026-10-12. Raw output in `results/`.

| Case | 1080p median (worst) | 4K median (worst) |
|---|---|---|
| First view, nothing cached (read + shuffle + 5 exposures) | 10.4 ms | 31.4 ms |
| Same view again (everything from the cache) | 0.01 ms | 0.02 ms |
| Drag the last Exposure slider (1 node recomputed) | 2.0 ms (2.0) | 6.6 ms (7.1) |
| Drag the first Exposure slider (5 nodes recomputed) | 9.8 ms (10.3) | 35.5 ms (40.2) |
| The same at proxy 2 | 4.4 ms (5.5) | 9.3 ms (12.2) |
| Alternate two passes and move the last slider | 2.0 ms (10.0) | 6.5 ms (32.9) |

- **The 100 ms rule holds with a wide margin:** 2–10 ms at 1080p, and 4K stays under 41 ms. A cache hit costs
  microseconds, so redrawing an unchanged frame is free.
- **Memory:** every node's result is cached, so every slider position leaves its results behind: 50 slider steps at
  4K put ~30 GB of tiles in the cache before the least-recently-used ones were evicted at the budget (28.8 GB on this
  machine). That is the design (bounded by the budget, oldest first), but intermediate results must not push out
  playback frames: item 14 gives the frame cache priority over node results (D-075).
- One run varied by about ±10 % from the next; the worst cases are the first steps after the cache filled up
  (page faults for fresh memory).
