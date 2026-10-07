/** Status bar: editable zoom and a choice of document information. */
import { useState } from 'react';
import { evaluateNumberInput } from '../controls/number-expr';
import { useController, useWorkspace } from '../AppContext';
import { documentSizes, formatBytes, formatZoom } from '../format';
import { useUi, type StatusInfo } from '../state/ui-store';

const INFO_LABELS: Record<StatusInfo, string> = {
  sizes: 'Document Sizes',
  dimensions: 'Document Dimensions',
  profile: 'Document Profile',
  scratch: 'Scratch Sizes',
  tool: 'Current Tool',
};

export function StatusBar() {
  const controller = useController();
  const view = useUi((s) => s.view);
  const info = useUi((s) => s.statusInfo);
  const setInfo = useUi((s) => s.setStatusInfo);
  const toolId = useUi((s) => s.activeToolId);
  const doc = useWorkspace((w) => w.active?.doc ?? null);
  useWorkspace((w) => w.version); // refresh sizes after edits
  // Text being typed in the zoom field; null when not editing.
  const [zoomDraft, setZoomDraft] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!doc || !view) return <footer className="status-bar" />;

  const applyZoom = () => {
    if (zoomDraft === null) return;
    setZoomDraft(null);
    const pct = evaluateNumberInput(zoomDraft, view.zoom * 100);
    const ctx = controller.canvas?.context;
    if (pct !== null && pct > 0 && ctx) {
      ctx.viewport.zoomTo(pct / 100);
      ctx.viewChanged();
    }
  };

  let text: string;
  switch (info) {
    case 'sizes': {
      const s = documentSizes(doc);
      text = `Doc: ${formatBytes(s.flattened)}/${formatBytes(s.layered)}`;
      break;
    }
    case 'dimensions':
      text = `${doc.width} px × ${doc.height} px (${Number(doc.resolution.toFixed(2))} ppi)`;
      break;
    case 'profile':
      text = doc.iccProfile
        ? 'Embedded profile (not applied yet)'
        : `Untagged ${doc.mode === 'grayscale' ? 'Gray' : 'RGB'} (${doc.depth}bpc)`;
      break;
    case 'scratch': {
      const stats = controller.services.tileStore.stats;
      text = `Scratch: ${formatBytes(stats.residentBytes)}/${formatBytes(stats.budgetBytes)}`;
      break;
    }
    case 'tool':
      text = controller.tools.byId.get(toolId)?.name ?? '';
      break;
  }

  return (
    <footer className="status-bar">
      <input
        className="status-zoom"
        aria-label="Zoom level"
        value={zoomDraft ?? formatZoom(view.zoom)}
        onFocus={(e) => {
          setZoomDraft(formatZoom(view.zoom));
          e.currentTarget.select();
        }}
        onChange={(e) => setZoomDraft(e.target.value)}
        onBlur={applyZoom}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setZoomDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <div className="status-info">
        <button
          type="button"
          className="status-info-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {text}
        </button>
        {menuOpen && (
          <div className="menu status-menu" role="menu" onPointerLeave={() => setMenuOpen(false)}>
            {(Object.keys(INFO_LABELS) as StatusInfo[]).map((key) => (
              <div
                key={key}
                role="menuitemradio"
                aria-checked={key === info}
                tabIndex={-1}
                className="menu-row"
                onClick={() => {
                  setInfo(key);
                  setMenuOpen(false);
                }}
              >
                <span className="menu-check">{key === info ? '•' : ''}</span>
                <span className="menu-label">{INFO_LABELS[key]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </footer>
  );
}
