/**
 * The app controller: registers the app commands (menus and shortcuts), connects
 * the keyboard and the tools, and implements file operations. The UI implements
 * `UiBridge` (dialogs, panels, tool state) and attaches the canvas.
 */
import { APP_NAME } from './brand';
import {
  BLEND_MODE_LABELS,
  availableBlendModes,
  blendModeMenu,
  brushModeMenu,
  cycleBlendMode,
} from '../core/composite/blend';
import { suggestedCopyName } from '../core/commands/builtin/layer-common';
import { mergeKind } from '../core/commands/builtin/merge';
import { colorToSamples, rgbToHex, type RGB } from '../core/color/color';
import {
  artHistorySampler,
  dynamicsColors,
  paintTarget,
  paintToolUnavailable,
  paintsFromHistory,
  resolveStamp,
  strokeResources,
  strokeSetup,
  usesColorDynamics,
  usesHistory,
  usesSymmetry,
  type BrushResources,
  type PaintTool,
} from '../core/commands/builtin/paint';
import { HistorySourceError, sourcePixels, stateLayer } from '../core/history/history-source';
import { ArtHistoryDabber, DEFAULT_ART_HISTORY } from '../core/paint/art-history';
import { mixerStroke, type MixerLoad } from '../core/paint/mixer';
import {
  DEFAULT_BRUSH,
  MAX_TIP_SIDE,
  stepBrushSize,
  stepHardness,
  type BrushMode,
  type BrushSettings,
  type StrokePoint,
} from '../core/paint/brush';
import { planFromDocument, planNode, type FlattenPlan } from '../core/composite/flatten';
import { DEFAULT_DYNAMICS } from '../core/paint/dynamics';
import { applyPreset, presetFromBrush, type BrushBundle } from '../core/paint/presets';
import { BRUSH_FILE_EXTENSION, readBrushFile, writeBrushFile } from '../io/brush-file';
import { readAco, readAse } from '../io/swatch-files';
import { readGrd, writeGrd } from '../io/grd';
import { cloneGradient, type Gradient, type GradientMethod } from '../core/paint/gradient';
import { DEFAULT_PATTERN_ID, MAX_PATTERN_SIDE } from '../core/pattern/pattern';

import { sampleRect, samplePlan, sampledToRgb, type EyedropperOptions } from '../core/paint/sample';
import { SYMMETRY_KINDS, defaultSymmetry, hasSegments, type SymmetryKind } from '../core/paint/symmetry';
import { GradientTool } from '../tools/gradient/gradient-tool';
import { PaintBucketTool } from '../tools/paint-bucket/paint-bucket-tool';
import { PaintingTool } from '../tools/paint/paint-tool';
import { SelectionTool } from '../tools/selection/selection-tool';
import type { ColorHost, PaintBeginOptions, PaintHost, PaintStroke, Tool } from '../tools/types';
import { PaintSession, type PaintSessionOptions } from './paint-session';
import { deferredStroke } from '../workers/stroke-client';
import { ColorSwatches } from './colors';
import {
  CommandCancelledError,
  CommandUnavailableError,
  type CommandDescriptor,
  type JsonObject,
} from '../core/commands/command';
import type { LayerPropChanges } from '../core/commands/builtin/set-layer-props';
import type { ImageDocument } from '../core/document/document';
import { unionRects, type Rect } from '../core/document/geometry';
import { layerSource } from '../core/commands/builtin/geometry';
import { transformTargets } from '../core/commands/builtin/transform';
import type { Thumbnail } from '../core/composite/thumbnail';
import { IDENTITY, invert } from '../core/geometry/transform';
import { bytesPerSample, maxSampleValue, samplesPerPixel } from '../core/document/pixel-format';
import {
  LAYER_BLEND_MODES,
  layerCapabilities,
  type BlendMode,
  type LayerBlendMode,
  type GroupLayer,
  type LayerNode,
  type PixelLayer,
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
  NameRequest,
  FillContents,
  FillRequest,
  FillResult,
  ImageSizeResult,
  LayerOptionsRequest,
  JpegOptionsRequest,
  LayerOptionsResult,
  NewDocumentRequest,
  NewDocumentResult,
  SaveAsRequest,
  SaveAsResult,
  WebpOptionsRequest,
  SizeRequest,
} from '../ui/state/ui-store';
import {
  FORMATS,
  formatById,
  formatFromFileName,
  openAcceptTypes,
  withExtension,
  type FileFormat,
} from '../io/formats';
import { pickFiles, saveFileAs, writeToHandle, type PickedFile } from '../io/file-access';
import { openImage } from '../io/open-image';
import { DEFAULT_DOCUMENT_PRESET, createNewDocument } from '../core/document/new-document';
import { encodeDocumentAsPng } from '../io/save-png';
import { encodeDocumentAsPsd } from '../io/psd';
import { DEFAULT_JPEG_OPTIONS, type JpegSaveOptions } from '../io/jpeg-options';
import { DEFAULT_WEBP_OPTIONS, type WebpSaveOptions } from '../io/webp-options';
import type { PreferenceValues } from './preferences';
import { encodeDocumentAsJpeg, encodeDocumentAsWebp } from '../io/save-flat';

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
  /** File > New; null when closed. */
  newDocument(request: NewDocumentRequest): Promise<NewDocumentResult | null>;
  /** The Save As dialog (name and format); null when cancelled. */
  saveAs(request: SaveAsRequest): Promise<SaveAsResult | null>;
  /** The JPEG Options dialog; null when cancelled. */
  jpegOptions(request: JpegOptionsRequest): Promise<JpegSaveOptions | null>;
  /** The WebP Options dialog; null when cancelled. */
  webpOptions(request: WebpOptionsRequest): Promise<WebpSaveOptions | null>;
  /** The Brush Name dialog for a new tip; null when cancelled. */
  brushName(tip: { width: number; height: number; data: Uint8Array }, name: string): Promise<string | null>;
  /** Edit > Preferences; the new values, or null when cancelled. */
  preferences(values: PreferenceValues): Promise<PreferenceValues | null>;
  /** Radial / Mandala symmetry: the segment count (2–12), or null when cancelled. */
  symmetrySegments(kind: 'radial' | 'mandala', segments: number): Promise<number | null>;
  /** A name (and an optional checkbox), or null when cancelled. */
  askName(request: NameRequest): Promise<{ name: string; option: boolean } | null>;
  /** Export Brushes / Gradients: the groups to export ('' for presets outside any group), or null. */
  /** The Gradient Editor; the edited gradient, or null when cancelled. */
  editGradient(request: { gradient: Gradient; method: GradientMethod }): Promise<Gradient | null>;
  exportGroups(request: {
    title: string;
    ungroupedLabel: string;
    groups: string[];
    selected: string[];
  }): Promise<string[] | null>;
}

/** A new unique id (presets, tips). */
function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const TOOL_COMMANDS: Record<string, string> = {
  'tool.hand': 'hand',
  'tool.rotateView': 'rotate-view',
  'tool.zoom': 'zoom',
  'tool.move': 'move',
  'tool.eraser': 'eraser',
  'tool.crop': 'crop',
  'tool.eyedropper': 'eyedropper',
};

/** Two number keys typed within this time (ms) make one value ("4", "5" → 45 %). */
const DIGIT_PAIR_MS = 400;

/** Tool letters that pick a toolbar group's current tool (Shift + letter cycles the group). */
const GROUP_COMMANDS: Record<string, string> = {
  'tool.marquee': 'marquee-group',
  'tool.lasso': 'lasso-group',
  'tool.brush': 'brush-group',
  'tool.gradient': 'gradient-group',
  'tool.stamp': 'stamp-group',
  'tool.historyBrush': 'history-group',
  'tool.dodge': 'dodge-group',
};

export class AppController {
  readonly services: AppServices;
  readonly commands = new AppCommandRegistry();
  readonly platform: Platform = detectPlatform();
  readonly keymap = new Keymap(this.platform);
  readonly tools: ToolSet = createTools();
  readonly colors = new ColorSwatches();
  /** Starts brush/eraser strokes on the active document. */
  readonly paintHost: PaintHost = {
    begin: (tool, brush, options) => this.#beginStroke(tool, brush, options),
    loadMixer: (at, size, allLayers, solid) => this.#loadMixer(at, size, allLayers, solid),
  };
  /** The colours, and sampling them off the active document (Eyedropper, Alt with the Brush). */
  readonly colorHost: ColorHost = {
    sample: (x, y, options) => this.#sampleColor(x, y, options),
    get: (which) => (which === 'foreground' ? this.colors.foreground : this.colors.background),
    set: (which, color) =>
      which === 'foreground' ? this.colors.setForeground(color) : this.colors.setBackground(color),
    eyedropper: this.tools.eyedropper.options,
  };
  #lastDigit: { digit: number; time: number; key: 'opacity' | 'flow' | 'mix' } | null = null;
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
    // Choosing a foreground colour loads the Mixer Brush with it.
    let foreground = this.colors.foreground;
    this.colors.changes.on(() => {
      if (this.colors.foreground === foreground) return;
      foreground = this.colors.foreground;
      this.tools.mixerBrush.loadForeground();
    });
    this.tools.mixerBrush.onMixerChange = () => this.#ui.toolOptionsChanged();
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

