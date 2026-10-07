/** The options bar: settings and actions for the active tool. */
import type { SelectionMode } from '../../core/selection/mask-ops';
import { resetView, setViewRotation } from '../../tools/rotate-view/rotate-view-tool';
import { CropTool } from '../../tools/crop/crop-tool';
import { viewActions } from '../../tools/hand/hand-tool';
import { MoveTool } from '../../tools/move/move-tool';
import { PaintingTool } from '../../tools/paint/paint-tool';
import { MarqueeTool, SingleLineMarqueeTool, type MarqueeStyle } from '../../tools/selection/marquee-tool';
import { SelectionTool } from '../../tools/selection/selection-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { Icon, type IconName } from '../icons';
import { useUi } from '../state/ui-store';
import { toolIcon } from '../tool-icons';

const SELECTION_MODES: [SelectionMode, string, IconName][] = [
  ['new', 'New selection', 'selectionNew'],
  ['add', 'Add to selection', 'selectionAdd'],
  ['subtract', 'Subtract from selection', 'selectionSubtract'],
  ['intersect', 'Intersect with selection', 'selectionIntersect'],
];

const MARQUEE_STYLES: [MarqueeStyle, string][] = [
  ['normal', 'Normal'],
  ['fixed-ratio', 'Fixed Ratio'],
  ['fixed-size', 'Fixed Size'],
];

/** Options of the Move tool. */
function MoveOptions({ tool }: { tool: MoveTool }) {
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  return (
    <>
      <label className="option-check">
        <input
          type="checkbox"
          checked={tool.options.autoSelect}
          onChange={(e) => {
            tool.setOptions({ autoSelect: e.target.checked });
            bump();
          }}
        />
        Auto-Select:
      </label>
      <select
        className="option-select"
        aria-label="Auto-select target"
        value={tool.options.autoSelectTarget}
        onChange={(e) => {
          tool.setOptions({ autoSelectTarget: e.target.value as 'layer' | 'group' });
          bump();
        }}
      >
        <option value="layer">Layer</option>
        <option value="group">Group</option>
      </select>
    </>
  );
}

const CROP_RATIOS: [string, string, number, number][] = [
  ['free', 'Ratio', 0, 0],
  ['original', 'Original Ratio', 0, 0],
  ['1:1', '1 : 1 (Square)', 1, 1],
  ['4:5', '4 : 5 (8 : 10)', 4, 5],
  ['5:7', '5 : 7', 5, 7],
  ['2:3', '2 : 3 (4 : 6)', 2, 3],
  ['16:9', '16 : 9', 16, 9],
];

