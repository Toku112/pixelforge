/**
 * Live and recorded brush strokes painted by WebAssembly (pixel-ops `BrushStroke`), with
 * the same interface as the TypeScript renderer (core/paint/stroke.ts). The stroke's
 * state (tiles before the stroke, coverage) stays in WebAssembly memory; after each
 * batch of dabs the changed tiles are copied into the layer's tile arrays.
 */
import { tileKey } from '../core/document/tile';
import type { SampleArray } from '../core/document/pixel-format';
import type { Dab } from '../core/paint/brush';
import type { StrokeSetup } from '../core/paint/stroke';
import { MaskReader } from '../core/selection/mask-ops';
import type { BrushStroke } from '../wasm/pkg/pixel-ops-st/pixel_ops.js';

/** What a stroke painter offers the worker (the TypeScript renderer has the same). */
export interface StrokePainter {
  hasTile(tx: number, ty: number): boolean;
  addTile(tx: number, ty: number, data: SampleArray): void;
  /** More of the History Brush's source tiles (painters of strokes with a history source). */
  addSourceTiles?(tiles: readonly { tx: number; ty: number; data: SampleArray }[]): void;
  applyDabs(dabs: readonly Dab[]): Set<number>;
  tile(key: number): { tx: number; ty: number; data: SampleArray } | undefined;
  /** Frees what the painter holds (WebAssembly memory). */
  dispose?(): void;
}

type BrushStrokeClass = new (
  depth: number,
  colorChannels: number,
  hasAlpha: boolean,
  color: Float64Array,
  opacity: number,
  flow: number,
  hardness: number,
  mode: number,
  lockAlpha: boolean,
  offsetX: number,
  offsetY: number,
  aliased: boolean,
) => BrushStroke;

const MODES = { normal: 0, behind: 1, clear: 2 } as const;

export class WasmStrokeRenderer implements StrokePainter {
  readonly #stroke: BrushStroke;
  readonly #setup: StrokeSetup;
  readonly #reader: MaskReader | null;
  readonly #tiles = new Map<number, { tx: number; ty: number; data: SampleArray; index: number }>();
  readonly #byIndex: number[] = [];
  /** The module's memory, to copy tiles out with one copy (null: through the bindings). */
  readonly #memory: WebAssembly.Memory | null;

  constructor(BrushStrokeImpl: BrushStrokeClass, setup: StrokeSetup, memory: WebAssembly.Memory | null = null) {
    this.#setup = setup;
    this.#memory = memory;
    const mode = setup.erase ? 3 : MODES[setup.mode as keyof typeof MODES];
    this.#stroke = new BrushStrokeImpl(
      setup.format.depth,
      setup.format.colorChannels,
      setup.format.hasAlpha,
      Float64Array.from(setup.color),
      setup.opacity,
      setup.flow,
      setup.hardness,
      mode,
      setup.lockAlpha,
      setup.offsetX,
      setup.offsetY,
      !!setup.aliased,
    );
    if (setup.tip) this.#stroke.set_tip(setup.tip.width, setup.tip.height, setup.tip.data);
    this.#reader = setup.selection ? new MaskReader(setup.selection.mask) : null;
  }

  hasTile(tx: number, ty: number): boolean {
    return this.#tiles.has(tileKey(tx, ty));
  }

  addTile(tx: number, ty: number, data: SampleArray): void {
    const key = tileKey(tx, ty);
    if (this.#tiles.has(key)) return;
    const s = this.#setup;
    const sel = this.#reader ? this.#reader.layerTile(s.selection!.canvas, s.offsetX, s.offsetY, tx, ty) : 255;
    const mask = typeof sel === 'number' ? new Uint8Array(0) : sel;
    const uniform = typeof sel === 'number' ? sel : 0;
    const index =
      data instanceof Uint8Array
        ? this.#stroke.add_tile_u8(tx, ty, data, mask, uniform)
        : data instanceof Uint16Array
          ? this.#stroke.add_tile_u16(tx, ty, data, mask, uniform)
          : this.#stroke.add_tile_f32(tx, ty, data, mask, uniform);
    this.#tiles.set(key, { tx, ty, data, index });
    this.#byIndex[index] = key;
  }

  applyDabs(dabs: readonly Dab[]): Set<number> {
    const flat = new Float64Array(dabs.length * 8);
    dabs.forEach((d, i) => {
      flat.set([d.x, d.y, d.size, d.strength, d.angle, d.roundness, d.flipX ? 1 : 0, d.flipY ? 1 : 0], i * 8);
    });
    const changed = new Set<number>();
    for (const index of this.#stroke.apply_dabs(flat)) {
      const key = this.#byIndex[index]!;
      const tile = this.#tiles.get(key)!;
      this.#copyOut(index, tile.data);
      changed.add(key);
    }
    return changed;
  }

  /** A tile's pixels from WebAssembly memory into the layer's array. */
  #copyOut(index: number, data: SampleArray): void {
    if (this.#memory) {
      // A fresh view each time: the memory may have grown since.
      const at = this.#stroke.tile_pointer(index);
      const buffer = this.#memory.buffer;
      if (data instanceof Uint8Array) data.set(new Uint8Array(buffer, at, data.length));
      else if (data instanceof Uint16Array) data.set(new Uint16Array(buffer, at, data.length));
      else data.set(new Float32Array(buffer, at, data.length));
      return;
    }
    if (data instanceof Uint8Array) this.#stroke.read_tile_u8(index, data);
    else if (data instanceof Uint16Array) this.#stroke.read_tile_u16(index, data);
    else this.#stroke.read_tile_f32(index, data);
  }

  tile(key: number): { tx: number; ty: number; data: SampleArray } | undefined {
    const t = this.#tiles.get(key);
    return t && { tx: t.tx, ty: t.ty, data: t.data };
  }

  dispose(): void {
    this.#stroke.free();
  }
}
