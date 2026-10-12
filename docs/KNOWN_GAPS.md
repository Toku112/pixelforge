# Known gaps

Things that are impossible, not yet possible, or deliberately not replicated, with the closest alternative we
implement instead (CLAUDE.md §4 "When you are unsure"). The browser prototype's gaps (reserved browser shortcuts, OPFS
in private windows, Safari encoders…) no longer apply; they remain on the branch `archive/web-prototype`.

| Area | Gap | Alternative / status |
|---|---|---|
| 3D | The reference app removed its 3D feature set; we do not implement 3D editing. | None for Photoshop's 3D. Compositing-side 3D (camera projection, deep compositing) is in PLAN B0.10. |
| Photoshop plug-ins (8BF) | Hosting Photoshop's binary plug-in format is not planned (its SDK terms and API surface are the vendor's). | OpenFX host and our own C++ plugin API (PLAN B19). |
| Cloud services | Vendor stock photos, fonts, cloud documents, boards and social-portfolio services are not replicated. | Local project files, local asset library; open font sources only with owner approval (PLAN B24). |
| H.264 / H.265 software encoders | The common open encoders (x264, x265) are GPL; our FFmpeg build is LGPL only (D-064). | Hardware/OS encoders: VideoToolbox on macOS, Media Foundation on Windows, VA-API on Linux; OpenH264 (BSD) as an H.264 software fallback if the owner approves. Distributing H.264/H.265 may need patent licences — owner to decide before release. |
| NVIDIA-only acceleration | CUDA/OptiX features (e.g. the OptiX denoiser) are not used. | Open Image Denoise on CPU and GPU, our GPU layer for everything else; optional CUDA/OptiX later, never required. |
| Blender AgX config (temporary) | Its licence is not confirmed, so it is not bundled yet (D-066). | Use the config from the user's own Blender install, or our own AgX-style config; ACES 2.0 is bundled. |
| OS-reserved shortcuts on macOS | macOS keeps Cmd+Space (Spotlight), Cmd+Tab, Cmd+H/M (hide/minimise; the app can claim Cmd+H only by replacing Hide) for itself. | Photoshop-compatible alternates documented in the Keyboard Shortcuts editor; Zoom via Z, Option+wheel or pinch. |
