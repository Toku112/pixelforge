# PixelForge

A browser-based professional raster image editor (working title — the name lives in `src/app/brand.ts`).

- How we work: [CLAUDE.md](CLAUDE.md)
- What we build and current status: [PLAN.md](PLAN.md)
- Decisions, format notes, known gaps, third-party licences: [docs/](docs/)

## Requirements

Node.js ≥ 22.12, pnpm, Rust (via rustup) with the `wasm32-unknown-unknown` target, wasm-pack.

## Commands

| Command            | What it does                           |
| ------------------ | -------------------------------------- |
| `pnpm install`     | Install dependencies                   |
| `pnpm dev`         | Start the app at http://localhost:5173 |
| `pnpm build`       | Production build                       |
| `pnpm typecheck`   | TypeScript checks                      |
| `pnpm lint`        | ESLint + Prettier checks               |
| `pnpm test`        | Unit and golden-image tests            |
| `pnpm test:golden` | Golden-image tests only                |
| `pnpm test:e2e`    | Browser end-to-end tests               |
