/**
 * Move tool (V).
 *
 * Behaviour (own summary of the reference app):
 * - Dragging moves the selected layers by whole pixels; with a selection, dragging
 *   inside it moves the selected pixels of the active layer instead (leaving
 *   transparency, or the background colour on the Background).
 * - Alt/Option-drag duplicates first: the layers, or the selected pixels.
 * - Shift constrains the move to horizontal, vertical or 45°.
 * - Auto-Select (options bar) picks the topmost visible layer — or its outermost
 *   group — with pixels under the pointer; Ctrl/Cmd-click does it just once
 *   while Auto-Select is off.
 * - The arrow keys nudge by 1 px (Shift: 10 px); see the app commands.
 */
import { moveRefusal } from '../../core/commands/builtin/translate';
import type { CommandDescriptor, JsonObject } from '../../core/commands/command';
import type { ImageDocument } from '../../core/document/document';
import { layerCapabilities, type LayerNode } from '../../core/document/layers';
import type { Point } from '../../engine/viewport/viewport';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export interface MoveToolOptions {
  autoSelect: boolean;
  autoSelectTarget: 'layer' | 'group';
}

interface MoveDrag {
  start: Point;
  startView: Point;
  what: 'layers' | 'pixels';
  copy: boolean;
  moved: boolean;
  dx: number;
  dy: number;
}

/** Movement (CSS px) below which a press counts as a click. */
const CLICK_SLOP = 3;

/** The topmost visible layer with a visible pixel at a document point. */
export function layerAt(doc: ImageDocument, x: number, y: number, target: 'layer' | 'group'): LayerNode | null {
  const visit = (nodes: readonly LayerNode[]): LayerNode | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      if (!node.visible) continue;
      if (node.kind === 'group') {
        const hit = visit(node.children);
        if (hit) return hit;
        continue;
      }
      const lx = Math.floor(x) - node.offsetX;
      const ly = Math.floor(y) - node.offsetY;
      const format = node.buffer.format;
      const px = node.buffer.getPixel(lx, ly);
      const alpha = format.hasAlpha ? px[format.colorChannels]! : 1;
      if (alpha > 0) return node;
    }
    return null;
  };
  let hit = visit(doc.root.children);
  if (hit && target === 'group') {
    while (hit.parent && hit.parent !== doc.root) hit = hit.parent;
  }
  return hit;
}

export class MoveTool implements Tool {
  readonly id = 'move';
  readonly name = 'Move Tool';
  readonly key = 'V';
  readonly options: MoveToolOptions = { autoSelect: false, autoSelectTarget: 'layer' };
  #drag: MoveDrag | null = null;

  setOptions(changes: Partial<MoveToolOptions>): void {
    Object.assign(this.options, changes);
  }

  cursor({ altKey }: CursorState): string {
    return altKey ? 'copy' : 'move';
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const doc = ctx.document;
    if (!doc) return;
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    if (this.options.autoSelect !== e.primaryKey) {
      const hit = layerAt(doc, p.x, p.y, this.options.autoSelectTarget);
      if (hit) ctx.selectLayers([hit.id]);
    }
    const active = doc.activeLayer;
    const inSelection =
      !!doc.selection &&
      doc.selection.value(Math.floor(p.x), Math.floor(p.y), doc.canvasRect) >= 128 &&
      active?.kind === 'pixel' &&
      layerCapabilities(active).editPixels;
    const what = inSelection ? 'pixels' : 'layers';
    this.#drag = { start: p, startView: { x: e.x, y: e.y }, what, copy: e.altKey, moved: false, dx: 0, dy: 0 };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const d = this.#drag;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.x - d.startView.x, e.y - d.startView.y) < CLICK_SLOP * ctx.devicePixelRatio) return;
      d.moved = true;
      // Only an actual drag of layers that cannot move is refused (a click just selects).
      const doc = ctx.document;
      const refusal = d.what === 'layers' && doc ? moveRefusal(doc, doc.selectedLayerIds) : null;
      if (refusal) {
        this.#drag = null;
        ctx.report('Could not move', refusal);
        return;
      }
      // Alt-drag on layers: duplicate them first; the move then applies to the copies.
      if (d.copy && d.what === 'layers') ctx.execute({ name: 'duplicateLayers', params: {} });
    }
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    let dx = Math.round(p.x - d.start.x);
    let dy = Math.round(p.y - d.start.y);
    if (e.shiftKey) {
      // Horizontal, vertical or diagonal.
      if (Math.abs(dx) > 2 * Math.abs(dy)) dy = 0;
      else if (Math.abs(dy) > 2 * Math.abs(dx)) dx = 0;
      else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx) * m;
        dy = Math.sign(dy) * m;
      }
    }
    if (dx === d.dx && dy === d.dy) return;
    d.dx = dx;
    d.dy = dy;
    ctx.preview(this.#descriptor(d));
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    const d = this.#drag;
    this.#drag = null;
    if (!d) return;
    if (d.moved && (d.dx !== 0 || d.dy !== 0)) ctx.execute(this.#descriptor(d));
    else ctx.preview(null);
  }

  #descriptor(d: MoveDrag): CommandDescriptor {
    if (d.what === 'layers') return { name: 'translateLayers', params: { dx: d.dx, dy: d.dy } };
    const params: JsonObject = { dx: d.dx, dy: d.dy };
    if (d.copy) params['copy'] = true;
    return { name: 'moveSelectedPixels', params };
  }

  cancel(ctx: ToolContext): void {
    if (this.#drag) ctx.preview(null);
    this.#drag = null;
  }
}
