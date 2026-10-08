import { describe, expect, it } from 'vitest';
import { DEFAULT_BRUSH, strokePoint, type BrushSettings, type Dab } from '../../../../src/core/paint/brush';
import {
  DEFAULT_DYNAMICS,
  StrokeDabber,
  parseDynamics,
  seededRandom,
  type BrushDynamics,
} from '../../../../src/core/paint/dynamics';

/** A brush with some dynamics switched on (deep copies of the defaults). */
function brush(change: (d: BrushDynamics) => void, more: Partial<BrushSettings> = {}): BrushSettings {
  const d = structuredClone(DEFAULT_DYNAMICS);
  change(d);
  return { ...DEFAULT_BRUSH, size: 20, spacing: 0.5, ...more, dynamics: d };
}

/** The dabs of a straight horizontal stroke from (0, 0) to (length, 0). */
function stroke(
  b: BrushSettings,
  length = 200,
  seed = 1,
  pressure = 1,
  colors: ConstructorParameters<typeof StrokeDabber>[2] = null,
): Dab[] {
  const dabber = new StrokeDabber(b, seed, colors);
  return [...dabber.add(strokePoint(0, 0, pressure)), ...dabber.add(strokePoint(length, 0, pressure))];
}

describe('brush dynamics', () => {
  it('draws the same random numbers from the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(first[0]);
  });

  it('size jitter stays at or below the size and above the minimum diameter', () => {
    const b = brush((d) => {
      d.shape.enabled = true;
      d.shape.size.jitter = 1;
      d.shape.size.minimum = 0.3;
    });
    const sizes = stroke(b).map((d) => d.size);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(6 - 1e-9);
    expect(new Set(sizes.map((s) => s.toFixed(3))).size).toBeGreaterThan(5); // it varies
    // The same seed repeats the stroke exactly; another differs.
    expect(stroke(b, 200, 1)).toEqual(stroke(b, 200, 1));
    expect(stroke(b, 200, 2)).not.toEqual(stroke(b, 200, 1));
  });

  it('controls: pen pressure, and fade over a number of dabs', () => {
    const pressure = brush((d) => {
      d.shape.enabled = true;
      d.shape.size.control = 'pressure';
    });
    expect(stroke(pressure, 0, 1, 0.25)[0]!.size).toBeCloseTo(5);
    const fade = brush((d) => {
      d.shape.enabled = true;
      d.shape.size.control = 'fade';
      d.shape.size.fadeSteps = 10;
    });
    const sizes = stroke(fade).map((d) => d.size);
    expect(sizes[0]).toBe(20);
    expect(sizes[5]).toBeCloseTo(10);
    expect(sizes[12]).toBe(1); // faded out (at least one pixel)
  });

  it('spacing follows the size a control sets (a light stroke stays joined), not the random jitter', () => {
    const pressure = brush((d) => {
      d.shape.enabled = true;
      d.shape.size.control = 'pressure';
    });
    // Size 20 at a quarter pressure = 5 px dabs, 50 % spacing = every 2.5 px.
    const light = stroke(pressure, 100, 1, 0.25);
    expect(light[1]!.x - light[0]!.x).toBeCloseTo(2.5);
    expect(light).toHaveLength(41);
    // Random size jitter leaves the spacing at the full size (every 10 px).
    const jitter = brush((d) => {
      d.shape.enabled = true;
      d.shape.size.jitter = 1;
    });
    const dabs = stroke(jitter, 100);
    expect(dabs.map((d) => d.x)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('angle follows the stroke direction; jitter turns it', () => {
    const dir = brush((d) => {
      d.shape.enabled = true;
      d.shape.angle.control = 'direction';
    });
    const dabber = new StrokeDabber(dir, 1, null);
    dabber.add(strokePoint(0, 0));
    const down = dabber.add(strokePoint(0, 100)); // downwards on screen
    expect(down[0]!.angle).toBeCloseTo(-90);
    const jit = brush((d) => {
      d.shape.enabled = true;
      d.shape.angle.jitter = 1;
    });
    const angles = stroke(jit).map((d) => d.angle);
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(180);
    expect(angles.every((a) => a >= -180 && a <= 180)).toBe(true);
  });

  it('scatters across the stroke by a share of the diameter, several dabs per step', () => {
    const b = brush((d) => {
      d.scatter.enabled = true;
      d.scatter.amount = 1; // 100 %: up to one diameter
      d.scatter.count = 3;
    });
    const plain = stroke({ ...DEFAULT_BRUSH, size: 20, spacing: 0.5 });
    const dabs = stroke(b);
    expect(dabs.length).toBe(plain.length * 3);
    expect(dabs.every((d) => Math.abs(d.y) <= 20 + 1e-9)).toBe(true);
    expect(dabs.some((d) => Math.abs(d.y) > 5)).toBe(true);
    // Without Both Axes the dabs stay at their place along the stroke.
    expect(dabs.slice(0, 3).every((d) => d.x === 0)).toBe(true);
  });

  it('transfer varies opacity and flow; brush pose overrides the pressure', () => {
    const b = brush((d) => {
      d.transfer.enabled = true;
      d.transfer.opacity.jitter = 1;
      d.transfer.flow.control = 'pressure';
      d.pose.enabled = true;
      d.pose.overridePressure = true;
      d.pose.pressure = 0.5;
    });
    const dabs = stroke(b, 200, 3, 1);
    expect(dabs.every((d) => d.opacity! <= 1 && d.opacity! >= 0)).toBe(true);
    expect(dabs.every((d) => Math.abs(d.strength - 0.5) < 1e-9)).toBe(true); // flow by the posed pressure
    // Opacity jitter varies below the brush's own Opacity, never above it.
    const half = stroke({ ...b, opacity: 0.5 }, 200, 3, 1);
    expect(Math.max(...half.map((d) => d.opacity!))).toBeLessThanOrEqual(0.5);
    expect(half.map((d) => d.opacity! * 2)).toEqual(dabs.map((d) => d.opacity));
  });

  it('colour dynamics mix foreground to background by pressure and jitter the hue', () => {
    const colors = {
      foreground: { r: 1, g: 0, b: 0 },
      background: { r: 0, g: 0, b: 1 },
      toSamples: (c: { r: number; g: number; b: number }) => [c.r * 255, c.g * 255, c.b * 255].map(Math.round),
    };
    const b = brush((d) => {
      d.color.enabled = true;
      d.color.fgbg.control = 'pressure';
    });
    expect(stroke(b, 0, 1, 1, colors)[0]!.color).toEqual([255, 0, 0]);
    expect(stroke(b, 0, 1, 0, colors)[0]!.color).toEqual([0, 0, 255]);
    const hue = brush((d) => {
      d.color.enabled = true;
      d.color.hue = 0.5;
    });
    const hues = new Set(stroke(hue, 200, 1, 1, colors).map((d) => d.color!.join()));
    expect(hues.size).toBeGreaterThan(3);
    const once = brush((d) => {
      d.color.enabled = true;
      d.color.hue = 0.5;
      d.color.perTip = false;
    });
    expect(new Set(stroke(once, 200, 1, 1, colors).map((d) => d.color!.join())).size).toBe(1);
  });

  it('reads recorded settings, filling what is missing and refusing nonsense', () => {
    const d = parseDynamics({ shape: { enabled: true, size: { jitter: 0.5 } } });
    expect(d.shape.size).toEqual({ ...DEFAULT_DYNAMICS.shape.size, jitter: 0.5 });
    expect(d.scatter).toEqual(DEFAULT_DYNAMICS.scatter);
    expect(() => parseDynamics({ shape: { size: { jitter: 2 } } })).toThrow('jitter');
    expect(() => parseDynamics({ shape: { angle: { control: 'moon' } } })).toThrow('control');
  });
});
