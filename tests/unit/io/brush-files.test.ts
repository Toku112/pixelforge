import { describe, expect, it } from 'vitest';
import { importAbr } from '../../../src/io/abr';
import { readBrushFile, writeBrushFile } from '../../../src/io/brush-file';
import { builtInTip, builtInTips } from '../../../src/core/paint/builtin-tips';
import { DEFAULT_BRUSH } from '../../../src/core/paint/brush';
import { applyPreset, defaultPresets, parsePreset, presetFromBrush } from '../../../src/core/paint/presets';
import { DEFAULT_DYNAMICS } from '../../../src/core/paint/dynamics';
import { builtInPattern } from '../../../src/core/pattern/pattern';
import { bool, deg, dyn, long, obj, pct, px, text, writeAbr } from './abr-writer';

const common = {
  Spcn: pct(25),
  Wtdg: bool(false),
  Nose: bool(false),
  useBrushSize: bool(true),
};

describe('.abr brush files', () => {
  it('imports sampled tips and presets with their Brush Settings sections', () => {
    const tip = { id: '$tip-1', width: 6, height: 4, data: Uint8Array.from({ length: 24 }, (_, i) => i * 10) };
    const sampled = obj('Brsh', {
      'Nm  ': text('Test Sampled'),
      Brsh: obj('sampledBrush', {
        Dmtr: px(12),
        Angl: deg(15),
        Rndn: pct(80),
        Intr: bool(true),
        Spcn: pct(40),
        flipX: bool(true),
        flipY: bool(false),
        'Nm  ': text('tip'),
        sampledData: text('$tip-1'),
      }),
      ...common,
      Nose: bool(true),
      useTipDynamics: bool(true),
      szVr: dyn(2),
      angleDynamics: dyn(6, 10),
      roundnessDynamics: dyn(0, 30),
      tiltScale: pct(0),
      minimumDiameter: pct(20),
      minimumRoundness: pct(25),
      flipX: bool(false),
      flipY: bool(true),
      brushProjection: bool(false),
      useScatter: bool(true),
      'Cnt ': long(3),
      bothAxes: bool(true),
      countDynamics: dyn(0, 50),
      scatterDynamics: dyn(0, 250),
    });
    const computed = obj('Brsh', {
      'Nm  ': text('Test Computed'),
      Brsh: obj('computedBrush', {
        Dmtr: px(20),
        Angl: deg(30),
        Rndn: pct(50),
        Intr: bool(false),
        Spcn: pct(10),
        flipX: bool(false),
        flipY: bool(true),
        Hrdn: pct(80),
      }),
      ...common,
      Wtdg: bool(true),
      useTexture: bool(true),
      Txtr: obj('Ptrn', { Idnt: text('not-in-file'), 'Nm  ': text('Gone') }),
      textureBlendMode: { t: 'enum', type: 'BlnM', value: 'Hght' },
      textureDepth: pct(30),
      minimumDepth: pct(10),
      textureDepthDynamics: dyn(1, 20),
      textureScale: pct(200),
      InvT: bool(true),
      textureBrightness: long(10),
      textureContrast: long(5),
      TxtC: bool(true),
      usePaintDynamics: bool(true),
      prVr: dyn(2),
      opVr: dyn(0, 40, 10),
      wtVr: dyn(0, 30),
      mxVr: dyn(0),
      toolOptions: obj('PbTl', {
        brushPreset: bool(true),
        Opct: long(60),
        flow: long(40),
        'Md  ': { t: 'enum', type: 'BlnM', value: 'Mltp' },
        smoothingValue: long(30),
        smoothingRadiusMode: bool(true),
        smoothingCatchup: bool(false),
        smoothingCatchupAtEnd: bool(true),
        smoothingZoomCompensation: bool(true),
      }),
    });
    const result = importAbr(writeAbr([tip], [sampled, computed]), 'My Brushes', 'abr1:');

    expect(result.tips).toHaveLength(1);
    expect(result.tips[0]).toMatchObject({ id: 'abr1:$tip-1', width: 6, height: 4 });
    expect([...result.tips[0]!.data]).toEqual([...tip.data]);

    const [a, b] = result.presets;
    expect(a).toMatchObject({ name: 'Test Sampled', group: 'My Brushes', toolSettings: false });
    expect(a!.brush).toMatchObject({
      size: 12,
      angle: 15,
      roundness: 0.8,
      spacing: 0.4,
      flipX: true,
      tip: 'abr1:$tip-1',
    });
    const da = a!.brush.dynamics!;
    expect(da.shape).toMatchObject({ enabled: true, flipYJitter: true });
    expect(da.shape.size).toMatchObject({ control: 'pressure', minimum: 0.2 });
    expect(da.shape.angle).toMatchObject({ control: 'direction', jitter: 0.1 });
    expect(da.shape.roundness).toMatchObject({ jitter: 0.3, minimum: 0.25 });
    expect(da.scatter).toMatchObject({ enabled: true, amount: 2.5, bothAxes: true, count: 3 });
    expect(da.scatter.countJitter.jitter).toBeCloseTo(0.5);
    expect(da.noise).toBe(true);

    expect(b!.brush).toMatchObject({ size: 20, angle: 30, roundness: 0.5, hardness: 0.8, flipY: true, tip: null });
    expect(b!.brush.spacingEnabled).toBe(false);
    expect(b!.brush).toMatchObject({ opacity: 0.6, flow: 0.4, mode: 'multiply' });
    expect(b!.toolSettings).toBe(true);
    expect(b!.smoothing).toMatchObject({ amount: 0.3, pulledString: true, catchUp: false, catchUpOnEnd: true });
    const db = b!.brush.dynamics!;
    expect(db.wetEdges).toBe(true);
    // Its pattern is not in the file: our Paper instead (and a note says so).
    expect(db.texture).toMatchObject({
      enabled: true,
      pattern: 'pf-paper',
      mode: 'height',
      depth: 0.3,
      scale: 2,
      invert: true,
      brightness: 10,
      contrast: 5,
      eachTip: true,
    });
    expect(db.texture.depthJitter).toMatchObject({ control: 'fade', jitter: 0.2, minimum: 0.1 });
    expect(db.transfer.flow.control).toBe('pressure');
    expect(db.transfer.opacity).toMatchObject({ jitter: 0.4, minimum: 0.1 });
    expect(result.notes.join(' ')).toMatch(/Paper/);
    expect(result.notes.join(' ')).toMatch(/Mixer Brush/);
  });

  it('refuses what it cannot read, saying why', () => {
    expect(() => importAbr(Uint8Array.of(0, 1, 0, 3), 'X', 'x:')).toThrow(/very old version/);
    expect(() => importAbr(Uint8Array.of(9, 9, 9), 'X', 'x:')).toThrow(/could not be read/);
  });
});

