# core/ — the pure model

Standard C++ and Imath only: no Qt, no GPU, no file or OS APIs, no other layer (CLAUDE.md §3.1). Everything here is
unit-testable without a window or a GPU. Subfolders as they arrive: `image/`, `graph/`, `anim/`, `commands/`,
`history/`, `actions/`, `layers/`, `selection/`, `paths/`, `text/`, `project/`.

| Folder | What it holds |
|---|---|
| `image/` | the float image: named channels, data/display windows, 256² copy-on-write tiles, alpha and sample conversions (FORMAT_NOTES §19) |
| `anim/` | keyframe curves: Constant/Linear/Smooth/Bézier keys, extrapolation (FORMAT_NOTES §20.1) |
| `graph/` | parameters, node types (`NodeDef`) and their pixel interface (`NodeOp`), nodes, the graph, requests, hashing (docs/specs/node-graph.md) |
