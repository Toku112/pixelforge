/** Drawing gradients for the interface (presets, the options bar, the Gradient Editor). */
import { gradientTable, resolveGradient, type Gradient, type GradientMethod } from '../core/paint/gradient';

/** Draws a gradient into a canvas (CSS size × device pixels). */
export function paintGradient(
  canvas: HTMLCanvasElement,
  gradient: Gradient,
  method: GradientMethod,
  colors: { foreground: { r: number; g: number; b: number }; background: { r: number; g: number; b: number } },
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 1) return;
  const table = gradientTable(resolveGradient(gradient, colors.foreground, colors.background), method, true, w);
  // Checkerboard…
  const cell = Math.max(3, Math.round(h / 4));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ccc';
  for (let y = 0; y * cell < h; y++)
    for (let x = y % 2; x * cell < w; x += 2) ctx.fillRect(x * cell, y * cell, cell, cell);
  // …under one row of the gradient, stretched to the height.
  const row = new ImageData(w, 1);
  for (let x = 0; x < w * 4; x++) row.data[x] = Math.round(table[x]! * 255);
  const strip = document.createElement('canvas');
  strip.width = w;
  strip.height = 1;
  strip.getContext('2d')?.putImageData(row, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(strip, 0, 0, w, h);
}
