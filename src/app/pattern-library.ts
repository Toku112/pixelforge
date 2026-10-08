/**
 * The patterns the app offers (brush Texture now; Fill and the Pattern Stamp later):
 * our built-in set. Patterns the user defines join it with Edit > Define Pattern.
 */
import { builtInPattern, builtInPatterns, type Pattern, type PatternSource } from '../core/pattern/pattern';

export class PatternLibrary implements PatternSource {
  get(id: string): Pattern | undefined {
    return builtInPattern(id);
  }

  /** In picker order. */
  list(): Pattern[] {
    return builtInPatterns();
  }
}
