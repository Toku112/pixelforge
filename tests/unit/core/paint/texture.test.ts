import { describe, expect, it } from 'vitest';
import { DEFAULT_BRUSH, strokePoint, type Dab } from '../../../../src/core/paint/brush';
import {
  BUILD_UP_INTERVAL,
  DEFAULT_DYNAMICS,
  StrokeDabber,
  parseDynamics,
  type BrushDynamics,
} from '../../../../src/core/paint/dynamics';
import { StrokeRenderer, dabTiles, type StrokeSetup, type StrokeTexture } from '../../../../src/core/paint/stroke';
import {
  DUAL_MODES,
  TEXTURE_MODES,
  addNoise,
  applyTexture,
  combineDual,
  textureLut,
  wetEdge,
} from '../../../../src/core/paint/texture';
import { builtInPattern, builtInPatterns, patternGray } from '../../../../src/core/pattern/pattern';
import { TILE_SIZE } from '../../../../src/core/document/tile';

const dab = (x: number, y: number, size: number, more: Partial<Dab> = {}): Dab => ({
  x,
  y,
  size,
  strength: 1,
  angle: 0,
  roundness: 1,
  flipX: false,
  flipY: false,
  ...more,
});

describe('texture and dual brush maths', () => {
  it('depth 0 leaves the paint as it is; light parts of the texture take more paint than dark', () => {
    for (const [mode] of TEXTURE_MODES) {
      if (mode === 'height' || mode === 'linear-height') continue;
      for (const a of [0, 0.3, 0.7, 1]) expect(applyTexture(mode, a, 0.2, 0), mode).toBeCloseTo(a, 9);
    }
    for (const [mode] of TEXTURE_MODES) {
      expect(applyTexture(mode, 0, 0.9, 1), `${mode}: no paint stays no paint`).toBe(0);
      expect(applyTexture(mode, 0.6, 1, 0.8), mode).toBeGreaterThanOrEqual(applyTexture(mode, 0.6, 0, 0.8));
    }
    // At full depth the darkest parts get nothing in the punching modes.
    for (const mode of ['multiply', 'subtract', 'darken', 'color-burn', 'linear-burn', 'hard-mix'] as const)
      expect(applyTexture(mode, 1, 0, 1), mode).toBe(0);
    // Height: pressing harder (more paint) reaches deeper into the relief.
    expect(applyTexture('height', 0.3, 0.5, 0)).toBe(0);
    expect(applyTexture('height', 1, 0.5, 0)).toBe(1);
    expect(applyTexture('height', 0.5, 0.6, 0)).toBeGreaterThan(0);
    expect(applyTexture('height', 0.5, 0.4, 0)).toBe(0);
  });

  it('adjusts the pattern with brightness, contrast and invert', () => {
    const plain = textureLut(0, 0, false);
    expect(plain[0]).toBe(0);
    expect(plain[255]).toBe(1);
    expect(textureLut(0, 0, true)[0]).toBe(1);
    expect(textureLut(100, 0, false)[100]).toBeCloseTo(200 / 255);
    const strong = textureLut(0, 100, false);
    expect(strong[100]).toBe(0); // 5 × the distance from mid-gray
    expect(strong[160]).toBe(1);
    expect(textureLut(0, -50, false)[20]).toBeCloseTo(0.5, 2); // flat gray
  });

  it('the dual tip only masks: nothing outside the main stroke, and multiply/darken stay within it', () => {
    for (const [mode] of DUAL_MODES) for (const m of [0, 0.5, 1]) expect(combineDual(mode, 0, m), mode).toBe(0);
    expect(combineDual('multiply', 0.8, 0.5)).toBeCloseTo(0.4);
    expect(combineDual('darken', 0.8, 0.5)).toBe(0.5);
    expect(combineDual('hard-mix', 1, 0.2)).toBe(1);
    expect(combineDual('hard-mix', 0.5, 0.2)).toBe(0);
  });

  it('noise roughens only partial coverage; wet edges leave the middle at half with a darker rim', () => {
    for (const x of [3, 50, 777]) {
      expect(addNoise(0, x, 9)).toBe(0);
      expect(addNoise(1, x, 9)).toBe(1);
    }
    const noisy = Array.from({ length: 200 }, (_, i) => addNoise(0.5, i, 4));
    expect(Math.min(...noisy)).toBeLessThan(0.15);
    expect(Math.max(...noisy)).toBeGreaterThan(0.85);
    expect(addNoise(0.5, 10, 20)).toBe(addNoise(0.5, 10, 20)); // fixed to the pixel
    expect(wetEdge(1, 1)).toBe(0.5); // the middle
    expect(wetEdge(1, 0)).toBeCloseTo(0.9); // a hard tip's rim
    expect(wetEdge(0.8, 1)).toBeCloseTo(0.8); // a soft tip's ring
    expect(wetEdge(0.1, 0)).toBeCloseTo(0.1);
  });
});

