/**
 * Default keyboard shortcuts, matching the reference app's default set on macOS
 * and Windows (CLAUDE.md §7). Chords are platform-neutral (see chord.ts): Mod is
 * Cmd/Ctrl and Alt is Option/Alt; `mac` overrides the few chords that differ.
 *
 * Commands that are not implemented yet are listed too: their shortcuts do nothing
 * until the command is registered, and the Keyboard Shortcuts editor shows them.
 */

export interface DefaultBinding {
  command: string;
  keys: readonly string[];
  /** macOS chords, when they differ from `keys`. */
  mac?: readonly string[];
}

/** Menu and global commands. */
const MENU: DefaultBinding[] = [
  // File
  { command: 'file.new', keys: ['Mod+N'] },
  { command: 'file.open', keys: ['Mod+O'] },
  { command: 'file.openAs', keys: ['Mod+Alt+Shift+O'] },
  { command: 'file.close', keys: ['Mod+W'] },
  { command: 'file.closeAll', keys: ['Mod+Alt+W'] },
  { command: 'file.closeOthers', keys: ['Mod+Alt+P'] },
  { command: 'file.save', keys: ['Mod+S'] },
  { command: 'file.saveAs', keys: ['Mod+Shift+S'] },
  { command: 'file.saveCopy', keys: ['Mod+Alt+S'] },
  { command: 'file.saveForWeb', keys: ['Mod+Alt+Shift+S'] },
  { command: 'file.exportAs', keys: ['Mod+Alt+Shift+W'] },
  { command: 'file.revert', keys: ['F12'] },
  { command: 'file.fileInfo', keys: ['Mod+Alt+Shift+I'] },
  { command: 'file.print', keys: ['Mod+P'] },
  { command: 'file.printOneCopy', keys: ['Mod+Alt+Shift+P'] },
  // Edit
  { command: 'edit.undo', keys: ['Mod+Z'] },
  { command: 'edit.redo', keys: ['Mod+Shift+Z'] },
  { command: 'edit.toggleLastState', keys: ['Mod+Alt+Z'] },
  { command: 'edit.fade', keys: ['Mod+Shift+F'] },
  { command: 'edit.cut', keys: ['Mod+X', 'F2'] },
  { command: 'edit.copy', keys: ['Mod+C', 'F3'] },
  { command: 'edit.copyMerged', keys: ['Mod+Shift+C'] },
  { command: 'edit.paste', keys: ['Mod+V', 'F4'] },
  { command: 'edit.pasteInPlace', keys: ['Mod+Shift+V'] },
  { command: 'edit.pasteInto', keys: ['Mod+Alt+Shift+V'] },
  { command: 'edit.clear', keys: ['Delete', 'Backspace'] },
  { command: 'edit.search', keys: ['Mod+F'] },
  { command: 'edit.fill', keys: ['Shift+F5', 'Shift+Backspace'] },
  { command: 'edit.fillForeground', keys: ['Alt+Backspace', 'Alt+Delete'] },
  { command: 'edit.fillBackground', keys: ['Mod+Backspace', 'Mod+Delete'] },
  { command: 'edit.fillForegroundPreserve', keys: ['Alt+Shift+Backspace'] },
  { command: 'edit.fillBackgroundPreserve', keys: ['Mod+Shift+Backspace'] },
  { command: 'edit.contentAwareScale', keys: ['Mod+Alt+Shift+C'] },
  { command: 'edit.freeTransform', keys: ['Mod+T'] },
  { command: 'edit.transformAgain', keys: ['Mod+Shift+T'] },
  { command: 'edit.colorSettings', keys: ['Mod+Shift+K'] },
  { command: 'edit.keyboardShortcuts', keys: ['Mod+Alt+Shift+K'] },
  { command: 'edit.menus', keys: ['Mod+Alt+Shift+M'] },
  { command: 'edit.preferences', keys: ['Mod+K'] },
  // Image
  { command: 'image.adjustments.levels', keys: ['Mod+L'] },
  { command: 'image.adjustments.curves', keys: ['Mod+M'] },
  { command: 'image.adjustments.hueSaturation', keys: ['Mod+U'] },
  { command: 'image.adjustments.colorBalance', keys: ['Mod+B'] },
  { command: 'image.adjustments.blackWhite', keys: ['Mod+Alt+Shift+B'] },
  { command: 'image.adjustments.invert', keys: ['Mod+I'] },
  { command: 'image.adjustments.desaturate', keys: ['Mod+Shift+U'] },
  { command: 'image.autoTone', keys: ['Mod+Shift+L'] },
  { command: 'image.autoContrast', keys: ['Mod+Alt+Shift+L'] },
  { command: 'image.autoColor', keys: ['Mod+Shift+B'] },
  { command: 'image.imageSize', keys: ['Mod+Alt+I'] },
  { command: 'image.canvasSize', keys: ['Mod+Alt+C'] },
  // Layer
  { command: 'layer.new', keys: ['Mod+Shift+N'] },
  { command: 'layer.newNoDialog', keys: ['Mod+Alt+Shift+N'] },
  { command: 'layer.viaCopy', keys: ['Mod+J'] },
  { command: 'layer.viaCut', keys: ['Mod+Shift+J'] },
  { command: 'layer.clippingMask', keys: ['Mod+Alt+G'] },
  { command: 'layer.group', keys: ['Mod+G'] },
  { command: 'layer.ungroup', keys: ['Mod+Shift+G'] },
  { command: 'layer.hide', keys: ['Mod+,'] },
  { command: 'layer.bringToFront', keys: ['Mod+Shift+]'] },
  { command: 'layer.bringForward', keys: ['Mod+]'] },
  { command: 'layer.sendBackward', keys: ['Mod+['] },
  { command: 'layer.sendToBack', keys: ['Mod+Shift+['] },
  { command: 'layer.lock', keys: ['Mod+/'] },
  { command: 'layer.mergeDown', keys: ['Mod+E'] },
  { command: 'layer.mergeVisible', keys: ['Mod+Shift+E'] },
  { command: 'layer.stampVisible', keys: ['Mod+Alt+Shift+E'] },
  // Select
  { command: 'select.all', keys: ['Mod+A'] },
  { command: 'select.deselect', keys: ['Mod+D'] },
  { command: 'select.reselect', keys: ['Mod+Shift+D'] },
  { command: 'select.inverse', keys: ['Mod+Shift+I', 'Shift+F7'] },
  { command: 'select.allLayers', keys: ['Mod+Alt+A'] },
  { command: 'select.findLayers', keys: ['Mod+Alt+Shift+F'] },
  { command: 'select.selectAndMask', keys: ['Mod+Alt+R'] },
  { command: 'select.feather', keys: ['Shift+F6'] },
  // Filter
  { command: 'filter.last', keys: ['Mod+Alt+F'] },
  { command: 'filter.adaptiveWideAngle', keys: ['Mod+Alt+Shift+A'] },
  { command: 'filter.cameraRaw', keys: ['Mod+Shift+A'] },
  { command: 'filter.lensCorrection', keys: ['Mod+Shift+R'] },
  { command: 'filter.liquify', keys: ['Mod+Shift+X'] },
  { command: 'filter.vanishingPoint', keys: ['Mod+Alt+V'] },
  // View
  { command: 'view.proofColors', keys: ['Mod+Y'] },
  { command: 'view.gamutWarning', keys: ['Mod+Shift+Y'] },
  { command: 'view.zoomIn', keys: ['Mod+=', 'Mod+Shift+='] },
  { command: 'view.zoomOut', keys: ['Mod+-'] },
  { command: 'view.fitOnScreen', keys: ['Mod+0'] },
  { command: 'view.actualPixels', keys: ['Mod+1'] },
  { command: 'view.extras', keys: ['Mod+H'] },
  { command: 'view.targetPath', keys: ['Mod+Shift+H'] },
  { command: 'view.grid', keys: ["Mod+'"] },
  { command: 'view.guides', keys: ['Mod+;'] },
  { command: 'view.rulers', keys: ['Mod+R'] },
  { command: 'view.snap', keys: ['Mod+Shift+;'] },
  { command: 'view.lockGuides', keys: ['Mod+Alt+;'] },
  // Window
  { command: 'window.brushSettings', keys: ['F5'] },
  { command: 'window.color', keys: ['F6'] },
  { command: 'window.layers', keys: ['F7'] },
  { command: 'window.info', keys: ['F8'] },
  { command: 'window.actions', keys: ['Alt+F9'], mac: ['Alt+F9'] },
  { command: 'window.nextDocument', keys: ['Ctrl+Tab'] },
  { command: 'window.previousDocument', keys: ['Ctrl+Shift+Tab'] },
  // Help
  { command: 'help.help', keys: ['F1'] },
];

