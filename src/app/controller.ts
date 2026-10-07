/**
 * The app controller: registers the app commands (menus and shortcuts), connects
 * the keyboard and the tools, and implements file operations. The UI implements
 * `UiBridge` (dialogs, panels, tool state) and attaches the canvas.
 */
import { APP_NAME } from './brand';
import { BLEND_MODE_LABELS, availableBlendModes, blendModeMenu, cycleBlendMode } from '../core/composite/blend';
import { LAYER_BLEND_MODES, layerCapabilities, type BlendMode, type LayerNode } from '../core/document/layers';
import { AppCommandRegistry } from './commands/app-commands';
import { detectPlatform, type Platform } from './keymap/chord';
import { KeyboardService } from './keymap/keyboard-service';
import { Keymap } from './keymap/keymap';
import type { AppServices } from './services';
import type { DocumentSession } from './workspace';
import { viewActions } from '../tools/hand/hand-tool';
import { createTools, type ToolSet } from '../tools/registry';
import type { CanvasView } from '../ui/canvas/canvas-view';
import { formatById, openAcceptTypes, withExtension } from '../io/formats';
import { pickFiles, saveFileAs, writeToHandle, type PickedFile } from '../io/file-access';
import { openImage } from '../io/open-image';
import { encodeDocumentAsPng } from '../io/save-png';

export interface UiBridge {
  activeToolId(): string;
  setActiveTool(id: string, groupId: string): void;
  isPanelOpen(id: string): boolean;
  togglePanel(id: string): void;
  resetWorkspace(): void;
  alert(title: string, message: string): Promise<void>;
  confirmSave(documentName: string): Promise<'save' | 'discard' | 'cancel'>;
  about(): Promise<void>;
}

const TOOL_COMMANDS: Record<string, string> = {
  'tool.hand': 'hand',
  'tool.rotateView': 'rotate-view',
  'tool.zoom': 'zoom',
};

export class AppController {
  readonly services: AppServices;
  readonly commands = new AppCommandRegistry();
  readonly platform: Platform = detectPlatform();
  readonly keymap = new Keymap(this.platform);
  readonly tools: ToolSet = createTools();
  readonly keyboard: KeyboardService;
  readonly #ui: UiBridge;
  #canvas: CanvasView | null = null;

  constructor(services: AppServices, ui: UiBridge) {
    this.services = services;
    this.#ui = ui;
    this.keyboard = new KeyboardService({
      keymap: this.keymap,
      commands: this.commands,
      platform: this.platform,
      tools: {
        activeToolId: () => ui.activeToolId(),
        setActiveTool: (id) => ui.setActiveTool(id, this.groupOf(id)),
        toolForCommand: (c) => TOOL_COMMANDS[c],
        nextToolForCommand: (c) => TOOL_COMMANDS[c],
      },
    });
    this.commands.onError(
      (_id, error) => void ui.alert('Something went wrong', error instanceof Error ? error.message : String(error)),
    );
    this.#registerCommands();
  }

  get workspace() {
    return this.services.workspace;
  }

  get canvas(): CanvasView | null {
    return this.#canvas;
  }

  attachCanvas(canvas: CanvasView | null): void {
    this.#canvas = canvas;
  }

  groupOf(toolId: string): string {
    return this.tools.groups.find((g) => g.tools.some((t) => t.id === toolId))?.id ?? '';
  }

  // --- Files ----------------------------------------------------------------

  async openWithDialog(): Promise<void> {
    await this.openFiles(await pickFiles(openAcceptTypes()));
  }

