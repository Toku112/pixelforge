# Third-party components

Every dependency, ML model, bundled OCIO config, LUT, ICC profile and font must be listed here with its licence
(CLAUDE.md §1.2). The check-licenses build target (PLAN Part C item 3) compares this file with what vcpkg installed.

**Licence policy (D-064)**

- Allowed by default: MIT, BSD-2/3-Clause, Apache-2.0, ISC, Zlib, BSL-1.0, MPL-2.0 (as a separate module).
- LGPL: dynamically linked only, owner-approved components only — Qt 6 and an LGPL build of FFmpeg.
- Anything else (GPL, AGPL, non-commercial, unknown) requires the owner's approval first, including build tools whose
  output ships.

The browser prototype's npm and Rust dependencies are listed on the branch `archive/web-prototype`.

## Shipped (runtime)

_None yet — nothing is added until Phase 0 starts._

## Planned (not yet added — each licence is verified again when it is added)

| Component | Expected licence | Purpose | Notes |
|---|---|---|---|
| Qt 6 (6.8 LTS) | LGPL-3.0 (dynamic linking) | UI, windows, RHI if chosen | Owner-approved. Some Qt modules are GPL-only — use only LGPL modules. Qt Shader Tools runtime is LGPL-3.0/GPL-2.0; its `qsb` command-line tool is GPL-3.0 (build-time; ask owner if RHI is chosen) |
| Dawn | BSD-3-Clause | GPU layer, if chosen instead of Qt RHI | Spike decides (D-066) |
| OpenEXR (≥ 3.4.14) | BSD-3-Clause | EXR read/write | Brings OpenJPH (BSD-2-Clause) for HTJ2K and libdeflate (MIT) |
| Imath | BSD-3-Clause | Half floats, vectors, matrices | |
| OpenColorIO 2.x | BSD-3-Clause | Scene colour management | Brings yaml-cpp (MIT), pystring (BSD-3), expat (MIT), minizip-ng (Zlib) |
| ACES 2.0 OCIO configs (OpenColorIO-Config-ACES) | BSD-3-Clause | Bundled config | Verify the exact config files |
| Blender-compatible AgX config | **Unknown** | Bundled config | Not bundled until confirmed (D-066) |
| OpenImageIO | Apache-2.0 (verify per version) | Non-EXR image formats | Its optional plugins pull in more libraries — each checked (libtiff, libpng, libjpeg-turbo, libwebp…) |
| Open Image Denoise | Apache-2.0 | Render denoising | |
| oneTBB | Apache-2.0 | Thread pool / tasks | |
| Little CMS 2 (lcms2) | MIT | ICC, CMYK, soft proofing | |
| HarfBuzz | MIT ("Old MIT") | Text shaping | |
| FreeType | FreeType License (BSD-style), chosen over its GPL-2.0 option | Font rasterising | |
| FFmpeg | LGPL-2.1+ (built without GPL/nonfree parts) | Video read/write | Owner-approved; dynamic linking |
| ONNX Runtime | MIT | On-device ML | Later (Phase 14) |
| OpenFX headers | BSD-3-Clause | Plugin host | Later (Phase 13) |
| LibRaw | LGPL-2.1 or CDDL-1.0 | Camera raw | **Ask owner** (Phase 12) |
| GoogleTest | BSD-3-Clause | Tests (not shipped) | |

## ML models

_None yet._

## Fonts, icons, presets, sample images, configs

_None yet. All icons, presets and sample images are created by us (CLAUDE.md §1.2)._
