/**
 * WebGL2 document renderer.
 *
 * Pipeline:
 *  1. Layer tiles are uploaded as textures on demand (cached by tile identity and
 *     version) — 8-bit as normalised, 16-bit as unsigned-integer, 32-bit as float
 *     textures, read exactly with texelFetch.
 *  2. Composite tiles (256 × 256, document resolution = level 0) blend the visible
 *     layers into RGBA16F targets (RGBA8 if float targets are unavailable). Normal
 *     and Dissolve use premultiplied hardware blending; the other blend modes run a
 *     shader pass that reads the backdrop and writes into a second texture
 *     (ping-pong), using the same formulas as core/composite/blend.ts.
 *  3. A pyramid of coarser levels (level L tile = 256·2^L document pixels) is built
 *     by 2×2 averaging, so zoomed-out views draw a few small textures instead of
 *     every full-resolution tile.
 *  4. The display pass draws the composite tiles of the level matching the zoom
 *     through the view transform, over a transparency checkerboard, with an
 *     optional pixel grid at high zoom.
 *
 * Only dirty tiles are recomposited (see DirtyTracker); frames are rendered on
 * demand, and heavy work is spread over frames (coarser or stale tiles are shown
 * meanwhile) so panning and zooming stay smooth.
 */
import type { ImageDocument } from '../../core/document/document';
import { intersectRects, isEmptyRect, type Rect } from '../../core/document/geometry';
import { SPECIAL_EIGHT } from '../../core/composite/blend';
import {
  LAYER_BLEND_MODES,
  type BlendMode,
  type LayerBlendMode,
  type LayerNode,
  type PixelLayer,
} from '../../core/document/layers';
import { maxSampleValue, samplesPerPixel } from '../../core/document/pixel-format';
import { TILE_SIZE, tileIndex, type Tile } from '../../core/document/tile';
import { DirtyTracker } from '../tiles/dirty-tracker';
import { Viewport } from '../viewport/viewport';
import { Program, createTexture, tileTextureFormat } from './gl-utils';
import {
  COPY_FS,
  DISPLAY_FS,
  DISPLAY_VS,
  DISSOLVE_PREMUL_FS,
  DISSOLVE_SOLID_FS,
  DOWNSAMPLE_FS,
  MIX_FS,
  SOLID_FS,
  TARGET_RECT_VS,
  blendFS,
  dissolveTileFS,
  layerTileFS,
} from './shaders';

export interface RendererOptions {
  /** Transparency checkerboard square size, CSS pixels. */
  checkerSize?: number;
  /** Checkerboard colours (sRGB, 0–1). */
  checkerColors?: readonly [readonly number[], readonly number[]];
  /** Colour around the canvas (sRGB, 0–1). */
  pasteboardColor?: readonly number[];
  /** Pixel grid colour and opacity (sRGB, 0–1). */
  gridColor?: readonly number[];
  /** GPU memory for layer tile textures, bytes. */
  layerTextureBudget?: number;
  /** GPU memory for composite tiles, bytes. */
  compositeBudget?: number;
  /** Composite/downsample operations per frame before the rest is deferred. */
  workPerFrame?: number;
  /** CPU time per frame for compositing work before the rest is deferred, ms. */
  frameBudgetMs?: number;
  /** Keep the drawing buffer after presenting (tests read it back). */
  preserveDrawingBuffer?: boolean;
}

export interface RendererStats {
  frames: number;
  composites: number;
  downsamples: number;
  uploads: number;
  layerTextures: number;
  compositeTiles: number;
  /** Duration of the last render call, ms (CPU side). */
  lastFrameMs: number;
  /** Whether the last frame showed every visible tile at full quality. */
  complete: boolean;
  floatTargets: boolean;
}

interface LayerTexture {
  tex: WebGLTexture;
  version: number;
  bytes: number;
  used: number;
}

interface CompositeEntry {
  tex: WebGLTexture;
  valid: boolean;
  used: number;
}

/** Remaining compositing work allowed in this frame. */
interface WorkBudget {
  left: number;
  deadline: number;
}

function exhausted(budget: WorkBudget): boolean {
  return budget.left <= 0 || performance.now() >= budget.deadline;
}

const COMPOSITE_BYTES_F16 = TILE_SIZE * TILE_SIZE * 8;