describe('built-in patterns', () => {
  it('are made the same every time and repeat without a seam', () => {
    const all = builtInPatterns();
    expect(all.map((p) => p.name)).toEqual(['Paper', 'Rough Paper', 'Canvas', 'Grain', 'Hatching', 'Dots']);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) {
      expect(p.data).toHaveLength(p.width * p.height * 4);
      const g = patternGray(p);
      // Across the repeat (last column → first) the step is like any step inside the pattern.
      let inside = 0;
      let seam = 0;
      for (let y = 0; y < p.height; y++) {
        inside += Math.abs(g[y * p.width + 1]! - g[y * p.width]!);
        seam += Math.abs(g[y * p.width]! - g[y * p.width + p.width - 1]!);
      }
      expect(seam, p.name).toBeLessThanOrEqual(inside * 2.5 + p.height * 2);
      // Not flat: a usable texture.
      expect(Math.max(...g) - Math.min(...g), p.name).toBeGreaterThan(100);
    }
    expect(builtInPattern('pf-paper')).toBe(builtInPattern('pf-paper'));
    expect(builtInPattern('nope')).toBeUndefined();
  });

  it('reads transparent pattern pixels as white', () => {
    const g = patternGray({ id: 'x', name: 'x', width: 2, height: 1, data: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 255) });
    expect([...g]).toEqual([255, 0]);
  });
});

