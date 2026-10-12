# PixelForge

A native desktop compositor for multi-layer OpenEXR render passes (stills and animations), with a full
Photoshop-equivalent toolset for painting, retouching and selections. Working title — the name lives in
`src/app/Brand.h`.

- How we work: [CLAUDE.md](CLAUDE.md)
- What we build and current status: [PLAN.md](PLAN.md)
- Decisions, format notes, known gaps, third-party licences: [docs/](docs/)

**Status:** Phase 0 (Foundation): the build skeleton exists (an empty main window); the compositor is being built.
The earlier browser prototype is on the branch `archive/web-prototype`.

## Platforms

macOS 14+ on Apple Silicon (primary), Windows 10/11 x64, Linux x64.

## Requirements and commands

Toolchain (PLAN Part C item 1), versions used on the reference Mac (Apple M5 Pro, macOS 26.3):

| Tool | Version | Install |
|---|---|---|
| Xcode (with Metal tools) | 26.6 | App Store |
| CMake | 4.4.4 | `brew install cmake` |
| Ninja | 1.13.2 | `brew install ninja` |
| vcpkg | tool 2026-09-26 | cloned to `~/vcpkg`, `VCPKG_ROOT` set in `~/.zshrc`, metrics off |
| aqtinstall | 3.3.0 | `brew install aqtinstall` |
| Qt | 6.11.3 (+ Qt Shader Tools) | `aqt install-qt mac desktop 6.11.3 clang_64 -m qtshadertools -O ~/Qt` |
| clang-format | 21 (Apple, in Xcode 26.6) | comes with Xcode |
| clang-tidy | 21 | `brew install llvm@21` |

Windows (Visual Studio 2022 Build Tools) and Linux set-up come later in Phase 0.

Build and run on the Mac (all commands: CLAUDE.md §9):

```
cmake --preset macos-debug
cmake --build --preset macos-debug --target run
```
