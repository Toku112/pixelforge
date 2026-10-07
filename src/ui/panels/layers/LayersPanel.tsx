/**
 * Layers panel: the layer stack with visibility, thumbnails and names, plus the
 * blend mode, Opacity, Fill and lock controls for the selected layers.
 *
 * Mouse: click selects, Ctrl/Cmd-click adds/removes, Shift-click selects a range;
 * Alt/Option-click on an eye shows only that layer (again: restores); double-click
 * a name to rename it (on the Background: convert it to a normal layer); drag rows
 * to reorder (onto the middle of a group row to put layers inside it); Alt-click a
 * group's triangle opens or closes the groups inside it too.
 * Keyboard (list focused): ↑/↓ select (Shift extends), ←/→ collapse/expand a group,
 * Enter renames, Delete/Backspace deletes, Space shows/hides.
 */
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { AppController } from '../../../app/controller';
import { blendModeMenu } from '../../../core/composite/blend';
import type { ImageDocument } from '../../../core/document/document';
import { layerCapabilities, type BlendMode, type LayerLocks, type LayerNode } from '../../../core/document/layers';
import { useController, useWorkspace } from '../../AppContext';
import { NumberField } from '../../controls/NumberField';
import { Icon, type IconName } from '../../icons';
import { BlendModeOptions } from '../../shell/Dialogs';
import { useUi } from '../../state/ui-store';
import {
  dropPlacement,
  isSoloState,
  layerRows,
  restoreVisibility,
  rowRange,
  soloChanges,
  toggleSelection,
  type DropZone,
  type LayerRow,
} from './layer-rows';
import { ThumbnailCache } from './thumbnail-cache';

/** Thumbnail box, CSS pixels. */
const THUMB_BOX = 32;
/** Pointer travel before a press on a row becomes a drag, CSS pixels. */
const DRAG_THRESHOLD = 4;

const thumbnailCaches = new WeakMap<AppController, ThumbnailCache>();
/** Visibility to restore on a second Alt-click, per document. */
const solos = new WeakMap<ImageDocument, { layerId: string; before: Map<string, boolean> }>();

const LOCK_BUTTONS: { key: keyof LayerLocks; label: string; icon: IconName }[] = [
  { key: 'transparency', label: 'Lock transparent pixels', icon: 'lockTransparency' },
  { key: 'pixels', label: 'Lock image pixels', icon: 'lockPixels' },
  { key: 'position', label: 'Lock position', icon: 'lockPosition' },
  { key: 'all', label: 'Lock all', icon: 'lock' },
];

const percent = (v: number) => Math.round(v * 100);
const rowDomId = (id: string) => `layer-row-${id}`;

export function LayersPanel() {
  const doc = useWorkspace((w) => w.active?.doc ?? null);
  if (!doc) return <div className="panel-message">No document is open.</div>;
  return <LayersView doc={doc} />;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  /** Row pressed; selected on release if no drag happened (it was already selected). */
  rowId: string;
  ids: string[];
  dragging: boolean;
  drop: { targetId: string; zone: DropZone } | null;
}

