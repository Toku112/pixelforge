# core/ — the pure model

Standard C++ and Imath only: no Qt, no GPU, no file or OS APIs, no other layer (CLAUDE.md §3.1). Everything here is
unit-testable without a window or a GPU. Subfolders as they arrive: `image/`, `graph/`, `anim/`, `commands/`,
`history/`, `actions/`, `layers/`, `selection/`, `paths/`, `text/`, `project/`.
