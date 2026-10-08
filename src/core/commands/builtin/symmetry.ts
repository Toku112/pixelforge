/**
 * Paint symmetry as a document command: choosing a type (New Symmetry), moving,
 * turning or scaling its guide (Transform Symmetry) and turning it off are History
 * steps, like the reference app's symmetry paths.
 */
import { parseSymmetry, type Symmetry } from '../../paint/symmetry';
import type { Command, CommandContext, JsonObject } from '../command';
import type { CommandDefinition } from '../registry';

/** The History label for going from one symmetry to another. */
export function symmetryLabel(before: Symmetry | null, after: Symmetry | null): string {
  if (!after || !after.enabled) return 'Turn Off Symmetry';
  if (!before || !before.enabled || before.kind !== after.kind || before.segments !== after.segments)
    return 'New Symmetry';
  return 'Transform Symmetry';
}

class SetSymmetryCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly undoBytes = 64;
  readonly #ctx: CommandContext;
  readonly #next: Symmetry | null;
  #previous: Symmetry | null = null;

  constructor(ctx: CommandContext, next: Symmetry | null) {
    this.#ctx = ctx;
    this.#next = next;
    this.label = symmetryLabel(ctx.doc.symmetry, next);
    this.descriptor = { name: 'setSymmetry', params: { symmetry: next as unknown as JsonObject | null } };
  }

  execute(): void {
    this.#previous = this.#ctx.doc.setSymmetry(this.#next);
  }

  undo(): void {
    this.#ctx.doc.setSymmetry(this.#previous);
  }

  redo(): void {
    this.#ctx.doc.setSymmetry(this.#next);
  }
}

export const setSymmetryCommand: CommandDefinition = {
  name: 'setSymmetry',
  create: (ctx, p) => {
    const raw = p['symmetry'];
    return new SetSymmetryCommand(ctx, raw === null || raw === undefined ? null : parseSymmetry(raw));
  },
};
