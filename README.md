# PixelForge

A native desktop compositor for multi-layer OpenEXR render passes (stills and animations), with a full
Photoshop-equivalent toolset for painting, retouching and selections. Working title — the name lives in
`src/app/Brand.h`.

- How we work: [CLAUDE.md](CLAUDE.md)
- What we build and current status: [PLAN.md](PLAN.md)
- Decisions, format notes, known gaps, third-party licences: [docs/](docs/)

**Status:** Phase 0 (Foundation) has not started; there is no code on `main` yet. The earlier browser prototype is on
the branch `archive/web-prototype`.

## Platforms

macOS 14+ on Apple Silicon (primary), Windows 10/11 x64, Linux x64.

## Requirements and commands

Set up in Phase 0 (PLAN Part C items 1 and 3): C++20 compiler (Xcode / Visual Studio 2022 / GCC or Clang), CMake,
Ninja, vcpkg and Qt 6. The commands are listed in CLAUDE.md §9 once they exist.
