# Image sequence timing (PLAN Part C item 10)

Throw-away code that measures the sequence code (`src/io/sequence`, docs/specs/sequences.md) and the Read node's
per-frame work. Never linked into the app. Decisions in `docs/DECISIONS.md` D-078.

`sequence_scan_bench` makes folders of 100, 1,000 and 10,000 empty frame files (`shot010_v002.####.exr`, every 50th
frame missing) next to 200 other numbered files, and times, best of several runs with the folder in the system's
cache:

- **scan the pattern**: listing the folder and keeping the pattern's frames (what the Read node does when the folder
  changed);
- **scan with stamps**: the same plus every file's size and modification time — a snapshot for live linking;
- **detect from one file**: finding the sequence of a picked file (Open, drag and drop);
- **list the folder**: all sequences and single files of a folder (a dropped folder);
- **index, unchanged folder**: asking the shared listing cache when the folder did not change (one look at the
  folder's time);
- **Read hash per frame**: hashing a Read node at every frame of the sequence, a fresh evaluation per frame, as
  playback will ask: which file shows (cached listing) and that file's stamp; and the slowest **missing frame**
  (checkerboard: the listing plus a look for the frame's usual file names).

With folders as arguments it also detects the sequence in each and hashes every frame of it.

## Build and run (macOS)

```
cmake --build --preset macos-release
cmake -S spikes/sequence-scan -B spikes/sequence-scan/build -G Ninja -DPF_BUILD_DIR=$PWD/build/macos-release -DCMAKE_PREFIX_PATH=$PWD/build/vcpkg_installed/arm64-osx-pf -DCMAKE_OSX_SYSROOT=macosx
cmake --build spikes/sequence-scan/build
spikes/sequence-scan/build/sequence_scan_bench "blender render"
```

## Results

Apple M5 Pro (18 cores, 48 GB), macOS 27, APFS on the internal SSD, release, 2026-10-13. Raw output in `results/`.

| | 100 frames | 1,000 frames | 10,000 frames |
|---|---|---|---|
| scan the pattern | 0.22 ms | 0.72 ms | 6.1 ms |
| scan with stamps (snapshot) | 0.64 ms | 5.4 ms | 56 ms |
| detect from one file | 0.23 ms | 0.75 ms | 6.2 ms |
| list the folder | 0.23 ms | 0.79 ms | 6.4 ms |
| index, unchanged folder | 0.003 ms | 0.003 ms | 0.003 ms |
| Read hash per frame | 0.009 ms | 0.009 ms | 0.010 ms |
| Read hash, missing frame | 0.010 ms | 0.011 ms | 0.010 ms |

The owner's Cycles sequence (`blender render/`, 20 frames): detected in 0.07 ms, 0.007 ms per frame to hash.

- **Playback is not slowed by sequences.** Working out which file shows at a frame costs about 10 microseconds
  whatever the sequence length (two file-system lookups: the folder's time, the frame's stamp) — 0.02 % of a frame's
  42 ms at 24 fps. Missing frames cost the same.
- **Listings are fast and rare.** Even 10,000 frames list in 6 ms, and only when the folder changed. Picking a file
  of a long render opens its sequence without a noticeable wait (and runs in the background anyway).
- **Snapshots cost one file-system call per frame** (56 ms for 10,000 frames). Live linking (Phase 1) should take
  them in the background and only when the folder's time changed or at a modest interval, not every frame.
- Network shares are slower per call; the same design (cached listings, one look per frame) keeps the count of
  calls minimal there too. To be measured when the owner has a share to test (Phase 1, live linking).
