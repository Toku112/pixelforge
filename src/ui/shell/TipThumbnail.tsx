/** Brush tip thumbnails (brush picker, Brush Settings, Brushes panel). */
import { useEffect, useRef } from 'react';
import type { BrushTip } from '../../core/paint/brush';

/** A tip drawn as dark paint on white into a square of `box` CSS pixels (sampled, so large tips stay quick). */
export function TipThumbnail({
  tip,
  box,
  roundHardness,
}: {
  tip: BrushTip | null;
  box: number;
  roundHardness?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    el.width = box;
    el.height = box;
    const image = ctx.createImageData(box, box);
    const scale = tip ? Math.min(1, (box - 4) / Math.max(tip.width, tip.height)) : 1;
    for (let y = 0; y < box; y++) {
      for (let x = 0; x < box; x++) {
        let cover: number;
        if (tip) {
          const tx = Math.floor((x - box / 2) / scale + tip.width / 2);
          const ty = Math.floor((y - box / 2) / scale + tip.height / 2);
          cover = tx < 0 || ty < 0 || tx >= tip.width || ty >= tip.height ? 0 : tip.data[ty * tip.width + tx]! / 255;
        } else {
          // The round tip: a disc with a soft rim set by hardness.
          const r = box / 2 - 2;
          const d = Math.hypot(x + 0.5 - box / 2, y + 0.5 - box / 2);
          const h = roundHardness ?? 1;
          cover = d >= r ? 0 : d <= r * h ? 1 : 1 - (d - r * h) / (r * (1 - h));
        }
        const v = Math.round(255 - cover * 255);
        image.data.set([v, v, v, 255], (y * box + x) * 4);
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [tip, box, roundHardness]);
  return <canvas ref={canvas} className="tip-thumb" style={{ width: box, height: box }} />;
}
