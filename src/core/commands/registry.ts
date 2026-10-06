import type { Command, CommandContext, CommandDescriptor, JsonObject } from './command';

export interface CommandDefinition {
  readonly name: string;
  /** Creates a command bound to a document from descriptor parameters. */
  create(ctx: CommandContext, params: JsonObject): Command;
  /**
   * Whether the command can run now (menus grey it out otherwise), e.g. Invert is
   * unavailable in 32-bit documents. Defaults to always available.
   */
  isAvailable?(ctx: CommandContext): boolean;
}

/** Maps descriptor names to command definitions, for Actions replay, scripting and menus. */
export class CommandRegistry {
  readonly #definitions = new Map<string, CommandDefinition>();

  register(definition: CommandDefinition): void {
    if (this.#definitions.has(definition.name)) throw new Error(`Command "${definition.name}" is already registered`);
    this.#definitions.set(definition.name, definition);
  }

  get(name: string): CommandDefinition | undefined {
    return this.#definitions.get(name);
  }

  has(name: string): boolean {
    return this.#definitions.has(name);
  }

  isAvailable(name: string, ctx: CommandContext): boolean {
    const definition = this.#definitions.get(name);
    return !!definition && (definition.isAvailable?.(ctx) ?? true);
  }

  /** Re-creates a command from its descriptor. */
  create(ctx: CommandContext, descriptor: CommandDescriptor): Command {
    const definition = this.#definitions.get(descriptor.name);
    if (!definition) throw new Error(`Unknown command "${descriptor.name}"`);
    return definition.create(ctx, descriptor.params);
  }
}
