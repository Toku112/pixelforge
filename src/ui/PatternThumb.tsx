/**
 * A pattern's thumbnail: the pattern repeated (or, when larger than the box, shrunk to
 * fit) over a checkerboard, so transparency shows.
 */
import { useEffect, useRef } from 'react';
import type { Pattern } from '../core/pattern/pattern';

export function PatternThumb({ pattern, size }: { pattern: Pattern; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = typeof devicePixelRatio === 'number' ? Math.min(2, devicePixelRatio) : 1;
  const px = Math.round(size * dpr);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const cell = Math.max(3, Math.round(px / 6));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#ccc';
    for (let y = 0; y * cell < px; y++)
      for (let x = y % 2; x * cell < px; x += 2) ctx.fillRect(x * cell, y * cell, cell, cell);
    const source = document.createElement('canvas');
    source.width = pattern.width;
    source.height = pattern.height;
    source.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pattern.data), pattern.width), 0, 0);
    const largest = Math.max(pattern.width, pattern.height);
    if (largest > px) {
      const s = px / largest;
      ctx.drawImage(source, 0, 0, pattern.width * s, pattern.height * s);
      return;
    }
    const fill = ctx.createPattern(source, 'repeat');
    if (!fill) return;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, px, px);
  }, [pattern, px]);
  return (
    <canvas
      ref={ref}
      className="pattern-thumb"
      width={px}
      height={px}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