  /** Opens files (from the Open dialog or a drop); reports unreadable ones. */
  async openFiles(files: PickedFile[]): Promise<void> {
    const { codec, tileStore } = this.services;
    for (const file of files) {
      try {
        const doc = await openImage(file.bytes, file.name, codec, { memory: tileStore, shared: tileStore.shared });
        this.workspace.add(doc, file.handle ?? null);
      } catch (error) {
        await this.#ui.alert(`Could not open “${file.name}”`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Saves in place when the document came from a PNG it can be written back to; otherwise Save As. */
  async save(session: DocumentSession): Promise<boolean> {
    const flat = session.doc.layerCount === 1 && session.doc.root.children[0]?.kind === 'pixel';
    if (
      session.fileHandle &&
      flat &&
      session.fileHandle.name.toLowerCase().endsWith('.png') &&
      !formatById('png').saveRestriction(session.doc)
    ) {
      await writeToHandle(session.fileHandle, await encodeDocumentAsPng(session.doc, this.services.codec));
      this.workspace.markSaved(session, session.fileHandle);
      return true;
    }
    return this.saveAs(session);
  }

  async saveAs(session: DocumentSession): Promise<boolean> {
    const png = formatById('png');
    const restriction = png.saveRestriction(session.doc);
    if (restriction) {
      await this.#ui.alert('Cannot save as PNG', restriction);
      return false;
    }
    const bytes = await encodeDocumentAsPng(session.doc, this.services.codec);
    const outcome = await saveFileAs(bytes, withExtension(session.doc.name, '.png'), png.mimeType, '.png', 'PNG image');
    if (outcome.kind === 'cancelled') return false;
    this.workspace.markSaved(session, outcome.kind === 'saved' ? outcome.handle : null, outcome.name);
    return true;
  }

  /** Closes a document, asking about unsaved changes. Returns false if cancelled. */
  async close(session: DocumentSession): Promise<boolean> {
    if (this.workspace.isDirty(session)) {
      const answer = await this.#ui.confirmSave(session.doc.name);
      if (answer === 'cancel') return false;
      if (answer === 'save' && !(await this.save(session))) return false;
    }
    this.workspace.remove(session.id);
    return true;
  }

  async closeAll(except?: DocumentSession): Promise<void> {
    for (const session of [...this.workspace.sessions]) {
      if (session !== except && !(await this.close(session))) return;
    }
  }

  // --- Commands -------------------------------------------------------------

  #registerCommands(): void {
    const ws = this.workspace;
    const hasDoc = () => ws.active !== null;
    const history = () => ws.active?.history;
    const view = () => this.#canvas?.context;
    const withView = (fn: (ctx: NonNullable<ReturnType<typeof view>>) => void) => () => {
      const ctx = view();
      if (ctx?.document) fn(ctx);
    };
    const add = this.commands.register.bind(this.commands);

    // File
    add({ id: 'file.open', label: 'Open…', run: () => this.openWithDialog() });
    add({
      id: 'file.close',
      label: 'Close',
      enabled: hasDoc,
      run: async () => void (ws.active && (await this.close(ws.active))),
    });
    add({ id: 'file.closeAll', label: 'Close All', enabled: hasDoc, run: () => this.closeAll() });
    add({
      id: 'file.closeOthers',
      label: 'Close Others',
      enabled: () => ws.sessions.length > 1,
      run: () => this.closeAll(ws.active ?? undefined),
    });
    add({
      id: 'file.save',
      label: 'Save',
      enabled: hasDoc,
      run: async () => void (ws.active && (await this.save(ws.active))),
    });
    add({
      id: 'file.saveAs',
      label: 'Save As…',
      enabled: hasDoc,
      run: async () => void (ws.active && (await this.saveAs(ws.active))),
    });

    // Edit
    add({ id: 'edit.undo', label: 'Undo', enabled: () => !!history()?.canUndo, run: () => history()?.undo() });
    add({ id: 'edit.redo', label: 'Redo', enabled: () => !!history()?.canRedo, run: () => history()?.redo() });
    add({
      id: 'edit.toggleLastState',
      label: 'Toggle Last State',
      enabled: () => !!history()?.canUndo || !!history()?.canRedo,
      run: () => history()?.toggleLastState(),
    });

    // Image
    add({
      id: 'image.adjustments.invert',
      label: 'Invert',
      enabled: () => ws.canExecute('invert'),
      run: () => ws.execute({ name: 'invert', params: {} }),
    });

    // Layer
    const doc = () => ws.active?.doc;
    const selected = () => [...(doc()?.selectedLayerIds ?? [])];
    const exec =
      (name: string, params: Record<string, string> = {}) =>
      () =>
        ws.execute({ name, params });
    add({
      id: 'layer.newNoDialog',
      label: 'New Layer',
      enabled: () => ws.canExecute('newLayer'),
      run: exec('newLayer'),
    });
    add({ id: 'layer.newGroup', label: 'Group', enabled: () => ws.canExecute('newGroup'), run: exec('newGroup') });
    add({
      id: 'layer.fromBackground',
      label: 'Layer from Background',
      enabled: () => ws.canExecute('layerFromBackground'),
      run: exec('layerFromBackground'),
    });
    add({
      id: 'layer.viaCopy',
      label: 'Layer via Copy',
      enabled: () => ws.canExecute('duplicateLayers'),
      run: exec('duplicateLayers'),
    });
    add({
      id: 'layer.delete',
      label: 'Layer',
      enabled: () => ws.canExecute('deleteLayers'),
      run: exec('deleteLayers'),
    });
    const hiddenLayers = () => [...(doc()?.layers() ?? [])].filter((l) => !l.visible).map((l) => l.id);
    add({
      id: 'layer.deleteHidden',
      label: 'Hidden Layers',
      enabled: () => hiddenLayers().length > 0 && !!doc()?.root.children.some((l) => l.visible),
      run: () => ws.execute({ name: 'deleteLayers', params: { layerIds: hiddenLayers() } }),
    });
    add({
      id: 'layer.group',
      label: 'Group Layers',
      enabled: () => ws.canExecute('groupLayers'),
      run: exec('groupLayers'),
    });
    add({
      id: 'layer.ungroup',
      label: 'Ungroup Layers',
      enabled: () => ws.canExecute('ungroup'),
      run: exec('ungroup'),
    });
    for (const [id, mode, label] of [
      ['layer.bringToFront', 'front', 'Bring to Front'],
      ['layer.bringForward', 'forward', 'Bring Forward'],
      ['layer.sendBackward', 'backward', 'Send Backward'],
      ['layer.sendToBack', 'back', 'Send to Back'],
    ] as const) {
      add({ id, label, enabled: () => ws.canExecute('arrangeLayers'), run: exec('arrangeLayers', { mode }) });
    }
    add({
      id: 'layer.hide',
      label: 'Hide Layers',
      enabled: () => selected().length > 0,
      run: () => {
        const ids = selected();
        const anyVisible = ids.some((id) => doc()?.getLayer(id)?.visible);
        return ws.execute({ name: 'setLayerProps', params: { layerIds: ids, props: { visible: !anyVisible } } });
      },
    });

    // Blend modes (Alt+Shift+letter, Shift+Plus/Minus) for the selected layers.
    // (Once painting tools exist, they change the tool's mode while one is active.)
    const blendTargets = (): LayerNode[] => {
      const d = doc();
      if (!d) return [];
      return selected()
        .map((id) => d.getLayer(id))
        .filter((l): l is LayerNode => l !== undefined && layerCapabilities(l).changeBlendMode);
    };
    const setBlendMode = (mode: BlendMode) => {
      const ids = blendTargets()
        .filter((l) => l.blendMode !== mode)
        .map((l) => l.id);
      if (ids.length === 0) return;
      return ws.execute({ name: 'setLayerProps', params: { layerIds: ids, props: { blendMode: mode } } });
    };
    for (const [id, label, step] of [
      ['blend.next', 'Next Blend Mode', 1],
      ['blend.previous', 'Previous Blend Mode', -1],
    ] as const) {
      add({
        id,
        label,
        enabled: () => blendTargets().length > 0,
        run: () => {
          const d = doc();
          const targets = blendTargets();
          if (!d || targets.length === 0) return;
          const active = targets.find((l) => l.id === d.activeLayerId) ?? targets[0]!;
          const kind = targets.every((l) => l.kind === 'group') ? 'group' : 'pixel';
          return setBlendMode(cycleBlendMode(blendModeMenu(kind, d.mode, d.depth), active.blendMode, step));
        },
      });
    }
    for (const mode of LAYER_BLEND_MODES) {
      add({
        id: `blend.set.${mode}`,
        label: BLEND_MODE_LABELS[mode],
        enabled: () => {
          const d = doc();
          return !!d && availableBlendModes(d.mode, d.depth).includes(mode) && blendTargets().length > 0;
        },
        run: () => setBlendMode(mode),
      });
    }

    // View
    add({
      id: 'view.zoomIn',
      label: 'Zoom In',
      enabled: hasDoc,
      run: withView((ctx) => (ctx.viewport.zoomIn(), ctx.viewChanged())),
    });
    add({
      id: 'view.zoomOut',
      label: 'Zoom Out',
      enabled: hasDoc,
      run: withView((ctx) => (ctx.viewport.zoomOut(), ctx.viewChanged())),
    });
    add({ id: 'view.fitOnScreen', label: 'Fit on Screen', enabled: hasDoc, run: () => this.#canvas?.fitOnScreen() });
    add({
      id: 'view.actualPixels',
      label: '100%',
      enabled: hasDoc,
      run: withView((ctx) => viewActions.actualPixels(ctx)),
    });
    add({
      id: 'view.zoom200',
      label: '200%',
      enabled: hasDoc,
      run: withView((ctx) => (ctx.viewport.zoomTo(2), ctx.viewChanged())),
    });
    add({
      id: 'view.show.pixelGrid',
      label: 'Pixel Grid',
      checked: () => this.#canvas?.renderer.showPixelGrid ?? true,
      run: () => {
        const renderer = this.#canvas?.renderer;
        if (!renderer) return;
        renderer.showPixelGrid = !renderer.showPixelGrid;
        renderer.requestRender();
      },
    });

    // Window
    for (const [id, panel, label] of [
      ['window.panel.history', 'history', 'History'],
      ['window.panel.navigator', 'navigator', 'Navigator'],
    ] as const) {
      add({ id, label, checked: () => this.#ui.isPanelOpen(panel), run: () => this.#ui.togglePanel(panel) });
    }
    add({ id: 'window.workspace.essentials', label: 'Essentials (Default)', run: () => this.#ui.resetWorkspace() });
    add({ id: 'window.workspace.reset', label: 'Reset Essentials', run: () => this.#ui.resetWorkspace() });
    add({
      id: 'window.nextDocument',
      label: 'Next Document',
      enabled: () => ws.sessions.length > 1,
      run: () => ws.cycle(1),
    });
    add({
      id: 'window.previousDocument',
      label: 'Previous Document',
      enabled: () => ws.sessions.length > 1,
      run: () => ws.cycle(-1),
    });

    // Help
    add({ id: 'help.about', label: `About ${APP_NAME}…`, run: () => this.#ui.about() });
  }

  /** Menu label for a command, with dynamic text such as "Undo Invert". */
  labelFor(id: string, fallback: string): string {
    const h = this.workspace.active?.history;
    if (id === 'edit.undo' && h?.canUndo) return `Undo ${h.entries[h.currentIndex]!.label}`;
    if (id === 'edit.redo' && h?.canRedo) return `Redo ${h.entries[h.currentIndex + 1]!.label}`;
    if (id === 'help.about') return `About ${APP_NAME}…`;
    return fallback;
  }

  dispose(): void {
    this.keyboard.dispose();
  }
}
