import { describe, expect, it } from 'vitest';
import { AppCommandRegistry } from '../../../../src/app/commands/app-commands';
import { canonicalChord, chordFromEvent, chordLabel, isPlainChord, parseChord } from '../../../../src/app/keymap/chord';
import { DEFAULT_KEYMAP } from '../../../../src/app/keymap/defaults';
import { KeyboardService, SpringLoadedTools, type ToolKeyTarget } from '../../../../src/app/keymap/keyboard-service';
import { Keymap } from '../../../../src/app/keymap/keymap';
import { isBrowserReserved } from '../../../../src/app/keymap/reserved';

const keyEvent = (init: Partial<KeyboardEvent>) => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe('chords', () => {
  it('parse into a canonical order', () => {
    expect(canonicalChord('shift+mod+s')).toBe('Mod+Shift+S');
    expect(canonicalChord('Alt+Shift+Mod+e')).toBe('Mod+Alt+Shift+E');
    expect(canonicalChord('Mod++')).toBe('Mod+=');
    expect(canonicalChord('Option+F9')).toBe('Alt+F9');
    expect(parseChord('Shift+[')).toMatchObject({ key: '[', shift: true, mod: false });
    expect(() => parseChord('Hyper+S')).toThrow('Unknown modifier');
    expect(() => parseChord('Mod+Banana')).toThrow('Unknown key');
  });

  it('come from keyboard events, following the layout for letters', () => {
    expect(chordFromEvent(keyEvent({ key: 's', code: 'KeyS', metaKey: true }), 'mac')).toMatchObject({
      key: 'S',
      mod: true,
      ctrl: false,
    });
    expect(chordFromEvent(keyEvent({ key: 's', code: 'KeyS', ctrlKey: true }), 'other')).toMatchObject({
      key: 'S',
      mod: true,
    });
    expect(chordFromEvent(keyEvent({ key: 'z', code: 'KeyW' }), 'other')?.key).toBe('Z'); // AZERTY: the key labelled Z
    expect(chordFromEvent(keyEvent({ key: 'ß', code: 'KeyS', altKey: true }), 'mac')?.key).toBe('S'); // Option changes the character
    expect(chordFromEvent(keyEvent({ key: '{', code: 'BracketLeft', shiftKey: true }), 'mac')).toMatchObject({
      key: '[',
      shift: true,
    });
    expect(chordFromEvent(keyEvent({ key: '!', code: 'Digit1', shiftKey: true }), 'other')).toMatchObject({
      key: '1',
      shift: true,
    });
    expect(chordFromEvent(keyEvent({ key: 'F5', code: 'F5' }), 'other')?.key).toBe('F5');
    expect(chordFromEvent(keyEvent({ key: ' ', code: 'Space' }), 'other')?.key).toBe('Space');
    expect(chordFromEvent(keyEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 'other')).toBeNull();
    expect(chordFromEvent(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true }), 'mac')).toMatchObject({
      key: 'Tab',
      ctrl: true,
      mod: false,
    });
  });

  it('are labelled for menus per platform', () => {
    expect(chordLabel('Mod+Shift+S', 'mac')).toBe('⇧⌘S');
    expect(chordLabel('Mod+Shift+S', 'other')).toBe('Shift+Ctrl+S');
    expect(chordLabel('Mod+Alt+Shift+K', 'mac')).toBe('⌥⇧⌘K');
    expect(chordLabel('Mod+=', 'other')).toBe('Ctrl++');
    expect(chordLabel('F12', 'mac')).toBe('F12');
    expect(isPlainChord('Shift+B')).toBe(true);
    expect(isPlainChord('Mod+B')).toBe(false);
  });
});

