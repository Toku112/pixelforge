// Test-only page: the WebGL renderer, checked against the CPU reference compositor.
import { registerBuiltinCommands } from '../../../src/core/commands/builtin';
import { CommandRegistry } from '../../../src/core/commands/registry';
import type { ImageDocument } from '../../../src/core/document/document';
import { flatten, planFromDocument } from '../../../src/core/composite/flatten';
import { Renderer } from '../../../src/engine/gl/renderer';
import { createPixelWorker } from '../../../src/workers/pixel-client';
import { createWorkerPixelOps } from '../../../src/workers/pixel-ops-client';
import { availableBlendModes } from '../../../src/core/composite/blend';
import type { BitDepth, ColorMode } from '../../../src/core/document/pixel-format';
import { blendScene, hdrScene, layeredScene, patternScene } from './scenes';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new Renderer(canvas, { preserveDrawingBuffer: true });
renderer.resize(512, 384, 1);
const CHECKER = [1, 0.8];
const PASTEBOARD = Math.round(0.157 * 255);

const scenes: Record<string, () => ImageDocument> = {
  layers8: () => layeredScene(8),
  layers16: () => layeredScene(16),
  gray8: () => layeredScene(8, 'grayscale'),
  transparent: () => layeredScene(8, 'rgb', false),
  hdr32: () => hdrScene(),
  pattern: () => patternScene(),
};

function renderUntilComplete(): number {
  let frames = 0;
  while (!renderer.render()) if (++frames > 500) throw new Error('Rendering did not complete');
  return frames + 1;
}