/** Tool letters (Shift+letter cycles tools sharing the letter). */
const TOOLS: DefaultBinding[] = [
  { command: 'tool.move', keys: ['V'] },
  { command: 'tool.marquee', keys: ['M'] },
  { command: 'tool.lasso', keys: ['L'] },
  { command: 'tool.objectSelection', keys: ['W'] },
  { command: 'tool.crop', keys: ['C'] },
  { command: 'tool.frame', keys: ['K'] },
  { command: 'tool.eyedropper', keys: ['I'] },
  { command: 'tool.healing', keys: ['J'] },
  { command: 'tool.brush', keys: ['B'] },
  { command: 'tool.stamp', keys: ['S'] },
  { command: 'tool.historyBrush', keys: ['Y'] },
  { command: 'tool.eraser', keys: ['E'] },
  { command: 'tool.gradient', keys: ['G'] },
  { command: 'tool.dodge', keys: ['O'] },
  { command: 'tool.pen', keys: ['P'] },
  { command: 'tool.type', keys: ['T'] },
  { command: 'tool.pathSelection', keys: ['A'] },
  { command: 'tool.shape', keys: ['U'] },
  { command: 'tool.hand', keys: ['H'] },
  { command: 'tool.rotateView', keys: ['R'] },
  { command: 'tool.zoom', keys: ['Z'] },
];