describe('textured strokes in the renderer', () => {
  const rgba = { depth: 8 as const, colorChannels: 3, hasAlpha: true };
  const setup = (over: Partial<StrokeSetup> = {}): StrokeSetup => ({
    format: rgba,
    color: [0, 0, 0],
    erase: false,
    opacity: 1,
    flow: 1,
    hardness: 1,
    mode: 'normal',
    tip: null,
    lockAlpha: false,
    offsetX: 0,
    offsetY: 0,
    selection: null,
    ...over,
  });
  /** Stripes 1 px wide: white on even columns, black on odd. */
  const stripes = (over: Partial<StrokeTexture> = {}): StrokeTexture => ({
    width: 2,
    height: 1,
    gray: Uint8Array.of(255, 0),
    scale: 1,
    brightness: 0,
    contrast: 0,
    invert: false,
    eachTip: false,
    mode: 'multiply',
    depth: 1,
    ...over,
  });
  const alphaAt = (data: Uint8Array, x: number, y: number) => data[(y * TILE_SIZE + x) * 4 + 3]!;
  const blank = () => new Uint8Array(TILE_SIZE * TILE_SIZE * 4);

  it('the pattern shows through the paint, fixed to the document', () => {
    const data = blank();
    const r = new StrokeRenderer(setup({ texture: stripes() }));
    r.addTile(0, 0, data);
    r.applyDabs([dab(50.5, 50.5, 20)]);
    expect(alphaAt(data, 50, 50)).toBe(255); // white column: full paint
    expect(alphaAt(data, 51, 50)).toBe(0); // black column at full depth: none
    // Half depth: the dark columns get half.
    const half = blank();
    const h = new StrokeRenderer(setup({ texture: stripes({ depth: 0.5 }) }));
    h.addTile(0, 0, half);
    h.applyDabs([dab(50.5, 50.5, 20)]);
    expect(alphaAt(half, 51, 50)).toBe(128);
    // Invert swaps them (white columns now get none); Scale 200 % makes each stripe 2 px wide.
    const inv = blank();
    const i = new StrokeRenderer(setup({ texture: stripes({ invert: true, scale: 2 }) }));
    i.addTile(0, 0, inv);
    i.applyDabs([dab(50.5, 50.5, 20)]);
    const painted = [48, 49, 50, 51, 52, 53].map((x) => alphaAt(inv, x, 50) > 128);
    expect(painted).toEqual([false, false, true, true, false, false]);
  });

  it('Texture Each Tip lets overlapping dabs fill the pattern in; the whole-stroke texture does not', () => {
    const tex = { mode: 'multiply' as const, depth: 0.5 };
    const each = blank();
    const a = new StrokeRenderer(setup({ texture: stripes({ ...tex, eachTip: true }) }));
    a.addTile(0, 0, each);
    a.applyDabs([dab(50.5, 50.5, 20), dab(50.5, 50.5, 20), dab(50.5, 50.5, 20)]);
    const whole = blank();
    const b = new StrokeRenderer(setup({ texture: stripes(tex) }));
    b.addTile(0, 0, whole);
    b.applyDabs([dab(50.5, 50.5, 20), dab(50.5, 50.5, 20), dab(50.5, 50.5, 20)]);
    expect(alphaAt(each, 51, 50)).toBe(Math.round(255 * (1 - 0.5 ** 3))); // 0.5 per dab, building up
    expect(alphaAt(whole, 51, 50)).toBe(128);
    // A dab's own depth (Depth Jitter) wins.
    const own = blank();
    const c = new StrokeRenderer(setup({ texture: stripes({ ...tex, eachTip: true }) }));
    c.addTile(0, 0, own);
    c.applyDabs([dab(50.5, 50.5, 20, { depth: 0 })]);
    expect(alphaAt(own, 51, 50)).toBe(255);
  });

  it('dual-tip dabs mask the stroke without painting on their own', () => {
    const data = blank();
    const r = new StrokeRenderer(setup({ dual: { tip: null, hardness: 1, mode: 'multiply' } }));
    r.addTile(0, 0, data);
    r.applyDabs([dab(100.5, 100.5, 6, { dual: true })]); // nothing painted yet
    expect(alphaAt(data, 100, 100)).toBe(0);
    r.applyDabs([dab(100.5, 100.5, 30)]);
    expect(alphaAt(data, 100, 100)).toBe(255); // inside the dual dab
    expect(alphaAt(data, 110, 100)).toBe(0); // main stroke only
    // The dual tip may be a sampled one: its bounds count for the tiles to load.
    expect(dabTiles([dab(255, 10, 4, { dual: true })], 0, 0, false, true)).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it('wet edges leave the middle of a stroke at half and noise speckles soft edges', () => {
    const wet = blank();
    const r = new StrokeRenderer(setup({ wetEdges: true, hardness: 0 }));
    r.addTile(0, 0, wet);
    r.applyDabs([dab(60.5, 60.5, 40), dab(60.5, 60.5, 40), dab(60.5, 60.5, 40)]);
    expect(alphaAt(wet, 60, 60)).toBe(128);
    const ring = Math.max(...Array.from({ length: 20 }, (_, k) => alphaAt(wet, 60 + k, 60)));
    expect(ring).toBeGreaterThan(180);
    // A hard tip: half in the middle, a rim of about a tenth of the diameter near the edge.
    const hard = blank();
    const h = new StrokeRenderer(setup({ wetEdges: true }));
    h.addTile(0, 0, hard);
    h.applyDabs([dab(60.5, 60.5, 40)]);
    expect(alphaAt(hard, 60, 60)).toBe(128);
    expect(alphaAt(hard, 60 + 18, 60)).toBeGreaterThan(220);
    expect(alphaAt(hard, 60 + 12, 60)).toBe(128);
    const noisy = blank();
    const n = new StrokeRenderer(setup({ noise: true, hardness: 0 }));
    n.addTile(0, 0, noisy);
    n.applyDabs([dab(60.5, 60.5, 40)]);
    const plain = blank();
    const p = new StrokeRenderer(setup({ hardness: 0 }));
    p.addTile(0, 0, plain);
    p.applyDabs([dab(60.5, 60.5, 40)]);
    let differ = 0;
    for (let x = 60; x < 80; x++) if (alphaAt(noisy, x, 60) !== alphaAt(plain, x, 60)) differ++;
    expect(differ).toBeGreaterThan(5);
    expect(alphaAt(noisy, 60, 60)).toBe(alphaAt(plain, 60, 60)); // the full centre is untouched
  });
});

describe('dual brush dabs, build-up and settings', () => {
  const brushWith = (change: (d: BrushDynamics) => void) => {
    const d = structuredClone(DEFAULT_DYNAMICS);
    change(d);
    return { ...DEFAULT_BRUSH, size: 40, spacing: 0.25, dynamics: d };
  };

  it('stamps the dual tip along the path at its own size and spacing, scaled with the brush', () => {
    const b = brushWith((d) => {
      d.dual.enabled = true;
      d.dual.size = 0.25; // 10 px
      d.dual.spacing = 1; // every 10 px
      d.dual.count = 2;
    });
    const dabber = new StrokeDabber(b, 5, null);
    const dabs = [...dabber.add(strokePoint(0, 0)), ...dabber.add(strokePoint(100, 0))];
    const dual = dabs.filter((d) => d.dual);
    const main = dabs.filter((d) => !d.dual);
    expect(main).toHaveLength(11); // every 10 px (25 % of 40)
    expect(dual).toHaveLength(22); // 11 places × 2
    expect(dual.every((d) => d.size === 10 && d.strength === 1)).toBe(true);
    // Scatter moves them off the line, the same way for the same seed.
    const scattered = brushWith((d) => {
      d.dual.enabled = true;
      d.dual.scatter = 2;
    });
    const run = (seed: number) => {
      const s = new StrokeDabber(scattered, seed, null);
      return [...s.add(strokePoint(0, 0)), ...s.add(strokePoint(100, 0))].filter((d) => d.dual);
    };
    expect(run(1).some((d) => Math.abs(d.y) > 1)).toBe(true);
    expect(run(1)).toEqual(run(1));
    expect(run(2)).not.toEqual(run(1));
  });

  it('build-up keeps adding dabs while the pointer is held still', () => {
    const b = brushWith((d) => {
      d.buildUp = true;
    });
    const dabber = new StrokeDabber(b, 1, null);
    const still = (t: number) => ({ ...strokePoint(10, 10), time: t });
    expect(dabber.add(still(0))).toHaveLength(1);
    expect(dabber.add(still(10))).toHaveLength(0);
    expect(dabber.add(still(BUILD_UP_INTERVAL * 3 + 1))).toHaveLength(3);
    // Without Build-up, nothing more.
    const plain = new StrokeDabber(
      brushWith(() => {}),
      1,
      null,
    );
    plain.add(still(0));
    expect(plain.add(still(1000))).toHaveLength(0);
  });

  it('reads recorded texture and dual settings, filling what is missing and refusing nonsense', () => {
    const d = parseDynamics({
      texture: { enabled: true, mode: 'height', depth: 0.2 },
      dual: { tip: 'abc' },
      wetEdges: true,
    });
    expect(d.texture).toMatchObject({ enabled: true, mode: 'height', depth: 0.2, pattern: 'pf-paper', scale: 1 });
    expect(d.dual).toMatchObject({ enabled: false, tip: 'abc', size: 0.5 });
    expect([d.noise, d.wetEdges, d.buildUp]).toEqual([false, true, false]);
    expect(() => parseDynamics({ texture: { mode: 'screen' } })).toThrow(/mode/);
    expect(() => parseDynamics({ dual: { count: 40 } })).toThrow(/count/);
    expect(() => parseDynamics({ texture: { pattern: 7 } })).toThrow(/pattern/);
  });
});
