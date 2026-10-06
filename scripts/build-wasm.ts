/**
 * Builds the Rust crates in src/wasm to WebAssembly with wasm-pack.
 *
 * Each crate is built in up to two variants:
 *  - `mt`: SIMD + threads (shared memory, atomics, std rebuilt on the pinned nightly).
 *          Used when the page is cross-origin isolated (COOP/COEP headers).
 *  - `st`: SIMD only. Fallback when SharedArrayBuffer is unavailable; also used by
 *          Node unit tests.
 * Output: src/wasm/pkg/<crate>-<variant>/  (git-ignored).
 *
 * Usage: node scripts/build-wasm.ts [--if-stale]
 *   --if-stale  only rebuild when Rust sources changed since the last build.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WASM_DIR = join(ROOT, 'src', 'wasm');
const PKG_DIR = join(WASM_DIR, 'pkg');
const STAMP = join(PKG_DIR, '.build-stamp');

/** Maximum shared memory for threaded builds: 4 GiB, the wasm32 limit. */
const MT_MAX_MEMORY = 4 * 1024 * 1024 * 1024;

type Variant = 'mt' | 'st';
interface CrateBuild {
  crate: string;
  outName: string;
  variants: Variant[];
}

const CRATES: CrateBuild[] = [{ crate: 'pixel-ops', outName: 'pixel_ops', variants: ['mt', 'st'] }];

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === 'target' || entry === 'pkg') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (/\.(rs|toml|lock)$/.test(entry)) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

function isStale(): boolean {
  if (!existsSync(STAMP)) return true;
  for (const { crate, variants } of CRATES) {
    for (const v of variants) if (!existsSync(join(PKG_DIR, `${crate}-${v}`))) return true;
  }
  const stamp = statSync(STAMP).mtimeMs;
  return newestMtime(WASM_DIR) > stamp || statSync(import.meta.filename).mtimeMs > stamp;
}

function build({ crate, outName }: CrateBuild, variant: Variant): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // rustup installs cargo here; make the build work even if the shell profile wasn't loaded.
    PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env['PATH'] ?? ''}`,
    // Separate target dirs: the variants use different flags and would otherwise rebuild each other.
    CARGO_TARGET_DIR: join(WASM_DIR, 'target', variant),
  };
  const cargoArgs: string[] = [];
  if (variant === 'mt') {
    // Target-scoped so the flags never leak into host builds (e.g. wasm-pack installing wasm-bindgen-cli).
    // Recent rustc no longer adds the shared-memory linker flags implicitly, so pass them all.
    env['CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS'] = [
      '-C target-feature=+atomics,+bulk-memory,+simd128',
      '-C link-arg=--shared-memory',
      '-C link-arg=--import-memory',
      `-C link-arg=--max-memory=${MT_MAX_MEMORY}`,
      '-C link-arg=--export=__wasm_init_tls',
      '-C link-arg=--export=__tls_size',
      '-C link-arg=--export=__tls_align',
      '-C link-arg=--export=__tls_base',
    ].join(' ');
    cargoArgs.push('--features', 'threads', '-Z', 'build-std=panic_abort,std');
  }
  const args = [
    'build',
    join('crates', crate),
    '--release',
    '--target',
    'web',
    '--out-dir',
    join(PKG_DIR, `${crate}-${variant}`),
    '--out-name',
    outName,
    ...(cargoArgs.length ? ['--', ...cargoArgs] : []),
  ];
  console.log(`\n▸ wasm-pack ${crate} (${variant})`);
  execFileSync('wasm-pack', args, { cwd: WASM_DIR, env, stdio: 'inherit' });
}

const ifStale = process.argv.includes('--if-stale');
if (ifStale && !isStale()) {
  console.log('WASM packages are up to date.');
} else {
  for (const crate of CRATES) for (const v of crate.variants) build(crate, v);
  mkdirSync(PKG_DIR, { recursive: true });
  writeFileSync(STAMP, new Date().toISOString() + '\n');
}
