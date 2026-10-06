/** Tabs of the open documents: name, zoom, mode and an asterisk for unsaved changes. */
import { useController, useWorkspace } from '../AppContext';
import { formatZoom, modeLabel } from '../format';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';

export function DocumentTabs() {
  const controller = useController();
  const liveZoom = useUi((s) => s.view?.zoom);
  const tabs = useWorkspace((w) =>
    w.sessions.map((s) => ({
      session: s,
      id: s.id,
      name: s.doc.name,
      mode: modeLabel(s.doc),
      dirty: w.isDirty(s),
      active: s === w.active,
      zoom: s === w.active ? liveZoom : s.view?.zoom,
    })),
  );
  if (tabs.length === 0) return null;
  return (
    <div className="doc-tabs" role="tablist" aria-label="Open documents">
      {tabs.map((t) => {
        const label = `${t.name}${t.zoom !== undefined ? ` @ ${formatZoom(t.zoom)}` : ''} (${t.mode}${t.dirty ? '*' : ''})`;
        return (
        <div
          key={t.id}
          role="tab"
          aria-label={label}
          aria-selected={t.active}
          tabIndex={t.active ? 0 : -1}
          className={`doc-tab${t.active ? ' active' : ''}`}
          title={t.name}
          onClick={() => controller.workspace.activate(t.id)}
          onAuxClick={(e) => e.button === 1 && void controller.close(t.session)}
        >
          <span className="doc-tab-label">{label}</span>
          <button
            type="button"
            className="doc-tab-close"
            aria-label={`Close ${t.name}`}
            onClick={(e) => {
              e.stopPropagation();
              void controller.close(t.session);
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        );
      })}
    </div>
  );
}