/** Options of the Crop tool. */
function CropOptions({ tool }: { tool: CropTool }) {
  const controller = useController();
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const ctx = () => controller.canvas?.context;
  const { ratioW, ratioH } = tool.options;
  const preset = CROP_RATIOS.find(([id, , w, h]) => id !== 'original' && w === ratioW && h === ratioH)?.[0] ?? 'free';
  const set = (changes: Partial<CropTool['options']>) => {
    tool.setOptions(changes, ctx());
    bump();
  };
  const choose = (id: string) => {
    const doc = ctx()?.document;
    if (id === 'original') {
      if (doc) set({ ratioW: doc.width, ratioH: doc.height });
      return;
    }
    const entry = CROP_RATIOS.find(([key]) => key === id);
    if (entry) set({ ratioW: entry[2], ratioH: entry[3] });
  };
  const act = (fn: (c: NonNullable<ReturnType<typeof ctx>>) => void) => () => {
    const c = ctx();
    if (c) fn(c);
  };
  return (
    <>
      <select
        className="option-select"
        aria-label="Crop ratio preset"
        value={preset}
        onChange={(e) => choose(e.target.value)}
      >
        {CROP_RATIOS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <NumberField
        label="Ratio width"
        hideLabel
        value={ratioW}
        min={0}
        max={300000}
        precision={3}
        width={48}
        onChange={(v) => set({ ratioW: v })}
      />
      <button
        type="button"
        className="option-icon"
        aria-label="Swap width and height"
        title="Swap width and height"
        onClick={() => set({ ratioW: ratioH, ratioH: ratioW })}
      >
        <Icon name="swap" size={16} />
      </button>
      <NumberField
        label="Ratio height"
        hideLabel
        value={ratioH}
        min={0}
        max={300000}
        precision={3}
        width={48}
        onChange={(v) => set({ ratioH: v })}
      />
      <button type="button" className="option-button" onClick={() => set({ ratioW: 0, ratioH: 0 })}>
        Clear
      </button>
      <span className="options-divider" />
      <label className="option-check">
        <input
          type="checkbox"
          checked={tool.options.deleteCropped}
          onChange={(e) => set({ deleteCropped: e.target.checked })}
        />
        Delete Cropped Pixels
      </label>
      <span className="options-divider" />
      <button
        type="button"
        className="option-icon"
        aria-label="Cancel crop"
        title="Cancel crop (Esc)"
        onClick={act((c) => tool.reset(c))}
      >
        <Icon name="cancelCircle" size={16} />
      </button>
      <button
        type="button"
        className="option-icon"
        aria-label="Commit crop"
        title="Commit crop (Enter)"
        onClick={act((c) => tool.commit(c))}
      >
        <Icon name="check" size={16} />
      </button>
    </>
  );
}

/** Options of the Brush and Eraser. */
function PaintOptions({ tool }: { tool: PaintingTool }) {
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const o = tool.options;
  const set = (changes: Partial<typeof o>) => {
    tool.setOptions(changes);
    bump();
  };
  const percent = (v: number) => Math.round(v * 100);
  return (
    <>
      <NumberField
        label="Size:"
        value={o.size}
        min={1}
        max={5000}
        suffix=" px"
        width={58}
        onChange={(size) => set({ size })}
      />
      <NumberField
        label="Hardness:"
        value={percent(o.hardness)}
        min={0}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ hardness: v / 100 })}
      />
      <span className="options-divider" />
      <NumberField
        label="Opacity:"
        value={percent(o.opacity)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ opacity: v / 100 })}
      />
      <button
        type="button"
        className={`option-icon${o.pressureOpacity ? ' active' : ''}`}
        aria-pressed={o.pressureOpacity}
        aria-label="Pen pressure controls opacity"
        title="Pen pressure controls opacity"
        onClick={() => set({ pressureOpacity: !o.pressureOpacity })}
      >
        <Icon name="penPressure" size={16} />
      </button>
      <NumberField
        label="Flow:"
        value={percent(o.flow)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ flow: v / 100 })}
      />
      <NumberField
        label="Spacing:"
        value={percent(o.spacing)}
        min={1}
        max={1000}
        suffix="%"
        width={50}
        onChange={(v) => set({ spacing: v / 100 })}
      />
      <button
        type="button"
        className={`option-icon${o.pressureSize ? ' active' : ''}`}
        aria-pressed={o.pressureSize}
        aria-label="Pen pressure controls size"
        title="Pen pressure controls size"
        onClick={() => set({ pressureSize: !o.pressureSize })}
      >
        <Icon name="penPressureSize" size={16} />
      </button>
    </>
  );
}

