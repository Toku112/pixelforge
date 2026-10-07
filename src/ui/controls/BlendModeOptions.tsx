/** The blend-mode menu's options. */
import { BLEND_MODE_LABELS } from '../../core/composite/blend';
import type { BlendMode } from '../../core/document/layers';

/** Blend-mode menu options, grouped like the reference app's menu (separators between families). */
export function BlendModeOptions({ modes }: { modes: readonly BlendMode[] }) {
  const families: BlendMode[][] = [
    ['pass-through', 'normal', 'dissolve'],
    ['darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color'],
    ['lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color'],
    ['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix'],
    ['difference', 'exclusion', 'subtract', 'divide'],
    ['hue', 'saturation', 'color', 'luminosity'],
  ];
  const groups = families.map((f) => f.filter((m) => modes.includes(m))).filter((f) => f.length > 0);
  return (
    <>
      {groups.map((group, i) => [
        i > 0 ? (
          <option key={`sep-${i}`} disabled aria-hidden="true">
            ──────────
          </option>
        ) : null,
        ...group.map((mode) => (
          <option key={mode} value={mode}>
            {BLEND_MODE_LABELS[mode]}
          </option>
        )),
      ])}
    </>
  );
}