describe('default keymap', () => {
  it('parses every default chord', () => {
    for (const b of DEFAULT_KEYMAP)
      for (const k of [...b.keys, ...(b.mac ?? [])]) expect(() => parseChord(k), `${b.command}: ${k}`).not.toThrow();
    expect(new Set(DEFAULT_KEYMAP.map((b) => b.command)).size).toBe(DEFAULT_KEYMAP.length); // one entry per command
  });

  it.each(['mac', 'other'] as const)('has no conflicting chords on %s', (platform) => {
    expect(new Keymap(platform).conflicts()).toEqual([]);
  });

  it('matches the reference shortcuts for key commands', () => {
    const km = new Keymap('mac');
    expect(km.commandsFor('Mod+I')).toEqual(['image.adjustments.invert']);
    expect(km.commandsFor('Mod+Z')).toEqual(['edit.undo']);
    expect(km.commandsFor('Mod+Shift+Z')).toEqual(['edit.redo']);
    expect(km.commandsFor('Mod+Alt+Z')).toEqual(['edit.toggleLastState']);
    expect(km.commandsFor('Mod+=')).toEqual(['view.zoomIn']);
    expect(km.commandsFor('Mod+0')).toEqual(['view.fitOnScreen']);
    expect(km.commandsFor('Mod+1')).toEqual(['view.actualPixels']);
    expect(km.commandsFor('H')).toEqual(['tool.hand']);
    expect(km.commandsFor('Alt+Shift+M')).toEqual(['blend.set.multiply']);
    expect(km.label('file.saveAs')).toBe('⇧⌘S');
    expect(new Keymap('other').label('file.saveAs')).toBe('Shift+Ctrl+S');
  });

  it('treats Ctrl as Mod on Windows/Linux', () => {
    const km = new Keymap('other');
    expect(km.commandsFor('Mod+Tab')).toEqual(['window.nextDocument']);
    expect(new Keymap('mac').commandsFor('Ctrl+Tab')).toEqual(['window.nextDocument']);
  });

  it('applies user overrides', () => {
    const km = new Keymap('mac', DEFAULT_KEYMAP, { 'image.adjustments.invert': ['Mod+Shift+0'] });
    expect(km.commandsFor('Mod+I')).toEqual([]);
    expect(km.commandsFor('Mod+Shift+0')).toEqual(['image.adjustments.invert']);
  });

  it('reports shortcuts the browser keeps for itself', () => {
    expect(isBrowserReserved('Mod+W', 'other')).toBe(true);
    expect(isBrowserReserved('Mod+S', 'other')).toBe(false);
    expect(isBrowserReserved('Mod+Q', 'mac')).toBe(true);
    const reserved = new Keymap('other').browserReserved().flatMap((c) => c.commands);
    expect(reserved).toEqual(expect.arrayContaining(['file.new', 'file.close', 'window.nextDocument']));
  });
});

function toolTarget(start = 'hand') {
  let active = start;
  const groups: Record<string, string[]> = {
    'tool.hand': ['hand'],
    'tool.zoom': ['zoom'],
    'tool.brush': ['brush', 'pencil'],
  };
  const target: ToolKeyTarget = {
    activeToolId: () => active,
    setActiveTool: (id) => (active = id),
    toolForCommand: (c) => groups[c]?.[0],
    nextToolForCommand: (c) => {
      const g = groups[c];
      if (!g) return undefined;
      return g[(g.indexOf(active) + 1) % g.length];
    },
  };
  return { target, active: () => active };
}

describe('spring-loaded tool keys', () => {
  it('tapping a tool key switches tools for good', () => {
    const t = toolTarget();
    const spring = new SpringLoadedTools(t.target);
    spring.keyDown('zoom', 0);
    spring.keyUp('zoom', 100);
    expect(t.active()).toBe('zoom');
  });

  it('holding a tool key borrows the tool until release', () => {
    const t = toolTarget();
    const spring = new SpringLoadedTools(t.target);
    spring.keyDown('zoom', 0);
    expect(t.active()).toBe('zoom');
    spring.keyUp('zoom', 500);
    expect(t.active()).toBe('hand');
  });

  it('using the tool while its key is down makes the switch temporary even for short presses', () => {
    const t = toolTarget();
    const spring = new SpringLoadedTools(t.target);
    spring.keyDown('zoom', 0);
    spring.used();
    spring.keyUp('zoom', 50);
    expect(t.active()).toBe('hand');
  });
});

