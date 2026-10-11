/** A painting tool's brush options in the options bar, and a setter that refreshes the bar. */
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { useUi } from '../state/ui-store';

export function useBrushOptions(tool: PaintingTool) {
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const o = tool.options;
  const set = (changes: Partial<typeof o>) => {
    tool.setOptions(changes);
    bump();
  };
  return { o, set, bump };
}
