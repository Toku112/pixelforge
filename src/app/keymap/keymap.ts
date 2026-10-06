/**
 * The active keymap: shortcut chords → command ids, for one platform.
 *
 * Built from the defaults plus user overrides (the Keyboard Shortcuts editor will
 * save those). Several commands may share a chord only if they are told apart by
 * context — e.g. tool letters vs. the same letter in a dialog; `conflicts()`
 * reports chords bound to more than one command.
 */
import { canonicalChord, chordLabel, formatChord, parseChord, type Chord, type Platform } from './chord';
import { DEFAULT_KEYMAP, type DefaultBinding } from './defaults';
import { isBrowserReserved } from './reserved';

/** On Windows/Linux the Control key is Mod, so "Ctrl+X" and "Mod+X" are the same chord there. */
function platformChord(text: string, platform: Platform): string {
  const c = parseChord(text);
  if (platform === 'other' && c.ctrl) {
    c.ctrl = false;
    c.mod = true;
  }
  return formatChord(c);
}

export interface Conflict {
  chord: string;
  commands: string[];
}

export class Keymap {
  readonly platform: Platform;
  readonly #byChord = new Map<string, string[]>();
  readonly #byCommand = new Map<string, string[]>();

  constructor(
    platform: Platform,
    bindings: readonly DefaultBinding[] = DEFAULT_KEYMAP,
    overrides: Readonly<Record<string, readonly string[]>> = {},
  ) {
    this.platform = platform;
    for (const b of bindings) {
      if (Object.hasOwn(overrides, b.command)) continue;
      this.#bind(b.command, (platform === 'mac' && b.mac) || b.keys);
    }
    for (const [command, keys] of Object.entries(overrides)) this.#bind(command, keys);
  }

  #bind(command: string, keys: readonly string[]): void {
    const chords = keys.map((k) => platformChord(k, this.platform));
    this.#byCommand.set(command, chords);
    for (const chord of chords) {
      const list = this.#byChord.get(chord) ?? [];
      if (!list.includes(command)) list.push(command);
      this.#byChord.set(chord, list);
    }
  }

  /** Command ids bound to a chord. */
  commandsFor(chord: Chord | string): readonly string[] {
    const text = typeof chord === 'string' ? platformChord(chord, this.platform) : formatChord(chord);
    return this.#byChord.get(text) ?? [];
  }

  /** Chords bound to a command (canonical form). */
  chordsFor(command: string): readonly string[] {
    return this.#byCommand.get(command) ?? [];
  }

  /** Menu label of a command's first shortcut, e.g. "⇧⌘S" / "Shift+Ctrl+S". */
  label(command: string): string | undefined {
    const first = this.chordsFor(command)[0];
    return first ? chordLabel(first, this.platform) : undefined;
  }

  conflicts(): Conflict[] {
    return [...this.#byChord.entries()]
      .filter(([, cmds]) => cmds.length > 1)
      .map(([chord, commands]) => ({ chord, commands }));
  }

  /** Bound chords the browser intercepts in a normal tab, with their commands. */
  browserReserved(): Conflict[] {
    return [...this.#byChord.entries()]
      .filter(([chord]) => isBrowserReserved(chord, this.platform))
      .map(([chord, commands]) => ({ chord, commands }));
  }

  static canonical(text: string): string {
    return canonicalChord(text);
  }
}
