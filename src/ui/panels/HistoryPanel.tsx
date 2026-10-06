/** History panel: the document's states; click a state to go back (or forward) to it. */
import { useController, useWorkspace } from '../AppContext';
import { Icon } from '../icons';

export function HistoryPanel() {
  const controller = useController();
  const entries = useWorkspace((w) => w.active?.history.entries ?? null);
  if (!entries) return <div className="panel-message">No document is open.</div>;
  return (
    <ol className="history-list" role="listbox" aria-label="History states">
      {entries.map((entry, i) => (
        <li
          key={entry.id}
          role="option"
          aria-selected={entry.status === 'current'}
          className={`history-row ${entry.status}`}
          onClick={() => void controller.workspace.active?.history.goTo(i)}
        >
          <span className="history-icon">{entry.snapshot ? <Icon name="history" size={14} /> : null}</span>
          <span>{entry.label}</span>
        </li>
      ))}
    </ol>
  );
}
