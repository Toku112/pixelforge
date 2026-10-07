/**
 * Feature flags. Unfinished features stay hidden unless a flag is on
 * (CLAUDE.md §4). Flags come from `?flags=a,b` in the URL or localStorage
 * `pixelforge.flags`; they are for development, not user settings.
 */
export const FLAGS = {
  /** Show menu items that are not implemented yet (greyed out) to see the full menu structure. */
  showUnimplementedMenuItems: 'show-unimplemented',
} as const;

export type FlagName = (typeof FLAGS)[keyof typeof FLAGS];

function readFlags(): Set<string> {
  const flags = new Set<string>();
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('flags');
    const fromStorage = window.localStorage.getItem('pixelforge.flags');
    for (const list of [fromUrl, fromStorage])
      for (const f of (list ?? '').split(',')) if (f.trim()) flags.add(f.trim());
  } catch {
    // Storage may be unavailable (private mode); flags are optional.
  }
  return flags;
}

let active: Set<string> | null = null;

export function isFlagOn(flag: FlagName): boolean {
  active ??= readFlags();
  return active.has(flag);
}
