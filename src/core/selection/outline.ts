/**
 * The outline of a selection, for the marching ants: closed loops along pixel
 * edges between pixels selected at least half (value ≥ 128) and the rest, in
 * document coordinates. Runs in the pixel worker.
 *
 * Each selected pixel contributes the edges it shares with unselected (or
 * off-canvas) neighbours, directed so the selection is on the right; the edges
 * are then chained into loops and straight runs merged into single segments.
 */
import { isEmptyRect, type Rect } from '../document/geometry';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { MaskReader } from './mask-ops';
import type { MaskData } from './selection';

/** Selected for the outline: at least half. */
const THRESHOLD = 128;

/** Removes corners of a closed loop that lie on a straight line (where the loop started mid-edge). */
function dropStraightCorners(points: number[]): number[] {
  const n = points.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    const q = (i + 1) % n;
    const x = points[i * 2]!;
    const y = points[i * 2 + 1]!;
    const straight =
      (points[p * 2] === x && points[q * 2] === x) || (points[p * 2 + 1] === y && points[q * 2 + 1] === y);
    if (!straight) out.push(x, y);
  }
  return out;
}

export function selectionOutline(mask: MaskData, canvas: Rect): Float32Array[] {
  if (isEmptyRect(canvas)) return [];
  if (mask.fill === 255 && mask.tiles.length === 0) {
    const { x, y, w, h } = canvas;
    return [new Float32Array([x, y, x + w, y, x + w, y + h, x, y + h])];
  }
  // Mask windows for each document tile of the canvas.
  const reader = new MaskReader(mask);
  const windows = new Map<number, Uint8Array | 0 | 255>();
  const tx0 = tileIndex(canvas.x);
  const ty0 = tileIndex(canvas.y);
  const tx1 = tileIndex(canvas.x + canvas.w - 1);
  const ty1 = tileIndex(canvas.y + canvas.h - 1);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const out = new Uint8Array(TILE_SIZE * TILE_SIZE);
      windows.set(tileKey(tx, ty), reader.window(tx * TILE_SIZE, ty * TILE_SIZE, canvas, out));
    }
  }
  const inside = (x: number, y: number): boolean => {
    if (x < canvas.x || y < canvas.y || x >= canvas.x + canvas.w || y >= canvas.y + canvas.h) return false;
    const tx = tileIndex(x);
    const ty = tileIndex(y);
    const w = windows.get(tileKey(tx, ty))!;
    if (typeof w === 'number') return w >= THRESHOLD;
    return w[(y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)]! >= THRESHOLD;
  };

  // Directed edges, keyed by start vertex.
  const stride = canvas.w + 3;
  const vkey = (x: number, y: number) => (y - canvas.y + 1) * stride + (x - canvas.x + 1);
  const outgoing = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = vkey(x0, y0);
    const list = outgoing.get(k);
    if (list) list.push(vkey(x1, y1));
    else outgoing.set(k, [vkey(x1, y1)]);
  };
  const visit = (x: number, y: number) => {
    if (!inside(x, y)) return;
    if (!inside(x, y - 1)) add(x, y, x + 1, y);
    if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!inside(x - 1, y)) add(x, y + 1, x, y);
  };
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const w = windows.get(tileKey(tx, ty))!;
      if (w === 0) continue;
      const xa = Math.max(canvas.x, tx * TILE_SIZE);
      const ya = Math.max(canvas.y, ty * TILE_SIZE);
      const xb = Math.min(canvas.x + canvas.w, (tx + 1) * TILE_SIZE) - 1;
      const yb = Math.min(canvas.y + canvas.h, (ty + 1) * TILE_SIZE) - 1;
      if (w === 255) {
        // A fully selected tile can only have edges along its border.
        for (let x = xa; x <= xb; x++) {
          visit(x, ya);
          if (yb !== ya) visit(x, yb);
        }
        for (let y = ya + 1; y < yb; y++) {
          visit(xa, y);
          if (xb !== xa) visit(xb, y);
        }
      } else {
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) visit(x, y);
      }
    }
  }

  // Chain edges into loops, merging straight runs.
  const loops: Float32Array[] = [];
  const toXY = (k: number): [number, number] => [(k % stride) - 1 + canvas.x, Math.floor(k / stride) - 1 + canvas.y];
  for (const [start, list] of outgoing) {
    while (list.length > 0) {
      const points: number[] = [];
      let from = start;
      let to = list.pop()!;
      let dir: [number, number] | null = null;
      for (;;) {
        const [fx, fy] = toXY(from);
        const [tx, ty] = toXY(to);
        const d: [number, number] = [tx - fx, ty - fy];
        if (!dir || d[0] !== dir[0] || d[1] !== dir[1]) points.push(fx, fy);
        dir = d;
        if (to === start) break;
        const next = outgoing.get(to);
        if (!next || next.length === 0) break; // cannot happen for a closed boundary
        from = to;
        to = next.pop()!;
      }
      const simplified = dropStraightCorners(points);
      if (simplified.length >= 6) loops.push(new Float32Array(simplified));
    }
  }
  return loops;
}
