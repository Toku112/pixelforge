/**
 * The tip's angle and roundness as one control (Brush Tip Shape): the tip drawn as
 * an ellipse in a circle; drag the arrow (or anywhere) to turn it, drag either dot
 * to squash it. Keyboard: Left/Right turn by 1° (Shift: 10°), Up/Down change the
 * roundness by 1 % (Shift: 10 %).
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

const SIZE = 72;
const C = SIZE / 2;
const R = 28;

export function TipPoseWidget({
  angle,
  roundness,
  onChange,
}: {
  angle: number;
  roundness: number;
  onChange: (pose: { angle: number; roundness: number }) => void;
}) {
  const drag = useRef<'angle' | 'roundness' | null>(null);
  const a = (angle * Math.PI) / 180;
  // The tip's axes on screen (y down): u along the angle (counter-clockwise), v across it.
  const u = { x: Math.cos(a), y: -Math.sin(a) };
  const v = { x: Math.sin(a), y: Math.cos(a) };
  const ry = R * roundness;

  const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
  const update = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * SIZE - C;
    const y = ((e.clientY - box.top) / box.height) * SIZE - C;
    if (drag.current === 'roundness') {
      const across = Math.abs(x * v.x + y * v.y);
      onChange({ angle, roundness: Math.min(1, Math.max(0.01, Math.round((across / R) * 100) / 100)) });
    } else if (x !== 0 || y !== 0) {
      onChange({ angle: wrap(Math.round((Math.atan2(-y, x) * 180) / Math.PI)), roundness });
    }
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      onChange({ angle: wrap(angle + (e.key === 'ArrowLeft' ? step : -step)), roundness });
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const r = Math.round(roundness * 100) + (e.key === 'ArrowUp' ? step : -step);
      onChange({ angle, roundness: Math.min(100, Math.max(1, r)) / 100 });
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    <svg
      className="tip-pose"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="slider"
      tabIndex={0}
      aria-label="Tip angle and roundness"
      aria-valuetext={`Angle ${angle}°, roundness ${Math.round(roundness * 100)}%`}
      aria-valuenow={angle}
      aria-valuemin={-180}
      aria-valuemax={180}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        const target = (e.target as Element).getAttribute('data-handle');
        drag.current = target === 'roundness' ? 'roundness' : 'angle';
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => {
        if (drag.current) update(e);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <circle cx={C} cy={C} r={R} className="tip-pose-ring" />
      <ellipse cx={C} cy={C} rx={R} ry={ry} transform={`rotate(${-angle} ${C} ${C})`} className="tip-pose-tip" />
      <line
        x1={C - u.x * (R + 4)}
        y1={C - u.y * (R + 4)}
        x2={C + u.x * (R + 4)}
        y2={C + u.y * (R + 4)}
        className="tip-pose-axis"
      />
      <path
        d={`M ${C + u.x * (R + 6)} ${C + u.y * (R + 6)} l ${-u.x * 6 + v.x * 3} ${-u.y * 6 + v.y * 3} l ${-v.x * 6} ${-v.y * 6} Z`}
        className="tip-pose-arrow"
        data-handle="angle"
      />
      {[1, -1].map((s) => (
        <circle
          key={s}
          cx={C + v.x * ry * s}
          cy={C + v.y * ry * s}
          r={3.5}
          className="tip-pose-dot"
          data-handle="roundness"
        />
      ))}
    </svg>
  );
}
