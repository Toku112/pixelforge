# GPU-layer spike: Qt RHI vs Dawn

PLAN Part C item 2, decision D-066. Code in `spikes/gpu/` (throw-away, never linked into the app); raw output of the
final runs in `spikes/gpu/results/`.

## Recommendation (in plain words)

**Use Qt RHI**, behind our own thin `gpu::` layer, with one planned addition: a fast "transfer" path for moving
frames between the computer's memory and the GPU, which we can add later per platform if playback of very large
frames needs it.

Why, in one example each:

- **Colour is right and fast with RHI out of the box.** The colour library (OCIO) writes its shaders in exactly the
  language RHI reads. Blender's AgX and ACES 2.0 views ran on the GPU in under 1 ms per 4K frame and matched OCIO's
  own CPU result to 0.00002. With Dawn the same shaders first had to be rewritten by our own code, and then ACES 2.0
  took **565–700 ms per frame** — about 600 times slower, too slow for a viewer.
- **HDR on your MacBook works with RHI by design.** Both showed brighter-than-white (EDR, ~11× headroom on your
  screen), but Dawn officially rejects HDR on macOS; it only worked because we reached around it.
- **RHI is already inside Qt.** Dawn added a 7.4-minute build, a 33 MB library, a second shader compiler (glslang)
  and its own window plumbing (Qt's window layer could not be used directly).
- **Dawn's one clear win** is moving whole frames between memory and GPU: with a reused buffer, 15–17 ms for an 8K
  float frame against RHI's ~65 ms. For the Phase 0 goal (1080p playback: a 1080p float frame is 16× smaller, about
  4 ms with RHI) this does not matter; for 4K–8K multi-pass playback it might, which is what the transfer path
  above is for.

What RHI asks of us: it is a "semi-public" part of Qt, tied to the exact Qt version we ship (fine — we bundle Qt and
pin it); reading frames back must happen on a background GPU connection, not the window's (or the window stalls
~80 ms per 8K frame — the same is true for Dawn); and every sampler setting must be set explicitly (RHI's default
for the third texture axis is "repeat", which caused 0.002% wrong pixels in our first AgX test until fixed).

**The GPL-3 question goes away:** RHI's shaders can be compiled while the app runs by the LGPL part of Qt Shader
Tools (8–60 ms per shader, cacheable), so the GPL-3 `qsb` tool is not needed.

Still to do before the decision is final: run the same programs on the Windows/NVIDIA machine (RHI uses D3D12 or
Vulkan there). The spike code is portable except `dawn/dawn_window.mm`.

## How it was measured

- Machine: MacBook Pro, **Apple M5 Pro**, 48 GB, macOS 26.3.1, Xcode 26.6, built-in XDR display. Metal backend for
  both candidates.
