# History cost per edit (PLAN Part C item 8)

Throw-away code that checks the History against the UI thread's budget (CLAUDE.md §3.5: never more than 16 ms per
event). Never linked into the app. Decisions in `docs/DECISIONS.md` D-076.

Every edit performs its command on a copy of the graph's node table and then compares the two tables to find the
nodes that changed, so its cost grows with the number of nodes. `history_cost_bench` builds chains of 10 to 5000
grade-like nodes (ten parameters each) through the History, then times, on a node in the middle of the chain:

- **new step**: setting a parameter as a new History step (perform, compare, record, drop the oldest step over 50);
- **drag step**: the same as part of a slider drag (merged into the current step);
- **undo + redo** of one step;
- **jump**: clicking between the first and the last of the 50 entries in the History panel.

## Build and run (macOS)

```
cmake --build --preset macos-release
cmake -S spikes/history-cost -B spikes/history-cost/build -G Ninja -DPF_BUILD_DIR=$PWD/build/macos-release -DCMAKE_PREFIX_PATH=$PWD/build/vcpkg_installed/arm64-osx-pf -DCMAKE_OSX_SYSROOT=macosx
cmake --build spikes/history-cost/build
spikes/history-cost/build/history_cost_bench
```

## Results

Apple M5 Pro (48 GB), macOS 27, release, 2026-10-13. Raw output in `results/`.

| Nodes | New step | Drag step | Undo + redo | Jump across 50 entries |
|---|---|---|---|---|
| 10 | 0.001 ms | 0.001 ms | < 0.001 ms | < 0.001 ms |
| 100 | 0.004 ms | 0.004 ms | < 0.001 ms | < 0.001 ms |
| 1000 | 0.05 ms | 0.05 ms | < 0.001 ms | 0.001 ms |
| 5000 | 0.27 ms (worst 0.34) | 0.27 ms (worst 0.34) | < 0.001 ms | 0.001 ms |

Even a 5000-node comp — far beyond any real one — uses 2 % of the 16 ms budget per edit. Undo, redo and jumps only
swap shared nodes, so they cost almost nothing whatever the graph size. No change to the design is needed; if comps
ever grow much larger, the graph can track the nodes an edit touches instead of comparing the whole table.
