/**
 * Typed math for numeric fields: "45", "90-15", "2*(3+4)", or a relative change
 * starting with an operator — "+10" adds 10 to the current value, "*2" doubles it,
 * "/4" divides it. A leading "-" is a negative number, not a subtraction. Unit
 * suffixes such as "%", "°", "px" are ignored. Returns null for invalid input.
 */
export function evaluateNumberInput(text: string, current: number): number | null {
  const cleaned = text.trim().replace(/(%|°|px|in|cm|mm|pt)$/i, '').trim().replace(',', '.');
  if (cleaned === '') return null;
  const relative = /^[+*/]/.test(cleaned) ? cleaned[0] : null;
  const value = parseExpression(relative ? cleaned.slice(1) : cleaned);
  if (value === null || !Number.isFinite(value)) return null;
  switch (relative) {
    case '+':
      return current + value;
    case '*':
      return current * value;
    case '/':
      return value === 0 ? null : current / value;
    default:
      return value;
  }
}

/** Recursive-descent parser for + − × ÷ and parentheses. */
function parseExpression(src: string): number | null {
  const tokens = src.match(/\d*\.?\d+(?:e[+-]?\d+)?|[-+*/()x×÷]/gi);
  if (!tokens || tokens.join('') !== src.replace(/\s+/g, '')) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function expr(): number | null {
    let left = term();
    while (left !== null && (peek() === '+' || peek() === '-')) {
      const op = next();
      const right = term();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function term(): number | null {
    let left = factor();
    while (left !== null && ['*', '/', 'x', 'X', '×', '÷'].includes(peek() ?? '')) {
      const op = next();
      const right = factor();
      if (right === null) return null;
      left = op === '/' || op === '÷' ? left / right : left * right;
    }
    return left;
  }
  function factor(): number | null {
    const t = next();
    if (t === undefined) return null;
    if (t === '-') {
      const v = factor();
      return v === null ? null : -v;
    }
    if (t === '(') {
      const v = expr();
      return next() === ')' ? v : null;
    }
    const n = Number(t);
    return Number.isNaN(n) ? null : n;
  }

  const result = expr();
  return pos === tokens.length ? result : null;
}
