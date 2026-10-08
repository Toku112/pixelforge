/**
 * A brush's preview stroke (Brush Settings, the Brushes panel): an S-curve with the
 * pressure rising and falling, painted by the stroke engine in the worker.
 */
import type { AppController } from '../app/controller';
import { brushStrokeSetup, resolveBrushResources } from '../core/commands/builtin/paint';
import { colorToSamples, type RGB } from '../core/color/color';
import { strokePoint, type BrushSettings } from '../core/paint/brush';
import { StrokeDabber } from '../core/paint/dynamics';

/**
 * RGBA rows of `brush` painted along the curve in `color` (null if its tip or pattern is
 * missing). Colour dynamics vary between the foreground and background colours.
 */
export async function brushPreview(
  controller: AppController,
  brush: BrushSettings,
  width: number,
  height: number,
  color: RGB,
  varyColor = !!brush.dynamics?.color.enabled,
): Promise<Uint8Array | null> {
  const colors = {
    foreground: controller.colors.foreground,
    background: controller.colors.background,
    toSamples: (c: RGB) => colorToSamples(c, 'rgb', 8),
  };
  const dabber = new StrokeDabber(brush, 12345, varyColor ? colors : null);
  const margin = Math.min(height / 2 - 1, brush.size / 2 + 2);
  const dabs = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const p = strokePoint(
      margin + t * (width - 2 * margin),
      height / 2 - Math.sin(t * Math.PI * 2) * Math.max(0, height / 2 - margin),
      Math.sin(t * Math.PI),
    );
    dabs.push(...dabber.add(p));
  }
  let res;
  try {
    res = resolveBrushResources(brush, controller.services.brushes, controller.services.patterns);
  } catch {
    return null; // a tip or pattern that is no longer in the library
  }
  const setup = {
    ...brushStrokeSetup(
      { ...brush, mode: 'normal' },
      'brush',
      { depth: 8, colorChannels: 3, hasAlpha: true },
      colorToSamples(color, 'rgb', 8),
      res,
    ),
    varyColor,
    lockAlpha: false,
    offsetX: 0,
    offsetY: 0,
    selection: null,
  };
  return controller.services.brushPreview(setup, dabs, width, height);
}
