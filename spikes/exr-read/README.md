# EXR reading speed (PLAN Part C item 9)

Throw-away code that measures the EXR reader (`src/io/exr`, on OpenEXRCore) on the owner's Cycles render
(`blender render/`, tests/fixtures/README.md: 1920 × 1080, 13 parts, 41 channels, DWAA, float). Never linked into the
app. Decisions in `docs/DECISIONS.md` D-077.

`exr_read_bench` times, best of several runs with the file in the system's cache:

- **open**: reading and checking the header, building the description and the metadata (no pixels);
- reading the **beauty** (`ViewLayer.Combined`, RGBA), the **depth** pass (one channel), the **position** pass (XYZ)
  and **everything**, each on one thread and spread over all cores with oneTBB (as the Read node does through the
  engine), next to OpenEXR's own high-level reader with its thread pool on all cores;
- a **sequence**: opening every frame given and reading its beauty, as filling the playback cache will.

## Build and run (macOS)

```
cmake --build --preset macos-release
cmake -S spikes/exr-read -B spikes/exr-read/build -G Ninja -DPF_BUILD_DIR=$PWD/build/macos-release -DCMAKE_PREFIX_PATH=$PWD/build/vcpkg_installed/arm64-osx-pf -DCMAKE_OSX_SYSROOT=macosx
cmake --build spikes/exr-read/build
spikes/exr-read/build/exr_read_bench "blender render/render0001.exr" "blender render/"render00*.exr
```

## Results

Apple M5 Pro (18 cores, 48 GB), macOS 27, release, 2026-10-13. Raw output in `results/`.

| Read | Ours, 1 thread | Ours, all cores | OpenEXR's reader, all cores |
|---|---|---|---|
| open (header only) | 0.17 ms | — | — |
| beauty (RGBA) | 24 ms | 2.0 ms | 2.1 ms |
| depth (1 channel) | 7.8 ms | 0.6 ms | 0.9 ms |
| position (XYZ) | 34 ms | 2.3 ms | 2.6 ms |
| everything (41 channels) | 246 ms | 16 ms | 21 ms |

Sequence: open + beauty of 21 frames (frame 1 twice), **3.5 ms per frame (285 frames per second)**.

- A 1080p beauty pass decodes in 2 ms, far inside the 100 ms budget for interactive previews (CLAUDE.md §5) and the
  42 ms a frame has at 24 fps; playback-cache filling (item 14) is not limited by decoding.
- Lazy reading pays: one pass costs a tenth of the whole file (depth 0.6 ms against 16 ms for everything).
- Spreading chunks over cores scales about 12× on 18 cores, and the reader matches or beats OpenEXR's own threaded
  reader without needing its separate thread pool (everything runs on the engine's oneTBB threads, D-074).