  /** The Mixer Brush's load swatch: picks a foreground colour and loads the brush with it. */
  async pickMixerColor(): Promise<void> {
    const picked = await this.#ui.pickColor('Color Picker (Foreground Color)', this.colors.foreground);
    if (!picked) return;
    this.colors.setForeground(picked);
    this.tools.mixerBrush.loadForeground();
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

  #beginStroke(tool: PaintTool, brush: BrushSettings, options: PaintBeginOptions = {}): PaintStroke | null {
    const ws = this.workspace;
    const session = ws.active;
    if (!session || ws.running) return null;
    const doc = session.doc;
    const what = {
      brush: 'the Brush Tool',
      pencil: 'the Pencil',
      eraser: 'the Eraser',
      'pattern-stamp': 'the Pattern Stamp',
      'history-brush': 'the History Brush',
      'art-history-brush': 'the Art History Brush',
      'mixer-brush': 'the Mixer Brush',
      dodge: 'the Dodge Tool',
      burn: 'the Burn Tool',
      sponge: 'the Sponge Tool',
      blur: 'the Blur Tool',
      sharpen: 'the Sharpen Tool',
      smudge: 'the Smudge Tool',
    }[tool];
    const unavailable = paintToolUnavailable(tool, doc);
    if (unavailable) {
      void this.#ui.alert(`Could not use ${what}`, unavailable);
      return null;
    }
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
    const kind = { tool, ...(options.toHistory ? { toHistory: true } : {}) };
    // Strokes from the history need the source state's version of this layer.
    let source: PixelLayer | null = null;
    if (usesHistory(kind)) {
      try {
        source = stateLayer(session.history.sourceState, doc, layer.id);
      } catch (error) {
        void this.#ui.alert(`Could not use ${what}`, error instanceof Error ? error.message : String(error));
        return null;
      }
    }
    let color: number[];
    try {
      color = colorToSamples(tool === 'eraser' ? this.colors.background : this.colors.foreground, doc.mode, doc.depth);
      // Auto Erase: a Pencil stroke starting on the foreground colour paints the background colour.
      if (options.autoEraseAt && this.#hasColorAt(layer, options.autoEraseAt, color))
        color = colorToSamples(this.colors.background, doc.mode, doc.depth);
    } catch (error) {
      void this.#ui.alert(`Could not use ${what}`, error instanceof Error ? error.message : String(error));
      return null;
    }
    const restores = source !== null && paintsFromHistory(kind);
    let res: BrushResources;
    try {
      res = {
        ...strokeResources(tool, brush, this.services.brushes, this.services.patterns),
        stamp: resolveStamp(options.pattern, this.services.patterns),
        history: restores ? sourcePixels(source!) : null,
      };
    } catch (error) {
      void this.#ui.alert(`Could not use ${what}`, error instanceof Error ? error.message : String(error));
      return null;
    }
    // A fresh seed per stroke; the colours only when Color Dynamics vary between them.
    const seed = Math.floor(Math.random() * 2 ** 31);
    const varyColor = usesColorDynamics(tool) && !!brush.dynamics?.color.enabled;
    const colors = varyColor ? { foreground: this.colors.foreground, background: this.colors.background } : undefined;
    const params = {
      ...kind,
      brush,
      color,
      seed,
      ...(colors ? { colors } : {}),
      ...(options.pattern ? { pattern: options.pattern } : {}),
      ...(options.tone ? { tone: options.tone } : {}),
      ...(options.retouch ? { retouch: options.retouch } : {}),
    };
    // The Art History Brush reads the layer as it is before the stroke paints into it.
    const before =
      tool === 'art-history-brush'
        ? { buffer: layer.buffer.clone(), offsetX: layer.offsetX, offsetY: layer.offsetY }
        : null;
    // The Mixer Brush starts once the stroke before it has handed on what the brush holds.
    const mixerBegin = tool === 'mixer-brush' ? options.mixer : undefined;
    let mixer: PaintSessionOptions['mixer'] = null;
    let live;
    if (mixerBegin) {
      const max = maxSampleValue(doc.depth);
      const foreground = color.map((v) => v / max);
      const stroke = mixerBegin.state.then((state) => mixerStroke(state, mixerBegin.options, doc, foreground));
      live = deferredStroke(
        stroke.then((m) => this.services.strokes.begin(strokeSetup(doc, layer, { ...params, mixer: m }, res))),
      );
      mixer = { stroke, finish: (end) => mixerBegin.finish(end, doc.mode) };
    } else {
      live = this.services.strokes.begin(strokeSetup(doc, layer, params, res));
    }
    const symmetry = doc.symmetry?.enabled && usesSymmetry(tool) ? doc.symmetry : null;
    // The source's tiles may have been moved to disk: they are read once back in memory.
    const resident = source ? session.history.sourceLayer(layer.id) : null;
    const artOptions = { ...DEFAULT_ART_HISTORY, ...options.art };
    const artBrush = structuredClone(brush);
    const art =
      before && resident
        ? {
            options: artOptions,
            dabber: resident.then(
              (src) => new ArtHistoryDabber(artBrush, artOptions, seed, artHistorySampler(src, before)),
            ),
          }
        : null;
    const stroke = new PaintSession(ws, doc, layer, live, tool, brush, color, seed, dynamicsColors(doc, params), {
      symmetry,
      pattern: options.pattern ?? null,
      toHistory: options.toHistory === true,
      source: restores ? resident : null,
      art,
      mixer,
      tone: options.tone ?? null,
      retouch: options.retouch ?? null,
    });
    return {
      seed,
      colors: stroke.colors,
      symmetry,
      add: (dabs) => stroke.add(dabs),
      ...(art ? { addPoints: (points: StrokePoint[]) => stroke.addPoints(points) } : {}),
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

  /** Mixer Brush Alt-click: paint from the active document under a tip of `size` at `at` (see PaintHost.loadMixer). */
  async #loadMixer(
    at: { x: number; y: number },
    size: number,
    allLayers: boolean,
    solid: boolean,
  ): Promise<MixerLoad | null> {
    const doc = this.workspace.active?.doc;
    if (!doc || (doc.mode !== 'rgb' && doc.mode !== 'grayscale')) return null;
    const side = Math.max(1, Math.ceil(size));
    const rect = { x: Math.round(at.x - side / 2), y: Math.round(at.y - side / 2), w: side, h: side };
    // The active layer's own pixels (as at full opacity), as the brush takes them up; or what all layers show.
    const active = doc.activeLayer;
    const plan: FlattenPlan =
      allLayers || !active
        ? planFromDocument(doc)
        : {
            ...planFromDocument(doc, []),
            layers: [{ ...planNode(active), visible: true, opacity: 1, fillOpacity: 1, blendMode: 'normal' }],
          };
    const { paint, preview } = await this.services.pixelOps.mixerLoad(plan, rect, doc.canvasRect, solid);
    return { kind: 'sample', mode: doc.mode, paint, preview };
  }

  /** Whether a layer's pixel at a document point has these colour samples (and is not transparent). */
  #hasColorAt(layer: PixelLayer, at: { x: number; y: number }, color: readonly number[]): boolean {
    const x = Math.floor(at.x) - layer.offsetX;
    const y = Math.floor(at.y) - layer.offsetY;
    const px = layer.buffer.getPixel(x, y);
    const cc = color.length;
    if (layer.buffer.format.hasAlpha && (px[cc] ?? 0) === 0) return false;
    return color.every((v, i) => px[i] === v);
  }

  /** The active tool when it is the Brush or the Eraser. */
  /** Every painting tool (brush presets may be chosen for any of them). */
  #paintingTools(): PaintingTool[] {
    return [...this.tools.byId.values()].filter((t): t is PaintingTool => t instanceof PaintingTool);
  }

  #paintTool(): PaintingTool | null {
    const tool = this.tools.byId.get(this.#ui.activeToolId());
    return tool instanceof PaintingTool ? tool : null;
  }

