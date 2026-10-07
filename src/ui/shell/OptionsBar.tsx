/** The options bar: settings and actions for the active tool. */
import type { SelectionMode } from '../../core/selection/mask-ops';
import { resetView, setViewRotation } from '../../tools/rotate-view/rotate-view-tool';
import { viewActions } from '../../tools/hand/hand-tool';
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
