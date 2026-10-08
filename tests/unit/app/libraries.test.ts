import { describe, expect, it } from 'vitest';
import { GradientLibrary } from '../../../src/app/gradient-library';
import { PatternLibrary } from '../../../src/app/pattern-library';
import { SwatchLibrary } from '../../../src/app/swatch-library';
import { solidGradient } from '../../../src/core/paint/gradient';

describe('restoring default presets keeps the user’s own', () => {
  it('patterns: our patterns come back, the user’s stay in their group', async () => {
    const lib = new PatternLibrary(false);
    await lib.ready;
    await lib.add([{ id: 'mine', name: 'Mine', width: 1, height: 1, data: Uint8Array.of(1, 2, 3, 255) }], 'Textures');
    await lib.remove('pf-grain');
    expect(lib.groups()[0]!.patterns.map((p) => p.id)).not.toContain('pf-grain');
    expect(lib.get('pf-grain')).toBeDefined(); // still there for brushes and recordings
    await lib.restoreDefaults();
    const ids = lib.groups()[0]!.patterns.map((p) => p.id);
    expect(ids).toContain('pf-grain');
    expect(ids).toContain('mine');
    expect(lib.groups()).toHaveLength(1);
  });

  it('gradients and swatches', async () => {
    const gradients = new GradientLibrary(false);
    await gradients.add(
      { id: 'g1', gradient: solidGradient('Mine', [{ location: 0, color: { r: 0, g: 0, b: 0 } }]) },
      'Basics',
    );
    await gradients.remove('pf-grad-black-white');
    await gradients.restoreDefaults();
    const basics = gradients
      .groups()
      .find((g) => g.name === 'Basics')!
      .gradients.map((e) => e.id);
    expect(basics).toContain('pf-grad-black-white');
    expect(basics).toContain('g1');

    const swatches = new SwatchLibrary(false);
    await swatches.add({ id: 'mine', name: 'Mine', color: { r: 1, g: 0, b: 0 } }, 'Basics');
    await swatches.restoreDefaults();
    expect(swatches.groups()[0]!.swatches.map((s) => s.id)).toContain('mine');
  });
});
