/** The options bar: settings and actions for the active tool. */
import { resetView, setViewRotation } from '../../tools/rotate-view/rotate-view-tool';
import { viewActions } from '../../tools/hand/hand-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { Icon, type IconName } from '../icons';
import { useUi } from '../state/ui-store';

const TOOL_ICONS: Record<string, IconName> = { hand: 'hand', 'rotate-view': 'rotateView', zoom: 'zoom' };

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
        <Icon name={TOOL_ICONS[toolId] ?? 'hand'} size={18} />
      </span>
      <span className="options-divider" />
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
                  zoom.mode = mode;
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
                zoom.scrubby = e.target.checked;
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
