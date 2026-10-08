/**
 * Color panel (Window > Color, F6): the foreground and background colours (click one
 * to edit it, double-click for the Color Picker), sliders (RGB, HSB, Grayscale or Lab)
 * with their numbers, the hex value, and a colour ramp to pick from (spectrum,
 * grayscale or between the current colours).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { hexToRgb, hsbToRgb, labToRgb, rgbToHex, rgbToHsb, rgbToLab, type HSB, type RGB } from '../../core/color/color';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';

type SliderMode = 'rgb' | 'hsb' | 'gray' | 'lab';
type RampMode = 'spectrum' | 'gray' | 'current';

const css = (c: RGB) => `#${rgbToHex(c)}`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function Channel({
  label,
  value,
  min,
  max,
  suffix,
  stops,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  stops: RGB[];
  onChange: (v: number) => void;
}) {
  const gradient = `linear-gradient(to right, ${stops.map(css).join(', ')})`;
  return (
    <div className="color-channel">
      <span className="color-channel-label">{label}</span>
      <input
        type="range"
        className="color-range"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={Math.round(value)}
        style={{ backgroundImage: gradient }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <NumberField
        label=""
        ariaLabel={`${label} value`}
        value={Math.round(value)}
        min={min}
        max={max}
        suffix={suffix}
        width={44}
        onChange={onChange}
      />
    </div>
  );
}

/** The ramp's colour at (u, v), both 0–1. */
function rampColor(mode: RampMode, u: number, v: number, fg: RGB, bg: RGB): RGB {
  if (mode === 'gray') return { r: 1 - u, g: 1 - u, b: 1 - u };
  if (mode === 'current')
    return { r: fg.r + (bg.r - fg.r) * u, g: fg.g + (bg.g - fg.g) * u, b: fg.b + (bg.b - fg.b) * u };
  // Spectrum: hues across; white at the top, the full hue in the middle, black at the bottom.
  const hue = hsbToRgb({ h: u * 360, s: 1, b: 1 });
  if (v < 0.5) {
    const t = v * 2;
    return { r: 1 + (hue.r - 1) * t, g: 1 + (hue.g - 1) * t, b: 1 + (hue.b - 1) * t };
  }
  const t = (1 - v) * 2;
  return { r: hue.r * t, g: hue.g * t, b: hue.b * t };
}

function Ramp({ mode, fg, bg, onPick }: { mode: RampMode; fg: RGB; bg: RGB; onPick: (c: RGB) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const w = el.clientWidth || 200;
    const h = el.clientHeight || 40;
    el.width = w;
    el.height = h;
    const image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = rampColor(mode, x / (w - 1), y / (h - 1), fg, bg);
        image.data.set([c.r * 255, c.g * 255, c.b * 255, 255], (y * w + x) * 4);
      }
    ctx.putImageData(image, 0, 0);
  }, [mode, fg, bg]);
  const pick = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    onPick(
      rampColor(mode, clamp01((e.clientX - box.left) / box.width), clamp01((e.clientY - box.top) / box.height), fg, bg),
    );
  };
  return (
    <canvas
      ref={canvas}
      className="color-ramp"
      role="img"
      aria-label="Color ramp"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => {
        if (dragging.current) pick(e);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
    />
  );
}

