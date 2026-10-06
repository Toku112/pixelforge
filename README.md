# PixelForge

A browser-based professional raster image editor (working title — the name lives in `src/app/brand.ts`).

- How we work: [CLAUDE.md](CLAUDE.md)
- What we build and current status: [PLAN.md](PLAN.md)
- Decisions, format notes, known gaps, third-party licences: [docs/](docs/)

## Requirements

Node.js ≥ 22.12, pnpm, Rust (via rustup) with the `wasm32-unknown-unknown` target, wasm-pack.

## Commands

| Command                 | What it does                                     |
| ----------------------- | ------------------------------------------------ |
| `pnpm install`          | Install dependencies                             |
| `pnpm dev`              | Start the app at http://localhost:5173           |
| `pnpm build`            | Production build                                 |
| `pnpm typecheck`        | TypeScript checks                                |
| `pnpm lint`             | ESLint + Prettier checks                         |
| `pnpm test`             | Unit and golden-image tests                      |
| `pnpm test:golden`      | Golden-image tests only                          |
| `pnpm test:e2e`         | Browser end-to-end tests                         |
| `pnpm test:e2e:all`     | End-to-end tests in Chromium, Firefox and WebKit |
| `pnpm test:e2e:preview` | End-to-end tests against a production build      |
| `pnpm test:rust`        | Rust unit tests                                  |
| `pnpm wasm`             | Build the Rust crates to WebAssembly             |

## Golden-image tests

Visual results are checked against approved images in `tests/golden/<feature>/<case>.expected.png` using the CIEDE2000
colour difference (average ≤ 1.0, worst pixel ≤ 3.0). When a test fails, the actual output and a heat map
(red = small difference, magenta = over the limit) are written to `tests/golden/__output__/`. After a deliberate,
reviewed visual change, refresh the expected images with `pnpm test:golden:update`.

## Deploying

The app needs **cross-origin isolation** (for multi-threaded WebAssembly). The web server must send these headers on
every response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`public/_headers` already declares them for Netlify / Cloudflare Pages. Without them the app still works, but heavy
operations run on a single thread.