function LayersView({ doc }: { doc: ImageDocument }) {
  const controller = useController();
  const renamingId = useUi((s) => s.renamingLayerId);
  const setRenaming = useUi((s) => s.setRenamingLayer);
  const treeRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const updateDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const rows = layerRows(doc);
  const active = doc.activeLayer ?? null;
  const selected = doc.selectedLayerIds.map((id) => doc.getLayer(id)).filter((l): l is LayerNode => !!l);
  const canBlend = selected.some((l) => layerCapabilities(l).changeBlendMode);
  const canOpacity = selected.some((l) => layerCapabilities(l).changeOpacity);
  const canLock = selected.some((l) => !(l.kind === 'pixel' && l.isBackground));

  // --- Selection ------------------------------------------------------------

  const select = (id: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const toggle = controller.platform === 'mac' ? e.metaKey : e.ctrlKey;
    if (e.shiftKey && doc.activeLayerId) {
      controller.selectLayers(rowRange(rows, doc.activeLayerId, id), doc.activeLayerId);
    } else if (toggle) {
      const next = toggleSelection(doc.selectedLayerIds, doc.activeLayerId, id);
      controller.selectLayers(next.ids, next.active);
    } else {
      controller.selectLayers([id], id);
    }
  };

  // --- Visibility -----------------------------------------------------------

  const onEye = (e: MouseEvent, layer: LayerNode) => {
    e.stopPropagation();
    if (e.altKey) {
      const solo = solos.get(doc);
      if (solo && solo.layerId === layer.id && isSoloState(doc, layer.id, solo.before)) {
        solos.delete(doc);
        void controller.setLayerProps(restoreVisibility(doc, solo.before));
      } else {
        const { changes, before } = soloChanges(doc, layer.id);
        solos.set(doc, { layerId: layer.id, before });
        void controller.setLayerProps(changes);
      }
      return;
    }
    void controller.setLayerProps([{ layerId: layer.id, props: { visible: !layer.visible } }]);
  };

  // --- Drag and drop ----------------------------------------------------------

  const onRowPointerDown = (e: PointerEvent<HTMLDivElement>, row: LayerRow) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return;
    treeRef.current?.focus({ preventScroll: true });
    const id = row.layer.id;
    const modifiers = e.shiftKey || e.ctrlKey || e.metaKey;
    // Pressing an unselected row selects it at once; a press on a selected row waits
    // for the release, so several selected layers can be dragged together.
    if (!row.selected || modifiers) select(id, e);
    const ids = (doc.selectedLayerIds.includes(id) ? doc.selectedLayerIds : [id]).filter(
      (l) => layerCapabilities(doc.requireLayer(l)).reorder,
    );
    updateDrag({
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      rowId: row.selected && !modifiers ? id : '',
      ids,
      dragging: false,
      drop: null,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= DRAG_THRESHOLD;
      if (!d.dragging && (!moved || d.ids.length === 0)) return;
      const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-layer-id]');
      let drop: DragState['drop'] = null;
      if (rowEl && treeRef.current?.contains(rowEl)) {
        const targetId = rowEl.dataset['layerId']!;
        const box = rowEl.getBoundingClientRect();
        const f = (e.clientY - box.top) / box.height;
        const isGroup = doc.getLayer(targetId)?.kind === 'group';
        const zone: DropZone = isGroup
          ? f < 0.25
            ? 'above'
            : f > 0.75
              ? 'below'
              : 'inside'
          : f < 0.5
            ? 'above'
            : 'below';
        if (dropPlacement(doc, d.ids, targetId, zone)) drop = { targetId, zone };
      }
      updateDrag({ ...d, dragging: true, drop });
    };
    const onUp = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      updateDrag(null);
      if (d.dragging) {
        const place = d.drop && dropPlacement(doc, d.ids, d.drop.targetId, d.drop.zone);
        if (place) void controller.moveLayers(d.ids, place.parentId, place.index);
      } else if (d.rowId) {
        controller.selectLayers([d.rowId], d.rowId);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        updateDrag(null);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
    // Listeners read the latest state through dragRef; re-attach only when a drag starts or ends.
  }, [drag !== null, doc, controller]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Keyboard ----------------------------------------------------------------

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renamingId || e.target !== e.currentTarget) return;
    const index = rows.findIndex((r) => r.active);
    const row = rows[index];
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1)))];
        if (!next) return;
        e.preventDefault();
        if (e.shiftKey && doc.activeLayerId) {
          // Extend from the far end of the selection's anchor (the first selected row).
          const anchor = doc.selectedLayerIds[0] ?? doc.activeLayerId;
          controller.selectLayers(rowRange(rows, anchor, next.layer.id), next.layer.id);
        } else {
          controller.selectLayers([next.layer.id], next.layer.id);
        }
        document.getElementById(rowDomId(next.layer.id))?.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        if (row?.layer.kind === 'group') {
          e.preventDefault();
          controller.setGroupExpanded(row.layer.id, e.key === 'ArrowRight');
        }
        break;
      case 'Enter':
        if (row) {
          e.preventDefault();
          setRenaming(row.layer.id);
        }
        break;
      case ' ':
        if (row) {
          e.preventDefault();
          void controller.setLayerProps([{ layerId: row.layer.id, props: { visible: !row.layer.visible } }]);
        }
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        void controller.deleteSelectedLayers(false);
        break;
    }
  };

  // --- Locks -------------------------------------------------------------------

  const toggleLock = (key: keyof LayerLocks) => {
    if (!active) return;
    const value = !active.locks[key];
    void controller.setLayerProps(
      selected
        .filter((l) => !(l.kind === 'pixel' && l.isBackground))
        .map((l) => ({ layerId: l.id, props: { locks: { ...l.locks, [key]: value } } })),
    );
  };

  const dropIndicator = drag?.dragging && drag.drop ? drag.drop : null;

  return (
    <div className="layers-panel">
      <div className="layers-controls">
        <select
          className="layers-blend"
          aria-label="Blend mode"
          value={active?.blendMode ?? 'normal'}
          disabled={!canBlend}
          onChange={(e) => void controller.setSelectedLayerProps({ blendMode: e.target.value as BlendMode })}
        >
          <BlendModeOptions modes={active ? blendModeMenu(active.kind, doc.mode, doc.depth) : ['normal']} />
        </select>
        <NumberField
          label="Opacity"
          value={percent(active?.opacity ?? 1)}
          min={0}
          max={100}
          suffix="%"
          width={44}
          disabled={!canOpacity}
          onPreview={(v) => void controller.setSelectedLayerProps({ opacity: v / 100 }, true)}
          onChange={(v) => void controller.setSelectedLayerProps({ opacity: v / 100 })}
        />
      </div>
      <div className="layers-controls">
        <span className="layers-lock-label">Lock:</span>
        <div className="layers-locks" role="group" aria-label="Locks">
          {LOCK_BUTTONS.map((b) => (
            <button
              key={b.key}
              type="button"
              className="icon-toggle"
              title={b.label}
              aria-label={b.label}
              aria-pressed={!!active?.locks[b.key]}
              disabled={!canLock}
              onClick={() => toggleLock(b.key)}
            >
              <Icon name={b.icon} size={14} />
            </button>
          ))}
        </div>
        <NumberField
          label="Fill"
          value={percent(active?.fillOpacity ?? 1)}
          min={0}
          max={100}
          suffix="%"
          width={44}
          disabled={!canOpacity}
          onPreview={(v) => void controller.setSelectedLayerProps({ fillOpacity: v / 100 }, true)}
          onChange={(v) => void controller.setSelectedLayerProps({ fillOpacity: v / 100 })}
        />
      </div>
      <div
        ref={treeRef}
        className={`layers-tree${drag?.dragging ? ' dragging' : ''}`}
        role="tree"
        aria-label="Layers"
        aria-multiselectable="true"
        aria-activedescendant={active ? rowDomId(active.id) : undefined}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
      >
        {rows.map((row) => (
          <LayerRowView
            key={row.layer.id}
            doc={doc}
            row={row}
            renaming={renamingId === row.layer.id}
            drop={dropIndicator?.targetId === row.layer.id ? dropIndicator.zone : null}
            onPointerDown={(e) => onRowPointerDown(e, row)}
            onEye={(e) => onEye(e, row.layer)}
          />
        ))}
      </div>
      <div className="layers-footer">
        <button
          type="button"
          className="icon-button"
          title="Create a new group (Alt/Option-click for options)"
          aria-label="New group"
          disabled={!controller.commands.isEnabled('layer.newGroupNoDialog')}
          onClick={(e) => void controller.commands.run(e.altKey ? 'layer.newGroup' : 'layer.newGroupNoDialog')}
        >
          <Icon name="newGroup" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Create a new layer (Alt/Option-click for options)"
          aria-label="New layer"
          disabled={!controller.commands.isEnabled('layer.newNoDialog')}
          onClick={(e) => void controller.commands.run(e.altKey ? 'layer.new' : 'layer.newNoDialog')}
        >
          <Icon name="newLayer" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Delete layer (Alt/Option-click to skip the question)"
          aria-label="Delete layer"
          disabled={!controller.commands.isEnabled('layer.delete')}
          onClick={(e) => void controller.deleteSelectedLayers(!e.altKey)}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}

