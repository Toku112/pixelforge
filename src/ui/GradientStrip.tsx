/**
 * A gradient drawn left to right over a checkerboard (so transparency shows), with
 * the foreground/background stops in the current colours.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Gradient, GradientMethod } from '../core/paint/gradient';
import { paintGradient } from './gradient-paint';
import { useController } from './AppContext';

export function GradientStrip({
  gradient,
  method = 'perceptual',
  width,
  height,
  className,
}: {
  gradient: Gradient;
  method?: GradientMethod;
  width: number;
  height: number;
  className?: string;
}) {
  const controller = useController();
  const colors = controller.colors;
  const version = useSyncExternalStore(
    (onChange) => colors.changes.on(onChange),
    () => colors.version,
  );
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = typeof devicePixelRatio === 'number' ? Math.min(2, devicePixelRatio) : 1;
  useEffect(() => {
    if (ref.current) paintGradient(ref.current, gradient, method, colors);
  }, [gradient, method, colors, version, width, height]);
  return (
    <canvas
      ref={ref}
      className={className ? `gradient-strip ${className}` : 'gradient-strip'}
      width={Math.round(width * dpr)}
      height={Math.round(height * dpr)}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
