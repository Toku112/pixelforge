# core/ — the pure model

Standard C++ and Imath only: no Qt, no GPU, no file or OS APIs, no other layer (CLAUDE.md §3.1). Everything here is
unit-testable without a window or a GPU. Subfolders as they arrive: `image/`, `graph/`, `anim/`, `json/`,
`commands/`, `history/`, `actions/`, `layers/`, `selection/`, `paths/`, `text/`, `project/`.

| Folder | What it holds |
|---|---|
| `image/` | the float image: named channels, data/display windows, 256² copy-on-write tiles, alpha and sample conversions (FORMAT_NOTES §19) |
| `anim/` | keyframe curves: Constant/Linear/Smooth/Bézier keys, extrapolation (FORMAT_NOTES §20.1); whole frames, frame ranges, hold/loop/bounce/black (FORMAT_NOTES §23.3) |
| `graph/` | parameters, node types (`NodeDef`) and their pixel interface (`NodeOp`), nodes, the graph, requests, hashing (docs/specs/node-graph.md); graph deltas and JSON forms of values (docs/specs/commands-history.md) |
| `json/` | JSON values, strict reading and stable writing (FORMAT_NOTES §21.1) |
| `commands/` | command descriptors, the command registry, the graph commands and `group` (docs/specs/commands-history.md §2–3) |
| `history/` | undo, redo, continuous edits and the History panel's model (docs/specs/commands-history.md §4–6) |
| `actions/` | recording and playing Actions, action files (docs/specs/commands-history.md §7) |
