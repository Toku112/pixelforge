/**
 * Keyboard chords: a key plus modifiers, written platform-neutrally.
 *
 *   "Mod+Shift+S"  — Mod = Cmd on macOS, Ctrl elsewhere
 *   "Alt+F9"       — Alt = Option on macOS
 *   "Ctrl+Tab"     — Ctrl = the Control key on every platform
 *   "Shift+["      — keys are the unshifted key ("Shift+[" is the "{" key)
 *
 * Canonical form orders modifiers Mod, Ctrl, Alt, Shift and upper-cases letters.
 */

export type Platform = 'mac' | 'other';

export interface Chord {
  key: string;
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export function detectPlatform(): Platform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other';
}

const NAMED_KEYS = new Set([
  'Escape',
  'Tab',
  'Enter',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'CapsLock',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** Physical punctuation/digit keys → the key name used in chords (unshifted, US layout). */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, String(i)])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, String(i)])),
};

export function normalizeKey(key: string): string {
  // "+" shares a key with "=" (shifted), so zoom shortcuts like Ctrl++ are stored as Ctrl+=.
  if (key === '+' || key.toLowerCase() === 'plus') return '=';
  if (key.length === 1) return key.toUpperCase();
  const named = [...NAMED_KEYS].find((k) => k.toLowerCase() === key.toLowerCase());
  if (named) return named;
  throw new Error(`Unknown key "${key}"`);
}

export function parseChord(text: string): Chord {
  const parts = text.split('+');
  // A trailing "+" means the plus key itself (e.g. "Mod++").
  if (text.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  const chord: Chord = { key: '', mod: false, ctrl: false, alt: false, shift: false };
  for (const [i, raw] of parts.entries()) {
    const part = raw.trim();
    const last = i === parts.length - 1;
    const lower = part.toLowerCase();
    if (!last && lower === 'mod') chord.mod = true;
    else if (!last && lower === 'ctrl') chord.ctrl = true;
    else if (!last && (lower === 'alt' || lower === 'option')) chord.alt = true;
    else if (!last && lower === 'shift') chord.shift = true;
    else if (last) chord.key = normalizeKey(part);
    else throw new Error(`Unknown modifier "${part}" in "${text}"`);
  }
  if (!chord.key) throw new Error(`Chord "${text}" has no key`);
  return chord;
}

export function formatChord(chord: Chord): string {
  return [chord.mod && 'Mod', chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.key]
    .filter(Boolean)
    .join('+');
}

/** Canonical string for a chord written in any accepted form. */
export function canonicalChord(text: string): string {
  return formatChord(parseChord(text));
}

/**
 * The chord a keyboard event produces. Letters come from the character typed (so
 * shortcuts follow the user's keyboard layout), falling back to the physical key
 * when a modifier changes the character (e.g. Option+S → "ß" on macOS). Digits and
 * punctuation use the physical key.
 */
export function chordFromEvent(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: Platform,
): Chord | null {
  let key: string | undefined;
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.code in CODE_KEYS) key = CODE_KEYS[e.code];
  else if (e.code === 'Space' || e.key === ' ') key = 'Space';
  else if (NAMED_KEYS.has(e.key)) key = e.key;
  if (!key) return null; // a bare modifier or an unsupported key
  return {
    key,
    mod: platform === 'mac' ? e.metaKey : e.ctrlKey,
    ctrl: platform === 'mac' ? e.ctrlKey : false,
    alt: e.altKey,
    shift: e.shiftKey,
  };
}

const MAC_SYMBOLS: Record<string, string> = {
  Escape: '⎋',
  Tab: '⇥',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
};

/** How a chord is shown in menus: "⇧⌘S" on macOS, "Shift+Ctrl+S" elsewhere. */
export function chordLabel(text: string, platform: Platform): string {
  const c = parseChord(text);
  const key = c.key === '=' ? '+' : c.key;
  if (platform === 'mac') {
    return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${MAC_SYMBOLS[key] ?? key}`;
  }
  return [c.shift && 'Shift', (c.mod || c.ctrl) && 'Ctrl', c.alt && 'Alt', key].filter(Boolean).join('+');
}

/** True for chords with no Mod/Ctrl/Alt (tool letters, brush keys…), which must not fire while typing. */
export function isPlainChord(text: string): boolean {
  const c = parseChord(text);
  return !c.mod && !c.ctrl && !c.alt;
}
