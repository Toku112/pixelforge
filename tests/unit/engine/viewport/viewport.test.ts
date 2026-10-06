import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, Viewport, ZOOM_STEPS, normalizeAngle } from '../../../../src/engine/viewport/viewport';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

function view(extra: Partial<Viewport> = {}) {
  return new Viewport({ viewWidth: 800, viewHeight: 600, centerX: 500, centerY: 400, zoom: 2, rotation: 30, ...extra });
}

describe('Viewport', () => {
  it('maps the centre point to the middle of the view', () => {
    close(view().docToView({ x: 500, y: 400 }), { x: 400, y: 300 });
  });

  it('converts between document and view coordinates in both directions', () => {
    const v = view();
    for (const p of [
      { x: 0, y: 0 },
      { x: 123.5, y: -7 },
      { x: 4000, y: 3000 },
    ])
      close(v.viewToDoc(v.docToView(p)), p);
  });

  it('rotates clockwise for positive angles', () => {
    const v = view({ rotation: 90, zoom: 1 });
    // A point to the right of the centre in the document appears below the centre on screen.
    close(v.docToView({ x: 510, y: 400 }), { x: 400, y: 310 });
  });

  it('keeps the point under the cursor fixed when zooming', () => {
    const v = view();
    const anchor = { x: 123, y: 456 };
    const doc = v.viewToDoc(anchor);
    v.zoomTo(7.5, anchor);
    expect(v.zoom).toBe(7.5);
    close(v.docToView(doc), anchor);
  });

  it('clamps zoom to 0.1 % – 12 800 %', () => {
    const v = view();
    v.zoomTo(1e6);
    expect(v.zoom).toBe(MAX_ZOOM);
    v.zoomTo(0);
    expect(v.zoom).toBe(MIN_ZOOM);
  });

  it('steps through the preset zoom levels', () => {
    const v = view({ zoom: 1 });
    v.zoomIn();
    expect(v.zoom).toBe(2);
    v.zoomOut();
    v.zoomOut();
    expect(v.zoom).toBeCloseTo(0.6667, 4);
    const odd = view({ zoom: 0.37 });
    odd.zoomIn();
    expect(odd.zoom).toBe(0.5);
    const top = view({ zoom: MAX_ZOOM });
    top.zoomIn();
    expect(top.zoom).toBe(MAX_ZOOM);
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual(ZOOM_STEPS);
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS.at(-1)).toBe(MAX_ZOOM);
  });

  it('pans so content follows the pointer, also when rotated', () => {
    const v = view();
    const p = { x: 300, y: 200 };
    const doc = v.viewToDoc(p);
    v.panBy(25, -40);
    close(v.docToView(doc), { x: p.x + 25, y: p.y - 40 });
  });

  it('rotates around an anchor and normalises angles', () => {
    const v = view();
    const anchor = { x: 100, y: 100 };
    const doc = v.viewToDoc(anchor);
    v.rotateTo(395, anchor);
    expect(v.rotation).toBe(35);
    close(v.docToView(doc), anchor);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(720)).toBe(0);
  });

  it('fits the document, including when rotated', () => {
    const v = view({ rotation: 0 });
    v.fit(4000, 3000, 0);
    expect(v.zoom).toBeCloseTo(0.2, 6); // limited by width 800/4000 and height 600/3000
    close(v.docToView({ x: 2000, y: 1500 }), { x: 400, y: 300 });
    v.rotateTo(90);
    v.fit(4000, 3000, 0);
    expect(v.zoom).toBeCloseTo(600 / 4000, 6); // rotated: the 4000 px side is now vertical
  });

  it('reports the visible document area', () => {
    const v = new Viewport({ viewWidth: 800, viewHeight: 600, centerX: 400, centerY: 300, zoom: 1 });
    expect(v.visibleDocRect()).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    v.zoomTo(2);
    expect(v.visibleDocRect()).toEqual({ x: 200, y: 150, w: 400, h: 300 });
  });

  it('builds a clip-space matrix consistent with docToView', () => {
    const v = view();
    const m = v.docToClipMatrix();
    for (const p of [
      { x: 0, y: 0 },
      { x: 640, y: 120 },
      { x: 900, y: 900 },
    ]) {
      const clip = { x: m[0]! * p.x + m[3]! * p.y + m[6]!, y: m[1]! * p.x + m[4]! * p.y + m[7]! };
      const viewPt = v.docToView(p);
      close(clip, { x: (viewPt.x / 800) * 2 - 1, y: 1 - (viewPt.y / 600) * 2 });
    }
  });

  it('shows the pixel grid only above 500 %', () => {
    expect(view({ zoom: 5 }).showsPixelGrid).toBe(false);
    expect(view({ zoom: 6 }).showsPixelGrid).toBe(true);
  });
});