/** Options of the marquee and lasso tools. */
function SelectionOptions({ tool }: { tool: SelectionTool }) {
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const o = tool.options;
  const set = (changes: Partial<typeof o>) => {
    tool.setOptions(changes);
    bump();
  };
  const marquee = tool instanceof MarqueeTool ? tool : null;
  const line = tool instanceof SingleLineMarqueeTool;
  // Whole-pixel rectangles have no edges to smooth: Anti-alias is greyed out, as in the reference app.
  const rect = tool.id === 'marquee-rect';
  return (
    <>
      <div className="segmented" role="radiogroup" aria-label="Selection mode">
        {SELECTION_MODES.map(([mode, label, icon]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={o.mode === mode}
            aria-label={label}
            title={label}
            className={`option-icon${o.mode === mode ? ' active' : ''}`}
            onClick={() => set({ mode })}
          >
            <Icon name={icon} size={16} />
          </button>
        ))}
      </div>
      <span className="options-divider" />
      {!line && (
        <NumberField
          label="Feather:"
          value={o.feather}
          min={0}
          max={1000}
          precision={1}
          suffix=" px"
          width={58}
          onChange={(feather) => set({ feather })}
        />
      )}
      {!line && (
        <label className="option-check">
          <input
            type="checkbox"
            checked={o.antiAlias && !rect}
            disabled={rect}
            onChange={(e) => set({ antiAlias: e.target.checked })}
          />
          Anti-alias
        </label>
      )}
      {marquee && (
        <>
          <span className="options-divider" />
          <label className="option-check">
            Style:
            <select
              className="option-select"
              value={marquee.options.style}
              onChange={(e) => {
                marquee.setOptions({ style: e.target.value as MarqueeStyle });
                bump();
              }}
            >
              {MARQUEE_STYLES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {marquee.options.style !== 'normal' && (
            <>
              <NumberField
                label="Width:"
                value={marquee.options.width}
                min={marquee.options.style === 'fixed-size' ? 1 : 0.001}
                max={300000}
                precision={marquee.options.style === 'fixed-size' ? 0 : 3}
                suffix={marquee.options.style === 'fixed-size' ? ' px' : ''}
                width={64}
                onChange={(width) => {
                  marquee.setOptions({ width });
                  bump();
                }}
              />
              <NumberField
                label="Height:"
                value={marquee.options.height}
                min={marquee.options.style === 'fixed-size' ? 1 : 0.001}
                max={300000}
                precision={marquee.options.style === 'fixed-size' ? 0 : 3}
                suffix={marquee.options.style === 'fixed-size' ? ' px' : ''}
                width={64}
                onChange={(height) => {
                  marquee.setOptions({ height });
                  bump();
                }}
              />
            </>
          )}
        </>
      )}
    </>
  );
}

function ViewButtons() {
  const controller = useController();
  const ctx = () => controller.canvas?.context;
  const run = (fn: (c: NonNullable<ReturnType<typeof ctx>>) => void) => () => {
    const c = ctx();
    if (c?.document) fn(c);
  };
  return (
    <>
      <button type="button" className="option-button" onClick={run((c) => viewActions.actualPixels(c))}>
        100%
      </button>
      <button type="button" className="option-button" onClick={run((c) => viewActions.fitOnScreen(c))}>
        Fit Screen
      </button>
      <button type="button" className="option-button" onClick={run((c) => viewActions.fillScreen(c))}>
        Fill Screen
      </button>
    </>
  );
}

export function OptionsBar() {
  const controller = useController();
  const toolId = useUi((s) => s.activeToolId);
  const view = useUi((s) => s.view);
  useUi((s) => s.toolOptionsVersion);
  const bump = useUi((s) => s.bumpToolOptions);
  const zoom = controller.tools.zoom.options;
  const tool = controller.tools.byId.get(toolId);

  return (
    <div className="options-bar" role="toolbar" aria-label="Tool options">
      <span className="options-tool-icon" title={tool?.name}>
        <Icon name={toolIcon(toolId)} size={18} />
      </span>
      <span className="options-divider" />
      {tool instanceof SelectionTool && <SelectionOptions key={tool.id} tool={tool} />}
      {tool instanceof PaintingTool && <PaintOptions key={tool.id} tool={tool} />}
      {tool instanceof MoveTool && <MoveOptions tool={tool} />}
      {tool instanceof CropTool && <CropOptions tool={tool} />}
      {toolId === 'hand' && <ViewButtons />}
      {toolId === 'zoom' && (
        <>
          <div className="segmented" role="radiogroup" aria-label="Zoom direction">
            {(['in', 'out'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={zoom.mode === mode}
                aria-label={mode === 'in' ? 'Zoom in' : 'Zoom out'}
                title={mode === 'in' ? 'Zoom in' : 'Zoom out'}
                className={`option-icon${zoom.mode === mode ? ' active' : ''}`}
                onClick={() => {
                  controller.tools.zoom.setOptions({ mode });
                  bump();
                  controller.canvas?.toolChanged();
                }}
              >
                <Icon name={mode === 'in' ? 'zoomIn' : 'zoomOut'} size={16} />
              </button>
            ))}
          </div>
          <label className="option-check">
            <input
              type="checkbox"
              checked={zoom.scrubby}
              onChange={(e) => {
                controller.tools.zoom.setOptions({ scrubby: e.target.checked });
                bump();
              }}
            />
            Scrubby Zoom
          </label>
          <ViewButtons />
        </>
      )}
      {toolId === 'rotate-view' && (
        <>
          <NumberField
            label="Rotation Angle:"
            value={view?.rotation ?? 0}
            precision={1}
            suffix="°"
            min={-180}
            max={180}
            onChange={(v) => {
              const ctx = controller.canvas?.context;
              if (ctx?.document) setViewRotation(ctx, v);
            }}
          />
          <button
            type="button"
            className="option-button"
            onClick={() => {
              const ctx = controller.canvas?.context;
              if (ctx?.document) resetView(ctx);
            }}
          >
            Reset View
          </button>
        </>
      )}
    </div>
  );
}