export function ColorPanel() {
  const controller = useController();
  const colors = controller.colors;
  useSyncExternalStore(
    (onChange) => colors.changes.on(onChange),
    () => colors.version,
  );
  const [target, setTarget] = useState<'foreground' | 'background'>('foreground');
  const [mode, setMode] = useState<SliderMode>('rgb');
  const [ramp, setRamp] = useState<RampMode>('spectrum');
  const fg = colors.foreground;
  const bg = colors.background;
  const color = target === 'foreground' ? fg : bg;
  // While the colour is gray or black it has no hue: the hue (and saturation) last set here are shown.
  const [kept, setKept] = useState<{ h: number; s: number }>({ h: 0, s: 0 });
  const measured = rgbToHsb(color);
  const hsb: HSB = {
    h: measured.s === 0 || measured.b === 0 ? kept.h : measured.h,
    s: measured.b === 0 ? kept.s : measured.s,
    b: measured.b,
  };
  const set = (c: RGB) => {
    const next = { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) };
    if (target === 'foreground') colors.setForeground(next);
    else colors.setBackground(next);
  };
  const setHsb = (changes: Partial<HSB>) => {
    const next = { ...hsb, ...changes };
    setKept({ h: next.h, s: next.s });
    set(hsbToRgb(next));
  };
  const lab = rgbToLab(color);
  const gray = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;

  return (
    <div className="color-panel">
      <div className="color-panel-head">
        <div className="color-targets" role="radiogroup" aria-label="Color to edit">
          {(['foreground', 'background'] as const).map((which) => (
            <button
              key={which}
              type="button"
              role="radio"
              aria-checked={target === which}
              aria-label={which === 'foreground' ? 'Foreground color' : 'Background color'}
              title={`${which === 'foreground' ? 'Foreground' : 'Background'} color (double-click for the Color Picker)`}
              className={`color-target ${which}${target === which ? ' active' : ''}`}
              style={{ background: css(which === 'foreground' ? fg : bg) }}
              onClick={() => setTarget(which)}
              onDoubleClick={() => void controller.pickColor(which)}
            />
          ))}
        </div>
        <select aria-label="Color sliders" value={mode} onChange={(e) => setMode(e.target.value as SliderMode)}>
          <option value="rgb">RGB Sliders</option>
          <option value="hsb">HSB Sliders</option>
          <option value="gray">Grayscale Slider</option>
          <option value="lab">Lab Sliders</option>
        </select>
      </div>
      <div className="color-channels">
        {mode === 'rgb' &&
          (['r', 'g', 'b'] as const).map((k) => (
            <Channel
              key={k}
              label={k.toUpperCase()}
              value={color[k] * 255}
              min={0}
              max={255}
              stops={[
                { ...color, [k]: 0 },
                { ...color, [k]: 1 },
              ]}
              onChange={(v) => set({ ...color, [k]: v / 255 })}
            />
          ))}
        {mode === 'hsb' && (
          <>
            <Channel
              label="H"
              value={hsb.h}
              min={0}
              max={360}
              suffix="°"
              stops={[0, 60, 120, 180, 240, 300, 360].map((h) => hsbToRgb({ h, s: hsb.s || 1, b: hsb.b || 1 }))}
              onChange={(h) => setHsb({ h: h % 360 })}
            />
            <Channel
              label="S"
              value={hsb.s * 100}
              min={0}
              max={100}
              suffix="%"
              stops={[hsbToRgb({ ...hsb, s: 0 }), hsbToRgb({ ...hsb, s: 1 })]}
              onChange={(s) => setHsb({ s: s / 100 })}
            />
            <Channel
              label="B"
              value={hsb.b * 100}
              min={0}
              max={100}
              suffix="%"
              stops={[hsbToRgb({ ...hsb, b: 0 }), hsbToRgb({ ...hsb, b: 1 })]}
              onChange={(b) => setHsb({ b: b / 100 })}
            />
          </>
        )}
        {mode === 'gray' && (
          <Channel
            label="K"
            value={(1 - gray) * 100}
            min={0}
            max={100}
            suffix="%"
            stops={[
              { r: 1, g: 1, b: 1 },
              { r: 0, g: 0, b: 0 },
            ]}
            onChange={(k) => set({ r: 1 - k / 100, g: 1 - k / 100, b: 1 - k / 100 })}
          />
        )}
        {mode === 'lab' && (
          <>
            <Channel
              label="L"
              value={lab.L}
              min={0}
              max={100}
              stops={[labToRgb({ ...lab, L: 0 }), labToRgb({ ...lab, L: 50 }), labToRgb({ ...lab, L: 100 })]}
              onChange={(L) => set(labToRgb({ ...lab, L }))}
            />
            <Channel
              label="a"
              value={lab.a}
              min={-128}
              max={127}
              stops={[labToRgb({ ...lab, a: -128 }), labToRgb({ ...lab, a: 0 }), labToRgb({ ...lab, a: 127 })]}
              onChange={(a) => set(labToRgb({ ...lab, a }))}
            />
            <Channel
              label="b"
              value={lab.b}
              min={-128}
              max={127}
              stops={[labToRgb({ ...lab, b: -128 }), labToRgb({ ...lab, b: 0 }), labToRgb({ ...lab, b: 127 })]}
              onChange={(b) => set(labToRgb({ ...lab, b }))}
            />
          </>
        )}
      </div>
      <div className="color-hex">
        <label className="option-field">
          #
          <input
            key={rgbToHex(color)}
            type="text"
            aria-label="Hex color"
            defaultValue={rgbToHex(color)}
            maxLength={7}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const c = hexToRgb(e.currentTarget.value);
              if (c) set(c);
            }}
            onBlur={(e) => {
              const c = hexToRgb(e.currentTarget.value);
              if (c) set(c);
            }}
          />
        </label>
        <select aria-label="Color ramp type" value={ramp} onChange={(e) => setRamp(e.target.value as RampMode)}>
          <option value="spectrum">RGB Spectrum</option>
          <option value="gray">Grayscale Ramp</option>
          <option value="current">Current Colors</option>
        </select>
      </div>
      <Ramp mode={ramp} fg={fg} bg={bg} onPick={set} />
    </div>
  );
}
