/**
 * The app controller: registers the app commands (menus and shortcuts), connects
 * the keyboard and the tools, and implements file operations. The UI implements
 * `UiBridge` (dialogs, panels, tool state) and attaches the canvas.
 */
import { APP_NAME } from './brand';
import { BLEND_MODE_LABELS, availableBlendModes, blendModeMenu, cycleBlendMode } from '../core/composite/blend';
import { suggestedCopyName } from '../core/commands/builtin/layer-common';
import { mergeKind } from '../core/commands/builtin/merge';
import { colorToSamples, type RGB } from '../core/color/color';
import { paintTarget, strokeSetup, type PaintTool } from '../core/commands/builtin/paint';
import { stepBrushSize, stepHardness, type BrushSettings } from '../core/paint/brush';
import { PaintingTool } from '../tools/paint/paint-tool';
import { SelectionTool } from '../tools/selection/selection-tool';
import type { PaintHost, PaintStroke } from '../tools/types';
import { PaintSession } from './paint-session';
import { ColorSwatches } from './colors';
import {
  CommandCancelledError,
  CommandUnavailableError,
  type CommandDescriptor,
  type JsonObject,
} from '../core/commands/command';
import type { LayerPropChanges } from '../core/commands/builtin/set-layer-props';
import type { ImageDocument } from '../core/document/document';
import { bytesPerSample, samplesPerPixel } from '../core/document/pixel-format';
import {
  LAYER_BLEND_MODES,
  layerCapabilities,
  type BlendMode,
  type LayerBlendMode,
  type GroupLayer,
  type LayerNode,
} from '../core/document/layers';
import { AppCommandRegistry } from './commands/app-commands';
import { detectPlatform, type Platform } from './keymap/chord';
import { KeyboardService } from './keymap/keyboard-service';
import { Keymap } from './keymap/keymap';
import type { AppServices } from './services';
import type { DocumentSession } from './workspace';
import { viewActions } from '../tools/hand/hand-tool';
import { createTools, type ToolSet } from '../tools/registry';
import type { CanvasView } from '../ui/canvas/canvas-view';
import type {
  CanvasSizeRequest,
  CanvasSizeResult,
  ConfirmRequest,
  FillContents,
  FillRequest,
  FillResult,
  ImageSizeResult,
  LayerOptionsRequest,
  LayerOptionsResult,
  SizeRequest,
} from '../ui/state/ui-store';
import { formatById, openAcceptTypes, withExtension } from '../io/formats';
import { pickFiles, saveFileAs, writeToHandle, type PickedFile } from '../io/file-access';
import { openImage } from '../io/open-image';
import { encodeDocumentAsPng } from '../io/save-png';

export interface UiBridge {
  activeToolId(): string;
  setActiveTool(id: string, groupId: string): void;
  isPanelOpen(id: string): boolean;
  togglePanel(id: string): void;
  /** Shows a panel (opening it if closed). */
  openPanel(id: string): void;
  resetWorkspace(): void;
  alert(title: string, message: string): Promise<void>;
  confirmSave(documentName: string): Promise<'save' | 'discard' | 'cancel'>;
  about(): Promise<void>;
  /** New Layer / New Group dialog; null when cancelled. */
  layerOptions(request: LayerOptionsRequest): Promise<LayerOptionsResult | null>;
  /** Duplicate Layer dialog (`source` null for several layers); null when cancelled. */
  duplicateLayer(source: string | null, name: string): Promise<{ name?: string } | null>;
  /** A yes/no question; resolves true without asking when "Don't show again" was ticked before. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Starts editing a layer's name in the Layers panel. */
  startRename(layerId: string): void;
  /** The tool a toolbar group currently shows (last used in it), if any. */
  groupTool(groupId: string): string | undefined;
  /** The Color Picker; null when cancelled. */
  pickColor(title: string, color: RGB): Promise<RGB | null>;
  /** A tool's options changed outside the options bar (e.g. [ ] keys): refresh it. */
  toolOptionsChanged(): void;
  /** The Fill dialog; null when cancelled. */
  fill(request: FillRequest): Promise<FillResult | null>;
  /** The Image Size dialog; null when cancelled. */
  imageSize(request: SizeRequest): Promise<ImageSizeResult | null>;
  /** The Canvas Size dialog; null when cancelled. */
  canvasSize(request: CanvasSizeRequest): Promise<CanvasSizeResult | null>;
}

