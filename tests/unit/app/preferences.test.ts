import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, Preferences, sanitizePreferences } from '../../../src/app/preferences';
import { effectivePaintCursor } from '../../../src/tools/types';

describe('preferences', () => {
  it('fill in what saved values lack and ignore what is damaged', () => {
    expect(sanitizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    const p = sanitizePreferences({
      overscroll: true,
      cursors: { painting: 'full', crosshairInTip: 'yes', previewColor: { r: 0, g: 2, b: 0 } },
    });
    expect(p.overscroll).toBe(true);
    expect(p.cursors.painting).toBe('full');
    expect(p.cursors.crosshairInTip).toBe(false); // not a boolean: the default
    expect(p.cursors.previewColor).toEqual({ r: 1, g: 0, b: 0 }); // out of range: the default
    expect(sanitizePreferences({ cursors: { painting: 'huge' } }).cursors.painting).toBe('normal');
  });

  it('apply a change at once and tell listeners (without storage, for the session)', async () => {
    const prefs = new Preferences(false);
    let told = 0;
    prefs.changes.on(() => told++);
    const next = { ...prefs.values, cursors: { ...prefs.values.cursors, painting: 'precise' as const } };
    const saving = prefs.set(next);
    expect(prefs.values.cursors.painting).toBe('precise');
    expect(told).toBe(1);
    await saving;
    await prefs.saved();
  });

  it('Caps Lock swaps the painting cursor for the crosshair, and the crosshair for the outline', () => {
    expect(effectivePaintCursor('normal', false)).toBe('normal');
    expect(effectivePaintCursor('normal', true)).toBe('precise');
    expect(effectivePaintCursor('standard', true)).toBe('precise');
    expect(effectivePaintCursor('precise', true)).toBe('normal');
  });
});
