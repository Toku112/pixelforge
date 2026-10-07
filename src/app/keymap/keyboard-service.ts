/**
 * Global keyboard handling: turns key presses into app commands and tool switches.
 *
 * - Shortcuts without Ctrl/Cmd/Alt (tool letters, D, X, [ ]…) are ignored while
 *   typing in a text field, and so are the text-editing chords (Ctrl/Cmd + Z, X,
 *   C, V, A, Y) — the field handles those itself.
 * - A chord bound in the keymap is kept from the browser (e.g. Ctrl+S never opens
 *   "Save page") even when its command is not available right now.
 * - Tool keys are spring-loaded: tap to switch tools; hold the key, use the tool,
 *   release, and the previous tool comes back. Shift + a tool's letter cycles
 *   through the tools that share that letter.
 */
import type { AppCommandRegistry } from '../commands/app-commands';
import { chordFromEvent, type Chord, type Platform } from './chord';
import type { Keymap } from './keymap';

export interface ToolKeyTarget {
  activeToolId(): string;
  setActiveTool(id: string): void;
  /** The tool a `tool.*` command selects (the group's current tool), if implemented. */
  toolForCommand(commandId: string): string | undefined;
  /** The next tool in the group of a `tool.*` command (Shift + letter), if any. */
  nextToolForCommand(commandId: string): string | undefined;
}

/** Holding a tool key longer than this (ms) makes the switch temporary. */
export const SPRING_HOLD_MS = 300;

/** Tap-to-switch / hold-to-borrow behaviour of tool keys. */
export class SpringLoadedTools {
  readonly #tools: ToolKeyTarget;
  readonly #holdMs: number;
  #spring: { tool: string; previous: string; start: number; used: boolean } | null = null;

  constructor(tools: ToolKeyTarget, holdMs = SPRING_HOLD_MS) {
    this.#tools = tools;
    this.#holdMs = holdMs;
  }

  keyDown(tool: string, now: number): void {
    if (this.#spring) return; // another tool key is already held
    const previous = this.#tools.activeToolId();
    this.#tools.setActiveTool(tool);
    if (previous !== tool) this.#spring = { tool, previous, start: now, used: false };
  }

  /** The held tool was used (e.g. the canvas was clicked while holding its key). */
  used(): void {
    if (this.#spring) this.#spring.used = true;
  }

  keyUp(tool: string, now: number): void {
    const spring = this.#spring;
    if (!spring || spring.tool !== tool) return;
    this.#spring = null;
    if (spring.used || now - spring.start >= this.#holdMs) this.#tools.setActiveTool(spring.previous);
  }

  /** Forgets a held key (e.g. the window lost focus) and restores the previous tool. */
  reset(): void {
    if (this.#spring) this.#tools.setActiveTool(this.#spring.previous);
    this.#spring = null;
  }
}

const TEXT_EDITING_KEYS = new Set(['Z', 'X', 'C', 'V', 'A', 'Y']);

function isEditable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Navigation keys that widgets (lists, sliders, menus) use themselves. */
const WIDGET_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  'Space',
]);

/** Widgets that handle navigation keys themselves (arrows in a list, a slider, a menu…). */
const KEY_WIDGETS =
  '[role="tree"], [role="slider"], [role="listbox"], [role="radiogroup"], [role="menu"], [role="menubar"], [role="tablist"]';

function inKeyWidget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.closest(KEY_WIDGETS) !== null;
}

/** A modal dialog is open: it handles the keyboard itself. */
function modalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}

export interface KeyboardServiceOptions {
  keymap: Keymap;
  commands: AppCommandRegistry;
  tools: ToolKeyTarget;
  platform: Platform;
  target?: EventTarget;
  now?: () => number;
}

export class KeyboardService {
  readonly spring: SpringLoadedTools;
  readonly #o: KeyboardServiceOptions;
  readonly #target: EventTarget;
  readonly #now: () => number;
  /** Tool held down via its key, so its keyup ends the spring even if modifiers changed. */
  #heldToolKey: { key: string; tool: string } | null = null;

  constructor(options: KeyboardServiceOptions) {
    this.#o = options;
    this.#target = options.target ?? window;
    this.#now = options.now ?? (() => performance.now());
    this.spring = new SpringLoadedTools(options.tools);
    this.#target.addEventListener('keydown', this.#onKeyDown as EventListener, { capture: true });
    this.#target.addEventListener('keyup', this.#onKeyUp as EventListener, { capture: true });
    this.#target.addEventListener('blur', this.#onBlur);
  }

  /** Call when the user starts using the canvas (ends a spring-loaded switch on release). */
  pointerUsed(): void {
    this.spring.used();
  }

  dispose(): void {
    this.#target.removeEventListener('keydown', this.#onKeyDown as EventListener, { capture: true });
    this.#target.removeEventListener('keyup', this.#onKeyUp as EventListener, { capture: true });
    this.#target.removeEventListener('blur', this.#onBlur);
  }

  readonly #onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return;
    const chord = chordFromEvent(e, this.#o.platform);
    if (!chord) return;
    const plain = !chord.mod && !chord.ctrl && !chord.alt;
    // In text fields, keys without Mod/Ctrl type text (Option/Alt + letter types accented
    // characters on macOS), and the text-editing chords edit the field.
    const typing = !chord.mod && !chord.ctrl;
    if (isEditable(e.target) && (typing || (TEXT_EDITING_KEYS.has(chord.key) && !chord.alt))) return;
    if (inKeyWidget(e.target) && typing && WIDGET_KEYS.has(chord.key)) return;
    if (modalOpen()) return;

    if (plain && this.#handleToolKey(chord, e)) return;

    const commands = this.#o.keymap.commandsFor(chord);
    if (commands.length === 0) return;
    // Ours: keep it from the browser even if no command can run right now.
    e.preventDefault();
    if (e.repeat && !this.#repeats(commands)) return;
    for (const id of commands) if (this.#o.commands.run(id)) break;
  };

  readonly #onKeyUp = (e: KeyboardEvent) => {
    const held = this.#heldToolKey;
    if (held && e.key.toUpperCase() === held.key) {
      this.#heldToolKey = null;
      this.spring.keyUp(held.tool, this.#now());
    }
  };

  readonly #onBlur = () => {
    this.#heldToolKey = null;
    this.spring.reset();
  };

  /** Tool letters (and Shift + letter cycling). Returns true if handled. */
  #handleToolKey(chord: Chord, e: KeyboardEvent): boolean {
    const keymap = this.#o.keymap;
    const tools = this.#o.tools;
    if (chord.shift) {
      const base = keymap.commandsFor({ ...chord, shift: false }).find((c) => c.startsWith('tool.'));
      if (!base || keymap.commandsFor(chord).length > 0) return false; // Shift+key has its own binding
      e.preventDefault();
      const next = tools.nextToolForCommand(base);
      if (next && !e.repeat) tools.setActiveTool(next);
      return true;
    }
    const command = keymap.commandsFor(chord).find((c) => c.startsWith('tool.'));
    if (!command) return false;
    e.preventDefault();
    const tool = tools.toolForCommand(command);
    if (!tool || e.repeat) return true;
    this.#heldToolKey = { key: chord.key, tool };
    this.spring.keyDown(tool, this.#now());
    return true;
  }

  /** Zoom and history steps repeat while the key is held; other commands fire once. */
  #repeats(commands: readonly string[]): boolean {
    return commands.some(
      (c) =>
        c === 'view.zoomIn' ||
        c === 'view.zoomOut' ||
        c === 'edit.undo' ||
        c === 'edit.redo' ||
        c.startsWith('move.nudge'),
    );
  }
}
