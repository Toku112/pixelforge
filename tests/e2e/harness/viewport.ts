// Test-only page: the document canvas with real pointer/wheel/keyboard input.
import { createTools } from '../../../src/tools/registry';
import { viewActions } from '../../../src/tools/hand/hand-tool';
import { CanvasView } from '../../../src/ui/canvas/canvas-view';
import { patternScene } from './scenes';

const tools = createTools();
let activeTool = 'hand';
const view = new CanvasView(
  document.getElementById('host')!,
  document.getElementById('c') as HTMLCanvasElement,
  document.getElementById('overlay')!,
  {
    tools,
    getActiveToolId: () => activeTool,
    renderer: { preserveDrawingBuffer: true },
  },
);
const doc = patternScene(4000, 3000);
view.setDocument(doc);

const harness = {
  state: () => ({ ...view.viewState, dpr: view.renderer.devicePixelRatio, canvasWidth: view.renderer.canvas.width }),
  setTool(id: string, options?: Record<string, unknown>) {
    activeTool = id;
    if (options && id === 'zoom') Object.assign(tools.zoom.options, options);
    view.toolChanged();
  },
  set(state: { zoom?: number; centerX?: number; centerY?: number; rotation?: number }) {
    Object.assign(view.renderer.viewport, state);
    view.context.viewChanged();
  },
  actualPixels: () => viewActions.actualPixels(view.context),
  fit: () => view.fitOnScreen(),
  /** Document point under a CSS-pixel position in the page. */
  docAt(cssX: number, cssY: number) {
    const dpr = view.renderer.devicePixelRatio;
    return view.renderer.viewport.viewToDoc({ x: cssX * dpr, y: cssY * dpr });
  },
  cursor: () => (document.getElementById('c') as HTMLCanvasElement).style.cursor,
  overlayVisible: () => document.getElementById('overlay')!.style.display === 'block',
  /** Renders and returns the colour at a CSS position (to check something is drawn). */
  pixelAt(cssX: number, cssY: number) {
    while (!view.renderer.render());
    const dpr = view.renderer.devicePixelRatio;
    const px = view.renderer.readCanvas();
    const i = (Math.floor(cssY * dpr) * view.renderer.canvas.width + Math.floor(cssX * dpr)) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  },
};

declare global {
  interface Window {
    __view?: typeof harness;
  }
}
window.__view = harness;