describe('our brush preset file and default library', () => {
  it('writes and reads presets with their tips and patterns', () => {
    const tip = { id: 'user-tip', name: 'Mine', width: 3, height: 2, data: Uint8Array.of(0, 50, 100, 150, 200, 255) };
    const pattern = { id: 'user-pat', name: 'Dots', width: 1, height: 2, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) };
    const brush = { ...DEFAULT_BRUSH, size: 77, tip: 'user-tip', dynamics: structuredClone(DEFAULT_DYNAMICS) };
    const preset = presetFromBrush('p1', 'Seventy-seven', 'Mine', brush, null);
    const back = readBrushFile(writeBrushFile({ presets: [preset], tips: [tip], patterns: [pattern] }));
    expect(back.presets).toEqual([preset]);
    expect(back.tips).toEqual([tip]);
    expect(back.patterns).toEqual([pattern]);
    expect(() => readBrushFile(new TextEncoder().encode('{"format":"other"}'))).toThrow(/not a brush preset file/);
    expect(() => readBrushFile(new TextEncoder().encode('nonsense'))).toThrow(/not a brush preset file/);
  });

  it('has groups of presets whose tips and patterns all exist, and they read back unchanged', () => {
    const presets = defaultPresets();
    expect([...new Set(presets.map((p) => p.group))]).toEqual([
      'General Brushes',
      'Dry Media',
      'Wet Media',
      'Special Effects',
    ]);
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    for (const p of presets) {
      const d = p.brush.dynamics!;
      for (const tipId of [p.brush.tip, d.dual.enabled ? d.dual.tip : null])
        if (tipId) expect(builtInTip(tipId), `${p.name}: ${tipId}`).toBeDefined();
      if (d.texture.enabled) expect(builtInPattern(d.texture.pattern), p.name).toBeDefined();
      expect(parsePreset(JSON.parse(JSON.stringify(p)))).toEqual(p);
    }
    for (const t of builtInTips()) {
      expect(t.data).toHaveLength(t.width * t.height);
      expect(Math.max(...t.data), t.name).toBe(255); // paints somewhere
    }
  });

  it('applies a preset keeping the tool settings it does not include, and Protect Texture keeps the pattern', () => {
    const current = {
      ...DEFAULT_BRUSH,
      opacity: 0.5,
      flow: 0.7,
      dynamics: structuredClone(DEFAULT_DYNAMICS),
    };
    current.dynamics.texture = { ...current.dynamics.texture, enabled: true, pattern: 'pf-canvas', scale: 0.3 };
    const charcoal = defaultPresets().find((p) => p.id === 'pf-charcoal')!;
    const next = applyPreset(current, charcoal);
    expect(next).toMatchObject({ opacity: 0.5, flow: 0.7, tip: 'pf-tip-charcoal' });
    expect(next.dynamics!.texture.pattern).toBe('pf-rough-paper');
    const kept = applyPreset(current, charcoal, true);
    expect(kept.dynamics!.texture).toMatchObject({ pattern: 'pf-canvas', scale: 0.3, mode: 'subtract' });
    const wash = defaultPresets().find((p) => p.id === 'pf-watercolor')!;
    expect(applyPreset(current, wash).flow).toBeCloseTo(0.35); // includes tool settings
  });
});
