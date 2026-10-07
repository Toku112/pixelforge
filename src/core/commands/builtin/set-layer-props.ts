/**
 * Changes layer properties (visibility, name, opacity, fill, blend mode, offset,
 * locks). Used by the Layers panel, the Move tool and layer dialogs.
 */
import { LAYER_BLEND_MODES, type GroupLayerProps, type PixelLayerProps } from '../../document/layers';
import type { Command, CommandContext, JsonObject } from '../command';
import type { CommandDefinition } from '../registry';

export type LayerPropChanges = Partial<PixelLayerProps & GroupLayerProps>;

const VALIDATORS: Record<keyof LayerPropChanges, (v: unknown) => boolean> = {
  name: (v) => typeof v === 'string',
  visible: (v) => typeof v === 'boolean',
  opacity: (v) => typeof v === 'number',
  fillOpacity: (v) => typeof v === 'number',
  blendMode: (v) => v === 'pass-through' || (LAYER_BLEND_MODES as readonly unknown[]).includes(v),
  offsetX: (v) => typeof v === 'number',
  offsetY: (v) => typeof v === 'number',
  expanded: (v) => typeof v === 'boolean',
  locks: (v) => typeof v === 'object' && v !== null,
};

function parseProps(raw: unknown): LayerPropChanges {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('setLayerProps: props must be an object');
  const entries = Object.entries(raw);
  if (entries.length === 0) throw new Error('setLayerProps: no properties to change');
  for (const [key, value] of entries) {
    const valid = Object.hasOwn(VALIDATORS, key) ? VALIDATORS[key as keyof LayerPropChanges] : undefined;
    if (!valid) throw new Error(`setLayerProps: unknown property "${key}"`);
    if (!valid(value)) throw new Error(`setLayerProps: invalid value for "${key}"`);
  }
  return raw;
}

function labelFor(props: LayerPropChanges): string {
  const keys = Object.keys(props);
  if (keys.length === 1) {
    switch (keys[0]) {
      case 'visible':
        return props.visible ? 'Show Layer' : 'Hide Layer';
      case 'name':
        return 'Rename Layer';
      case 'opacity':
        return 'Layer Opacity';
      case 'fillOpacity':
        return 'Fill Opacity';
      case 'blendMode':
        return 'Blend Mode Change';
      case 'locks':
        return 'Lock Layer';
    }
  }
  if (keys.every((k) => k === 'offsetX' || k === 'offsetY')) return 'Move';
  return 'Layer Properties';
}

class SetLayerPropsCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly undoBytes = 0;
  readonly #ctx: CommandContext;
  readonly #layerIds: string[];
  readonly #props: LayerPropChanges;
  #previous: LayerPropChanges[] = [];

  constructor(ctx: CommandContext, layerIds: string[], props: LayerPropChanges, single: boolean) {
    this.#ctx = ctx;
    this.#layerIds = layerIds;
    this.#props = props;
    this.label = labelFor(props);
    const target: JsonObject = single ? { layerId: layerIds[0]! } : { layerIds };
    this.descriptor = { name: 'setLayerProps', params: { ...target, props: props as unknown as JsonObject } };
  }

  execute(): void {
    const doc = this.#ctx.doc;
    // Check every layer first so a refusal leaves nothing half-changed.
    for (const id of this.#layerIds) doc.requireLayer(id);
    this.#previous = [];
    try {
      for (const id of this.#layerIds) this.#previous.push(doc.updateLayer(id, this.#props));
    } catch (error) {
      this.#previous.forEach((prev, i) => doc.updateLayer(this.#layerIds[i]!, prev));
      throw error;
    }
  }

  undo(): void {
    this.#previous.forEach((prev, i) => this.#ctx.doc.updateLayer(this.#layerIds[i]!, prev));
  }

  redo(): void {
    for (const id of this.#layerIds) this.#ctx.doc.updateLayer(id, this.#props);
  }
}

/** Changes properties of one layer (`layerId`) or several at once (`layerIds`), as one history step. */
export const setLayerPropsCommand: CommandDefinition = {
  name: 'setLayerProps',
  create: (ctx, params) => {
    const single = params['layerId'];
    const many = params['layerIds'];
    if (typeof single === 'string') return new SetLayerPropsCommand(ctx, [single], parseProps(params['props']), true);
    if (Array.isArray(many) && many.length > 0 && many.every((v) => typeof v === 'string')) {
      return new SetLayerPropsCommand(ctx, many, parseProps(params['props']), false);
    }
    throw new Error('setLayerProps: layerId must be a string (or layerIds a list of layer ids)');
  },
};
