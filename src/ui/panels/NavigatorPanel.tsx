/**
 * Navigator panel: a thumbnail of the whole image with the visible area outlined.
 * Drag the outline (or anywhere) to move the view; zoom with the slider, the
 * buttons or the zoom field.
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { MAX_ZOOM, MIN_ZOOM } from '../../engine/viewport/viewport';
import { useController, useWorkspace } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';

const LOG_MIN = Math.log2(MIN_ZOOM);
const LOG_MAX = Math.log2(MAX_ZOOM);

export function NavigatorPanel() {
  const controller = useController();
  const doc = useWorkspace((w) => w.active?.doc ?? null);
  const view = useUi((s) => s.view);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [thumb, setThumb] = useState<{ width: number; height: number; scale: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // Refresh the thumbnail after the document changes, at most a few times per second.
  useEffect(() => {
    const canvasView = controller.canvas;
    if (!doc || !canvasView) {
      setThumb(null);
      return;
    }
    let dirty = true;
    let last = 0;
    const offDoc = doc.changes.on(() => (dirty = true));
    const refresh = () => {
      const t = canvasView.renderer.thumbnail();
      const canvas = canvasRef.current;
      if (!t || !canvas) return;
      canvas.width = t.width;
      canvas.height = t.height;
      canvas.getContext('2d')?.putImageData(new ImageData(t.data as Uint8ClampedArray<ArrayBuffer>, t.width, t.height), 0, 0);
      setThumb({ width: t.width, height: t.height, scale: t.scale });
      dirty = false;
    };
    const offFrame = canvasView.renderer.onFrame((stats) => {
      const now = performance.now();
      if (dirty && stats.complete && now - last > 250) {
        last = now;
        refresh();
      }
    });
    canvasView.renderer.requestRender();
    return () => {
      offDoc();
      offFrame();
    };
  }, [doc, controller]);

  const ctx = () => controller.canvas?.context;

  // Visible area as a polygon in thumbnail pixels (it is rotated when the view is).
  let polygon = '';
  if (thumb && view && controller.canvas) {
    const v = controller.canvas.renderer.viewport;
    polygon = [
      { x: 0, y: 0 },
      { x: v.viewWidth, y: 0 },
      { x: v.viewWidth, y: v.viewHeight },
      { x: 0, y: v.viewHeight },
    ]
      .map((p) => v.viewToDoc(p))
      // Unrotated, keep the outline on the thumbnail even when the view is larger than the image.
      .map((p) => (v.rotation === 0 ? { x: Math.min(doc!.width, Math.max(0, p.x)), y: Math.min(doc!.height, Math.max(0, p.y)) } : p))
      .map((p) => `${p.x / thumb.scale},${p.y / thumb.scale}`)
      .join(' ');
  }

  const docPoint = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = (thumb?.width ?? 1) / rect.width;
    return { x: (e.clientX - rect.left) * sx * (thumb?.scale ?? 1), y: (e.clientY - rect.top) * sx * (thumb?.scale ?? 1) };
  };
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    const c = ctx();
    if (!c?.document) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = docPoint(e);
    const inside = (e.target as Element).tagName === 'polygon';
    // Grab the outline where it was clicked; elsewhere, centre the view on the click.
    drag.current = inside ? { dx: p.x - c.viewport.centerX, dy: p.y - c.viewport.centerY } : { dx: 0, dy: 0 };
    onPointerMove(e);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const c = ctx();
    if (!drag.current || !c) return;
    const p = docPoint(e);
    c.viewport.centerX = p.x - drag.current.dx;
    c.viewport.centerY = p.y - drag.current.dy;
    c.viewChanged();
  };

  const zoomTo = (zoom: number) => {
    const c = ctx();
    if (!c?.document) return;
    c.viewport.zoomTo(zoom);
    c.viewChanged();
  };

  if (!doc) return <div className="panel-message">No document is open.</div>;
  return (
    <div className="navigator">
      <div className="navigator-thumb">
        <div className="navigator-frame" style={thumb ? { aspectRatio: `${thumb.width} / ${thumb.height}` } : undefined}>
          <canvas ref={canvasRef} />
          {thumb && (
            <svg
              viewBox={`0 0 ${thumb.width} ${thumb.height}`}
              preserveAspectRatio="none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
              aria-label="Visible area"
            >
              <polygon points={polygon} className="navigator-proxy" />
            </svg>
          )}
        </div>
      </div>
      <div className="navigator-controls">
        <NumberField label="Zoom" hideLabel value={(view?.zoom ?? 1) * 100} precision={2} suffix="%" min={MIN_ZOOM * 100} max={MAX_ZOOM * 100} width={64} onChange={(pct) => zoomTo(pct / 100)} />
        <button type="button" className="option-icon" aria-label="Zoom out" onClick={() => (ctx()?.viewport.zoomOut(), ctx()?.viewChanged())}>
          <Icon name="zoomOut" size={14} />
        </button>
        <input
          type="range"
          className="navigator-slider"
          aria-label="Zoom slider"
          min={0}
          max={1000}
          value={Math.round(((Math.log2(view?.zoom ?? 1) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000)}
          onChange={(e) => zoomTo(2 ** (LOG_MIN + (Number(e.target.value) / 1000) * (LOG_MAX - LOG_MIN)))}
        />
        <button type="button" className="option-icon" aria-label="Zoom in" onClick={() => (ctx()?.viewport.zoomIn(), ctx()?.viewChanged())}>
          <Icon name="zoomIn" size={14} />
        </button>
      </div>
    </div>
  );
}
