# Tile-size measurement (PLAN Part C item 5)

Throw-away code that picks the tile size of `core/image` by measurement. Never linked into the app. The decision and
its reasons are in `docs/DECISIONS.md` D-073.

The storage mirrors the design of `core/image`: one float plane per channel, square tiles on a grid aligned to pixel
(0, 0), edge tiles clipped to the data window, one oneTBB task per (tile, channel). Each tile size (64, 128, 256,
512) runs the same work:

| Column | What | Why it matters |
|---|---|---|
| `grade4K`, `grade1080` | `out = in · gain + lift` on a 3840×2160 / 1920×1080 RGBA image, into new tiles | Every grade or merge node; memory-bound, so tile overhead shows most |
| `noAlloc` | the same 4K grade into existing tiles | Separates the memory allocator from the tiling |
| `1thr4K` | the 4K grade on one thread | Per-tile overhead without the scheduler |
| `gauss4`, `gauss32` | separable Gaussian, radius 4 and 32, each output tile from a padded copy of its neighbours | Blur-type nodes: the padding costs more with small tiles |
| `viewCopy` | a 1920×1080 window at (517, 233) copied to an interleaved RGBA buffer | The viewer's GPU upload |
| `ingest` | interleaved 4K RGBA scanlines (a decoder's output) split into tiles | EXR reading |
| `roiMs`, `roiWaste` | grade of a 480×270 window (viewer zoomed in): time per window, pixels computed / pixels asked for | Work wasted at the tile edges when only part of the image is needed |
| `undo/paint` | undo bytes when whole tiles are stored, / bytes of the pixels a 60 px brush stroke really changed | Paint undo size if undo kept whole tiles |

## Build and run (macOS)

Uses the oneTBB that the main build installed (configure the main build once first):

```
cmake -S spikes/tile-size -B spikes/tile-size/build -G Ninja -DCMAKE_PREFIX_PATH=$PWD/build/vcpkg_installed/arm64-osx-pf
cmake --build spikes/tile-size/build
spikes/tile-size/build/tile_bench
```

## Results

`results/tile_bench_m5pro.txt`: Apple M5 Pro (6 + 12 cores, 48 GB), macOS 26, Apple clang, release build,
2026-10-12.

| tile | grade4K | noAlloc | gauss4 | gauss32 | roiWaste | undo/paint |
|---|---|---|---|---|---|---|
| 64 | 1.93 ms | 1.09 ms | 20.0 ms | 148 ms | 1.39× | 2.6× |
| 128 | 2.75 ms | 1.06 ms | 9.6 ms | 118 ms | 1.85× | 4.0× |
| **256** | 1.59 ms | 1.03 ms | **5.9 ms** | **103 ms** | 2.95× | 7.4× |
| 512 | 1.25 ms | 1.06 ms | 6.7 ms | 101 ms | 5.49× | 15.5× |

What the numbers say, in short:

- **Point operations do not care** about the tile size: with the allocation taken out (`noAlloc`) every size takes
  ~1.05 ms for a 4K RGBA grade. The differences in `grade4K` come from the system allocator (128² tiles are 64 KB
  blocks, which macOS hands out more slowly), so the engine needs a tile pool or a faster allocator either way.
- **Neighbourhood operations prefer big tiles:** each tile must copy a border from its neighbours. Small blurs are
  1.6× faster with 256 than with 128 and 3.4× faster than with 64; 512 adds nothing over 256.
- **Partial requests prefer small tiles:** a zoomed-in viewer computes ~3× the pixels it shows with 256, ~1.9× with
  128. In time this is small (0.11 ms per window for a grade) and only matters for very heavy nodes.
- **Undo** would store 7.4× the changed pixels with whole 256² tiles. Paint undo will store only the changed part of
  each tile (decided with the Paint/Retouch node, Phase 3), which makes this independent of the tile size.

Recommendation, taken in D-073: **256 × 256**.
