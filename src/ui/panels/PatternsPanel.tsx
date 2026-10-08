/**
 * Patterns panel (Window > Patterns): the patterns in groups. Click one to choose it
 * (the Pattern Stamp and Edit > Fill use it); buttons make a group, define a pattern
 * from the image, and delete the selected pattern. Its menu imports and exports .pat
 * files and restores the default patterns.
 */
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';
import { PatternList } from './PatternList';

export function PatternsPanel() {
  const controller = useController();
  useUi((s) => s.toolOptionsVersion);
  const run = (id: string) => () => controller.commands.run(id);
  return (
    <div className="swatches-panel">
      <PatternList selectedId={controller.currentPatternId} onPick={(id) => controller.choosePattern(id)} />
      <div className="panel-footer">
        <button
          type="button"
          className="icon-button"
          aria-label="New pattern group"
          title="New pattern group"
          onClick={run('patterns.newGroup')}
        >
          <Icon name="newGroup" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New pattern"
          title="New pattern from the image (Edit > Define Pattern)"
          disabled={!controller.commands.isEnabled('edit.definePattern')}
          onClick={run('edit.definePattern')}
        >
          <Icon name="newLayer" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete pattern"
          title="Delete the selected pattern"
          disabled={!controller.commands.isEnabled('patterns.delete')}
          onClick={run('patterns.delete')}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}