- Versions: **Qt 6.11.3** (QRhi + Qt Shader Tools runtime); **Dawn 2026-09-11** from vcpkg, built with Tint's SPIR-V
  reader enabled (overlay port); OpenColorIO 2.6.0; glslang (Dawn's OCIO route only).
- The same work is written twice, test for test (`rhi/rhi_bench.cpp` ↔ `dawn/dawn_bench.cpp`,
  `rhi/rhi_window.cpp` ↔ `dawn/dawn_window.mm`), on the same images and kernels, checked against the same CPU
  references (`common/`).
- Test images: scene-linear RGBA32F, HDR values up to ~8, negatives, render-like noise. (A perfectly smooth image is
  squeezed by Apple GPUs' lossless texture compression and makes memory look faster than it is — the first run
  showed that.)
- Compute times subtract the fixed cost of a frame: (best of 3 × N iterations − best of 3 × 1 iteration) / (N − 1).
  They compare the two layers on the same GPU; they are not peak figures. Each benchmark ran twice back to back on a
  quiet machine; ranges are shown where runs differed.

## Results

| ID | Test | Qt RHI | Dawn |
|----|------|--------|------|
| B1 | Upload 8K RGBA32F (531 MB) | 65–67 ms (8 GB/s) | 64–70 ms (8 GB/s); **15–17 ms (31–36 GB/s) with a reused mapped staging buffer** — RHI has no equivalent |
| B2 | Read back the same | 68–72 ms (7.5 GB/s), bit-exact | 69–80 ms; **15–16 ms (33–36 GB/s) with a reused buffer**; bit-exact |
| B3 | 16384² RGBA32F as 16 tiles (4.3 GB) | 606–620 ms (7 GB/s) | 453–508 ms (8.5–9.5 GB/s) |
| B3 | Single 16384² RGBA32F texture | created | created |
| B4 | Grade, 4K RGBA32F | 0.57–0.62 ms | 0.56–0.58 ms |
| B5 | Gaussian r = 64 (129 taps), 4K, per pass | 10.7–13.1 ms | 10.6–15.2 ms (robustness off: 15.7 — within noise) |
| B6 | Linear filtering of float32 textures | yes | yes (feature `float32-filterable`) |
| B7 | OCIO sRGB / **AgX**, 4K vs OCIO CPU | max error 2.1e-5; 0.67–0.82 ms | max error 2.1e-5; 0.67–0.76 ms (after rewriting OCIO's shader) |
| B7 | OCIO sRGB / **ACES 2.0**, 4K vs OCIO CPU | max error 8.4e-6; **0.92–1.17 ms** | max error 8.4e-6; **565–701 ms** |
| B7 | Shader preparation | runtime bake 8–58 ms | glslang 14–67 ms + Tint/pipeline 6–533 ms (first build of a pipeline is the slow one) |
| B8 | HDR/EDR window | supported format `HDRExtendedDisplayP3Linear`; headroom reported by RHI (11.43 of 16) | Dawn rejects its HDR option on macOS; worked only by setting EDR on our own `CAMetalLayer` by hand; headroom only via `NSScreen` |
| B9 | Frame interval while idle (display 60 Hz) | 16.4 ms avg, 20 ms worst | 16.7 ms avg, 20 ms worst |
| B9 | 8K readback on the window's own GPU connection | 81 ms stall (RHI copies the data inside the frame) | 70 ms stall (our copy out of mapped memory; with Dawn we could hand the pointer to a worker instead) |
| B9 | 8K upload+readback on a worker thread while the window renders | no stall (worst 21 ms); 129 ms per round trip | no stall (worst 22 ms); 128 ms per round trip |

## Integration findings

**Qt RHI**
- Headers come with the `Qt6::GuiPrivate` target; Qt warns at configure time that the program is tied to that exact
  Qt build. We ship and pin Qt anyway (D-068), so this is a maintenance note: every Qt upgrade is tested.
- Shaders: one Vulkan-style GLSL source, baked at run time by `QShaderBaker` (LGPL runtime) for SPIR-V, MSL and HLSL.
  OCIO's `GPU_LANGUAGE_GLSL_VK_4_6` output plugs in unchanged, including its combined samplers and constant tables.
- Readbacks are copied into a `QByteArray` inside the frame; do them on a separate offscreen `QRhi` on a worker
  thread (tested: no window stall).
- No buffer→texture copy and no persistently mapped staging buffers. Escape hatch if 4K+/8K playback needs faster
  transfers: QRhi exposes native handles (`QRhiTexture::nativeTexture()` / `createFrom()`), so a small per-backend
  transfer module (Metal blit from a shared buffer, D3D12/Vulkan upload heaps) can be added behind `gpu::` without
  touching the rest.
- Pitfall found: `newSampler()`'s third address mode defaults to Repeat. Our `gpu::` layer will always set all three.

**Dawn**
- Build: 7.4 min for Dawn on an M5 Pro (debug + release) plus abseil; 33 MB static library; on Windows it also pulls
  DirectX Shader Compiler. Not versioned in releases (date-stamped snapshots); the `webgpu.h` API is still moving.
- OCIO does not generate WGSL. Route used: OCIO Vulkan GLSL → glslang → SPIR-V → Tint. The upstream vcpkg port builds
  Tint's SPIR-V reader only with the Vulkan backend, so an overlay port was needed on macOS. Tint renumbers bindings
  when it splits GLSL's combined texture+sampler, so OCIO's shader text had to be rewritten with regular expressions
  before compiling (`dawn/dawn_ocio.cpp`).
- **ACES 2.0 performance cliff:** OCIO's ACES 2.0 shader searches a 363-entry constant table in a loop. RHI's
  translation (SPIRV-Cross) keeps it as a constant table; Dawn's runs ~600× slower — most likely because the table is
  rebuilt per pixel. Turning off Dawn's robustness checks did not change it. A fix would mean rewriting OCIO's shader
  text further (moving tables into buffers), for every OCIO release.
- HDR: `SurfaceColorManagement` exists in the API but Dawn's native surface code rejects it ("unsupported").
- Windowing: Qt's Metal window has a container layer, which Dawn refuses; we had to add and manage our own
  `CAMetalLayer`, and would need equivalent code for Windows (HWND) and Linux (X11/Wayland).
- Strengths seen: explicit, persistently mapped staging buffers (fast transfers, zero-copy readback pointer), strict
  validation with clear error messages, explicit feature negotiation.

## Licences (spike only — nothing is shipped)

Qt 6.11.3 (LGPL-3.0, dynamically linked; Qt Shader Tools runtime LGPL-3.0); Dawn (BSD-3-Clause) with abseil
(Apache-2.0), SPIRV-Tools (Apache-2.0), SPIRV-Headers (MIT-style); glslang (BSD-3-Clause and other permissive
licences); OpenColorIO (BSD-3-Clause) with yaml-cpp (MIT), expat (MIT), pystring (BSD-3), minizip-ng (Zlib), zlib
(Zlib); OpenEXR/Imath (BSD-3-Clause), OpenJPH (BSD-2-Clause), libdeflate (MIT). The GPL-3 `qsb` tool was not used.
