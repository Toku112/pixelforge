import type { CommandRegistry } from '../registry';
import { invertCommand } from './invert';
import { layerCommands } from './layers';
import { setLayerPropsCommand } from './set-layer-props';

/** Registers every built-in document command. */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  registry.register(invertCommand);
  registry.register(setLayerPropsCommand);
  for (const definition of layerCommands) registry.register(definition);
}
