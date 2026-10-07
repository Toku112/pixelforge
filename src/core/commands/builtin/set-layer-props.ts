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

interface LayerChange {
  id: string;
  props: LayerPropChanges;
}

class SetLayerPropsCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly undoBytes = 0;
  readonly #ctx: CommandContext;
  readonly #changes: LayerChange[];
  #previous: LayerPropChanges[] = [];

  constructor(ctx: CommandContext, changes: LayerChange[], params: JsonObject) {
    this.#ctx = ctx;
    this.#changes = changes;
    const visibilityOnly = changes.every((c) => Object.keys(c.props).length === 1 && 'visible' in c.props);
    const shown = new Set(changes.map((c) => c.props.visible));
    if (visibilityOnly && changes.length > 1) {
      this.label = shown.size > 1 ? 'Show/Hide Layers' : shown.has(true) ? 'Show Layers' : 'Hide Layers';
    } else {
      this.label = labelFor(changes[0]!.props);
    }
    this.descriptor = { name: 'setLayerProps', params };
  }

  execute(): void {
    const doc = this.#ctx.doc;
    // Check every layer first so a refusal leaves nothing half-changed.
    for (const c of this.#changes) doc.requireLayer(c.id);
    this.#previous = [];
    try {
      for (const c of this.#changes) this.#previous.push(doc.updateLayer(c.id, c.props));
    } catch (error) {
      this.#previous.forEach((prev, i) => doc.updateLayer(this.#changes[i]!.id, prev));
      throw error;
    }
  }

  undo(): void {
    for (let i = this.#previous.length - 1; i >= 0; i--)
      this.#ctx.doc.updateLayer(this.#changes[i]!.id, this.#previous[i]!);
  }

  redo(): void {
    for (const c of this.#changes) this.#ctx.doc.updateLayer(c.id, c.props);
  }
}

const toJson = (props: LayerPropChanges) => props as unknown as JsonObject;

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((id) => typeof id === 'string');

/**
 * Changes properties of one layer (`layerId`), the same properties of several
 * (`layerIds`), or different properties per layer (`changes: [{ layerId, props }]`),
 * always as one history step.
 */
export const setLayerPropsCommand: CommandDefinition = {
  name: 'setLayerProps',
  create: (ctx, params) => {
    const single = params['layerId'];
    const many = params['layerIds'];
    const changes = params['changes'];
    if (typeof single === 'string') {
      const props = parseProps(params['props']);
      return new SetLayerPropsCommand(ctx, [{ id: single, props }], { layerId: single, props: toJson(props) });
    }
    if (isIdList(many)) {
      const props = parseProps(params['props']);
      return new SetLayerPropsCommand(
        ctx,
        many.map((id) => ({ id, props })),
        { layerIds: many, props: toJson(props) },
      );
    }
    if (Array.isArray(changes) && changes.length > 0) {
      const list = changes.map((c) => {
        if (typeof c !== 'object' || c === null || Array.isArray(c) || typeof c['layerId'] !== 'string')
          throw new Error('setLayerProps: each change needs a layerId and props');
        return { id: c['layerId'], props: parseProps(c['props']) };
      });
      return new SetLayerPropsCommand(ctx, list, {
        changes: list.map((c) => ({ layerId: c.id, props: toJson(c.props) })),
      });
    }
    throw new Error('setLayerProps: layerId must be a string (or layerIds a list of layer ids, or changes a list)');
  },
};
