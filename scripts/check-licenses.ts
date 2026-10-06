/**
 * Licence gate (CLAUDE.md §1.1). Fails if any installed npm package or Rust crate —
 * direct or transitive — carries a licence outside the allowlists below.
 *
 * - Packages that ship in the app (production dependencies) must use one of the
 *   licences pre-approved in CLAUDE.md.
 * - Build/test-only tooling may additionally use a few other permissive licences;
 *   each extra one is justified in docs/DECISIONS.md.
 *
 * Anything else (GPL, AGPL, non-commercial, unknown…) must be approved by the owner
 * before it is added. Run: `node scripts/check-licenses.ts`.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isLicenceAllowed } from './lib/spdx.ts';

const SHIPPED_ALLOWED = new Set([
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'ISC',
  'Zlib',
  'MPL-2.0',
  '0BSD',
]);

// Build/test tooling only — never bundled into the app. See DECISIONS.md D-007.
const DEV_ONLY_EXTRA = new Set(['BlueOak-1.0.0', 'CC-BY-4.0', 'CC0-1.0', 'Python-2.0']);

// Rust crates: the shipped list plus Unicode-3.0, which only appears on compile-time
// proc-macro helpers (unicode-ident). See DECISIONS.md D-007.
const RUST_ALLOWED = new Set([...SHIPPED_ALLOWED, 'Unicode-3.0']);

interface LicensedPackage {
  name: string;
  versions: string[];
}

function listLicences(prodOnly: boolean): Record<string, LicensedPackage[]> {
  const args = ['licenses', 'list', '--json'];
  if (prodOnly) args.push('--prod');
  const out = execFileSync('pnpm', args, { encoding: 'utf8' }).trim();
  // pnpm prints nothing (or "No licenses found") when the set is empty.
  if (!out.startsWith('{')) return {};
  return JSON.parse(out) as Record<string, LicensedPackage[]>;
}

/** A malformed licence string counts as not allowed (it needs a human look). */
function isAllowed(licence: string, allowed: ReadonlySet<string>): boolean {
  try {
    return isLicenceAllowed(licence, allowed);
  } catch {
    return false;
  }
}

const problems: string[] = [];
const shipped = listLicences(true);
for (const [licence, pkgs] of Object.entries(shipped)) {
  if (!isAllowed(licence, SHIPPED_ALLOWED)) {
    problems.push(`[shipped] ${licence}: ${pkgs.map((p) => p.name).join(', ')}`);
  }
}

const all = listLicences(false);
const devAllowed = new Set([...SHIPPED_ALLOWED, ...DEV_ONLY_EXTRA]);
for (const [licence, pkgs] of Object.entries(all)) {
  if (!isAllowed(licence, devAllowed)) {
    problems.push(`[tooling] ${licence}: ${pkgs.map((p) => p.name).join(', ')}`);
  }
}

interface CargoPackage {
  id: string;
  name: string;
  license: string | null;
}

// Run inside src/wasm so rustup picks the toolchain pinned there.
const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--all-features'], {
    cwd: join(import.meta.dirname, '..', 'src', 'wasm'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env['PATH'] ?? ''}` },
    maxBuffer: 64 * 1024 * 1024,
  }),
) as { packages: CargoPackage[]; workspace_members: string[] };
const members = new Set(metadata.workspace_members);
const crates = metadata.packages.filter((p) => !members.has(p.id));
for (const crate of crates) {
  // Old crates sometimes write "MIT/Apache-2.0" for "MIT OR Apache-2.0".
  const licence = (crate.license ?? 'UNKNOWN').replaceAll('/', ' OR ');
  if (!isAllowed(licence, RUST_ALLOWED)) problems.push(`[rust] ${crate.license ?? 'no licence'}: ${crate.name}`);
}

if (problems.length > 0) {
  console.error('Licence check failed — these packages need owner approval:\n' + problems.join('\n'));
  process.exit(1);
}
const count = (r: Record<string, LicensedPackage[]>) => Object.values(r).reduce((n, p) => n + p.length, 0);
console.log(
  `Licence check passed (npm: ${count(shipped)} shipped, ${count(all)} total; Rust crates: ${crates.length}).`,
);
