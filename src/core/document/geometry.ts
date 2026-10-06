/** Integer rectangles in pixel coordinates (x/y may be negative; w/h ≥ 0). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

export function isEmptyRect(r: Rect): boolean {
  return r.w <= 0 || r.h <= 0;
}

export function intersectRects(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : EMPTY_RECT;
}

export function unionRects(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return b;
  if (isEmptyRect(b)) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
