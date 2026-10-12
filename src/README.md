# src/ — layers

One folder per layer (CLAUDE.md §3.1). Include paths start at `src/`: `#include "core/image/Image.h"`.
A layer gets its `CMakeLists.txt` and library target (`pf_<layer>`) when its first code arrives, linking only the
layers it may use. The `layering` test (`cmake/scripts/check_layering.cmake`) enforces the include rules below.

| Folder | What lives here | May use |
|---|---|---|
| `app/` | `main()`, `Brand.h` (`APP_NAME`), service wiring, startup | everything |
| `core/` | the pure model: images, graph, animation, commands, history, actions, layers, selections, paths, text, project | C++ standard library, Imath — no Qt, no OS APIs, no other layer |
| `color/` | OpenColorIO and lcms2 wrappers, colour-space detection, display transforms | core |
| `engine/` | scheduler, caches, memory budget | core, color |
| `nodes/` | one folder per node type: CPU reference (+ GPU) implementation, parameters | core, color, engine, gpu, io — no Qt, no ui |
| `tools/` | one folder per editing tool used in the Paint/Retouch node | core, nodes, engine — no Qt, no ui |
| `gpu/` | the thin `gpu::` interface over Qt RHI (D-069), texture pool, transfers | core, Qt Gui |
| `io/` | format registry, EXR, OpenImageIO bridge, sequences, renderer presets, PSD, video | core, color |
| `ui/` | Qt Widgets: windows, menus, panels, viewer, node/layer view, timeline | everything except app |
| `ai/` | `AIProvider` and its implementations (CLAUDE.md §6) | core, engine |
| `plugins/` | OpenFX and scripting hosts (later) | core, engine, nodes |

`app/Brand.h` may be included from any layer except `core/`.