const TOOL_COMMANDS: Record<string, string> = {
  'tool.hand': 'hand',
  'tool.rotateView': 'rotate-view',
  'tool.zoom': 'zoom',
  'tool.move': 'move',
  'tool.brush': 'brush',
  'tool.eraser': 'eraser',
  'tool.crop': 'crop',
};

/** Two number keys typed within this time (ms) make one value ("4", "5" → 45 %). */
const DIGIT_PAIR_MS = 400;

/** Tool letters that pick a toolbar group's current tool (Shift + letter cycles the group). */
const GROUP_COMMANDS: Record<string, string> = {
  'tool.marquee': 'marquee-group',
  'tool.lasso': 'lasso-group',
};

export class AppController {
  readonly services: AppServices;
  readonly commands = new AppCommandRegistry();
  readonly platform: Platform = detectPlatform();
  readonly keymap = new Keymap(this.platform);
  readonly tools: ToolSet = createTools();
  readonly colors = new ColorSwatches();
  /** Starts brush/eraser strokes on the active document. */
  readonly paintHost: PaintHost = { begin: (tool, brush) => this.#beginStroke(tool, brush) };
  #lastDigit: { digit: number; time: number; shift: boolean } | null = null;
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
        toolForCommand: (c) => TOOL_COMMANDS[c] ?? this.#groupCurrentTool(GROUP_COMMANDS[c]),
        nextToolForCommand: (c) => TOOL_COMMANDS[c] ?? this.#groupNextTool(GROUP_COMMANDS[c]),
      },
    });
    this.commands.onError((_id, error) => {
      if (error instanceof CommandCancelledError) return; // the user pressed Esc
      void ui.alert('Something went wrong', error instanceof Error ? error.message : String(error));
    });
    this.#registerCommands();
    if (typeof window !== 'undefined') window.addEventListener('keydown', this.#onEscape, { capture: true });
  }

  /** Esc while a long command runs cancels it (and does nothing else). */
  readonly #onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.workspace.running) return;
    e.preventDefault();
    e.stopPropagation();
    this.workspace.cancelTask();
  };

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

  #groupCurrentTool(groupId: string | undefined): string | undefined {
    const group = this.tools.groups.find((g) => g.id === groupId);
    if (!group) return undefined;
    const remembered = this.#ui.groupTool(group.id);
    return group.tools.some((t) => t.id === remembered) ? remembered : group.tools[0]?.id;
  }

  /** Shift + a group's letter: the next tool in the group's cycle. */
  #groupNextTool(groupId: string | undefined): string | undefined {
    const group = this.tools.groups.find((g) => g.id === groupId);
    if (!group) return undefined;
    const cycle = group.cycle ?? group.tools.map((t) => t.id);
    const active = this.#ui.activeToolId();
    const current = cycle.includes(active) ? active : this.#groupCurrentTool(group.id);
    const i = cycle.indexOf(current ?? '');
    return cycle[(i + 1) % cycle.length];
  }

  /** Clicking a toolbar swatch: picks a new foreground or background colour. */
  async pickColor(which: 'foreground' | 'background'): Promise<void> {
    const title = which === 'foreground' ? 'Color Picker (Foreground Color)' : 'Color Picker (Background Color)';
    const picked = await this.#ui.pickColor(title, this.colors[which]);
    if (!picked) return;
    if (which === 'foreground') this.colors.setForeground(picked);
    else this.colors.setBackground(picked);
  }

  /** The background colour as samples of a document (undefined where colours cannot be converted yet). */
  #backgroundSamples(): number[] | undefined {
    const doc = this.workspace.active?.doc;
    if (!doc) return undefined;
    try {
      return colorToSamples(this.colors.background, doc.mode, doc.depth);
    } catch {
      return undefined;
    }
  }

  #beginStroke(tool: PaintTool, brush: BrushSettings): PaintStroke | null {
    const ws = this.workspace;
    const session = ws.active;
    if (!session || ws.running) return null;
    const doc = session.doc;
    const what = tool === 'brush' ? 'the Brush Tool' : 'the Eraser';
    const layer = paintTarget(doc);
    if (!layer) {
      const active = doc.activeLayer;
      const reason = !active
        ? 'No layer is selected.'
        : active.kind === 'group'
          ? 'The active layer is a group. Select a pixel layer.'
          : 'The active layer is locked.';
      void this.#ui.alert(`Could not use ${what}`, reason);
      return null;
    }
    let color: number[];
    try {
      color = colorToSamples(tool === 'brush' ? this.colors.foreground : this.colors.background, doc.mode, doc.depth);
    } catch (error) {
      void this.#ui.alert(`Could not use ${what}`, error instanceof Error ? error.message : String(error));
      return null;
    }
    const live = this.services.strokes.begin(strokeSetup(doc, layer, { tool, points: [], brush, color }));
    const stroke = new PaintSession(ws, doc, layer, live, tool, brush, color);
    return {
      add: (dabs) => stroke.add(dabs),
      end: async (points) => {
        try {
          await stroke.end(points);
        } catch (error) {
          await this.#ui.alert('Something went wrong', error instanceof Error ? error.message : String(error));
        }
      },
      cancel: () => stroke.cancel(),
    };
  }

  /** The active tool when it is the Brush or the Eraser. */
  #paintTool(): PaintingTool | null {
    const tool = this.tools.byId.get(this.#ui.activeToolId());
    return tool instanceof PaintingTool ? tool : null;
  }

  #setPaintOptions(changes: Partial<BrushSettings>): void {
    this.#paintTool()?.setOptions(changes);
    this.#ui.toolOptionsChanged();
  }

  /**
   * Number keys: opacity (Shift: flow) of the Brush/Eraser, or of the selected layers
   * (Shift: fill) with other tools. 1 = 10 % … 0 = 100 %; two digits typed quickly
   * give a precise value ("4", "5" → 45 %; "0", "5" → 5 %).
   */
  #numberKey(digit: number, shift: boolean): void {
    const now = performance.now();
    const last = this.#lastDigit;
    let percent = digit === 0 ? 100 : digit * 10;
    if (last && last.shift === shift && now - last.time < DIGIT_PAIR_MS) {
      percent = last.digit * 10 + digit;
      this.#lastDigit = null;
    } else {
      this.#lastDigit = { digit, time: now, shift };
    }
    const value = percent / 100;
    if (this.#paintTool()) this.#setPaintOptions(shift ? { flow: value } : { opacity: value });
    else void this.setSelectedLayerProps(shift ? { fillOpacity: value } : { opacity: value });
  }

  /** Edit > Fill: asks how to fill, then fills the selection (or canvas) of the active layer. */
  async fillWithDialog(contents: FillContents = 'foreground'): Promise<void> {
    const ws = this.workspace;
    const doc = ws.active?.doc;
    if (!doc || !ws.canExecute('fill')) return;
    const layer = doc.activeLayer;
    const canPreserve = layer?.kind === 'pixel' && layer.buffer.format.hasAlpha;
    const result = await this.#ui.fill({
      contents,
      foreground: this.colors.foreground,
      background: this.colors.background,
      blendModes: availableBlendModes(doc.mode, doc.depth),
      canPreserve: !!canPreserve,
      preserve: false,
    });
    if (!result || ws.active?.doc !== doc) return;
    await this.#fill(result.color, result.mode, result.opacity, result.preserveTransparency);
  }

  #sizeRequest(doc: ImageDocument): SizeRequest {
    const format = doc.layerFormat(false);
    return {
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution,
      bytesPerPixel: samplesPerPixel(format) * bytesPerSample(format.depth),
    };
  }

  /** Image > Image Size: resamples the image (or only changes its resolution). */
  async imageSizeWithDialog(): Promise<void> {
    const ws = this.workspace;
    const doc = ws.active?.doc;
    if (!doc) return;
    const result = await this.#ui.imageSize(this.#sizeRequest(doc));
    if (!result || ws.active?.doc !== doc) return;
    const { width, height, resolution, method } = result;
    if (width === doc.width && height === doc.height && resolution === doc.resolution) return;
    await this.runDocumentCommand({ name: 'imageSize', params: { width, height, resolution, method } });
  }

  /** Image > Canvas Size: adds or removes canvas around the image. */
  async canvasSizeWithDialog(): Promise<void> {
    const ws = this.workspace;
    const doc = ws.active?.doc;
    if (!doc) return;
    const hasBackground = !!doc.background;
    const result = await this.#ui.canvasSize({
      ...this.#sizeRequest(doc),
      hasBackground,
      foreground: this.colors.foreground,
      background: this.colors.background,
    });
    if (!result || ws.active?.doc !== doc) return;
    const { width, height, anchor } = result;
    if (width === doc.width && height === doc.height) return;
    if (width < doc.width || height < doc.height) {
      const proceed = await this.#ui.confirm({
        title: 'Canvas Size',
        message: 'The new canvas is smaller than the current one, so part of the image will be cut off.',
        confirmLabel: 'Proceed',
      });
      if (!proceed || ws.active?.doc !== doc) return;
    }
    let color: number[] | undefined;
    if (hasBackground) {
      try {
        color = colorToSamples(result.color, doc.mode, doc.depth);
      } catch (error) {
        await this.#ui.alert(
          'Could not change the canvas size',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }
    await this.runDocumentCommand({
      name: 'canvasSize',
      params: { width, height, anchor, ...(color ? { color } : {}) },
    });
  }

  /** Fills with a colour (Alt/Ctrl+Backspace and the dialog). */
  async #fill(color: RGB, mode: LayerBlendMode, opacity: number, preserve: boolean): Promise<void> {
    const doc = this.workspace.active?.doc;
    if (!doc) return;
    let samples: number[];
    try {
      samples = colorToSamples(color, doc.mode, doc.depth);
    } catch (error) {
      await this.#ui.alert('Could not fill', error instanceof Error ? error.message : String(error));
      return;
    }
    const layer = doc.activeLayer;
    const canPreserve = layer?.kind === 'pixel' && layer.buffer.format.hasAlpha;
    await this.workspace.execute({
      name: 'fill',
      params: { color: samples, mode, opacity, preserveTransparency: preserve && !!canPreserve },
    });
  }

  /** Tells the user why something cannot be done. */
  report(title: string, message: string): Promise<void> {
    return this.#ui.alert(title, message);
  }

  /**
   * Parameters a tool leaves to the app: the background colour for moving pixels on
   * the Background, and for new canvas when a crop reaches past the old one.
   */
  #withAppParams(descriptor: CommandDescriptor): CommandDescriptor {
    if (!['moveSelectedPixels', 'crop'].includes(descriptor.name) || descriptor.params['color']) return descriptor;
    const color = this.#backgroundSamples();
    return color ? { ...descriptor, params: { ...descriptor.params, color } } : descriptor;
  }

  /** Live preview for a tool (null cancels it). */
  async previewDocumentCommand(descriptor: CommandDescriptor | null): Promise<void> {
    try {
      if (descriptor) await this.workspace.preview(this.#withAppParams(descriptor));
      else await this.workspace.cancelPreview();
    } catch {
      // A preview that cannot run shows nothing; the final command reports the reason.
    }
  }

  /** Runs a document command for a tool, reporting problems (cancelling is not one). */
  async runDocumentCommand(descriptor: CommandDescriptor): Promise<void> {
    try {
      await this.workspace.execute(this.#withAppParams(descriptor));
    } catch (error) {
      if (error instanceof CommandCancelledError || error instanceof CommandUnavailableError) return;
      await this.#ui.alert('Something went wrong', error instanceof Error ? error.message : String(error));
    }
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

  // --- Layers (Layers panel and Layer menu) ----------------------------------

  /** Selects layers in the active document (not a history step, as in the reference app). */
  selectLayers(ids: readonly string[], activeId?: string | null): void {
    this.workspace.active?.doc.selectLayers(ids, activeId);
  }

  /**
   * Expands or collapses a group in the Layers panel (view state: not a history
   * step); with `nested`, the groups inside it too.
   */
  setGroupExpanded(id: string, expanded: boolean, nested = false): void {
    const doc = this.workspace.active?.doc;
    const group = doc?.getLayer(id);
    if (!doc || group?.kind !== 'group') return;
    const apply = (g: GroupLayer) => {
      if (g.expanded !== expanded) doc.updateLayer(g.id, { expanded });
      if (nested) for (const child of g.children) if (child.kind === 'group') apply(child);
    };
    apply(group);
  }

  /**
   * Changes the selected layers that allow it (the Background and locked layers
   * are skipped) as one history step. With `preview`, shows the change live
   * without recording it (while a value is dragged).
   */
  setSelectedLayerProps(props: LayerPropChanges, preview = false): Promise<void> {
    const doc = this.workspace.active?.doc;
    if (!doc) return Promise.resolve();
    const ids = doc.selectedLayerIds.filter((id) => {
      const layer = doc.getLayer(id);
      if (!layer) return false;
      const can = layerCapabilities(layer);
      if (
        'blendMode' in props &&
        (!can.changeBlendMode || (props.blendMode === 'pass-through' && layer.kind !== 'group'))
      )
        return false;
      if (('opacity' in props || 'fillOpacity' in props) && !can.changeOpacity) return false;
      if ('locks' in props && layer.kind === 'pixel' && layer.isBackground) return false;
      return true;
    });
    if (ids.length === 0) return Promise.resolve();
    const descriptor = { name: 'setLayerProps', params: { layerIds: ids, props: props as JsonObject } };
    return preview ? this.workspace.preview(descriptor) : this.workspace.execute(descriptor);
  }

  /** Changes properties of individual layers as one history step (visibility clicks, renaming). */
  setLayerProps(changes: { layerId: string; props: LayerPropChanges }[]): Promise<void> {
    if (changes.length === 0) return Promise.resolve();
    const params: JsonObject =
      changes.length === 1
        ? { layerId: changes[0]!.layerId, props: changes[0]!.props as JsonObject }
        : { changes: changes.map((c) => ({ layerId: c.layerId, props: c.props as JsonObject })) };
    return this.workspace.execute({ name: 'setLayerProps', params });
  }

  /** Drops layers at a position in the stack (dragging in the Layers panel). */
  moveLayers(layerIds: readonly string[], parentId: string, index: number): Promise<void> {
    return this.workspace.execute({ name: 'moveLayers', params: { layerIds: [...layerIds], parentId, index } });
  }

  /** Deletes the selected layers, asking first unless `ask` is false (Alt/Option-click). */
  async deleteSelectedLayers(ask = true): Promise<void> {
    const doc = this.workspace.active?.doc;
    if (!doc || !this.workspace.canExecute('deleteLayers')) return;
    const selected = doc.selectedLayerIds.map((id) => doc.requireLayer(id));
    const only = selected.length === 1 ? selected[0]! : null;
    const message = !only
      ? 'Delete the selected layers?'
      : only.kind === 'group'
        ? `Delete the group “${only.name}” and its contents?`
        : `Delete the layer “${only.name}”?`;
    if (
      ask &&
      !(await this.#ui.confirm({ title: 'Delete', message, confirmLabel: 'Delete', rememberKey: 'deleteLayer' }))
    )
      return;
    await this.workspace.execute({ name: 'deleteLayers', params: {} });
  }

  async #newLayerDialog(kind: 'layer' | 'group' | 'groupFromLayers' | 'fromBackground'): Promise<void> {
    const doc = this.workspace.active?.doc;
    if (!doc) return;
    const group = kind === 'group' || kind === 'groupFromLayers';
    const titles = {
      layer: 'New Layer',
      group: 'New Group',
      groupFromLayers: 'New Group from Layers',
      fromBackground: 'New Layer',
    };
    const result = await this.#ui.layerOptions({
      title: titles[kind],
      name: kind === 'fromBackground' ? 'Layer 0' : group ? doc.peekGroupName() : doc.peekLayerName(),
      blendModes: blendModeMenu(group ? 'group' : 'pixel', doc.mode, doc.depth),
      blendMode: group ? 'pass-through' : 'normal',
      opacity: 1,
    });
    if (!result || this.workspace.active?.doc !== doc) return;
    const commands = {
      layer: 'newLayer',
      group: 'newGroup',
      groupFromLayers: 'groupLayers',
      fromBackground: 'layerFromBackground',
    };
    await this.workspace.execute({ name: commands[kind], params: { ...result } });
  }

  async #duplicateDialog(): Promise<void> {
    const doc = this.workspace.active?.doc;
    if (!doc || !this.workspace.canExecute('duplicateLayers')) return;
    const selected = doc.selectedLayerIds;
    const source = selected.length === 1 ? doc.requireLayer(selected[0]!).name : null;
    const result = await this.#ui.duplicateLayer(source, source === null ? '' : suggestedCopyName(doc, source));
    if (!result || this.workspace.active?.doc !== doc) return;
    await this.workspace.execute({ name: 'duplicateLayers', params: result });
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
    // Not in the middle of a stroke or a polygon.
    const toolBusy = () => this.tools.byId.get(this.#ui.activeToolId())?.busy?.() ?? false;
    add({
      id: 'edit.undo',
      label: 'Undo',
      enabled: () => !toolBusy() && !!history()?.canUndo,
      run: async () => (await ws.cancelPreview(), history()?.undo()),
    });
    add({
      id: 'edit.redo',
      label: 'Redo',
      enabled: () => !toolBusy() && !!history()?.canRedo,
      run: async () => (await ws.cancelPreview(), history()?.redo()),
    });
    add({
      id: 'edit.toggleLastState',
      label: 'Toggle Last State',
      enabled: () => !!history()?.canUndo || !!history()?.canRedo,
      run: () => history()?.toggleLastState(),
    });

    // Delete/Backspace: clears the selected pixels; with nothing selected it deletes the
    // selected layers (as in the reference app). Not while a tool uses the key itself.
    add({
      id: 'edit.clear',
      label: 'Clear',
      enabled: () => !toolBusy() && (ws.active?.doc.selection ? ws.canExecute('clear') : ws.canExecute('deleteLayers')),
      run: () => {
        const doc = ws.active?.doc;
        // On the Background (no transparency to clear to) Delete opens Fill, as in the reference app.
        if (doc?.activeLayer?.kind === 'pixel' && doc.activeLayer.isBackground)
          return this.fillWithDialog('background');
        if (!doc?.selection) return ws.execute({ name: 'deleteLayers', params: {} });
        const color = this.#backgroundSamples();
        return ws.execute({ name: 'clear', params: color ? { color } : {} });
      },
    });
    add({
      id: 'edit.fill',
      label: 'Fill…',
      enabled: () => !toolBusy() && ws.canExecute('fill'),
      run: () => this.fillWithDialog(),
    });
    for (const [id, label, which, preserve] of [
      ['edit.fillForeground', 'Fill with Foreground Color', 'foreground', false],
      ['edit.fillBackground', 'Fill with Background Color', 'background', false],
      ['edit.fillForegroundPreserve', 'Fill with Foreground Color (Preserve Transparency)', 'foreground', true],
      ['edit.fillBackgroundPreserve', 'Fill with Background Color (Preserve Transparency)', 'background', true],
    ] as const) {
      add({
        id,
        label,
        enabled: () => !toolBusy() && ws.canExecute('fill'),
        run: () => this.#fill(this.colors[which], 'normal', 1, preserve),
      });
    }

    // Image
    add({
      id: 'image.adjustments.invert',
      label: 'Invert',
      enabled: () => ws.canExecute('invert'),
      run: () => ws.execute({ name: 'invert', params: {} }),
    });
    const docIdle = () => !toolBusy() && ws.active !== null;
    add({ id: 'image.imageSize', label: 'Image Size…', enabled: docIdle, run: () => this.imageSizeWithDialog() });
    add({ id: 'image.canvasSize', label: 'Canvas Size…', enabled: docIdle, run: () => this.canvasSizeWithDialog() });
    for (const [id, label, params] of [
      ['image.rotate180', 'Rotate 180°', { turns: 2 }],
      ['image.rotate90cw', 'Rotate 90° Clockwise', { turns: 1 }],
      ['image.rotate90ccw', 'Rotate 90° Counter Clockwise', { turns: 3 }],
      ['image.flipCanvasH', 'Flip Canvas Horizontal', { flip: 'horizontal' }],
      ['image.flipCanvasV', 'Flip Canvas Vertical', { flip: 'vertical' }],
    ] as const) {
      add({ id, label, enabled: docIdle, run: () => this.runDocumentCommand({ name: 'rotateCanvas', params }) });
    }
    add({
      id: 'image.crop',
      label: 'Crop',
      enabled: () => docIdle() && !!ws.active?.doc.selection,
      run: () => this.runDocumentCommand({ name: 'crop', params: {} }),
    });

    // Brush keys
    const paintTool = () => this.#paintTool() !== null;
    add({
      id: 'brush.smaller',
      label: 'Decrease Brush Size',
      enabled: paintTool,
      run: () => this.#setPaintOptions({ size: stepBrushSize(this.#paintTool()!.options.size, -1) }),
    });
    add({
      id: 'brush.larger',
      label: 'Increase Brush Size',
      enabled: paintTool,
      run: () => this.#setPaintOptions({ size: stepBrushSize(this.#paintTool()!.options.size, 1) }),
    });
    add({
      id: 'brush.softer',
      label: 'Decrease Brush Hardness',
      enabled: paintTool,
      run: () => this.#setPaintOptions({ hardness: stepHardness(this.#paintTool()!.options.hardness, -1) }),
    });
    add({
      id: 'brush.harder',
      label: 'Increase Brush Hardness',
      enabled: paintTool,
      run: () => this.#setPaintOptions({ hardness: stepHardness(this.#paintTool()!.options.hardness, 1) }),
    });
    for (let digit = 0; digit <= 9; digit++) {
      add({
        id: `paint.opacity${digit}`,
        label: `Opacity ${digit === 0 ? 100 : digit * 10}%`,
        enabled: () => paintTool() || ws.active !== null,
        run: () => this.#numberKey(digit, false),
      });
      add({
        id: `paint.flow${digit}`,
        label: `Flow ${digit === 0 ? 100 : digit * 10}%`,
        enabled: () => paintTool() || ws.active !== null,
        run: () => this.#numberKey(digit, true),
      });
    }

    // Arrow keys: nudge the selected layers (or selected pixels) with the Move tool, or the
    // selection outline with a selection tool; Shift moves 10 px.
    const nudge = (dx: number, dy: number): CommandDescriptor | null => {
      const doc = ws.active?.doc;
      const toolId = this.#ui.activeToolId();
      if (!doc) return null;
      if (toolId === 'move') {
        if (doc.selection && ws.canExecute('moveSelectedPixels'))
          return { name: 'moveSelectedPixels', params: { dx, dy, nudge: true } };
        return ws.canExecute('translateLayers') ? { name: 'translateLayers', params: { dx, dy, nudge: true } } : null;
      }
      const tool = this.tools.byId.get(toolId);
      if (tool instanceof SelectionTool && doc.selection) return { name: 'moveSelection', params: { dx, dy } };
      return null;
    };
    for (const [suffix, label, dx, dy] of [
      ['Left', 'Left', -1, 0],
      ['Right', 'Right', 1, 0],
      ['Up', 'Up', 0, -1],
      ['Down', 'Down', 0, 1],
    ] as const) {
      for (const step of [1, 10]) {
        const descriptor = () => nudge(dx * step, dy * step);
        add({
          id: `move.nudge${suffix}${step === 10 ? '10' : ''}`,
          label: `Nudge ${label}${step === 10 ? ' 10 px' : ''}`,
          enabled: () => !toolBusy() && descriptor() !== null,
          run: () => {
            const d = descriptor();
            return d ? this.runDocumentCommand(d) : undefined;
          },
        });
      }
    }

    // Colours
    add({ id: 'color.default', label: 'Default Foreground and Background Colors', run: () => this.colors.reset() });
    add({ id: 'color.swap', label: 'Switch Foreground and Background Colors', run: () => this.colors.swap() });

    // Select
    for (const [id, label, command] of [
      ['select.all', 'All', 'selectAll'],
      ['select.deselect', 'Deselect', 'deselect'],
      ['select.reselect', 'Reselect', 'reselect'],
      ['select.inverse', 'Inverse', 'inverseSelection'],
    ] as const) {
      add({ id, label, enabled: () => ws.canExecute(command), run: () => ws.execute({ name: command, params: {} }) });
    }

    // Layer
    const doc = () => ws.active?.doc;
    const selected = () => [...(doc()?.selectedLayerIds ?? [])];
    const exec =
      (name: string, params: Record<string, string> = {}) =>
      () =>
        ws.execute({ name, params });
    add({
      id: 'layer.new',
      label: 'New Layer…',
      enabled: () => ws.canExecute('newLayer'),
      run: () => this.#newLayerDialog('layer'),
    });
    add({
      id: 'layer.newNoDialog',
      label: 'New Layer',
      enabled: () => ws.canExecute('newLayer'),
      run: exec('newLayer'),
    });
    add({
      id: 'layer.newGroup',
      label: 'Group…',
      enabled: () => ws.canExecute('newGroup'),
      run: () => this.#newLayerDialog('group'),
    });
    add({
      id: 'layer.newGroupNoDialog',
      label: 'New Group',
      enabled: () => ws.canExecute('newGroup'),
      run: exec('newGroup'),
    });
    add({
      id: 'layer.groupFromLayers',
      label: 'Group from Layers…',
      enabled: () => ws.canExecute('groupLayers'),
      run: () => this.#newLayerDialog('groupFromLayers'),
    });
    add({
      id: 'layer.fromBackground',
      label: 'Layer from Background…',
      enabled: () => ws.canExecute('layerFromBackground'),
      run: () => this.#newLayerDialog('fromBackground'),
    });
    add({
      id: 'layer.duplicate',
      label: 'Duplicate Layer…',
      enabled: () => ws.canExecute('duplicateLayers'),
      run: () => this.#duplicateDialog(),
    });
    add({
      id: 'layer.rename',
      label: 'Rename Layer…',
      enabled: () => !!doc()?.activeLayer && selected().length === 1,
      run: () => {
        const id = doc()?.activeLayerId;
        if (!id) return;
        this.#ui.openPanel('layers');
        this.#ui.startRename(id);
      },
    });
    add({
      id: 'layers.collapseAll',
      label: 'Collapse All Groups',
      enabled: () => [...(doc()?.layers() ?? [])].some((l) => l.kind === 'group' && l.expanded),
      run: () => {
        for (const l of doc()?.layers() ?? []) if (l.kind === 'group') this.setGroupExpanded(l.id, false);
      },
    });
    add({
      id: 'layer.viaCopy',
      label: 'Layer via Copy',
      enabled: () => ws.canExecute('duplicateLayers'),
      run: exec('duplicateLayers'),
    });
    add({
      id: 'layer.delete',
      label: 'Delete Layer',
      enabled: () => ws.canExecute('deleteLayers'),
      run: () => this.deleteSelectedLayers(),
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
      id: 'layer.mergeDown',
      label: 'Merge Down',
      enabled: () => ws.canExecute('mergeLayers'),
      run: exec('mergeLayers'),
    });
    add({
      id: 'layer.mergeVisible',
      label: 'Merge Visible',
      enabled: () => ws.canExecute('mergeVisible'),
      run: exec('mergeVisible'),
    });
    add({
      id: 'layer.stampVisible',
      label: 'Stamp Visible',
      enabled: () => ws.canExecute('stampVisible'),
      run: exec('stampVisible'),
    });
    add({
      id: 'layer.flatten',
      label: 'Flatten Image',
      enabled: () => ws.canExecute('flattenImage'),
      run: async () => {
        const hidden = [...(doc()?.layers() ?? [])].some((l) => !l.visible);
        if (
          hidden &&
          !(await this.#ui.confirm({ title: 'Flatten Image', message: 'Discard hidden layers?', confirmLabel: 'OK' }))
        )
          return;
        await ws.execute({ name: 'flattenImage', params: {} });
      },
    });
    add({
      id: 'layer.backgroundFromLayer',
      label: 'Background from Layer',
      enabled: () => ws.canExecute('backgroundFromLayer'),
      // Transparency is filled with the background colour.
      run: () => {
        const color = this.#backgroundSamples();
        return ws.execute({ name: 'backgroundFromLayer', params: color ? { color } : {} });
      },
    });
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

    // Blend modes (Alt+Shift+letter, Shift+Plus/Minus) for the selected layers. With the
    // Brush/Eraser active they are the tool's mode in the reference app; until brush modes
    // exist (Phase 2) they do nothing then, rather than change the layer by surprise.
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
        enabled: () => this.#paintTool() === null && blendTargets().length > 0,
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
          return (
            !!d &&
            this.#paintTool() === null &&
            availableBlendModes(d.mode, d.depth).includes(mode) &&
            blendTargets().length > 0
          );
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
      ['window.layers', 'layers', 'Layers'],
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
    if (id === 'layer.mergeDown') {
      const doc = this.workspace.active?.doc;
      const kind = doc ? mergeKind(doc) : null;
      return kind === 'layers' ? 'Merge Layers' : kind === 'group' ? 'Merge Group' : 'Merge Down';
    }
    return fallback;
  }

  dispose(): void {
    this.keyboard.dispose();
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this.#onEscape, { capture: true });
  }
}
