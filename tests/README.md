# tests/

Run everything with `ctest --preset <preset>`. Every test carries one label; select a kind with `-L unit`,
`-L golden` or `-L integration` (CLAUDE.md §4). GoogleTest tests are named `<program>.<Suite>.<Test>`, so
`ctest --preset macos-debug -R GoldenCompare` runs one suite.

| Folder | What lives there | Label |
|---|---|---|
| `unit/` | GoogleTest tests of maths and models; the `layering` and `license_policy` checks | `unit` |
| `golden/<feature>/` | golden-image tests and their expected images (`<case>.expected.exr`) | `golden` |
| `integration/` | the app itself, run headless (`app_startup`: starts, shows its window, quits) | `integration` |
| `support/` | test-only libraries: the golden-image harness (`support/golden/`); the node bench (`support/nodes/`: a `.pftest` image format of the tests' own, a temporary folder, built-in node types and an evaluator); graph test types (`support/graph/`: node types with every kind of parameter, the built-in commands, graph comparison by node name); EXR test files (`support/exr/`: files of any layout written with OpenEXR's own library, a fixed pixel pattern to check against, a thread pool for concurrency tests) | — |
| `fixtures/` | input files: our own generated ones (`fixtures/exr/`: lossy-compression inputs of the EXR golden tests) and owner-provided renders (not in git) | — |

A new GoogleTest program is one line in a `CMakeLists.txt` (helper in `cmake/PfTesting.cmake`):

```cmake
pf_add_gtest(pf_test_exposure LABEL golden SOURCES ExposureGoldenTest.cpp LIBRARIES pf_nodes pf_test_golden)
```

## Golden-image tests

```cpp
#include "support/golden/Golden.h"

TEST(Exposure, HdrRamp) {
    EXPECT_TRUE(pf::golden::matchesGolden(result, "exposure/hdr_ramp"));
}
```

`result` is a `pf::golden::Image` (named float channels, data window, display window — as in EXR). It is compared
with `tests/golden/exposure/hdr_ramp.expected.exr`:

- **Float mode** (default, scene-linear data): every channel, every sample. A sample passes when the difference is at
  most 1e-4, or 1e-4 × the expected value above 1. NaN and infinity fail unless the test allows matching ones
  (`NonFinite::MustMatch`). Tolerances can be set per channel (`CompareOptions::channelTolerances`).
- **ΔE mode** (`CompareMode::DeltaE`, display-referred 8/16-bit results): R, G, B and A are compared by visible
  colour difference (CIEDE2000): average ≤ 1.0 and worst pixel ≤ 3.0. Other channels use float mode.
- Both images must have the same display window, data window and channel names.

The rules and the colour maths are in `docs/FORMAT_NOTES.md` §18.

**When a golden test fails**, its message says what differs and where, and two files appear in the build folder:
`build/<preset>/golden-output/<feature>/<case>.actual.exr` (what the code produced) and `<case>.diff.exr` (the
difference per channel, plus `golden.failed` = 1 on failing pixels). Open them in any EXR viewer. They disappear once
the test passes again.

**When a change of the expected image is intended** (or a new test has no expected image yet): review the actual
image first, then

```
cmake --build --preset macos-debug --target update-golden
```

re-runs the golden tests and rewrites the expected image of every test that failed or had none (expected images
that still match are left alone). For one test only: `PF_GOLDEN_UPDATE=1 ctest --preset macos-debug -R <name>`.
`git status` then lists the rewritten files; commit them with the change that caused them. Where the owner provides
real reference output (an image-editor export, a renderer's beauty pass), that file becomes the expected image.

## Continuous integration

`.github/workflows/ci.yml` builds and tests every push and pull request on macOS (Apple Silicon), Windows and Linux,
debug (with sanitizers) and release, and runs the licence check; macOS also runs `format-check` and `tidy`. When a
golden test fails there, its `golden-output` folder is attached to the run as a download.