describe('KeyboardService', () => {
  function setup() {
    const target = new EventTarget();
    const commands = new AppCommandRegistry();
    const ran: string[] = [];
    let invertEnabled = true;
    commands.register({
      id: 'image.adjustments.invert',
      label: 'Invert',
      run: () => void ran.push('invert'),
      enabled: () => invertEnabled,
    });
    commands.register({ id: 'view.zoomIn', label: 'Zoom In', run: () => void ran.push('zoomIn') });
    const tools = toolTarget();
    let now = 0;
    const service = new KeyboardService({
      keymap: new Keymap('other'),
      commands,
      tools: tools.target,
      platform: 'other',
      target,
      now: () => now,
    });
    const press = (type: 'keydown' | 'keyup', init: Partial<KeyboardEvent>) => {
      const e = Object.assign(new Event(type, { cancelable: true }), {
        key: '',
        code: '',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        ...init,
      });
      target.dispatchEvent(e);
      return e;
    };
    return {
      service,
      ran,
      tools,
      press,
      setNow: (t: number) => (now = t),
      disableInvert: () => (invertEnabled = false),
    };
  }

  it('runs the command bound to a chord and keeps the browser from acting on it', () => {
    const s = setup();
    const e = s.press('keydown', { key: 'i', code: 'KeyI', ctrlKey: true });
    expect(s.ran).toEqual(['invert']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('swallows bound chords whose command is unavailable, and ignores unbound ones', () => {
    const s = setup();
    s.disableInvert();
    expect(s.press('keydown', { key: 'i', code: 'KeyI', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(s.press('keydown', { key: 's', code: 'KeyS', ctrlKey: true }).defaultPrevented).toBe(true); // Save: bound, not implemented
    expect(
      s.press('keydown', { key: 'u', code: 'KeyU', ctrlKey: true, altKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(false); // unbound
    expect(s.ran).toEqual([]);
  });

  it('repeats zoom while held but not other commands', () => {
    const s = setup();
    s.press('keydown', { key: '=', code: 'Equal', ctrlKey: true });
    s.press('keydown', { key: '=', code: 'Equal', ctrlKey: true, repeat: true });
    s.press('keydown', { key: 'i', code: 'KeyI', ctrlKey: true });
    s.press('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, repeat: true });
    expect(s.ran).toEqual(['zoomIn', 'zoomIn', 'invert']);
  });

  it('switches tools with their letters, spring-loaded when held', () => {
    const s = setup();
    s.press('keydown', { key: 'z', code: 'KeyZ' });
    s.press('keyup', { key: 'z', code: 'KeyZ' });
    expect(s.tools.active()).toBe('zoom');
    s.press('keydown', { key: 'h', code: 'KeyH' });
    s.setNow(1000);
    s.press('keyup', { key: 'h', code: 'KeyH' });
    expect(s.tools.active()).toBe('zoom'); // held → back to Zoom
  });

  it('cycles tools sharing a letter with Shift + letter', () => {
    const s = setup();
    s.press('keydown', { key: 'b', code: 'KeyB' });
    s.press('keyup', { key: 'b', code: 'KeyB' });
    s.press('keydown', { key: 'B', code: 'KeyB', shiftKey: true });
    expect(s.tools.active()).toBe('pencil');
    s.press('keydown', { key: 'B', code: 'KeyB', shiftKey: true });
    expect(s.tools.active()).toBe('brush');
  });

  it('stops listening after dispose()', () => {
    const s = setup();
    s.service.dispose();
    s.press('keydown', { key: 'i', code: 'KeyI', ctrlKey: true });
    expect(s.ran).toEqual([]);
  });
});