/** Single-key and painting shortcuts. */
const KEYS: DefaultBinding[] = [
  { command: 'color.default', keys: ['D'] },
  { command: 'color.swap', keys: ['X'] },
  { command: 'mode.quickMask', keys: ['Q'] },
  { command: 'view.cycleScreenMode', keys: ['F'] },
  { command: 'window.togglePanels', keys: ['Tab'] },
  { command: 'window.togglePanelsExceptTools', keys: ['Shift+Tab'] },
  { command: 'brush.smaller', keys: ['['] },
  { command: 'brush.larger', keys: [']'] },
  { command: 'brush.softer', keys: ['Shift+['] },
  { command: 'brush.harder', keys: ['Shift+]'] },
  { command: 'brush.previousPreset', keys: [','] },
  { command: 'brush.nextPreset', keys: ['.'] },
  { command: 'brush.firstPreset', keys: ['Shift+,'] },
  { command: 'brush.lastPreset', keys: ['Shift+.'] },
  ...Array.from({ length: 10 }, (_, i) => ({ command: `paint.opacity${i}`, keys: [String(i)] })),
  ...Array.from({ length: 10 }, (_, i) => ({ command: `paint.flow${i}`, keys: [`Shift+${i}`] })),
  { command: 'move.nudgeLeft', keys: ['ArrowLeft'] },
  { command: 'move.nudgeRight', keys: ['ArrowRight'] },
  { command: 'move.nudgeUp', keys: ['ArrowUp'] },
  { command: 'move.nudgeDown', keys: ['ArrowDown'] },
  { command: 'move.nudgeLeft10', keys: ['Shift+ArrowLeft'] },
  { command: 'move.nudgeRight10', keys: ['Shift+ArrowRight'] },
  { command: 'move.nudgeUp10', keys: ['Shift+ArrowUp'] },
  { command: 'move.nudgeDown10', keys: ['Shift+ArrowDown'] },
  { command: 'blend.next', keys: ['Shift+='] },
  { command: 'blend.previous', keys: ['Shift+-'] },
];

/** Alt+Shift+letter picks a blend mode (with a painting tool or the Move tool). */
const BLEND_MODES: [string, string][] = [
  ['normal', 'N'],
  ['dissolve', 'I'],
  ['darken', 'K'],
  ['multiply', 'M'],
  ['color-burn', 'B'],
  ['linear-burn', 'A'],
  ['lighten', 'G'],
  ['screen', 'S'],
  ['color-dodge', 'D'],
  ['linear-dodge', 'W'],
  ['overlay', 'O'],
  ['soft-light', 'F'],
  ['hard-light', 'H'],
  ['vivid-light', 'V'],
  ['linear-light', 'J'],
  ['pin-light', 'Z'],
  ['hard-mix', 'L'],
  ['difference', 'E'],
  ['exclusion', 'X'],
  ['hue', 'U'],
  ['saturation', 'T'],
  ['color', 'C'],
  ['luminosity', 'Y'],
];

export const DEFAULT_KEYMAP: readonly DefaultBinding[] = [
  ...MENU,
  ...TOOLS,
  ...KEYS,
  ...BLEND_MODES.map(([mode, key]) => ({ command: `blend.set.${mode}`, keys: [`Alt+Shift+${key}`] })),
];