export class Renderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly viewport = new Viewport();
  /** View > Show > Pixel Grid. */
  showPixelGrid = true;
  devicePixelRatio = 1;

  readonly #gl: WebGL2RenderingContext;
  readonly #options: Required<RendererOptions>;
  #lost = false;
  #floatTargets = false;
  #compositeFormat = 0;
  #compositeBytes = COMPOSITE_BYTES_F16;

  #doc: ImageDocument | null = null;
  #tracker: DirtyTracker | null = null;
  #stopTracking: (() => void) | null = null;

  #quad: WebGLVertexArrayObject | null = null;
  #fbo: WebGLFramebuffer | null = null;
  readonly #layerPrograms = new Map<string, Program>();
  #programs: Record<'solid' | 'copy' | 'mix' | 'downsample' | 'display', Program> | null = null;
  readonly #layerTextures = new Map<number, LayerTexture>();
  #layerTextureBytes = 0;
  readonly #composites = new Map<string, CompositeEntry>();
  readonly #tempPool: WebGLTexture[] = [];
  #sharedUploadsSupported = true;

  #frame = 0;
  #rafId: number | null = null;
  readonly #frameListeners = new Set<(stats: RendererStats) => void>();
  readonly #stats: RendererStats = {
    frames: 0,
    composites: 0,
    downsamples: 0,
    uploads: 0,
    layerTextures: 0,
    compositeTiles: 0,
    lastFrameMs: 0,
    complete: true,
    floatTargets: false,
  };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.#options = {
      checkerSize: options.checkerSize ?? 8,
      checkerColors: options.checkerColors ?? [
        [1, 1, 1],
        [0.8, 0.8, 0.8],
      ],
      pasteboardColor: options.pasteboardColor ?? [0.157, 0.157, 0.157],
      gridColor: options.gridColor ?? [0.5, 0.5, 0.5, 0.45],
      layerTextureBudget: options.layerTextureBudget ?? 512 * 1024 * 1024,
      compositeBudget: options.compositeBudget ?? 384 * 1024 * 1024,
      workPerFrame: options.workPerFrame ?? 48,
      frameBudgetMs: options.frameBudgetMs ?? 8,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    };
    const gl = getWebGL2(canvas, {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: this.#options.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL 2 is not available in this browser');
    this.#gl = gl;
    canvas.addEventListener('webglcontextlost', this.#onContextLost);
    canvas.addEventListener('webglcontextrestored', this.#onContextRestored);
    this.#initResources();
  }

  get stats(): RendererStats {
    return { ...this.#stats };
  }

  get document(): ImageDocument | null {
    return this.#doc;
  }

  /** Shows `doc` (or nothing). The view is not changed; call `viewport.fit()` as needed. */
  setDocument(doc: ImageDocument | null): void {
    if (doc === this.#doc) return;
    this.#stopTracking?.();
    this.#tracker?.dispose();
    this.#clearComposites();
    this.#doc = doc;
    this.#tracker = doc ? new DirtyTracker(doc) : null;
    this.#stopTracking = this.#tracker?.onDirty(() => this.requestRender()) ?? null;
    this.requestRender();
  }

  /** Sets the drawing-buffer size from a CSS size and device pixel ratio. */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.devicePixelRatio = devicePixelRatio;
    const w = Math.max(1, Math.round(cssWidth * devicePixelRatio));
    const h = Math.max(1, Math.round(cssHeight * devicePixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.viewport.setViewSize(w, h);
    this.requestRender();
  }

  /** Called after every rendered frame. */
  onFrame(listener: (stats: RendererStats) => void): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  /** Schedules a frame (coalesced to one per animation frame). */
  requestRender(): void {
    if (this.#rafId !== null || typeof requestAnimationFrame === 'undefined') return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null;
      this.render();
    });
  }

  /** Renders a frame now. Returns true when every visible tile is up to date. */
  render(): boolean {
    if (this.#lost || !this.#programs) return false;
    const t0 = performance.now();
    const gl = this.#gl;
    this.#frame++;
    this.#applyDirty();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const [pr, pg, pb] = this.#options.pasteboardColor;
    gl.clearColor(pr ?? 0, pg ?? 0, pb ?? 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let complete = true;
    const doc = this.#doc;
    if (doc) complete = this.#drawDocument(doc);

    this.#evictComposites();
    this.#stats.frames++;
    this.#stats.lastFrameMs = performance.now() - t0;
    this.#stats.complete = complete;
    this.#stats.layerTextures = this.#layerTextures.size;
    this.#stats.compositeTiles = this.#composites.size;
    if (!complete) this.requestRender();
    for (const listener of this.#frameListeners) listener(this.stats);
    return complete;
  }

  /**
   * Reads the full-resolution composite (premultiplied RGBA, 0–1) of a document
   * rectangle, computing any missing tiles. For tests and diagnostics.
   */
  readComposite(rect: Rect): Float32Array {
    const doc = this.#doc;
    if (!doc) throw new Error('No document');
    this.#applyDirty();
    const gl = this.#gl;
    const out = new Float32Array(rect.w * rect.h * 4);
    const tile = new Float32Array(TILE_SIZE * TILE_SIZE * 4);
    const bytes = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    for (let ty = tileIndex(rect.y); ty <= tileIndex(rect.y + rect.h - 1); ty++) {
      for (let tx = tileIndex(rect.x); tx <= tileIndex(rect.x + rect.w - 1); tx++) {
        const entry = this.#ensure(doc, 0, tx, ty, { left: Infinity, deadline: Infinity });
        if (!entry) throw new Error('Composite tile unavailable');
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.tex, 0);
        if (this.#floatTargets) {
          gl.readPixels(0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.FLOAT, tile);
        } else {
          gl.readPixels(0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          for (let i = 0; i < bytes.length; i++) tile[i] = bytes[i]! / 255;
        }
        const span = intersectRects(rect, { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
        for (let y = span.y; y < span.y + span.h; y++) {
          const src = ((y - ty * TILE_SIZE) * TILE_SIZE + (span.x - tx * TILE_SIZE)) * 4;
          out.set(tile.subarray(src, src + span.w * 4), ((y - rect.y) * rect.w + (span.x - rect.x)) * 4);
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /**
   * A small picture of the whole document — the top pyramid tile, at most
   * 256 × 256 — over a fine checkerboard, as opaque sRGB RGBA8 (for the Navigator).
   */
  thumbnail(): { width: number; height: number; scale: number; data: Uint8ClampedArray } | null {
    const doc = this.#doc;
    if (!doc || this.#lost || !this.#programs) return null;
    this.#applyDirty();
    const level = this.#maxLevel(doc);
    const entry = this.#ensure(doc, level, 0, 0, { left: Infinity, deadline: Infinity });
    if (!entry) return null;
    const scale = 2 ** level;
    const width = Math.max(1, Math.ceil(doc.width / scale));
    const height = Math.max(1, Math.ceil(doc.height / scale));
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.tex, 0);
    const src = new Float32Array(width * height * 4);
    if (this.#floatTargets) {
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, src);
    } else {
      const bytes = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      for (let i = 0; i < bytes.length; i++) src[i] = bytes[i]! / 255;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const [ca, cb] = this.#options.checkerColors;
    const linear = doc.depth === 32;
    const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
    const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const checker = ((x >> 2) + (y >> 2)) % 2 === 0 ? ca : cb;
        const a = src[i + 3]!;
        for (let c = 0; c < 3; c++) {
          const k = checker[c] ?? 1;
          const v = linear
            ? toSrgb(Math.min(1, Math.max(0, src[i + c]! + toLinear(k) * (1 - a))))
            : src[i + c]! + k * (1 - a);
          data[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
        }
        data[i + 3] = 255;
      }
    }
    return { width, height, scale, data };
  }

  /** Reads the canvas (RGBA8, rows top to bottom). Requires `preserveDrawingBuffer` or a fresh render. */
  readCanvas(): Uint8Array {
    const gl = this.#gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(raw.length);
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }

  dispose(): void {
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
    this.setDocument(null);
    this.#deleteResources();
    this.canvas.removeEventListener('webglcontextlost', this.#onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.#onContextRestored);
    this.#frameListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  #initResources(): void {
    const gl = this.#gl;
    this.#floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.#stats.floatTargets = this.#floatTargets;
    this.#compositeFormat = this.#floatTargets ? gl.RGBA16F : gl.RGBA8;
    this.#compositeBytes = this.#floatTargets ? COMPOSITE_BYTES_F16 : COMPOSITE_BYTES_F16 / 2;

    this.#quad = gl.createVertexArray();
    gl.bindVertexArray(this.#quad);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.#fbo = gl.createFramebuffer();
    this.#programs = {
      solid: new Program(gl, TARGET_RECT_VS, SOLID_FS),
      copy: new Program(gl, TARGET_RECT_VS, COPY_FS),
      mix: new Program(gl, TARGET_RECT_VS, MIX_FS),
      downsample: new Program(gl, TARGET_RECT_VS, DOWNSAMPLE_FS),
      display: new Program(gl, DISPLAY_VS, DISPLAY_FS),
    };
  }

  #deleteResources(): void {
    const gl = this.#gl;
    this.#clearComposites();
    for (const t of this.#layerTextures.values()) gl.deleteTexture(t.tex);
    this.#layerTextures.clear();
    this.#layerTextureBytes = 0;
    for (const t of this.#tempPool) gl.deleteTexture(t);
    this.#tempPool.length = 0;
    for (const p of this.#layerPrograms.values()) p.delete();
    this.#layerPrograms.clear();
    if (this.#programs) for (const p of Object.values(this.#programs)) p.delete();
    this.#programs = null;
    gl.deleteFramebuffer(this.#fbo);
    gl.deleteVertexArray(this.#quad);
  }

  readonly #onContextLost = (event: Event) => {
    event.preventDefault(); // allow restoration
    this.#lost = true;
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
    // GPU objects are gone with the context; forget them.
    this.#layerTextures.clear();
    this.#layerTextureBytes = 0;
    this.#composites.clear();
    this.#tempPool.length = 0;
    this.#layerPrograms.clear();
    this.#programs = null;
  };

  readonly #onContextRestored = () => {
    this.#lost = false;
    this.#initResources();
    this.#tracker?.markAll();
    this.requestRender();
  };

  // ---------------------------------------------------------------------------
  // Dirty tracking and the composite pyramid
  // ---------------------------------------------------------------------------

  #maxLevel(doc: ImageDocument): number {
    return Math.max(0, Math.ceil(Math.log2(Math.max(doc.width, doc.height) / TILE_SIZE)));
  }

  #applyDirty(): void {
    const doc = this.#doc;
    if (!doc || !this.#tracker?.isDirty) return;
    const dirty = this.#tracker.consume();
    if (dirty.all) {
      for (const entry of this.#composites.values()) entry.valid = false;
      return;
    }
    const maxLevel = this.#maxLevel(doc);
    for (const [tx, ty] of dirty.tiles) {
      for (let level = 0; level <= maxLevel; level++) {
        const entry = this.#composites.get(compositeKey(level, tx >> level, ty >> level));
        if (entry) entry.valid = false;
      }
    }
  }

  /** Tiles per row/column of the document at `level`. */
  #levelTiles(doc: ImageDocument, level: number): [number, number] {
    const size = TILE_SIZE << level;
    return [Math.ceil(doc.width / size), Math.ceil(doc.height / size)];
  }

  /**
   * Returns an up-to-date composite tile, computing it (and, for coarse levels, its
   * children) if the work budget allows. Returns the stale entry, or null, otherwise.
   */
  #ensure(doc: ImageDocument, level: number, tx: number, ty: number, budget: WorkBudget): CompositeEntry | null {
    const key = compositeKey(level, tx, ty);
    let entry = this.#composites.get(key) ?? null;
    if (entry?.valid) {
      entry.used = this.#frame;
      return entry;
    }
    if (exhausted(budget)) return entry;

    if (level > 0) {
      // Children first; give up for this frame if any of them is not ready.
      const [nx, ny] = this.#levelTiles(doc, level - 1);
      const children: (CompositeEntry | null)[] = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = tx * 2 + dx;
          const cy = ty * 2 + dy;
          if (cx >= nx || cy >= ny) {
            children.push(null);
            continue;
          }
          const child = this.#ensure(doc, level - 1, cx, cy, budget);
          if (!child?.valid) return entry;
          children.push(child);
        }
      }
      if (exhausted(budget)) return entry;
      entry ??= this.#newEntry(key);
      this.#downsample(entry, children);
    } else {
      entry ??= this.#newEntry(key);
      this.#composite(doc, entry, tx, ty);
    }
    budget.left--;
    entry.valid = true;
    entry.used = this.#frame;
    return entry;
  }

  #newEntry(key: string): CompositeEntry {
    const entry = {
      tex: createTexture(this.#gl, this.#compositeFormat, TILE_SIZE, TILE_SIZE),
      valid: false,
      used: this.#frame,
    };
    this.#composites.set(key, entry);
    return entry;
  }

  #clearComposites(): void {
    for (const entry of this.#composites.values()) this.#gl.deleteTexture(entry.tex);
    this.#composites.clear();
  }

  #evictComposites(): void {
    const max = Math.floor(this.#options.compositeBudget / this.#compositeBytes);
    if (this.#composites.size <= max) return;
    const victims = [...this.#composites.entries()]
      .filter(([, e]) => e.used < this.#frame)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key, entry] of victims) {
      if (this.#composites.size <= max) break;
      this.#gl.deleteTexture(entry.tex);
      this.#composites.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Compositing
  // ---------------------------------------------------------------------------

  #bindTarget(tex: WebGLTexture): void {
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
  }

  #drawRect(program: Program, x: number, y: number, w: number, h: number): void {
    const gl = this.#gl;
    gl.uniform4f(program.loc('u_rect'), x, y, w, h);
    gl.uniform2f(program.loc('u_targetSize'), TILE_SIZE, TILE_SIZE);
    gl.bindVertexArray(this.#quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  #acquireTemp(): WebGLTexture {
    return this.#tempPool.pop() ?? createTexture(this.#gl, this.#compositeFormat, TILE_SIZE, TILE_SIZE);
  }

  #composite(doc: ImageDocument, entry: CompositeEntry, tx: number, ty: number): void {
    const gl = this.#gl;
    this.#bindTarget(entry.tex);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const tileRect = { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
    // Blend passes ping-pong between textures (returning replaced ones to the pool);
    // the entry keeps whichever holds the result.
    entry.tex = this.#compositeNodes(doc, doc.root.children, tileRect, entry.tex);
    gl.disable(gl.BLEND);
    this.#stats.composites++;
  }

  /**
   * Composites `nodes` onto `target` and returns the texture holding the result.
   * Takes ownership of `target`: when a blend pass replaces it, the old texture goes
   * back to the pool. Normal and Dissolve use hardware blending in place; other
   * modes read the backdrop and write into a fresh texture.
   */
  #compositeNodes(doc: ImageDocument, nodes: readonly LayerNode[], tileRect: Rect, target: WebGLTexture): WebGLTexture {
    const gl = this.#gl;
    const programs = this.#programs!;
    let current = target;
    for (const node of nodes) {
      if (!node.visible || node.opacity === 0) continue;
      if (node.kind === 'pixel') {
        if (node.blendMode === 'normal' || node.blendMode === 'dissolve' || node.blendMode === 'pass-through') {
          this.#bindTarget(current);
          gl.enable(gl.BLEND);
          this.#drawLayer(doc, node, tileRect, null);
        } else {
          current = this.#blendPass(current, (backdrop) => this.#drawLayer(doc, node, tileRect, backdrop));
        }
      } else if (node.blendMode === 'pass-through') {
        if (node.opacity >= 1) {
          current = this.#compositeNodes(doc, node.children, tileRect, current);
          continue;
        }
        // Mix between the backdrop before and after the group.
        const before = this.#acquireTemp();
        this.#copy(current, before, 1, false);
        this.#bindTarget(current);
        current = this.#compositeNodes(doc, node.children, tileRect, current);
        const mixed = this.#acquireTemp();
        this.#bindTarget(mixed);
        gl.disable(gl.BLEND);
        programs.mix.use();
        this.#bindSampler(0, before, programs.mix, 'u_before');
        this.#bindSampler(1, current, programs.mix, 'u_after');
        gl.uniform1f(programs.mix.loc('u_opacity'), node.opacity);
        this.#drawRect(programs.mix, 0, 0, TILE_SIZE, TILE_SIZE);
        this.#unbindSamplers(2);
        gl.enable(gl.BLEND);
        this.#tempPool.push(before, current);
        current = mixed;
      } else {
        const group = this.#acquireTemp();
        this.#bindTarget(group);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        const result = this.#compositeNodes(doc, node.children, tileRect, group);
        const strength = node.opacity * node.fillOpacity;
        if (node.blendMode === 'normal') {
          this.#copy(result, current, strength, true);
        } else if (node.blendMode === 'dissolve') {
          this.#bindTarget(current);
          gl.enable(gl.BLEND);
          const program = this.#program('dissolve:premul', () => DISSOLVE_PREMUL_FS).use();
          this.#bindSampler(0, result, program, 'u_src');
          gl.uniform1f(program.loc('u_opacity'), strength);
          gl.uniform2i(program.loc('u_docOrigin'), tileRect.x, tileRect.y);
          this.#drawRect(program, 0, 0, TILE_SIZE, TILE_SIZE);
          this.#unbindSamplers(1);
        } else {
          const mode = node.blendMode;
          current = this.#blendPass(current, (backdrop) => {
            const program = this.#program('blend:premul', () => blendFS({ kind: 'premultiplied' })).use();
            this.#bindSampler(0, result, program, 'u_src');
            this.#bindSampler(1, backdrop, program, 'u_backdrop');
            this.#setBlendUniforms(program, mode, node.opacity, node.fillOpacity, doc.depth === 32);
            this.#drawRect(program, 0, 0, TILE_SIZE, TILE_SIZE);
          });
        }
        this.#tempPool.push(result);
      }
    }
    return current;
  }

  /** Runs a blend pass: copies `current` into a new texture, draws over it reading `current` as the backdrop. */
  #blendPass(current: WebGLTexture, draw: (backdrop: WebGLTexture) => void): WebGLTexture {
    const gl = this.#gl;
    const next = this.#acquireTemp();
    this.#copy(current, next, 1, false);
    this.#bindTarget(next);
    gl.disable(gl.BLEND);
    draw(current);
    this.#unbindSamplers(2);
    gl.enable(gl.BLEND);
    this.#tempPool.push(current);
    return next;
  }

  #setBlendUniforms(program: Program, mode: BlendMode, opacity: number, fill: number, hdr: boolean): void {
    const gl = this.#gl;
    gl.uniform1i(program.loc('u_mode'), LAYER_BLEND_MODES.indexOf(mode as LayerBlendMode));
    gl.uniform1f(program.loc('u_opacity'), opacity);
    gl.uniform1f(program.loc('u_fill'), fill);
    gl.uniform1i(program.loc('u_special'), SPECIAL_EIGHT.has(mode) ? 1 : 0);
    gl.uniform1i(program.loc('u_hdr'), hdr ? 1 : 0);
  }

  /** Draws `src` onto `dst` scaled by `opacity`, blended (Normal) or replacing. */
  #copy(src: WebGLTexture, dst: WebGLTexture, opacity: number, blend: boolean): void {
    const gl = this.#gl;
    const program = this.#programs!.copy;
    this.#bindTarget(dst);
    if (blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    program.use();
    this.#bindSampler(0, src, program, 'u_src');
    gl.uniform1f(program.loc('u_opacity'), opacity);
    this.#drawRect(program, 0, 0, TILE_SIZE, TILE_SIZE);
    this.#unbindSamplers(1);
    gl.enable(gl.BLEND);
  }

  #bindSampler(unit: number, tex: WebGLTexture, program: Program, name: string): void {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(program.loc(name), unit);
  }

  #unbindSamplers(count: number): void {
    const gl = this.#gl;
    for (let i = count - 1; i >= 0; i--) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /**
   * Draws a layer's tiles covering a composite tile into the bound target. With a
   * `backdrop` (blend modes other than Normal/Dissolve) the shader composites the
   * full result itself; otherwise hardware blending does Normal "over".
   */
  #drawLayer(doc: ImageDocument, layer: PixelLayer, tileRect: Rect, backdrop: WebGLTexture | null): void {
    const gl = this.#gl;
    const buffer = layer.buffer;
    const format = buffer.format;
    const spp = samplesPerPixel(format);
    if (spp > 4) throw new Error(`Displaying ${doc.mode} documents is not supported yet`);
    const strength = layer.opacity * layer.fillOpacity;
    const scale = format.depth === 16 ? 1 / 65535 : 1;
    const max = maxSampleValue(format.depth);
    const alphaIndex = format.colorChannels;
    const defaultAlpha = format.hasAlpha ? buffer.defaultPixel[alphaIndex]! / max : 1;
    const dissolve = layer.blendMode === 'dissolve';
    const tileKind = `${format.depth}:${spp}:${format.colorChannels}`;
    const source = { kind: 'tile', depth: format.depth, spp, colorChannels: format.colorChannels } as const;

    // The composite tile in the layer's own pixel space.
    const local = { x: tileRect.x - layer.offsetX, y: tileRect.y - layer.offsetY, w: TILE_SIZE, h: TILE_SIZE };
    for (let lty = tileIndex(local.y); lty <= tileIndex(local.y + TILE_SIZE - 1); lty++) {
      for (let ltx = tileIndex(local.x); ltx <= tileIndex(local.x + TILE_SIZE - 1); ltx++) {
        const span = intersectRects(local, { x: ltx * TILE_SIZE, y: lty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
        if (isEmptyRect(span)) continue;
        const x = span.x - local.x;
        const y = span.y - local.y;
        const tile = buffer.getTile(ltx, lty);
        const defaultColor = (i: number) =>
          (format.colorChannels === 1 ? buffer.defaultPixel[0]! : buffer.defaultPixel[i]!) / max;
        if (tile) {
          const program = backdrop
            ? this.#program(`blend:tile:${tileKind}`, () => blendFS(source))
            : dissolve
              ? this.#program(`dissolve:${tileKind}`, () => dissolveTileFS(format.depth, spp, format.colorChannels))
              : this.#program(`normal:${tileKind}`, () => layerTileFS(format.depth, spp, format.colorChannels));
          program.use();
          this.#bindSampler(0, this.#layerTexture(tile, format.depth, spp), program, 'u_tile');
          gl.uniform2i(program.loc('u_srcOffset'), local.x - ltx * TILE_SIZE, local.y - lty * TILE_SIZE);
          gl.uniform1f(program.loc('u_scale'), format.depth === 8 ? 1 : scale);
          if (backdrop) {
            this.#bindSampler(1, backdrop, program, 'u_backdrop');
            this.#setBlendUniforms(program, layer.blendMode, layer.opacity, layer.fillOpacity, doc.depth === 32);
          } else {
            gl.uniform1f(program.loc('u_opacity'), strength);
            if (dissolve) gl.uniform2i(program.loc('u_docOrigin'), tileRect.x, tileRect.y);
          }
          this.#drawRect(program, x, y, span.w, span.h);
        } else if (defaultAlpha > 0) {
          if (backdrop) {
            const program = this.#program('blend:solid', () => blendFS({ kind: 'solid' })).use();
            gl.uniform4f(program.loc('u_color'), defaultColor(0), defaultColor(1), defaultColor(2), defaultAlpha);
            this.#bindSampler(1, backdrop, program, 'u_backdrop');
            this.#setBlendUniforms(program, layer.blendMode, layer.opacity, layer.fillOpacity, doc.depth === 32);
            this.#drawRect(program, x, y, span.w, span.h);
          } else if (dissolve) {
            const program = this.#program('dissolve:solid', () => DISSOLVE_SOLID_FS).use();
            gl.uniform4f(program.loc('u_color'), defaultColor(0), defaultColor(1), defaultColor(2), defaultAlpha);
            gl.uniform1f(program.loc('u_opacity'), strength);
            gl.uniform2i(program.loc('u_docOrigin'), tileRect.x, tileRect.y);
            this.#drawRect(program, x, y, span.w, span.h);
          } else {
            const program = this.#programs!.solid.use();
            const a = defaultAlpha * strength;
            gl.uniform4f(program.loc('u_color'), defaultColor(0) * a, defaultColor(1) * a, defaultColor(2) * a, a);
            this.#drawRect(program, x, y, span.w, span.h);
          }
        }
      }
    }
  }

  /** A compiled program from the cache, built by `fragment()` on first use. */
  #program(key: string, fragment: () => string): Program {
    let program = this.#layerPrograms.get(key);
    if (!program) {
      program = new Program(this.#gl, TARGET_RECT_VS, fragment());
      this.#layerPrograms.set(key, program);
    }
    return program;
  }

  #layerTexture(tile: Tile, depth: 8 | 16 | 32, spp: number): WebGLTexture {
    const gl = this.#gl;
    let entry = this.#layerTextures.get(tile.id);
    if (entry && entry.version === tile.version) {
      entry.used = this.#frame;
      return entry.tex;
    }
    const fmt = tileTextureFormat(gl, depth, spp);
    if (!entry) {
      this.#evictLayerTextures(tile.byteLength);
      entry = {
        tex: createTexture(gl, fmt.internal, TILE_SIZE, TILE_SIZE),
        version: -1,
        bytes: tile.byteLength,
        used: this.#frame,
      };
      this.#layerTextures.set(tile.id, entry);
      this.#layerTextureBytes += entry.bytes;
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data = tile.data;
    try {
      if (!this.#sharedUploadsSupported && data.buffer instanceof SharedArrayBuffer) throw new TypeError('shared');
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_SIZE, TILE_SIZE, fmt.format, fmt.type, data);
    } catch (error) {
      if (!(data.buffer instanceof SharedArrayBuffer)) throw error;
      // Some browsers refuse shared memory for uploads: copy first.
      this.#sharedUploadsSupported = false;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_SIZE, TILE_SIZE, fmt.format, fmt.type, data.slice());
    }
    entry.version = tile.version;
    entry.used = this.#frame;
    this.#stats.uploads++;
    return entry.tex;
  }

  #evictLayerTextures(incoming: number): void {
    if (this.#layerTextureBytes + incoming <= this.#options.layerTextureBudget) return;
    const victims = [...this.#layerTextures.entries()]
      .filter(([, e]) => e.used < this.#frame)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [id, entry] of victims) {
      if (this.#layerTextureBytes + incoming <= this.#options.layerTextureBudget) break;
      this.#gl.deleteTexture(entry.tex);
      this.#layerTextures.delete(id);
      this.#layerTextureBytes -= entry.bytes;
    }
  }

  #downsample(entry: CompositeEntry, children: (CompositeEntry | null)[]): void {
    const gl = this.#gl;
    const program = this.#programs!.downsample;
    this.#bindTarget(entry.tex);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    program.use();
    const half = TILE_SIZE / 2;
    children.forEach((child, i) => {
      if (!child) return;
      const qx = (i % 2) * half;
      const qy = Math.floor(i / 2) * half;
      this.#bindSampler(0, child.tex, program, 'u_child');
      gl.uniform2i(program.loc('u_quadrant'), qx, qy);
      this.#drawRect(program, qx, qy, half, half);
    });
    this.#unbindSamplers(1);
    this.#stats.downsamples++;
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------

  /** Pyramid level for the current zoom: the coarsest level still at least as sharp as the screen. */
  #displayLevel(doc: ImageDocument): number {
    const zoom = this.viewport.zoom;
    if (zoom >= 1) return 0;
    return Math.min(this.#maxLevel(doc), Math.max(0, Math.floor(Math.log2(1 / zoom))));
  }

  #drawDocument(doc: ImageDocument): boolean {
    const gl = this.#gl;
    const level = this.#displayLevel(doc);
    const size = TILE_SIZE << level;
    const canvasRect = doc.canvasRect;
    const visible = intersectRects(roundOut(this.viewport.visibleDocRect()), canvasRect);
    if (isEmptyRect(visible)) return true;

    // Visible tiles, nearest to the view centre first (they are computed first).
    const tiles: [number, number][] = [];
    for (let ty = Math.floor(visible.y / size); ty <= Math.floor((visible.y + visible.h - 1) / size); ty++) {
      for (let tx = Math.floor(visible.x / size); tx <= Math.floor((visible.x + visible.w - 1) / size); tx++)
        tiles.push([tx, ty]);
    }
    const cx = this.viewport.centerX / size;
    const cy = this.viewport.centerY / size;
    tiles.sort((a, b) => Math.hypot(a[0] + 0.5 - cx, a[1] + 0.5 - cy) - Math.hypot(b[0] + 0.5 - cx, b[1] + 0.5 - cy));

    const budget: WorkBudget = {
      left: this.#options.workPerFrame,
      deadline: performance.now() + this.#options.frameBudgetMs,
    };
    let complete = true;
    const draws: { entry: CompositeEntry; level: number; tx: number; ty: number; rect: Rect }[] = [];
    for (const [tx, ty] of tiles) {
      const rect = intersectRects({ x: tx * size, y: ty * size, w: size, h: size }, canvasRect);
      const entry = this.#ensure(doc, level, tx, ty, budget);
      if (entry?.valid) {
        draws.push({ entry, level, tx, ty, rect });
        continue;
      }
      complete = false;
      if (entry) {
        draws.push({ entry, level, tx, ty, rect }); // stale content until refreshed
        continue;
      }
      // Fall back to the nearest coarser tile that exists.
      for (let l = level + 1; l <= this.#maxLevel(doc); l++) {
        const coarse = this.#composites.get(compositeKey(l, tx >> (l - level), ty >> (l - level)));
        if (coarse) {
          coarse.used = this.#frame;
          draws.push({ entry: coarse, level: l, tx: tx >> (l - level), ty: ty >> (l - level), rect });
          break;
        }
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    const program = this.#programs!.display.use();
    const [ca, cb] = this.#options.checkerColors;
    const grid = this.#options.gridColor;
    gl.uniformMatrix3fv(program.loc('u_docToClip'), false, this.viewport.docToClipMatrix());
    gl.uniform1i(program.loc('u_linear'), doc.depth === 32 ? 1 : 0);
    gl.uniform1f(program.loc('u_zoom'), this.viewport.zoom);
    gl.uniform1f(program.loc('u_checkerSize'), this.#options.checkerSize * this.devicePixelRatio);
    gl.uniform3f(program.loc('u_checkerA'), ca[0] ?? 1, ca[1] ?? 1, ca[2] ?? 1);
    gl.uniform3f(program.loc('u_checkerB'), cb[0] ?? 0.8, cb[1] ?? 0.8, cb[2] ?? 0.8);
    gl.uniform1i(program.loc('u_grid'), this.showPixelGrid && this.viewport.showsPixelGrid ? 1 : 0);
    gl.uniform4f(program.loc('u_gridColor'), grid[0] ?? 0.5, grid[1] ?? 0.5, grid[2] ?? 0.5, grid[3] ?? 0.45);
    const filter = level === 0 && this.viewport.zoom >= 1 ? gl.NEAREST : gl.LINEAR;
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(program.loc('u_composite'), 0);
    gl.bindVertexArray(this.#quad);
    for (const d of draws) {
      const tileSize = TILE_SIZE << d.level;
      gl.bindTexture(gl.TEXTURE_2D, d.entry.tex);
      const f = d.level === level ? filter : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.uniform4f(program.loc('u_tileRect'), d.tx * tileSize, d.ty * tileSize, tileSize, tileSize);
      gl.uniform4f(program.loc('u_docRect'), d.rect.x, d.rect.y, d.rect.w, d.rect.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return complete;
  }
}

/** Gets a WebGL 2 context from either kind of canvas (resolving each overload separately). */
function getWebGL2(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  attributes: WebGLContextAttributes,
): WebGL2RenderingContext | null {
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
    return canvas.getContext('webgl2', attributes);
  }
  return (canvas as OffscreenCanvas).getContext('webgl2', attributes);
}

function compositeKey(level: number, tx: number, ty: number): string {
  return `${level}:${tx}:${ty}`;
}

function roundOut(r: { x: number; y: number; w: number; h: number }): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}
