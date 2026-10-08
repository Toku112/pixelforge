/**
 * Edit > Preferences (Ctrl/Cmd+K): pages listed on the left, the chosen page's
 * settings on the right; OK keeps the changes, Cancel drops them.
 */
import { useState, type FormEvent } from 'react';
import type { PreferenceValues } from '../../app/preferences';
import { rgbToHex, hexToRgb } from '../../core/color/color';
import type { PaintCursor } from '../../tools/types';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

type Page = 'tools' | 'cursors';

const PAGES: [Page, string][] = [
  ['tools', 'Tools'],
  ['cursors', 'Cursors'],
];

const PAINT_CURSORS: [PaintCursor, string][] = [
  ['standard', 'Standard'],
  ['precise', 'Precise'],
  ['normal', 'Normal Brush Tip'],
  ['full', 'Full Size Brush Tip'],
];

export function PreferencesDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'preferences' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [page, setPage] = useState<Page>('tools');
  const [values, setValues] = useState<PreferenceValues>(dialog.values);
  const cursors = values.cursors;
  const setCursors = (changes: Partial<PreferenceValues['cursors']>) =>
    setValues({ ...values, cursors: { ...cursors, ...changes } });
  const outline = cursors.painting === 'normal' || cursors.painting === 'full';

  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve(values);
  };

  return (
    <Modal title="Preferences" onCancel={cancel} className="preferences">
      <form className="dialog-form" onSubmit={submit}>
        <div className="preferences-body">
          <div className="preferences-pages" role="tablist" aria-label="Preference pages" aria-orientation="vertical">
            {PAGES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={page === id}
                className={page === id ? 'active' : undefined}
                onClick={() => setPage(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="preferences-page" role="tabpanel" aria-label={PAGES.find((p) => p[0] === page)![1]}>
            {page === 'tools' && (
              <fieldset className="dialog-fieldset">
                <legend>Options</legend>
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={values.overscroll}
                    onChange={(e) => setValues({ ...values, overscroll: e.target.checked })}
                  />
                  Overscroll
                </label>
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={cursors.hudHardness}
                    onChange={(e) => setCursors({ hudHardness: e.target.checked })}
                  />
                  Vary round brush hardness with vertical HUD movement
                </label>
              </fieldset>
            )}
            {page === 'cursors' && (
              <>
                <fieldset className="dialog-fieldset">
                  <legend>Painting Cursors</legend>
                  <div role="radiogroup" aria-label="Painting cursors">
                    {PAINT_CURSORS.map(([id, label]) => (
                      <label key={id} className="option-check">
                        <input
                          type="radio"
                          name="painting-cursor"
                          checked={cursors.painting === id}
                          onChange={() => setCursors({ painting: id })}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <label className="option-check">
                    <input
                      type="checkbox"
                      checked={cursors.crosshairInTip}
                      disabled={!outline}
                      onChange={(e) => setCursors({ crosshairInTip: e.target.checked })}
                    />
                    Show Crosshair in Brush Tip
                  </label>
                  <label className="option-check">
                    <input
                      type="checkbox"
                      checked={cursors.crosshairWhilePainting}
                      disabled={!outline}
                      onChange={(e) => setCursors({ crosshairWhilePainting: e.target.checked })}
                    />
                    Show Only Crosshair While Painting
                  </label>
                  <p className="hint">Caps Lock switches to the crosshair (and back) while it is on.</p>
                </fieldset>
                <fieldset className="dialog-fieldset">
                  <legend>Brush Preview</legend>
                  <label className="option-check">
                    Color:
                    <input
                      type="color"
                      aria-label="Brush preview color"
                      value={`#${rgbToHex(cursors.previewColor)}`}
                      onChange={(e) =>
                        setCursors({ previewColor: hexToRgb(e.target.value.slice(1)) ?? cursors.previewColor })
                      }
                    />
                  </label>
                </fieldset>
              </>
            )}
          </div>
        </div>
        <div className="modal-buttons">
          <button type="submit" className="primary-button">
            OK
          </button>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