interface LayerRowViewProps {
  doc: ImageDocument;
  row: LayerRow;
  renaming: boolean;
  drop: DropZone | null;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onEye: (e: MouseEvent) => void;
}

function LayerRowView({ doc, row, renaming, drop, onPointerDown, onEye }: LayerRowViewProps) {
  const controller = useController();
  const setRenaming = useUi((s) => s.setRenamingLayer);
  const { layer } = row;
  const background = layer.kind === 'pixel' && layer.isBackground;
  const classes = [
    'layer-row',
    row.selected && 'selected',
    row.active && 'active',
    !row.shown && 'in-hidden-group',
    drop && `drop-${drop}`,
  ].filter(Boolean);

  const onDoubleClickName = () => {
    if (background) void controller.commands.run('layer.fromBackground');
    else setRenaming(layer.id);
  };

  return (
    <div
      id={rowDomId(layer.id)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={row.selected}
      aria-expanded={layer.kind === 'group' ? layer.expanded : undefined}
      aria-label={layer.name}
      className={classes.join(' ')}
      data-layer-id={layer.id}
      onPointerDown={onPointerDown}
    >
      <button
        type="button"
        className="layer-eye"
        title="Show/hide (Alt/Option-click: show only this layer)"
        aria-label={`Visibility of ${layer.name}`}
        aria-pressed={layer.visible}
        tabIndex={-1}
        onClick={onEye}
      >
        {layer.visible && <Icon name="eye" size={14} />}
      </button>
      <span className="layer-indent" style={{ width: row.depth * 14 }} />
      {layer.kind === 'group' ? (
        <button
          type="button"
          className={`layer-disclosure${layer.expanded ? ' open' : ''}`}
          aria-label={layer.expanded ? `Collapse ${layer.name}` : `Expand ${layer.name}`}
          tabIndex={-1}
          onClick={(e) => controller.setGroupExpanded(layer.id, !layer.expanded, e.altKey)}
        >
          <Icon name="chevronRight" size={12} />
        </button>
      ) : (
        <span className="layer-disclosure-space" />
      )}
      {layer.kind === 'group' ? (
        <span className="layer-folder">
          <Icon name="folder" size={18} />
        </span>
      ) : (
        <LayerThumbnail doc={doc} layerId={layer.id} />
      )}
      {renaming ? (
        <RenameField
          name={layer.name}
          onDone={(name) => {
            setRenaming(null);
            if (name !== null && name.trim() !== '' && name !== layer.name)
              void controller.setLayerProps([{ layerId: layer.id, props: { name } }]);
          }}
        />
      ) : (
        <span className={`layer-name${background ? ' background' : ''}`} onDoubleClick={onDoubleClickName}>
          {layer.name}
        </span>
      )}
      {row.lock !== 'none' && (
        <span
          className={`layer-lock ${row.lock}${row.lockInherited ? ' inherited' : ''}`}
          title={row.lock === 'all' ? 'Fully locked' : 'Partially locked'}
        >
          <Icon name="lock" size={12} />
        </span>
      )}
      {background && row.lock === 'none' && (
        <span className="layer-lock background" title="Background layer">
          <Icon name="lock" size={12} />
        </span>
      )}
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  return (
    <input
      type="text"
      className="layer-rename"
      aria-label="Layer name"
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

function LayerThumbnail({ doc, layerId }: { doc: ImageDocument; layerId: string }) {
  const controller = useController();
  let cache = thumbnailCaches.get(controller);
  if (!cache) thumbnailCaches.set(controller, (cache = new ThumbnailCache(controller.services.renderThumbnail)));
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const layer = doc.getLayer(layerId);
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const image = layer?.kind === 'pixel' ? cache.get(doc, layer, THUMB_BOX * dpr) : null;
  const size = cache.size(doc, THUMB_BOX);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')?.putImageData(image, 0, 0);
  }, [image]);
  return (
    <span className="layer-thumb">
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height }}
        data-testid="layer-thumbnail"
        data-ready={image ? 'true' : 'false'}
      />
    </span>
  );
}
