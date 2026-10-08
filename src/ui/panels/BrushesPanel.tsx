/**
 * Brushes panel (Window > Brushes): the size of the current brush, then the brush
 * presets in groups (with a stroke preview each), and buttons to make a group, make
 * a preset from the current brush, and delete the selected preset. Its menu also
 * imports and exports brush files.
 */
import { PaintingTool } from '../../tools/paint/paint-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';
import { BrushPresetList } from './BrushPresetList';

export function BrushesPanel() {
  const controller = useController();
  const toolId = useUi((s) => s.activeToolId);
  useUi((s) => s.toolOptionsVersion);
  const bump = useUi((s) => s.bumpToolOptions);
  const tool = controller.tools.byId.get(toolId);
  const painting = tool instanceof PaintingTool ? tool : null;
  const run = (id: string) => () => controller.commands.run(id);
  return (
    <div className="brushes-panel">
      <div className="brushes-size">
        <NumberField
          label="Size:"
          value={painting?.options.size ?? controller.tools.brush.options.size}
          min={1}
          max={5000}
          suffix=" px"
          width={64}
          disabled={!painting}
          onChange={(size) => {
            painting?.setOptions({ size });
            bump();
          }}
        />
      </div>
      <BrushPresetList />
      <div className="panel-footer">
        <button
          type="button"
          className="icon-button"
          aria-label="New brush group"
          title="New brush group"
          onClick={run('brushes.newGroup')}
        >
          <Icon name="newGroup" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New brush preset"
          title="New brush preset from the current brush"
          onClick={run('brushes.newPreset')}
        >
          <Icon name="newLayer" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete brush"
          title="Delete the selected brush"
          disabled={!controller.commands.isEnabled('brushes.delete')}
          onClick={run('brushes.delete')}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}
