/**
 * Moving layers by whole pixels: the Move tool's drag ("Move") and the arrow keys
 * ("Nudge"). The move is relative (dx, dy), so a recorded Action moves whatever
 * layers are selected when it is replayed, as in the reference app.
 *
 * Groups move with everything inside them. The Background and layers whose
 * position is locked (also through a locked group) cannot move.
 */
import type { ImageDocument } from '../../document/document';
import { layerCapabilities, type LayerNode, type PixelLayer } from '../../document/layers';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';
import { stringArray, topLevelTargets } from './layer-common';

/** The pixel layers a move of `targets` shifts (groups contribute their contents). */
function pixelLayersOf(nodes: readonly LayerNode[]): PixelLayer[] {
  return nodes.flatMap((n) => (n.kind === 'pixel' ? [n] : pixelLayersOf(n.children)));
}

/** Why the layers cannot move, or null when they can. */
export function moveRefusal(doc: ImageDocument, ids: readonly string[]): string | null {
  const targets = topLevelTargets(doc, ids).map((id) => doc.requireLayer(id));
  if (targets.length === 0) return 'No layer is selected';
  for (const layer of [...targets, ...pixelLayersOf(targets)]) {
    if (layer.kind === 'pixel' && layer.isBackground) return 'The Background layer cannot be moved';
    if (!layerCapabilities(layer).move) return `“${layer.name}” is locked`;
  }
  return null;
}

class TranslateLayersCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly undoBytes = 0;
  readonly #ctx: CommandContext;
  readonly #ids: string[] | undefined;
  readonly #dx: number;
  readonly #dy: number;
  #moved: { id: string; x: number; y: number }[] = [];

  constructor(ctx: CommandContext, dx: number, dy: number, nudge: boolean, ids: string[] | undefined) {
    this.#ctx = ctx;
    this.#dx = dx;
    this.#dy = dy;
    this.#ids = ids;
    this.label = nudge ? 'Nudge' : 'Move';
    const params: JsonObject = { dx, dy };
    if (nudge) params['nudge'] = true;
    if (ids) params['layerIds'] = ids;
    this.descriptor = { name: 'translateLayers', params };
  }

  execute(): void {
    const doc = this.#ctx.doc;
    const ids = this.#ids ?? [...doc.selectedLayerIds];
    const refusal = moveRefusal(doc, ids);
    if (refusal) throw new CommandUnavailableError(refusal);
    const layers = pixelLayersOf(topLevelTargets(doc, ids).map((id) => doc.requireLayer(id)));
    this.#moved = layers.map((l) => ({ id: l.id, x: l.offsetX, y: l.offsetY }));
    this.redo();
  }

  undo(): void {
    for (const m of this.#moved) this.#ctx.doc.updateLayer(m.id, { offsetX: m.x, offsetY: m.y });
  }

  redo(): void {
    for (const m of this.#moved) this.#ctx.doc.updateLayer(m.id, { offsetX: m.x + this.#dx, offsetY: m.y + this.#dy });
  }
}

export const translateLayersCommand: CommandDefinition = {
  name: 'translateLayers',
  isAvailable: (ctx) => moveRefusal(ctx.doc, ctx.doc.selectedLayerIds) === null,
  create: (ctx, p) => {
    const { dx, dy } = p;
    if (!Number.isInteger(dx) || !Number.isInteger(dy))
      throw new Error('translateLayers: dx and dy must be whole pixels');
    return new TranslateLayersCommand(
      ctx,
      dx as number,
      dy as number,
      p['nudge'] === true,
      stringArray(p['layerIds'], 'layerIds'),
    );
  },
};