  #setPaintOptions(changes: Partial<BrushSettings>): void {
    this.#paintTool()?.setOptions(changes);
    this.#ui.toolOptionsChanged();
  }

  /** The active tool when it is the Gradient tool or the Paint Bucket (a mode and opacity, no brush). */
  #fillTool(): GradientTool | PaintBucketTool | null {
    const tool = this.tools.byId.get(this.#ui.activeToolId());
    return tool instanceof GradientTool || tool instanceof PaintBucketTool ? tool : null;
  }

  #setFillToolOptions(changes: { mode?: BrushMode; opacity?: number }): void {
    this.#fillTool()?.setOptions(changes);
    this.#ui.toolOptionsChanged();
  }

  /**
   * Number keys: opacity (Shift: flow) of the Brush/Eraser, the Gradient tool's or Paint Bucket's
   * opacity, or the opacity of the selected layers (Shift: fill) with other tools. 1 = 10 % … 0 = 100 %; two digits typed quickly
   * give a precise value ("4", "5" → 45 %; "0", "5" → 5 %).
   */
  /**
   * Number keys: opacity (with Shift: flow) of the painting tool, the fill tools or the selected
   * layers (Shift: fill). The Mixer Brush has Wet instead of opacity, and Mix with Alt+Shift; Dodge
   * and Burn have Exposure, Blur, Sharpen and Smudge Strength, the Sponge only Flow.
   */
  #numberKey(digit: number, key: 'opacity' | 'flow' | 'mix'): void {
    const now = performance.now();
    const last = this.#lastDigit;
    let percent = digit === 0 ? 100 : digit * 10;
    if (last && last.key === key && now - last.time < DIGIT_PAIR_MS) {
      percent = last.digit * 10 + digit;
      this.#lastDigit = null;
    } else {
      this.#lastDigit = { digit, time: now, key };
    }
    const value = percent / 100;
    const shift = key !== 'opacity';
    const paint = this.#paintTool();
    if (paint?.kind === 'mixer-brush') {
      if (key === 'flow') this.#setPaintOptions({ flow: value });
      else {
        paint.setMixer(key === 'mix' ? { mix: value } : { wet: value });
        this.#ui.toolOptionsChanged();
      }
    } else if (key === 'mix') return;
    else if (paint?.kind === 'dodge' || paint?.kind === 'burn') {
      if (shift) return; // no flow
      paint.setTone({ exposure: value });
      this.#ui.toolOptionsChanged();
    } else if (paint?.kind === 'sponge') this.#setPaintOptions({ flow: value });
    else if (paint?.kind === 'blur' || paint?.kind === 'sharpen' || paint?.kind === 'smudge') {
      if (shift) return; // no flow
      paint.setRetouch({ strength: value });
      this.#ui.toolOptionsChanged();
    } else if (paint) this.#setPaintOptions(shift ? { flow: value } : { opacity: value });
    else if (!shift && this.#fillTool()) this.#setFillToolOptions({ opacity: value });
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
      pattern: this.currentPatternId ?? DEFAULT_PATTERN_ID,
    });
    if (!result || ws.active?.doc !== doc) return;
    if (result.history) {
      await this.#fillFromHistory(result.mode, result.opacity, result.preserveTransparency && !!canPreserve);
      return;
    }
    if (result.pattern !== undefined) {
      this.choosePattern(result.pattern);
      await this.workspace.execute({
        name: 'fill',
        params: {
          pattern: result.pattern,
          mode: result.mode,
          opacity: result.opacity,
          preserveTransparency: result.preserveTransparency && !!canPreserve,
        },
      });
      return;
    }
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

  /** Edit > Free Transform: opens the transform box around the selection or the selected layers. */
  /** The active document's colour at a document point (the Eyedropper's options); null where nothing is painted. */
  async #sampleColor(x: number, y: number, options: EyedropperOptions): Promise<RGB | null> {
    const doc = this.workspace.active?.doc;
    if (!doc || (doc.mode !== 'rgb' && doc.mode !== 'grayscale')) return null;
    const rect = sampleRect(x, y, options.sampleSize, doc.canvasRect);
    if (!rect) return null;
    const values = await this.services.pixelOps.sampleColor(samplePlan(doc, options.source), rect);
    return values ? sampledToRgb(values, doc.mode, doc.depth) : null;
  }

  #symmetryHidden = false;

  /** Whether the paint symmetry guide is hidden (Hide Symmetry). */
  get symmetryHidden(): boolean {
    return this.#symmetryHidden;
  }

  /** A new paint symmetry of a type (Radial and Mandala ask for segments), then placing its guide. */
  async newSymmetry(kind: SymmetryKind): Promise<void> {
    const ws = this.workspace;
    const doc = ws.active?.doc;
    if (!doc || ws.running || this.tools.symmetry.active) return;
    let segments = doc.symmetry?.segments ?? 5;
    if (kind === 'radial' || kind === 'mandala') {
      const answer = await this.#ui.symmetrySegments(kind, segments);
      if (answer === null || ws.active?.doc !== doc) return;
      segments = answer;
    }
    await this.runDocumentCommand(
      { name: 'setSymmetry', params: { symmetry: { ...defaultSymmetry(kind, doc.width, doc.height, segments) } } },
      doc,
    );
    if (this.#symmetryHidden) this.toggleSymmetryHidden();
    this.transformSymmetry();
  }

  /** Places the current symmetry's guide (move, turn, size); Enter applies. */
  transformSymmetry(): void {
    const doc = this.workspace.active?.doc;
    const ctx = this.#canvas?.context;
    const tool = this.tools.symmetry;
    const symmetry = doc?.symmetry;
    if (!doc || !ctx || !symmetry?.enabled || tool.active) return;
    const previous = this.#ui.activeToolId();
    this.#ui.setActiveTool(tool.id, '');
    tool.begin(ctx, symmetry, {
      finish: (next) => {
        if (next) void this.runDocumentCommand({ name: 'setSymmetry', params: { symmetry: { ...next } } }, doc);
        if (this.#ui.activeToolId() === tool.id) this.#ui.setActiveTool(previous, this.groupOf(previous));
      },
    });
  }

  toggleSymmetryHidden(): void {
    this.#symmetryHidden = !this.#symmetryHidden;
    this.#canvas?.setSymmetryHidden(this.#symmetryHidden);
    this.#ui.toolOptionsChanged();
  }

  async freeTransform(): Promise<void> {
    const ws = this.workspace;
    const doc = ws.active?.doc;
    const ctx = this.#canvas?.context;
    const tool = this.tools.transform;
    if (!doc || !ctx || tool.active || ws.running) return;
    const targets = transformTargets(doc);
    if (targets.kind === 'refused') return this.#ui.alert('Could not use Free Transform', targets.reason);
    const { pixelOps } = this.services;
    let bounds: Rect | null;
    if (targets.kind === 'pixels') {
      bounds = await pixelOps.maskBounds(doc.selection!.data, doc.canvasRect);
    } else {
      const all = await Promise.all(targets.layers.map((l) => pixelOps.contentBounds(layerSource(doc, l))));
      const found = all.filter((b): b is Rect => b !== null);
      bounds = found.length > 0 ? found.reduce((a, b) => unionRects(a, b)) : null;
    }
    if (ws.active?.doc !== doc || tool.active) return;
    if (!bounds) return this.#ui.alert('Could not use Free Transform', 'There are no pixels to transform.');
    const renderer = this.#canvas?.renderer;
    // Whole layers preview on the GPU from a picture of each (at most 4096 px a side);
    // selected pixels preview through the command itself, computed for the visible area.
    const pictures = targets.kind === 'layers' && renderer ? await this.#transformPictures(doc, targets.layers) : null;
    if (ws.active?.doc !== doc || tool.active) return;
    if (pictures) renderer!.setTransformPreview({ layers: pictures, inverse: [...IDENTITY] });
    const previous = this.#ui.activeToolId();
    this.#ui.setActiveTool(tool.id, '');
    tool.begin(ctx, bounds, {
      preview: (matrix, draft) => {
        if (pictures) {
          const inverse = invert(matrix);
          if (inverse) renderer!.setTransformPreview({ layers: pictures, inverse: [...inverse] });
        } else {
          void this.previewDocumentCommand({
            name: 'freeTransform',
            params: { matrix: [...matrix], interpolation: 'bilinear', draft: { ...draft } },
          });
        }
      },
      finish: (descriptor) => {
        const endPreview = () => (pictures ? renderer!.setTransformPreview(null) : undefined);
        if (descriptor) void this.runDocumentCommand(descriptor, doc).finally(endPreview);
        else {
          endPreview();
          void ws.cancelPreview();
        }
        // Back to the tool used before (unless another one was chosen meanwhile).
        if (this.#ui.activeToolId() === tool.id) this.#ui.setActiveTool(previous, this.groupOf(previous));
      },
    });
  }

  /** Pictures of layers for the GPU transform preview (8-bit sRGB, at most 4096 px a side). */
  async #transformPictures(
    doc: ImageDocument,
    layers: readonly PixelLayer[],
  ): Promise<Map<string, { image: Thumbnail; area: Rect }>> {
    const pictures = new Map<string, { image: Thumbnail; area: Rect }>();
    await Promise.all(
      layers.map(async (layer) => {
        const source = layerSource(doc, layer);
        const area = await this.services.pixelOps.contentBounds(source);
        if (!area) return;
        const scale = Math.min(1, 4096 / Math.max(area.w, area.h));
        const width = Math.max(1, Math.round(area.w * scale));
        const height = Math.max(1, Math.round(area.h * scale));
        pictures.set(layer.id, { image: await this.services.renderThumbnail(source, area, width, height), area });
      }),
    );
    return pictures;
  }

  /**
   * Edit > Define Brush Preset: the selected area of the visible image (or the whole
   * canvas) becomes a sampled tip in the brush library and the Brush tool's tip.
   */
  async defineBrushPreset(): Promise<void> {
    const ws = this.workspace;
    const doc = ws.active?.doc;
    if (!doc) return;
    const title = 'Could not define the brush';
    const { pixelOps, brushes } = this.services;
    const rect = doc.selection ? await pixelOps.maskBounds(doc.selection.data, doc.canvasRect) : doc.canvasRect;
    if (!rect) return this.#ui.alert(title, 'Nothing is selected.');
    if (rect.w > MAX_TIP_SIDE || rect.h > MAX_TIP_SIDE)
      return this.#ui.alert(title, `A brush tip can be at most ${MAX_TIP_SIDE} × ${MAX_TIP_SIDE} pixels.`);
    const data = await pixelOps.brushTipFromImage(
      planFromDocument(doc),
      rect,
      doc.selection?.data ?? null,
      doc.canvasRect,
    );
    if (!data.some((v) => v > 0))
      return this.#ui.alert(
        title,
        'The selected area is empty: only dark pixels paint (white and transparent do not).',
      );
    const tip = { width: rect.w, height: rect.h, data };
    await brushes.ready;
    const count = brushes.list().filter((t) => brushes.isUserTip(t.id)).length;
    const name = await this.#ui.brushName(tip, `Sampled Brush ${count + 1}`);
    if (!name) return;
    const id = newId();
    await brushes.add({ id, name, ...tip });
    // A preset with the new tip, chosen at once (the Brush tool's, at the tip's own size).
    const brush = {
      ...DEFAULT_BRUSH,
      tip: id,
      size: Math.max(rect.w, rect.h),
      dynamics: structuredClone(DEFAULT_DYNAMICS),
    };
    const preset = presetFromBrush(newId(), name, null, brush, null);
    await brushes.savePresets([preset]);
    this.choosePreset(preset.id, this.tools.brush);
  }

  /** The active painting tool, or the Brush (made active) when another tool is. */
  #paintToolOrBrush(): PaintingTool {
    const tool = this.#paintTool();
    if (tool) return tool;
    this.#ui.setActiveTool(this.tools.brush.id, this.groupOf(this.tools.brush.id));
    return this.tools.brush;
  }

  /** Chooses a brush preset for the active painting tool (the Brush when another tool is active). */
  choosePreset(id: string, tool: PaintingTool = this.#paintToolOrBrush()): void {
    const preset = this.services.brushes.preset(id);
    if (!preset) return;
    tool.setOptions(applyPreset(tool.options, preset, tool.protectTexture));
    if (preset.toolSettings && preset.smoothing) tool.setSmoothing(preset.smoothing);
    tool.presetId = id;
    this.services.brushes.markUsed(id);
    this.#ui.toolOptionsChanged();
  }

  /** The preset the active painting tool uses, if any. */
  get currentPresetId(): string | null {
    return this.#paintTool()?.presetId ?? null;
  }

  /** New Brush Preset: the current brush under a name (with the tool's settings if asked). */
  async newBrushPreset(): Promise<void> {
    const brushes = this.services.brushes;
    const tool = this.#paintToolOrBrush();
    const answer = await this.#ui.askName({
      title: 'New Brush Preset',
      name: `Brush ${brushes.presets().length + 1}`,
      option: { label: 'Include tool settings (opacity, flow, mode, smoothing)', checked: false },
    });
    if (!answer) return;
    const group = (tool.presetId ? brushes.preset(tool.presetId)?.group : null) ?? null;
    const preset = presetFromBrush(newId(), answer.name, group, tool.options, answer.option ? tool.smoothing : null);
    await brushes.savePresets([preset]);
    tool.presetId = preset.id;
    this.#ui.toolOptionsChanged();
  }

  async newBrushGroup(): Promise<void> {
    const brushes = this.services.brushes;
    const answer = await this.#ui.askName({ title: 'New Brush Group', name: `Group ${brushes.groups().length + 1}` });
    if (answer) await brushes.addGroup(answer.name);
  }

  /** The group of the current preset (null when it has none). */
  get currentBrushGroup(): string | null {
    const id = this.currentPresetId;
    return (id ? this.services.brushes.preset(id)?.group : null) ?? null;
  }

  async renameBrushGroup(group = this.currentBrushGroup): Promise<void> {
    if (group === null) return;
    const answer = await this.#ui.askName({ title: 'Rename Brush Group', name: group });
    if (answer && answer.name !== group) await this.services.brushes.renameGroup(group, answer.name);
  }

  async deleteBrushGroup(group = this.currentBrushGroup): Promise<void> {
    if (group === null) return;
    const count = this.services.brushes.presets().filter((p) => p.group === group).length;
    const ok = await this.#ui.confirm({
      title: 'Delete Brush Group',
      message: `Delete the group “${group}” and the ${count} brush${count === 1 ? '' : 'es'} in it?`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await this.services.brushes.removeGroup(group);
    for (const t of this.#paintingTools())
      if (t.presetId && !this.services.brushes.preset(t.presetId)) t.presetId = null;
    this.#ui.toolOptionsChanged();
  }

  async renameBrushPreset(id = this.currentPresetId): Promise<void> {
    const preset = id ? this.services.brushes.preset(id) : undefined;
    if (!preset) return;
    const answer = await this.#ui.askName({ title: 'Rename Brush', name: preset.name });
    if (answer) await this.services.brushes.renamePreset(preset.id, answer.name);
  }

  async deleteBrushPreset(id = this.currentPresetId): Promise<void> {
    const preset = id ? this.services.brushes.preset(id) : undefined;
    if (!preset) return;
    const ok = await this.#ui.confirm({
      title: 'Delete Brush',
      message: `Delete the brush “${preset.name}”?`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await this.services.brushes.removePreset(preset.id);
    for (const t of this.#paintingTools()) if (t.presetId === preset.id) t.presetId = null;
    this.#ui.toolOptionsChanged();
  }

  /** Import Brushes: .abr files of the reference app and our .pfbrush files. */
  async importBrushes(): Promise<void> {
    const files = await pickFiles({ 'application/octet-stream': ['.abr', `.${BRUSH_FILE_EXTENSION}`] }, 'Brushes');
    const { brushes, patterns } = this.services;
    for (const file of files) {
      const group = file.name.replace(/\.[^.]+$/, '');
      try {
        let bundle: BrushBundle;
        let notes: string[] = [];
        if (/\.abr$/i.test(file.name)) {
          const result = await this.services.codec.importAbr(file.bytes, group, `abr-${newId()}:`);
          bundle = result;
          notes = result.notes;
        } else {
          bundle = readBrushFile(file.bytes);
        }
        if (bundle.presets.length === 0) throw new Error('It has no brushes.');
        await patterns.add(bundle.patterns);
        await brushes.savePresets(
          bundle.presets.map((p) => ({ ...p, group: p.group ?? group })),
          bundle.tips,
        );
        if (notes.length > 0)
          await this.#ui.alert(
            `Imported ${bundle.presets.length} brushes from “${file.name}”`,
            `Some settings were approximated: ${notes.join('; ')}.`,
          );
      } catch (error) {
        await this.#ui.alert(`Could not import “${file.name}”`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Export Brushes: the presets of chosen groups, with their tips and patterns, as our brush file. */
  async exportBrushes(): Promise<void> {
    const { brushes, patterns } = this.services;
    const groups = brushes.groups();
    const ungrouped = brushes.presets().some((p) => p.group === null);
    const current = this.currentPresetId ? brushes.preset(this.currentPresetId)?.group : undefined;
    const chosen = await this.#ui.exportGroups({
      title: 'Export Brushes',
      ungroupedLabel: 'Brushes outside groups',
      groups: [...groups, ...(ungrouped ? [''] : [])],
      selected: current !== undefined ? [current ?? ''] : groups.slice(0, 1),
    });
    if (!chosen || chosen.length === 0) return;
    const presets = brushes.presets().filter((p) => chosen.includes(p.group ?? ''));
    const tipIds = new Set(
      presets.flatMap((p) => [p.brush.tip, p.brush.dynamics?.dual.enabled ? p.brush.dynamics.dual.tip : null]),
    );
    const patternIds = new Set(
      presets.map((p) => (p.brush.dynamics?.texture.enabled ? p.brush.dynamics.texture.pattern : null)),
    );
    const bytes = writeBrushFile({
      presets,
      tips: brushes.list().filter((t) => tipIds.has(t.id) && brushes.isUserTip(t.id)),
      patterns: patterns.userPatterns().filter((p) => patternIds.has(p.id)),
    });
    const name = chosen.length === 1 && chosen[0] ? chosen[0] : 'Brushes';
    await saveFileAs(
      bytes,
      `${name}.${BRUSH_FILE_EXTENSION}`,
      'application/octet-stream',
      `.${BRUSH_FILE_EXTENSION}`,
      'Brushes',
    );
  }

  async restoreDefaultBrushes(): Promise<void> {
    const ok = await this.#ui.confirm({
      title: 'Restore Default Brushes',
      message: 'Bring back the default brushes? Your own brushes stay.',
      confirmLabel: 'Restore',
    });
    if (ok) await this.services.brushes.restoreDefaults();
  }

  // -- swatches ---------------------------------------------------------------

  #swatchId: string | null = null;

  /** The swatch clicked last (Delete Swatch acts on it). */
  get currentSwatchId(): string | null {
    return this.#swatchId;
  }

  /** A swatch clicked: the foreground colour (with Ctrl/Cmd, the background). */
  chooseSwatch(id: string, background = false): void {
    const swatch = this.services.swatches.find(id);
    if (!swatch) return;
    this.#swatchId = id;
    if (background) this.colors.setBackground(swatch.color);
    else this.colors.setForeground(swatch.color);
    this.#ui.toolOptionsChanged();
  }

  /** New Swatch: the foreground colour under a name. */
  async newSwatch(group?: string): Promise<void> {
    const answer = await this.#ui.askName({
      title: 'Color Swatch Name',
      name: `Swatch ${rgbToHex(this.colors.foreground)}`,
    });
    if (!answer) return;
    const id = newId();
    await this.services.swatches.add({ id, name: answer.name, color: { ...this.colors.foreground } }, group);
    this.#swatchId = id;
  }

  async newSwatchGroup(): Promise<void> {
    const answer = await this.#ui.askName({
      title: 'New Swatch Group',
      name: `Group ${this.services.swatches.groups().length + 1}`,
    });
    if (answer) await this.services.swatches.addGroup(answer.name);
  }

  async deleteSwatch(id = this.#swatchId): Promise<void> {
    if (!id || !this.services.swatches.find(id)) return;
    await this.services.swatches.remove(id);
    if (this.#swatchId === id) this.#swatchId = null;
    this.#ui.toolOptionsChanged();
  }

  async renameSwatch(id = this.#swatchId): Promise<void> {
    const swatch = id ? this.services.swatches.find(id) : undefined;
    if (!swatch) return;
    const answer = await this.#ui.askName({ title: 'Color Swatch Name', name: swatch.name });
    if (answer) await this.services.swatches.rename(swatch.id, answer.name);
  }

  /** Import Swatches: .ase and .aco files. */
  async importSwatches(): Promise<void> {
    const files = await pickFiles({ 'application/octet-stream': ['.ase', '.aco'] }, 'Swatches');
    for (const file of files) {
      const group = file.name.replace(/\.[^.]+$/, '');
      try {
        const groups = /\.ase$/i.test(file.name) ? readAse(file.bytes, group) : readAco(file.bytes, group);
        if (groups.every((g) => g.swatches.length === 0)) throw new Error('It has no colours.');
        await this.services.swatches.import(groups);
      } catch (error) {
        await this.#ui.alert(`Could not import “${file.name}”`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async restoreDefaultSwatches(): Promise<void> {
    const ok = await this.#ui.confirm({
      title: 'Restore Default Swatches',
      message: 'Bring back the default swatches? Your own groups stay.',
      confirmLabel: 'Restore',
    });
    if (ok) await this.services.swatches.restoreDefaults();
  }

  // -- patterns ---------------------------------------------------------------

  #patternId: string | null = null;

  /** The pattern chosen last (Patterns panel, Fill), if it still exists. */
  get currentPatternId(): string | null {
    const id = this.#patternId;
    return id && this.services.patterns.get(id) ? id : null;
  }

  /** A pattern clicked: the Pattern Stamp and the Paint Bucket use it and Edit > Fill offers it. */
  choosePattern(id: string): void {
    if (!this.services.patterns.get(id)) return;
    this.#patternId = id;
    this.tools.patternStamp.setStamp({ patternId: id });
    this.tools.paintBucket.setOptions({ patternId: id });
    this.#ui.toolOptionsChanged();
  }

  /** Edit > Define Pattern: the visible image in the rectangular selection (or the whole canvas). */
  async definePattern(): Promise<void> {
    const doc = this.workspace.active?.doc;
    if (!doc) return;
    const title = 'Could not define the pattern';
    const { pixelOps, patterns } = this.services;
    const rect = doc.selection ? await pixelOps.maskBounds(doc.selection.data, doc.canvasRect) : doc.canvasRect;
    if (!rect) return this.#ui.alert(title, 'Nothing is selected.');
    if (rect.w > MAX_PATTERN_SIDE || rect.h > MAX_PATTERN_SIDE)
      return this.#ui.alert(title, `A pattern can be at most ${MAX_PATTERN_SIDE} × ${MAX_PATTERN_SIDE} pixels.`);
    let result: { data: Uint8Array; rectangular: boolean };
    try {
      result = await pixelOps.patternFromImage(
        planFromDocument(doc),
        rect,
        doc.selection?.data ?? null,
        doc.canvasRect,
      );
    } catch (error) {
      return this.#ui.alert(title, error instanceof Error ? error.message : String(error));
    }
    if (!result.rectangular)
      return this.#ui.alert(title, 'Patterns are made from a rectangular selection without feathering.');
    await patterns.ready;
    const answer = await this.#ui.askName({
      title: 'Pattern Name',
      name: `Pattern ${patterns.userPatterns().length + 1}`,
    });
    if (!answer) return;
    const id = newId();
    const current = this.currentPatternId;
    const group = (current && patterns.groupOf(current)) ?? patterns.groups()[0]?.name ?? 'Patterns';
    await patterns.add([{ id, name: answer.name, width: rect.w, height: rect.h, data: result.data }], group);
    this.choosePattern(id);
  }

  async newPatternGroup(): Promise<void> {
    const library = this.services.patterns;
    const answer = await this.#ui.askName({
      title: 'New Pattern Group',
      name: library.freeGroupName(`Group ${library.groups().length + 1}`),
    });
    if (answer) await library.addGroup(answer.name);
  }

  async renamePattern(id = this.currentPatternId): Promise<void> {
    const library = this.services.patterns;
    const pattern = id ? library.get(id) : undefined;
    if (!pattern) return;
    if (!library.isUserPattern(pattern.id))
      return this.#ui.alert('Rename Pattern', 'The default patterns keep their names.');
    const answer = await this.#ui.askName({ title: 'Pattern Name', name: pattern.name });
    if (answer) await library.rename(pattern.id, answer.name);
    this.#ui.toolOptionsChanged();
  }

  async deletePattern(id = this.currentPatternId): Promise<void> {
    if (!id || !this.services.patterns.get(id)) return;
    await this.services.patterns.remove(id);
    if (this.#patternId === id) this.#patternId = null;
    this.#ui.toolOptionsChanged();
  }

  /** Import Patterns: .pat files, one group each. */
  async importPatterns(): Promise<void> {
    const library = this.services.patterns;
    const files = await pickFiles({ 'application/octet-stream': ['.pat'] }, 'Patterns');
    for (const file of files) {
      try {
        const { patterns, notes } = await this.services.codec.importPat(file.bytes);
        const group = library.freeGroupName(file.name.replace(/\.[^.]+$/, ''));
        await library.add(
          patterns.map((p) => ({ ...p, id: newId() })),
          group,
        );
        if (notes.length > 0) await this.#ui.alert(`Imported “${file.name}”`, notes.join(' '));
      } catch (error) {
        await this.#ui.alert(`Could not import “${file.name}”`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Export Selected Patterns: chosen groups into a .pat file. */
  async exportPatterns(): Promise<void> {
    const library = this.services.patterns;
    const current = this.currentPatternId;
    const groups = library.groups().map((g) => g.name);
    const chosen = await this.#ui.exportGroups({
      title: 'Export Patterns',
      ungroupedLabel: 'Patterns outside groups',
      groups,
      selected: current ? [library.groupOf(current) ?? ''] : groups.slice(0, 1),
    });
    if (!chosen || chosen.length === 0) return;
    const patterns = library
      .groups()
      .filter((g) => chosen.includes(g.name))
      .flatMap((g) => g.patterns);
    const name = chosen.length === 1 && chosen[0] ? chosen[0] : 'Patterns';
    await saveFileAs(
      await this.services.codec.exportPat(patterns),
      `${name}.pat`,
      'application/octet-stream',
      '.pat',
      'Patterns',
    );
  }

  async restoreDefaultPatterns(): Promise<void> {
    const ok = await this.#ui.confirm({
      title: 'Restore Default Patterns',
      message: 'Bring back the default patterns? Your own patterns stay.',
      confirmLabel: 'Restore',
    });
    if (ok) await this.services.patterns.restoreDefaults();
  }

  // -- gradients --------------------------------------------------------------

  /** The preset the Gradient tool's gradient came from (highlighted in the Gradients panel), if any. */
  get currentGradientId(): string | null {
    const id = this.tools.gradient.options.presetId;
    return id && this.services.gradients.find(id) ? id : null;
  }

  /** A gradient preset clicked: the Gradient tool uses it. */
  chooseGradient(id: string): void {
    const entry = this.services.gradients.find(id);
    if (!entry) return;
    this.tools.gradient.setOptions({ gradient: cloneGradient(entry.gradient), presetId: id });
    this.#ui.toolOptionsChanged();
  }

  /** The Gradient Editor on the Gradient tool's gradient; OK makes the edited one the tool's. */
  async editGradient(): Promise<void> {
    const tool = this.tools.gradient;
    const before = JSON.stringify(tool.options.gradient);
    const edited = await this.#ui.editGradient({
      gradient: cloneGradient(tool.options.gradient),
      method: tool.options.method,
    });
    if (!edited) return;
    const unchanged = JSON.stringify(edited) === before;
    tool.setOptions({ gradient: edited, presetId: unchanged ? tool.options.presetId : null });
    this.#ui.toolOptionsChanged();
  }

  /** Adds a gradient to the presets (the Gradient Editor's New button); returns its id. */
  async addGradientPreset(gradient: Gradient, group?: string): Promise<string> {
    const id = newId();
    const current = this.currentGradientId;
    await this.services.gradients.add(
      { id, gradient },
      group ?? (current ? this.services.gradients.groupOf(current) : undefined),
    );
    return id;
  }

  /** New Gradient: the Gradient tool's gradient as a preset under a name. */
  async newGradient(): Promise<void> {
    const tool = this.tools.gradient;
    const answer = await this.#ui.askName({ title: 'Gradient Name', name: tool.options.gradient.name });
    if (!answer) return;
    const gradient = { ...cloneGradient(tool.options.gradient), name: answer.name };
    const id = await this.addGradientPreset(gradient);
    tool.setOptions({ gradient, presetId: id });
    this.#ui.toolOptionsChanged();
  }

  async newGradientGroup(): Promise<void> {
    const answer = await this.#ui.askName({
      title: 'New Gradient Group',
      name: `Group ${this.services.gradients.groups().length + 1}`,
    });
    if (answer) await this.services.gradients.addGroup(answer.name);
  }

  async renameGradient(id = this.currentGradientId): Promise<void> {
    const entry = id ? this.services.gradients.find(id) : undefined;
    if (!entry) return;
    const answer = await this.#ui.askName({ title: 'Gradient Name', name: entry.gradient.name });
    if (!answer) return;
    await this.services.gradients.rename(entry.id, answer.name);
    const tool = this.tools.gradient;
    if (tool.options.presetId === entry.id)
      tool.setOptions({ gradient: { ...tool.options.gradient, name: answer.name } });
    this.#ui.toolOptionsChanged();
  }

  async deleteGradient(id = this.currentGradientId): Promise<void> {
    if (!id || !this.services.gradients.find(id)) return;
    await this.services.gradients.remove(id);
    if (this.tools.gradient.options.presetId === id) this.tools.gradient.setOptions({ presetId: null });
    this.#ui.toolOptionsChanged();
  }

  /** Import Gradients: .grd files, one group each. */
  async importGradients(): Promise<void> {
    const files = await pickFiles({ 'application/octet-stream': ['.grd'] }, 'Gradients');
    for (const file of files) {
      try {
        const { gradients, notes } = readGrd(file.bytes);
        await this.services.gradients.import([
          {
            name: file.name.replace(/\.[^.]+$/, ''),
            gradients: gradients.map((gradient) => ({ id: newId(), gradient })),
          },
        ]);
        if (notes.length > 0) await this.#ui.alert(`Imported “${file.name}”`, notes.join(' '));
      } catch (error) {
        await this.#ui.alert(`Could not import “${file.name}”`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Export Selected Gradients: chosen groups into a .grd file. */
  async exportGradients(): Promise<void> {
    const library = this.services.gradients;
    const current = this.currentGradientId;
    const groups = library.groups().map((g) => g.name);
    const chosen = await this.#ui.exportGroups({
      title: 'Export Gradients',
      ungroupedLabel: 'Gradients outside groups',
      groups,
      selected: current ? [library.groupOf(current) ?? ''] : groups.slice(0, 1),
    });
    if (!chosen || chosen.length === 0) return;
    const gradients = library
      .groups()
      .filter((g) => chosen.includes(g.name))
      .flatMap((g) => g.gradients.map((e) => e.gradient));
    const name = chosen.length === 1 && chosen[0] ? chosen[0] : 'Gradients';
    await saveFileAs(writeGrd(gradients), `${name}.grd`, 'application/octet-stream', '.grd', 'Gradients');
  }

  async restoreDefaultGradients(): Promise<void> {
    const ok = await this.#ui.confirm({
      title: 'Restore Default Gradients',
      message: 'Bring back the default gradients? Your own groups stay.',
      confirmLabel: 'Restore',
    });
    if (ok) await this.services.gradients.restoreDefaults();
  }

  // -- tool presets -----------------------------------------------------------

  #toolPresetId: string | null = null;

  /** The tool preset chosen last (the Tool Presets panel shows it selected). */
  get currentToolPresetId(): string | null {
    return this.#toolPresetId;
  }

  /** A tool's settings as plain data, or null for tools without settings. */
  #toolSettings(tool: Tool): unknown {
    if (tool.presetOptions) return tool.presetOptions();
    const withOptions = tool as Tool & { options?: unknown };
    return withOptions.options !== undefined ? (JSON.parse(JSON.stringify(withOptions.options)) as unknown) : null;
  }

  canMakeToolPreset(): boolean {
    const tool = this.tools.byId.get(this.#ui.activeToolId());
    return !!tool && this.#toolSettings(tool) !== null;
  }

  async newToolPreset(): Promise<void> {
    const tool = this.tools.byId.get(this.#ui.activeToolId());
    if (!tool) return;
    const options = this.#toolSettings(tool);
    if (options === null) return;
    const library = this.services.toolPresets;
    const answer = await this.#ui.askName({
      title: 'New Tool Preset',
      name: `${tool.name} ${library.list(tool.id).length + 1}`,
    });
    if (!answer) return;
    const id = newId();
    await library.add({ id, name: answer.name, toolId: tool.id, options });
    this.#toolPresetId = id;
    this.#ui.toolOptionsChanged();
  }

  /** Chooses a tool preset: its tool becomes active with the saved settings. */
  chooseToolPreset(id: string): void {
    const preset = this.services.toolPresets.get(id);
    const tool = preset ? this.tools.byId.get(preset.toolId) : undefined;
    if (!preset || !tool) return;
    this.#ui.setActiveTool(tool.id, this.groupOf(tool.id));
    const options = JSON.parse(JSON.stringify(preset.options)) as unknown;
    if (tool.applyPresetOptions) tool.applyPresetOptions(options);
    else (tool as Tool & { setOptions?(o: unknown): void }).setOptions?.(options);
    this.#toolPresetId = id;
    this.#ui.toolOptionsChanged();
  }

  async renameToolPreset(id = this.#toolPresetId): Promise<void> {
    const preset = id ? this.services.toolPresets.get(id) : undefined;
    if (!preset) return;
    const answer = await this.#ui.askName({ title: 'Rename Tool Preset', name: preset.name });
    if (answer) await this.services.toolPresets.rename(preset.id, answer.name);
  }

  async deleteToolPreset(id = this.#toolPresetId): Promise<void> {
    const preset = id ? this.services.toolPresets.get(id) : undefined;
    if (!preset) return;
    await this.services.toolPresets.remove(preset.id);
    if (this.#toolPresetId === preset.id) this.#toolPresetId = null;
    this.#ui.toolOptionsChanged();
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

  /** Fills with the History Brush source (Fill > History, Ctrl/Cmd+Alt+Backspace), explaining when it cannot. */
  async #fillFromHistory(mode: LayerBlendMode, opacity: number, preserve: boolean): Promise<void> {
    try {
      await this.workspace.execute({
        name: 'fill',
        params: { history: true, mode, opacity, preserveTransparency: preserve },
      });
    } catch (error) {
      if (!(error instanceof HistorySourceError)) throw error;
      await this.#ui.alert('Could not fill', error.message);
    }
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
    if (!['moveSelectedPixels', 'crop', 'freeTransform'].includes(descriptor.name) || descriptor.params['color'])
      return descriptor;
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

  /** Runs a document command for a tool (on the active document, or `doc`), reporting problems (cancelling is not one). */
  async runDocumentCommand(descriptor: CommandDescriptor, doc?: ImageDocument): Promise<void> {
    try {
      await this.workspace.execute(this.#withAppParams(descriptor), doc);
    } catch (error) {
      if (error instanceof CommandCancelledError || error instanceof CommandUnavailableError) return;
      await this.#ui.alert('Something went wrong', error instanceof Error ? error.message : String(error));
    }
  }

  // --- Files ----------------------------------------------------------------

  /** Numbers new documents get ("Untitled-1", "Untitled-2", …). */
  #untitled = 1;

  /** File > New: the New Document dialog, then a new document with its settings. */
  async newDocumentWithDialog(): Promise<void> {
    const library = this.services.documentPresets;
    await library.ready;
    const name = `Untitled-${this.#untitled}`;
    const result = await this.#ui.newDocument({
      name,
      settings: library.last() ?? DEFAULT_DOCUMENT_PRESET.settings,
      recent: library.recent(),
      saved: library.saved(),
      background: this.colors.background,
      savePreset: async (preset) => (await library.save(preset), library.saved()),
      deletePreset: async (id) => (await library.deleteSaved(id), library.saved()),
    });
    if (!result) return;
    let doc: ImageDocument;
    try {
      doc = createNewDocument(result.settings, result.name, this.colors.background, this.services.tileStore);
    } catch (error) {
      await this.#ui.alert('Could not make the document', error instanceof Error ? error.message : String(error));
      return;
    }
    if (result.name === name) this.#untitled++;
    this.workspace.add(doc, null, 'New');
    void library.addRecent({ id: newId(), name: result.presetName, settings: result.settings });
  }

  async openWithDialog(): Promise<void> {
    await this.openFiles(await pickFiles(openAcceptTypes()));
  }

  /** Opens files (from the Open dialog or a drop); reports unreadable ones. */
  async openFiles(files: PickedFile[]): Promise<void> {
    const { codec, tileStore } = this.services;
    for (const file of files) {
      try {
        const { doc, simplified } = await openImage(file.bytes, file.name, codec, {
          memory: tileStore,
          shared: tileStore.shared,
        });
        this.workspace.add(doc, file.handle ?? null);
        if (simplified.length > 0)
          await this.#ui.alert(
            `Opened “${file.name}” with simplifications`,
            `This file uses features this version cannot keep yet: ${simplified.join('; ')}. Saving over it would lose them.`,
          );
      } catch (error) {
        await this.#ui.alert(`Could not open “${file.name}”`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  #jpegOptions: JpegSaveOptions = DEFAULT_JPEG_OPTIONS;
  #webpOptions: WebpSaveOptions = DEFAULT_WEBP_OPTIONS;

  /**
   * The document as a file of `format` (layers kept in PSD; other formats get a
   * flattened copy). JPEG asks for its options first; null when that is cancelled.
   */
  async #encode(doc: ImageDocument, format: FileFormat): Promise<Uint8Array | null> {
    const { codec } = this.services;
    if (format.id === 'psd') return encodeDocumentAsPsd(doc, codec);
    if (format.id === 'png') return encodeDocumentAsPng(doc, codec);
    if (format.id === 'webp') {
      const options = await this.#ui.webpOptions({
        options: this.#webpOptions,
        lossySupported: await codec.canEncodeLossyWebp(),
        estimate: async (o) => (await encodeDocumentAsWebp(doc, codec, o)).byteLength,
      });
      if (!options) return null;
      this.#webpOptions = options;
      return encodeDocumentAsWebp(doc, codec, options);
    }
    const background = doc.background;
    const options = await this.#ui.jpegOptions({
      options: this.#jpegOptions,
      hasTransparency: !(background?.visible && background.opacity >= 1 && background.blendMode === 'normal'),
      foreground: this.colors.foreground,
      background: this.colors.background,
      estimate: async (o) => (await encodeDocumentAsJpeg(doc, codec, o)).byteLength,
    });
    if (!options) return null;
    this.#jpegOptions = options; // remembered for next time, as the reference app does
    return encodeDocumentAsJpeg(doc, codec, options);
  }

  /** A flat image (one pixel layer) loses nothing in formats without layers. */
  #isFlat(doc: ImageDocument): boolean {
    return doc.layerCount === 1 && doc.root.children[0]?.kind === 'pixel';
  }

  /**
   * Saves in place when the document came from a file it can be written back to
   * without losing anything (a PSD, or a flat image in its own format); otherwise Save As.
   */
  async save(session: DocumentSession): Promise<boolean> {
    const handle = session.fileHandle;
    const format = handle ? formatFromFileName(handle.name) : undefined;
    if (
      handle &&
      format?.canSave &&
      !format.saveRestriction(session.doc) &&
      (format.keepsLayers || this.#isFlat(session.doc))
    ) {
      const bytes = await this.#encode(session.doc, format);
      if (!bytes) return false;
      await writeToHandle(handle, bytes);
      this.workspace.markSaved(session, handle);
      return true;
    }
    return this.saveAs(session);
  }

  /** File > Save As: asks for a name and format, then where to save. */
  async saveAs(session: DocumentSession): Promise<boolean> {
    const doc = session.doc;
    const formats = FORMATS.filter((f) => f.canSave);
    const current = formatFromFileName(doc.name);
    const usable = (f: FileFormat | undefined) => !!f?.canSave && !f.saveRestriction(doc);
    // The document's own format when it keeps everything; else PSD (layers kept); else the first that works.
    const suggested =
      (usable(current) && (current!.keepsLayers || this.#isFlat(doc)) ? current : undefined) ??
      (usable(formatById('psd')) ? formatById('psd') : formats.find(usable));
    if (!suggested) {
      await this.#ui.alert(
        'Cannot save',
        formats
          .map((f) => f.saveRestriction(doc))
          .filter(Boolean)
          .join('\n'),
      );
      return false;
    }
    const choice = await this.#ui.saveAs({
      name: withExtension(doc.name, ''),
      formats: formats.map((f) => ({
        id: f.id,
        label: `${f.name} (${f.extensions.join(', ')})`,
        restriction: f.saveRestriction(doc),
        keepsLayers: f.keepsLayers,
      })),
      format: suggested.id,
      layered: !this.#isFlat(doc),
    });
    if (!choice) return false;
    const format = formatById(choice.format as FileFormat['id']);
    const bytes = await this.#encode(doc, format);
    if (!bytes) return false;
    const extension = format.extensions[0]!;
    const outcome = await saveFileAs(
      bytes,
      withExtension(choice.name, extension),
      format.mimeType,
      extension,
      `${format.name} file`,
    );
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
    add({ id: 'file.new', label: 'New…', enabled: () => !toolBusy(), run: () => this.newDocumentWithDialog() });
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
    for (const [kind, label] of SYMMETRY_KINDS) {
      add({
        id: `symmetry.${kind}`,
        label: hasSegments(kind) ? `${label}…` : label,
        enabled: () => !toolBusy() && ws.active !== null,
        checked: () => ws.active?.doc.symmetry?.enabled === true && ws.active.doc.symmetry.kind === kind,
        run: () => this.newSymmetry(kind),
      });
    }
    const symmetryOn = () => ws.active?.doc.symmetry?.enabled === true;
    add({
      id: 'symmetry.transform',
      label: 'Transform Symmetry',
      enabled: () => !toolBusy() && symmetryOn(),
      run: () => this.transformSymmetry(),
    });
    add({
      id: 'symmetry.hide',
      label: 'Hide Symmetry',
      enabled: () => symmetryOn(),
      checked: () => this.#symmetryHidden,
      run: () => this.toggleSymmetryHidden(),
    });
    add({
      id: 'symmetry.off',
      label: 'Turn Off Symmetry',
      enabled: () => !toolBusy() && symmetryOn(),
      run: async () => {
        const s = ws.active?.doc.symmetry;
        if (s) await this.runDocumentCommand({ name: 'setSymmetry', params: { symmetry: { ...s, enabled: false } } });
      },
    });
    add({
      id: 'brush.clearControls',
      label: 'Clear Brush Controls',
      enabled: () => this.#paintTool() !== null,
      run: () => {
        const tool = this.#paintTool();
        if (!tool) return;
        // Every Brush Settings section off; their settings are kept for when they are turned on again.
        const d = structuredClone(tool.options.dynamics ?? DEFAULT_DYNAMICS);
        for (const key of ['shape', 'scatter', 'texture', 'dual', 'color', 'transfer', 'pose'] as const)
          d[key].enabled = false;
        d.noise = d.wetEdges = d.buildUp = false;
        this.#setPaintOptions({ dynamics: d });
      },
    });
    add({
      id: 'edit.preferences',
      label: 'Preferences…',
      run: async () => {
        const values = await this.#ui.preferences(this.services.preferences.values);
        if (values) await this.services.preferences.set(values);
      },
    });
    add({
      id: 'edit.defineBrush',
      label: 'Define Brush Preset…',
      enabled: () => !toolBusy() && ws.active !== null,
      run: () => this.defineBrushPreset(),
    });
    add({
      id: 'edit.definePattern',
      label: 'Define Pattern…',
      enabled: () => !toolBusy() && ws.active !== null,
      run: () => this.definePattern(),
    });
    add({
      id: 'edit.freeTransform',
      label: 'Free Transform',
      enabled: () => !toolBusy() && ws.active !== null && ws.canExecute('freeTransform'),
      run: () => this.freeTransform(),
    });
    add({
      id: 'edit.fill',
      label: 'Fill…',
      enabled: () => !toolBusy() && ws.canExecute('fill'),
      run: () => this.fillWithDialog(),
    });
    add({
      id: 'edit.fillHistory',
      label: 'Fill from History',
      enabled: () => !toolBusy() && ws.canExecute('fill'),
      run: () => this.#fillFromHistory('normal', 1, false),
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
        run: () => this.#numberKey(digit, 'opacity'),
      });
      add({
        id: `paint.flow${digit}`,
        label: `Flow ${digit === 0 ? 100 : digit * 10}%`,
        enabled: () => paintTool() || ws.active !== null,
        run: () => this.#numberKey(digit, 'flow'),
      });
      add({
        id: `paint.mix${digit}`,
        label: `Mixer Brush Mix ${digit === 0 ? 100 : digit * 10}%`,
        enabled: () => this.#paintTool()?.kind === 'mixer-brush',
        run: () => this.#numberKey(digit, 'mix'),
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

    // Blend modes (Alt+Shift+letter, Shift+Plus/Minus): with the Brush, the Gradient tool or
    // the Paint Bucket active they set the tool's Mode (as in the reference app); otherwise
    // the selected layers' blend mode. The other painting tools (Eraser…) have no mode here,
    // so they do nothing with them rather than change the layer.
    const ownsModeKeys = () => this.#paintTool() !== null || this.#fillTool() !== null;
    const brushTool = (): { options: { mode: BrushMode } } | null =>
      this.#paintTool()?.kind === 'brush' ? this.#paintTool() : this.#fillTool();
    const brushModes = (): readonly BrushMode[] => {
      const d = doc();
      return d ? brushModeMenu(d.mode, d.depth) : [];
    };
    const setBrushMode = (mode: BrushMode) =>
      this.#paintTool() ? this.#setPaintOptions({ mode }) : this.#setFillToolOptions({ mode });
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
        enabled: () => (ownsModeKeys() ? !!brushTool() && !!doc() : blendTargets().length > 0),
        run: () => {
          const brush = brushTool();
          if (brush) {
            const menu = brushModes();
            const i = Math.max(0, menu.indexOf(brush.options.mode));
            return setBrushMode(menu[(i + step + menu.length) % menu.length]!);
          }
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
          if (!d || !availableBlendModes(d.mode, d.depth).includes(mode)) return false;
          return ownsModeKeys() ? !!brushTool() : blendTargets().length > 0;
        },
        run: () => (brushTool() ? setBrushMode(mode) : setBlendMode(mode)),
      });
    }
    for (const [mode, label] of [
      ['behind', 'Behind'],
      ['clear', 'Clear'],
    ] as const) {
      add({ id: `blend.set.${mode}`, label, enabled: () => !!brushTool() && !!doc(), run: () => setBrushMode(mode) });
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
      ['window.brushSettings', 'brush-settings', 'Brush Settings'],
      ['window.brushes', 'brushes', 'Brushes'],
      ['window.toolPresets', 'tool-presets', 'Tool Presets'],
      ['window.color', 'color', 'Color'],
      ['window.swatches', 'swatches', 'Swatches'],
      ['window.gradients', 'gradients', 'Gradients'],
      ['window.patterns', 'patterns', 'Patterns'],
    ] as const) {
      add({ id, label, checked: () => this.#ui.isPanelOpen(panel), run: () => this.#ui.togglePanel(panel) });
    }
    // Brushes and Tool Presets panels (their menus and buttons).
    const hasPreset = () => this.currentPresetId !== null;
    const hasToolPreset = () => this.#toolPresetId !== null;
    const hasGradient = () => this.currentGradientId !== null;
    const hasPattern = () => this.currentPatternId !== null;
    for (const [id, label, run, enabled] of [
      ['brushes.newPreset', 'New Brush Preset…', () => this.newBrushPreset(), undefined],
      ['brushes.newGroup', 'New Brush Group…', () => this.newBrushGroup(), undefined],
      ['brushes.rename', 'Rename Brush…', () => this.renameBrushPreset(), hasPreset],
      ['brushes.delete', 'Delete Brush', () => this.deleteBrushPreset(), hasPreset],
      ['brushes.renameGroup', 'Rename Group…', () => this.renameBrushGroup(), () => this.currentBrushGroup !== null],
      ['brushes.deleteGroup', 'Delete Group…', () => this.deleteBrushGroup(), () => this.currentBrushGroup !== null],
      ['brushes.import', 'Import Brushes…', () => this.importBrushes(), undefined],
      ['brushes.export', 'Export Brushes…', () => this.exportBrushes(), undefined],
      ['brushes.restore', 'Restore Default Brushes…', () => this.restoreDefaultBrushes(), undefined],
      ['toolPresets.new', 'New Tool Preset…', () => this.newToolPreset(), () => this.canMakeToolPreset()],
      ['swatches.new', 'New Swatch…', () => this.newSwatch(), undefined],
      ['swatches.newGroup', 'New Swatch Group…', () => this.newSwatchGroup(), undefined],
      ['swatches.rename', 'Rename Swatch…', () => this.renameSwatch(), () => this.#swatchId !== null],
      ['swatches.delete', 'Delete Swatch', () => this.deleteSwatch(), () => this.#swatchId !== null],
      ['swatches.import', 'Import Swatches…', () => this.importSwatches(), undefined],
      ['swatches.restore', 'Restore Default Swatches…', () => this.restoreDefaultSwatches(), undefined],
      ['gradients.new', 'New Gradient…', () => this.newGradient(), undefined],
      ['gradients.newGroup', 'New Gradient Group…', () => this.newGradientGroup(), undefined],
      ['gradients.rename', 'Rename Gradient…', () => this.renameGradient(), hasGradient],
      ['gradients.delete', 'Delete Gradient', () => this.deleteGradient(), hasGradient],
      ['gradients.import', 'Import Gradients…', () => this.importGradients(), undefined],
      ['gradients.export', 'Export Selected Gradients…', () => this.exportGradients(), hasGradient],
      ['gradients.restore', 'Restore Default Gradients…', () => this.restoreDefaultGradients(), undefined],
      ['patterns.newGroup', 'New Pattern Group…', () => this.newPatternGroup(), undefined],
      ['patterns.rename', 'Rename Pattern…', () => this.renamePattern(), hasPattern],
      ['patterns.delete', 'Delete Pattern', () => this.deletePattern(), hasPattern],
      ['patterns.import', 'Import Patterns…', () => this.importPatterns(), undefined],
      ['patterns.export', 'Export Selected Patterns…', () => this.exportPatterns(), undefined],
      ['patterns.restore', 'Restore Default Patterns…', () => this.restoreDefaultPatterns(), undefined],
      ['toolPresets.rename', 'Rename Tool Preset…', () => this.renameToolPreset(), hasToolPreset],
      ['toolPresets.delete', 'Delete Tool Preset', () => this.deleteToolPreset(), hasToolPreset],
    ] as const) {
      add({ id, label, run, ...(enabled ? { enabled } : {}) });
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
