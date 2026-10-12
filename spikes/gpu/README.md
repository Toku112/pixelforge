# GPU-layer spike (PLAN Part C item 2)

Throw-away code: the same measurements written twice, once on **Qt RHI** and once on **Dawn**, to choose the GPU
layer (D-066). Never linked into the app. Results and the recommendation go to `docs/specs/gpu-spike.md`.

## Measurements

| ID | What | Why it matters |
|----|------|----------------|
| B1 | Upload a 7680×4320 RGBA32F image (GB/s) | Getting EXR frames onto the GPU during playback |
| B2 | Read the same image back (GB/s) | Render queue, export, CPU-side nodes |
| B3 | A 16384×16384 RGBA32F image as 16 tiles of 4096² (and the largest single texture) | Huge stills |
| B4 | Compute: per-pixel grade on 3840×2160 RGBA32F (ms) | Every grade/merge node |
| B5 | Compute: separable Gaussian, radius 64 (129 taps), 3840×2160 RGBA32F (ms per pass) | Blur-type nodes, a heavy texture-read load |
| B6 | Linear filtering of float32 textures (supported?) | Transforms, distortion, viewer zoom |
| B7 | OpenColorIO display transform (Blender AgX) as a GPU shader vs OCIO's CPU result (max error) | The viewer's colour route |
| B8 | EDR/HDR window output on the Mac (values > 1.0 brighter than white) | HDR viewer |
| B9 | 8K readback while a window renders at display rate (worst frame time) | UI must not stall |

## Build (macOS)

```
cmake -S spikes/gpu -B spikes/gpu/build/cmake -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH=$HOME/Qt/6.11.3/macos \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=arm64-osx
cmake --build spikes/gpu/build/cmake
spikes/gpu/build/cmake/rhi_bench      # B1–B7, prints a table
spikes/gpu/build/cmake/dawn_bench
spikes/gpu/build/cmake/rhi_window     # B8, B9 (opens a window)
spikes/gpu/build/cmake/dawn_window
```

The Dawn package is built from `overlay-ports/dawn` (upstream port + Tint's SPIR-V reader enabled on macOS, needed
for B7).
