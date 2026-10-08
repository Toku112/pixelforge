/**
 * Gradients panel (Window > Gradients): the gradient presets in groups. Click one to
 * use it with the Gradient tool; buttons make a group, save the tool's current
 * gradient as a preset, and delete the selected preset. Its menu imports and exports
 * .grd files and restores the default gradients.
 */
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';
import { GradientList } from './GradientList';

export function GradientsPanel() {
  const controller = useController();
  useUi((s) => s.toolOptionsVersion);
  const run = (id: string) => () => controller.commands.run(id);
  return (
    <div className="swatches-panel">
      <GradientList />
      <div className="panel-footer">
        <button
          type="button"
          className="icon-button"
          aria-label="New gradient group"
          title="New gradient group"
          onClick={run('gradients.newGroup')}
        >
          <Icon name="newGroup" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New gradient"
          title="New gradient preset from the Gradient tool's gradient"
          onClick={run('gradients.new')}
        >
          <Icon name="newLayer" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete gradient"
          title="Delete the selected gradient"
          disabled={!controller.commands.isEnabled('gradients.delete')}
          onClick={run('gradients.delete')}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}
