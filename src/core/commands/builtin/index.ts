import type { CommandRegistry } from '../registry';
import { clearCommand } from './clear';
import { fillCommand } from './fill';
import { geometryCommands } from './geometry';
import { freeTransformCommand } from './transform';
import { invertCommand } from './invert';
import { layerCommands } from './layers';
import { mergeCommands } from './merge';
import { moveSelectedPixelsCommand } from './move-pixels';
import { paintStrokeCommand } from './paint';
import { selectionCommands } from './selection';
import { setLayerPropsCommand } from './set-layer-props';
import { translateLayersCommand } from './translate';

/** Registers every built-in document command. */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  registry.register(invertCommand);
  registry.register(clearCommand);
  registry.register(fillCommand);
  registry.register(paintStrokeCommand);
  registry.register(setLayerPropsCommand);
  registry.register(translateLayersCommand);
  registry.register(moveSelectedPixelsCommand);
  for (const definition of layerCommands) registry.register(definition);
  for (const definition of mergeCommands) registry.register(definition);
  for (const definition of selectionCommands) registry.register(definition);
  for (const definition of geometryCommands) registry.register(definition);
  registry.register(freeTransformCommand);
}
