# Test fixtures

Input files for tests: our own generated ones and renders from the owner.

## Owner renders (not in git)

Real renders are too large for the repository (hundreds of MB per sequence), so they stay on the owner's machine,
listed in `.gitignore`. How tests and CI reach them (a reduced copy in git, or tests that run only where the renders
exist) is decided with PLAN Part C item 15.

### Cycles sequence — `blender render/` (repository root), received 2026-10-13

- Blender 5.2.0 LTS, Cycles, 250 samples, ~16 s per frame; camera `PRO_Cam_Scene_1`.
- 20 frames, `render0001.exr` … `render0020.exr` (~21 MB each, 421 MB in all), 1920 × 1080, data window = display
  window, float32.
- **Multi-part EXR**, 13 parts per frame, every part scanline with **DWAA** compression (lossy for colour, lossless for
  data channels). Part names are the layer names: `Composite.Combined`, `ViewLayer.Combined`, `ViewLayer.Depth` (Z),
  `ViewLayer.Mist` (Z), `ViewLayer.Position` (X, Y, Z), `ViewLayer.Diffuse Direct`, `ViewLayer.Glossy Direct`,
  `ViewLayer.Transmission Direct`, `ViewLayer.Emission` (R, G, B), `ViewLayer.CryptoObject00/01/02` (r, g, b, a —
  lower case), `ViewLayer.Noisy Image` (RGBA).
- **Colour spaces in the header:** `colorInteropID` = `lin_rec709_scene` on colour passes, `data` on depth, mist,
  position and Cryptomatte (useful for automatic input colour spaces, item 11).
- **Cryptomatte:** manifest embedded (`cryptomatte/542cafa/…`, MurmurHash3_32, 10 names: Plane, Plane.001, Cube,
  Cube.001, Cube.002, Sphere, Sphere.001, Sun, Octane Analytic Light, object). Checked on frames 1, 5, 10, 15 and 20:
  every ID sample equals a manifest hash exactly, so the lossy compression did not touch the IDs; only
  CryptoObject00 holds IDs (one rank pair), 01 and 02 are empty.
- **Values (frame 1):** real HDR — Combined reaches ~27,000 (sun highlights), 26–43 % of pixels above 1; passes hold
  tiny negatives (down to −6·10⁻⁵, compression noise); depth is 10 to 10¹⁰ (background); no NaN or infinity.
  `Composite.Combined` equals `ViewLayer.Combined`; Combined is denoised (`Noisy Image` is the raw render).
- **Good for:** the Phase 0 exit test (open the sequence, play it with AgX, scrub, view any pass), sequences, multi-part
  reading, DWAA, metadata, Cryptomatte picking (Phase 1), position/depth/mist mattes and atmosphere (Phase 2).
- **Not enough for** rebuilding the beauty from passes (Phase 1): the indirect and colour passes (diffuse, glossy,
  transmission), volume and environment are missing, there is no light group, the beauty is denoised while the passes
  are not, and lossy compression adds small errors. A second, Phase 1 render is described in PLAN Part C item 15.
