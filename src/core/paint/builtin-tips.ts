/**
 * The built-in sampled brush tips of our default brush library, drawn by code
 * (CLAUDE.md §1.1: our own defaults, nothing bundled from elsewhere). Seeded, so they
 * are the same everywhere; strokes and presets refer to them by id like user tips.
 */
import { seededRandom } from '../random';
import type { BrushTip } from './brush';

/** Coverage 0–1 from a function over a w × h tip. */
function tip(id: string, name: string, w: number, h: number, cover: (x: number, y: number) => number): BrushTip {
  const values = new Float32Array(w * h);
  let peak = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.min(1, Math.max(0, cover(x + 0.5, y + 0.5)));
      values[y * w + x] = v;
      peak = Math.max(peak, v);
    }
  // Full strength where the tip is strongest.
  const data = Uint8Array.from(values, (v) => Math.round((255 * v) / (peak || 1)));
  return { id, name, width: w, height: h, data };
}

/** Smooth value noise over a w × h area with cells of `cell` px. */
function noise(w: number, h: number, cell: number, seed: number): (x: number, y: number) => number {
  const random = seededRandom(seed);
  const cw = Math.ceil(w / cell) + 2;
  const ch = Math.ceil(h / cell) + 2;
  const lattice = Float32Array.from({ length: cw * ch }, () => random());
  const s = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const u = x / cell;
    const v = y / cell;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = s(u - i);
    const fy = s(v - j);
    const at = (a: number, b: number) => lattice[Math.min(ch - 1, b) * cw + Math.min(cw - 1, a)]!;
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

/** A soft disc profile: 1 inside `r·inner`, falling to 0 at r. */
const disc = (d: number, r: number, inner: number) =>
  d >= r ? 0 : d <= r * inner ? 1 : 1 - (d - r * inner) / (r * (1 - inner));

const BUILT_IN: readonly { id: string; name: string; make: () => BrushTip }[] = [
  {
    id: 'pf-tip-charcoal',
    name: 'Charcoal',
    make: () => {
      const n = noise(96, 96, 6, 101);
      const fine = noise(96, 96, 2, 102);
      return tip('pf-tip-charcoal', 'Charcoal', 96, 96, (x, y) => {
        const d = Math.hypot((x - 48) / 1.25, y - 48);
        return disc(d, 40 + 6 * n(x, y), 0.55) * (fine(x, y) > 0.38 ? 1 : 0.15) * (0.55 + 0.45 * n(x, y));
      });
    },
  },
  {
    id: 'pf-tip-chalk',
    name: 'Chalk',
    make: () => {
      const grain = noise(80, 80, 1.5, 201);
      return tip('pf-tip-chalk', 'Chalk', 80, 80, (x, y) => {
        const d = Math.hypot(x - 40, y - 40);
        return disc(d, 36, 0.7) * (grain(x, y) > 0.45 ? 1 : 0);
      });
    },
  },
  {
    id: 'pf-tip-bristle',
    name: 'Bristles',
    make: () => {
      // Hairs: small soft dots scattered across a flat oval.
      const random = seededRandom(301);
      const hairs = Array.from({ length: 70 }, () => {
        const a = random() * 2 * Math.PI;
        const r = Math.sqrt(random());
        return {
          x: 50 + Math.cos(a) * r * 44,
          y: 30 + Math.sin(a) * r * 22,
          s: 2 + random() * 3,
          k: 0.6 + random() * 0.4,
        };
      });
      return tip('pf-tip-bristle', 'Bristles', 100, 60, (x, y) => {
        let c = 0;
        for (const h of hairs) c = Math.max(c, disc(Math.hypot(x - h.x, y - h.y), h.s, 0.3) * h.k);
        return c;
      });
    },
  },
  {
    id: 'pf-tip-spatter',
    name: 'Spatter',
    make: () => {
      const random = seededRandom(401);
      const drops = Array.from({ length: 34 }, () => {
        const a = random() * 2 * Math.PI;
        const r = Math.pow(random(), 0.7) * 54;
        return { x: 64 + Math.cos(a) * r, y: 64 + Math.sin(a) * r, s: 1.5 + Math.pow(random(), 3) * 9 };
      });
      return tip('pf-tip-spatter', 'Spatter', 128, 128, (x, y) => {
        let c = 0;
        for (const d of drops) c = Math.max(c, disc(Math.hypot(x - d.x, y - d.y), d.s, 0.7));
        return c;
      });
    },
  },
  {
    id: 'pf-tip-star',
    name: 'Star',
    make: () =>
      tip('pf-tip-star', 'Star', 64, 64, (x, y) => {
        // A five-pointed star: the radius swings between the points and the notches.
        const a = Math.atan2(y - 32, x - 32) + Math.PI / 2;
        const t = ((a / (2 * Math.PI)) * 5) % 1;
        const edge = 12 + 18 * Math.abs(1 - 2 * ((t + 1) % 1));
        const d = Math.hypot(x - 32, y - 32);
        return Math.min(1, Math.max(0, edge - d + 0.5));
      }),
  },
  {
    id: 'pf-tip-leaf',
    name: 'Leaf',
    make: () =>
      tip('pf-tip-leaf', 'Leaf', 48, 80, (x, y) => {
        // A pointed oval with a lighter middle vein.
        const t = (y - 4) / 72;
        if (t < 0 || t > 1) return 0;
        const half = 20 * Math.sin(Math.PI * t) ** 0.8;
        const dx = Math.abs(x - 24);
        const body = Math.min(1, Math.max(0, half - dx + 0.5));
        return dx < 1 ? body * 0.55 : body;
      }),
  },
  {
    id: 'pf-tip-grass',
    name: 'Grass',
    make: () => {
      const random = seededRandom(601);
      const blades = Array.from({ length: 9 }, () => ({
        x: 20 + random() * 60,
        lean: (random() - 0.5) * 30,
        h: 50 + random() * 46,
        w: 2 + random() * 2.5,
      }));
      return tip('pf-tip-grass', 'Grass', 100, 100, (x, y) => {
        let c = 0;
        for (const b of blades) {
          const t = (98 - y) / b.h; // 0 at the root, 1 at the tip
          if (t < 0 || t > 1) continue;
          const cx = b.x + b.lean * t * t;
          const half = b.w * (1 - t);
          c = Math.max(c, Math.min(1, Math.max(0, half - Math.abs(x - cx) + 0.5)));
        }
        return c;
      });
    },
  },
];

const made = new Map<string, BrushTip>();

export function builtInTip(id: string): BrushTip | undefined {
  const known = made.get(id);
  if (known) return known;
  const def = BUILT_IN.find((t) => t.id === id);
  if (!def) return undefined;
  const t = def.make();
  made.set(id, t);
  return t;
}

export function builtInTips(): BrushTip[] {
  return BUILT_IN.map((t) => builtInTip(t.id)!);
}

export const isBuiltInTip = (id: string) => BUILT_IN.some((t) => t.id === id);
