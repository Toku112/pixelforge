/**
 * Brush presets in their groups, as the Brushes panel and the options bar's brush
 * picker show them: a search field, the recently used brushes, then each group
 * (collapsible). Click a preset to use it; double-click to rename it (a group: to
 * rename the group); drag presets onto a group or between presets to move them.
 */
import { useEffect, useReducer, useRef, useState, type DragEvent } from 'react';
import type { BrushPreset } from '../../core/paint/presets';
import { brushPreview } from '../brush-preview';
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { TipThumbnail } from '../shell/TipThumbnail';
import { useUi } from '../state/ui-store';

const DRAG_TYPE = 'application/x-pixelforge-brush';

/** Stroke previews already painted, by preset and settings. */
const strokes = new Map<string, ImageData>();

function PresetStroke({ preset, width, height }: { preset: BrushPreset; width: number; height: number }) {
  const controller = useController();
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = `${width}x${height}:${JSON.stringify(preset.brush)}`;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    el.width = width;
    el.height = height;
    const ctx = el.getContext('2d');
    const known = strokes.get(key);
    if (known) {
      ctx?.putImageData(known, 0, 0);
      return;
    }
    let current = true;
    const brush = { ...preset.brush, size: Math.min(preset.brush.size, height - 6) };
    void brushPreview(controller, brush, width, height, { r: 0.85, g: 0.85, b: 0.85 }).then((rgba) => {
      if (!rgba) return;
      const image = new ImageData(new Uint8ClampedArray(rgba), width, height);
      strokes.set(key, image);
      if (current) ctx?.putImageData(image, 0, 0);
    });
    return () => {
      current = false;
    };
  }, [controller, key, preset.brush, width, height]);
  return <canvas ref={canvas} className="preset-stroke" style={{ width, height }} aria-hidden="true" />;
}

function PresetTip({ preset, box }: { preset: BrushPreset; box: number }) {
  const controller = useController();
  const tip = preset.brush.tip ? (controller.services.brushes.get(preset.brush.tip) ?? null) : null;
  return (
    <span className="preset-tip">
      <TipThumbnail tip={tip} box={box} roundHardness={preset.brush.hardness} />
    </span>
  );
}

export function BrushPresetList({ strokesShown = true }: { strokesShown?: boolean }) {
  const controller = useController();
  const library = controller.services.brushes;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => library.onChange(redraw), [library]);
  useUi((s) => s.toolOptionsVersion);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropAt, setDropAt] = useState<string | null>(null);
  const selected = controller.currentPresetId;
  const query = search.trim().toLowerCase();
  const presets = library.presets().filter((p) => query === '' || p.name.toLowerCase().includes(query));
  const groups = library.groups();
  const recent = query === '' ? library.recent() : [];

  const choose = (p: BrushPreset) => controller.choosePreset(p.id);
  const dragStart = (p: BrushPreset) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, p.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropOn = (group: string | null, before?: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropAt(before ?? `group:${group ?? ''}`);
    },
    onDragLeave: () => setDropAt(null),
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setDropAt(null);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      void library.movePreset(id, group, before);
    },
  });

  const row = (p: BrushPreset) => (
    <div
      key={p.id}
      role="option"
      aria-selected={p.id === selected}
      aria-label={p.name}
      title={p.name}
      tabIndex={p.id === selected ? 0 : -1}
      className={`preset-row${p.id === selected ? ' selected' : ''}${dropAt === p.id ? ' drop-before' : ''}`}
      draggable
      onDragStart={dragStart(p)}
      {...dropOn(p.group, p.id)}
      onClick={() => choose(p)}
      onDoubleClick={() => void controller.renameBrushPreset(p.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose(p);
        }
      }}
    >
      <PresetTip preset={p} box={28} />
      <span className="preset-size" aria-hidden="true">
        {p.brush.size}
      </span>
      <span className="preset-name">{p.name}</span>
      {strokesShown && <PresetStroke preset={p} width={120} height={26} />}
    </div>
  );

  const ungrouped = presets.filter((p) => p.group === null || !groups.includes(p.group));
  return (
    <div className="preset-list">
      <input
        type="search"
        className="preset-search"
        aria-label="Search brushes"
        placeholder="Search brushes"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {recent.length > 0 && (
        <div className="preset-recent" role="listbox" aria-label="Recent brushes" aria-orientation="horizontal">
          {recent.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === selected}
              aria-label={p.name}
              title={p.name}
              className="brush-tip"
              onClick={() => choose(p)}
            >
              <PresetTip preset={p} box={26} />
            </button>
          ))}
        </div>
      )}
      <div className="preset-groups" role="listbox" aria-label="Brush presets" {...dropOn(null)}>
        {groups.map((g) => {
          const inGroup = presets.filter((p) => p.group === g);
          if (query !== '' && inGroup.length === 0) return null;
          const open = query !== '' || !collapsed.has(g);
          return (
            <div key={g} role="group" aria-label={g} className="preset-group">
              <button
                type="button"
                className={`preset-group-header${dropAt === `group:${g}` ? ' drop-into' : ''}`}
                aria-expanded={open}
                onClick={() => {
                  const next = new Set(collapsed);
                  if (next.has(g)) next.delete(g);
                  else next.add(g);
                  setCollapsed(next);
                }}
                onDoubleClick={() => void controller.renameBrushGroup(g)}
                {...dropOn(g)}
              >
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                <Icon name="folder" size={14} />
                <span>{g}</span>
              </button>
              {open && inGroup.map(row)}
            </div>
          );
        })}
        {ungrouped.map(row)}
        {presets.length === 0 && <p className="hint">{query ? 'No brush has that name.' : 'No brushes.'}</p>}
      </div>
    </div>
  );
}
