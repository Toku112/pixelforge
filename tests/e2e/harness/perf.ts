// Test-only page: frame times while panning and zooming a heavy document.
import { Renderer } from '../../../src/engine/gl/renderer';
import { heavyScene } from './scenes';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
renderer.resize(1280, 800, 1);

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function animate(frames: number, step: () => void) {
  const cpu: number[] = [];
  const intervals: number[] = [];
  let last = await nextFrame();
  for (let i = 0; i < frames; i++) {
    step();
    renderer.render();
    cpu.push(renderer.stats.lastFrameMs);
    const now = await nextFrame();
    intervals.push(now - last);
    last = now;
  }
  return {
    cpuP50: percentile(cpu, 50),
    cpuP95: percentile(cpu, 95),
    intervalP50: percentile(intervals, 50),
    intervalP95: percentile(intervals, 95),
    intervalMax: Math.max(...intervals),
  };
}

const harness = {
  async run() {
    const t0 = performance.now();
    const doc = heavyScene();
    const buildMs = performance.now() - t0;
    renderer.setDocument(doc);
    renderer.viewport.fit(doc.width, doc.height, 20);
    const t1 = performance.now();
    let frames = 0;
    while (!renderer.render()) {
      frames++;
      await nextFrame();
    }
    const firstCompleteMs = performance.now() - t1;
    const pan = await animate(120, () => renderer.viewport.panBy(9, 4));
    const zoomIn = await animate(150, () => renderer.viewport.zoomBy(1.03));
    const zoomOut = await animate(150, () => renderer.viewport.zoomBy(1 / 1.03));
    const rotate = await animate(60, () => renderer.viewport.rotateTo(renderer.viewport.rotation + 1.5));
    return {
      layers: doc.layerCount,
      buildMs,
      firstCompleteMs,
      firstCompleteFrames: frames,
      pan,
      zoomIn,
      zoomOut,
      rotate,
      gpu: renderer.stats,
    };
  },
};

declare global {
  interface Window {
    __perf?: typeof harness;
  }
}
window.__perf = harness;
