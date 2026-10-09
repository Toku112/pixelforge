/**
 * History panel: the document's states; click a state to go back (or forward) to it.
 * The left column marks the History Brush source: click it on a state to paint from
 * that state with the History Brush, the Art History Brush, Erase to History and
 * Fill > History.
 */
import { useController, useWorkspace } from '../AppContext';
import { Icon } from '../icons';

export function HistoryPanel() {
  const controller = useController();
  const entries = useWorkspace((w) => w.active?.history.entries ?? null);
  if (!entries) return <div className="panel-message">No document is open.</div>;
  const history = () => controller.workspace.active?.history;
  return (
    <ol className="history-list" role="listbox" aria-label="History states">
      {entries.map((entry, i) => (
        <li
          key={entry.id}
          role="option"
          aria-selected={entry.status === 'current'}
          className={`history-row ${entry.status}`}
          onClick={() => void history()?.goTo(i)}
          ref={entry.status === 'current' ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
        >
          <button
            type="button"
            role="radio"
            className={`history-source${entry.source ? ' active' : ''}`}
            aria-checked={entry.source}
            aria-label={`History Brush source: ${entry.label}`}
            title="Paint from this state with the History Brush"
            onClick={(e) => {
              e.stopPropagation();
              void history()
                ?.setSource(i)
                .catch((error: unknown) =>
                  controller.report(
                    'Could not set the History Brush source',
                    error instanceof Error ? error.message : String(error),
                  ),
                );
            }}
          >
            {entry.source ? <Icon name="historyBrush" size={14} /> : null}
          </button>
          <span className="history-icon">{entry.snapshot ? <Icon name="history" size={14} /> : null}</span>
          <span>{entry.label}</span>
        </li>
      ))}
    </ol>
  );
}
