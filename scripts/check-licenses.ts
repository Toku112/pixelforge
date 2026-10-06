/**
 * Licence gate (CLAUDE.md §1.1). Fails if any installed npm package — direct or
 * transitive — carries a licence outside the allowlists below.
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

/** Accepts SPDX expressions like "(MIT OR Apache-2.0)" if any alternative is allowed. */
function isAllowed(licence: string, allowed: Set<string>): boolean {
  const alternatives = licence.replace(/[()]/g, '').split(/\s+OR\s+/i);
  return alternatives.some((alt) => alt.split(/\s+AND\s+/i).every((part) => allowed.has(part.trim())));
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

if (problems.length > 0) {
  console.error('Licence check failed — these packages need owner approval:\n' + problems.join('\n'));
  process.exit(1);
}
const count = (r: Record<string, LicensedPackage[]>) => Object.values(r).reduce((n, p) => n + p.length, 0);
console.log(`Licence check passed (${count(shipped)} shipped, ${count(all)} total packages).`);
