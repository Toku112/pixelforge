import { describe, expect, it } from 'vitest';
import { isLicenceAllowed } from '../../../scripts/lib/spdx';

const allowed = new Set(['MIT', 'Apache-2.0', 'Unicode-3.0']);

describe('SPDX licence expressions', () => {
  it.each([
    ['MIT', true],
    ['GPL-3.0-only', false],
    ['MIT OR GPL-3.0-only', true],
    ['MIT AND GPL-3.0-only', false],
    ['(MIT OR Apache-2.0) AND Unicode-3.0', true],
    ['(MIT OR Apache-2.0) AND GPL-3.0-only', false],
    ['MIT OR Apache-2.0 AND GPL-3.0-only', true], // AND binds tighter: MIT OR (Apache AND GPL)
    ['Apache-2.0 WITH LLVM-exception', true],
    ['GPL-2.0-only WITH Classpath-exception-2.0', false],
    ['(GPL-3.0-only OR (MIT AND Unicode-3.0))', true],
    ['mit', false], // identifiers are case-sensitive
    ['', false],
  ])('%s → %s', (expr, expected) => {
    expect(isLicenceAllowed(expr, allowed)).toBe(expected);
  });

  it('rejects malformed expressions', () => {
    expect(() => isLicenceAllowed('(MIT OR Apache-2.0', allowed)).toThrow('Missing ")"');
    expect(() => isLicenceAllowed('MIT OR', allowed)).toThrow('Unexpected end');
    expect(() => isLicenceAllowed('MIT Apache-2.0', allowed)).toThrow('Unexpected "Apache-2.0"');
  });
});
