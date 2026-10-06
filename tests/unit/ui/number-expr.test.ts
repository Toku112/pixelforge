import { describe, expect, it } from 'vitest';
import { evaluateNumberInput } from '../../../src/ui/controls/number-expr';

describe('typed math in numeric fields', () => {
  it.each([
    ['45', 0, 45],
    ['90-15', 0, 75],
    ['2*(3+4)', 0, 14],
    ['10/4', 0, 2.5],
    ['3x4', 0, 12],
    ['-30', 10, -30],
    ['+10', 50, 60],
    ['*2', 50, 100],
    ['/4', 50, 12.5],
    ['12.5%', 0, 12.5],
    ['15°', 0, 15],
    ['1,5', 0, 1.5],
    ['  7 ', 0, 7],
    ['-(2+3)', 0, -5],
  ])('%s (current %d) → %d', (input, current, expected) => {
    expect(evaluateNumberInput(input, current)).toBeCloseTo(expected, 10);
  });

  it.each(['', 'abc', '5+', '(2', '2)', '1//2', '/0', '5 5'])('rejects %j', (input) => {
    expect(evaluateNumberInput(input, 10)).toBeNull();
  });
});