/** Expected display colour for a premultiplied composite pixel over the checkerboard (8-bit sRGB). */
function overChecker(
  c: ArrayLike<number>,
  i: number,
  docX: number,
  docY: number,
  zoom: number,
  gray: boolean,
  linear: boolean,
): number[] {
  const cell = Math.floor((docX * zoom) / 8) + Math.floor((docY * zoom) / 8);
  const k = CHECKER[cell % 2 === 0 ? 0 : 1]!;
  const a = c[i + (gray ? 1 : 3)]!;
  const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const toSrgb = (v: number) => {
    v = Math.min(1, Math.max(0, v));
    return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [0, 1, 2].map((ch) => {
    const v = c[i + (gray ? 0 : ch)]!;
    const out = linear ? toSrgb(v + toLin(k) * (1 - a)) : v + k * (1 - a);
    return Math.round(Math.min(1, Math.max(0, out)) * 255);
  });
}

/** Max and typical difference between the GPU composite and the CPU reference (premultiplied, 0–1 units). */
function compareDocument(doc: ImageDocument) {
  renderer.setDocument(doc);
  const gpu = renderer.readComposite(doc.canvasRect);
  const cpu = flatten(planFromDocument(doc));
  const cc = cpu.colorChannels;
  let maxDiff = 0;
  let maxRel = 0;
  let outliers = 0;
  for (let p = 0; p < doc.width * doc.height; p++) {
    for (let c = 0; c < 4; c++) {
      const ref = cc === 1 ? cpu.data[p * 2 + (c === 3 ? 1 : 0)]! : cpu.data[p * 4 + c]!;
      const d = Math.abs(gpu[p * 4 + c]! - ref);
      maxDiff = Math.max(maxDiff, d);
      maxRel = Math.max(maxRel, d / Math.max(1, Math.abs(ref)));
      if (d / Math.max(1, Math.abs(ref)) > 1 / 255) outliers++;
    }
  }
  return {
    maxDiff,
    maxRel,
    outliers: outliers / (doc.width * doc.height * 4),
    floatTargets: renderer.stats.floatTargets,
  };
}

const harness = {
  compareComposite(scene: string) {
    return compareDocument(scenes[scene]!());
  },

  /** compareComposite for the blend-mode scene in every mode the document offers. */
  compareBlendModes(depth: BitDepth, colorMode: ColorMode = 'rgb') {
    return availableBlendModes(colorMode, depth).map((mode) => ({
      mode,
      ...compareDocument(blendScene(mode, depth, colorMode)),
    }));
  },

  /**
   * Renders `scene` with the given view and compares every canvas pixel with the
   * expected colour from the CPU composite (nearest pixel or 4×4 box at 25 %).
   */
  compareDisplay(
    scene: string,
    view: { zoom: number; rotation: number; centerX: number; centerY: number; grid?: boolean },
  ) {
    const doc = scenes[scene]!();
    renderer.setDocument(doc);
    renderer.showPixelGrid = view.grid ?? false;
    Object.assign(renderer.viewport, {
      zoom: view.zoom,
      rotation: view.rotation,
      centerX: view.centerX,
      centerY: view.centerY,
    });
    const frames = renderUntilComplete();
    const pixels = renderer.readCanvas();
    const cpu = flatten(planFromDocument(doc));
    const gray = cpu.colorChannels === 1;
    const stride = cpu.colorChannels + 1;
    const step = view.zoom < 1 ? Math.round(1 / view.zoom) : 1;
    let maxDiff = 0;
    let checked = 0;
    let at: number[] = [];
    for (let py = 0; py < 384; py++) {
      for (let px = 0; px < 512; px++) {
        const d = renderer.viewport.viewToDoc({ x: px + 0.5, y: py + 0.5 });
        let expected: number[];
        if (d.x < 0 || d.y < 0 || d.x >= doc.width || d.y >= doc.height) {
          expected = [PASTEBOARD, PASTEBOARD, PASTEBOARD];
        } else {
          // Pixel (or box of step×step pixels) under the sample point.
          const bx = Math.floor(d.x / step) * step;
          const by = Math.floor(d.y / step) * step;
          const box = new Float64Array(stride);
          for (let y = by; y < by + step; y++)
            for (let x = bx; x < bx + step; x++)
              for (let c = 0; c < stride; c++) box[c]! += cpu.data[(y * doc.width + x) * stride + c]! / (step * step);
          expected = overChecker(box, 0, d.x, d.y, view.zoom, gray, doc.depth === 32);
        }
        const i = (py * 512 + px) * 4;
        // Skip pixels where the sample point sits within a hair of a pixel edge (rounding may pick either side).
        if (Math.abs(d.x - Math.round(d.x)) < 1e-3 || Math.abs(d.y - Math.round(d.y)) < 1e-3) continue;
        const diff = Math.max(...expected.map((v, c) => Math.abs(v - pixels[i + c]!)));
        if (diff > maxDiff) {
          maxDiff = diff;
          at = [px, py, ...expected, pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
        }
        checked++;
      }
    }
    return { maxDiff, checked, at, frames };
  },

  /** Counts canvas pixels drawn in the grid colour at 800 % in a flat area. */
  gridLines() {
    const doc = scenes.pattern!();
    renderer.setDocument(doc);
    Object.assign(renderer.viewport, { zoom: 8, rotation: 0, centerX: 1000.5, centerY: 1000.5 });
    const run = (grid: boolean) => {
      renderer.showPixelGrid = grid;
      renderUntilComplete();
      return renderer.readCanvas();
    };
    const without = run(false);
    const withGrid = run(true);
    const differs = (px: number, py: number) => {
      const i = (py * 512 + px) * 4;
      return withGrid[i] !== without[i] || withGrid[i + 1] !== without[i + 1] || withGrid[i + 2] !== without[i + 2];
    };
    // With centre 1000.5 at 800 %, vertical lines fall on columns ≡ 4 (mod 8) and horizontal
    // lines on rows ≡ 4 (mod 8). Row 103 and column 3 cross no line of the other direction.
    let lineColumns = 0;
    let lineRows = 0;
    for (let i = 0; i < 64; i++) {
      if (differs(i, 103)) lineColumns++;
      if (differs(3, i)) lineRows++;
    }
    return { lineColumns, lineRows, onLine: differs(4, 103) && differs(3, 100) };
  },

  /** Renders, inverts one layer (through the real pixel worker) and reports how much was recomposited. */
  async incrementalUpdate() {
    const doc = scenes.pattern!();
    renderer.setDocument(doc);
    renderer.viewport.fit(doc.width, doc.height);
    renderer.viewport.zoomTo(1);
    renderUntilComplete();
    const before = renderer.stats.composites;
    const layer = [...doc.layers()].find((l) => l.kind === 'pixel' && !l.isBackground)!;
    doc.setActiveLayer(layer.id);
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    await registry
      .create(
        { doc, services: { pixelOps: createWorkerPixelOps(createPixelWorker()) } },
        { name: 'invert', params: {} },
      )
      .execute();
    renderUntilComplete();
    const composite = renderer.readComposite({ x: 600, y: 300, w: 1, h: 1 });
    return { recomposited: renderer.stats.composites - before, totalTiles: 8 * 4, composite: [...composite] };
  },

  contextInfo() {
    return renderer.stats;
  },
};

declare global {
  interface Window {
    __render?: typeof harness;
  }
}
window.__render = harness;
