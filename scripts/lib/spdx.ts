/**
 * Evaluates an SPDX licence expression ("MIT", "(MIT OR Apache-2.0) AND Unicode-3.0",
 * "Apache-2.0 WITH LLVM-exception") against a set of allowed licence identifiers.
 * AND binds tighter than OR, as in the SPDX specification. A `WITH` exception only
 * grants extra permissions, so "X WITH Y" is allowed when X is.
 */
export function isLicenceAllowed(expression: string, allowed: ReadonlySet<string>): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`Unexpected end of licence expression "${expression}"`);
    return t;
  };

  function orExpr(): boolean {
    let value = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      value = andExpr() || value;
    }
    return value;
  }
  function andExpr(): boolean {
    let value = atom();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      value = atom() && value;
    }
    return value;
  }
  function atom(): boolean {
    const t = next();
    if (t === '(') {
      const value = orExpr();
      if (peek() !== ')') throw new Error(`Missing ")" in licence expression "${expression}"`);
      next();
      return value;
    }
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      next(); // exception identifier
    }
    return allowed.has(t);
  }

  if (tokens.length === 0) return false;
  const result = orExpr();
  if (pos !== tokens.length) throw new Error(`Unexpected "${peek()}" in licence expression "${expression}"`);
  return result;
}
