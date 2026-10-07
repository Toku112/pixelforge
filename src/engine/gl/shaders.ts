/**
 * GLSL ES 3.00 shaders for the compositor and the display.
 *
 * Composite tiles store premultiplied colour in the document's encoding (gamma-
 * encoded for 8/16-bit, linear for 32-bit), with texture row 0 = top document row.
 * Compositing passes therefore draw without a vertical flip.
 */

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
`;

/** Unit quad mapped onto a pixel rectangle of the current render target. */
export const TARGET_RECT_VS = `${HEADER}
in vec2 a_pos;
uniform vec4 u_rect;       // x, y, w, h in target pixels
uniform vec2 u_targetSize;
void main() {
  vec2 p = (u_rect.xy + a_pos * u_rect.zw) / u_targetSize * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * Draws one layer tile into a composite tile: premultiplied output for
 * ONE / ONE_MINUS_SRC_ALPHA blending (the Normal blend mode).
 */
export function layerTileFS(depth: 8 | 16 | 32, spp: number, colorChannels: number): string {
  const sampler = depth === 16 ? 'usampler2D' : 'sampler2D';
  const hasAlpha = spp > colorChannels;
  const rgb = colorChannels === 1 ? 't.rrr' : 't.rgb';
  const alpha = hasAlpha ? (colorChannels === 1 ? 't.g' : 't.a') : '1.0';
  return `${HEADER}
uniform ${sampler} u_tile;
uniform ivec2 u_srcOffset;  // target pixel → tile texel
uniform float u_scale;      // sample normalisation
uniform float u_opacity;
out vec4 outColor;
void main() {
  vec4 t = vec4(texelFetch(u_tile, ivec2(gl_FragCoord.xy) + u_srcOffset, 0)) * u_scale;
  float a = ${alpha} * u_opacity;
  outColor = vec4(${rgb} * a, a);
}`;
}

/** Solid premultiplied colour (the default pixel of unallocated tiles). */
export const SOLID_FS = `${HEADER}
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

/** Copies a same-size texture, scaled by an opacity (premultiplied). */
export const COPY_FS = `${HEADER}
uniform sampler2D u_src;
uniform float u_opacity;
out vec4 outColor;
void main() { outColor = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0) * u_opacity; }`;

/** Pass Through group opacity: mix between the backdrop before and after the group. */
export const MIX_FS = `${HEADER}
uniform sampler2D u_before;
uniform sampler2D u_after;
uniform float u_opacity;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = mix(texelFetch(u_before, p, 0), texelFetch(u_after, p, 0), u_opacity);
}`;

/** 2×2 box downsample of a child tile into one quadrant of its parent (premultiplied average). */
export const DOWNSAMPLE_FS = `${HEADER}
uniform sampler2D u_child;
uniform ivec2 u_quadrant;   // pixel origin of the quadrant in the parent
out vec4 outColor;
void main() {
  ivec2 p = (ivec2(gl_FragCoord.xy) - u_quadrant) * 2;
  outColor = 0.25 * (texelFetch(u_child, p, 0) + texelFetch(u_child, p + ivec2(1, 0), 0)
                   + texelFetch(u_child, p + ivec2(0, 1), 0) + texelFetch(u_child, p + ivec2(1, 1), 0));
}`;

/** Places a document-space rectangle on screen through the view matrix. */
export const DISPLAY_VS = `${HEADER}
in vec2 a_pos;
uniform mat3 u_docToClip;
uniform vec4 u_docRect;     // x, y, w, h in document pixels
out vec2 v_doc;
void main() {
  vec2 doc = u_docRect.xy + a_pos * u_docRect.zw;
  v_doc = doc;
  vec3 c = u_docToClip * vec3(doc, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

/**
 * Shows a composite tile over the transparency checkerboard, with the optional
 * pixel grid. 32-bit composites are linear and are encoded to sRGB for display.
 */
export const DISPLAY_FS = `${HEADER}
uniform sampler2D u_composite;
uniform vec4 u_tileRect;      // tile origin and size in document pixels
uniform bool u_linear;
uniform float u_zoom;         // device pixels per document pixel
uniform float u_checkerSize;  // in device pixels
uniform vec3 u_checkerA;
uniform vec3 u_checkerB;
uniform bool u_grid;
uniform vec4 u_gridColor;
in vec2 v_doc;
out vec4 outColor;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec4 c = texture(u_composite, (v_doc - u_tileRect.xy) / u_tileRect.zw);
  vec2 cell = floor(v_doc * u_zoom / u_checkerSize);
  vec3 checker = mod(cell.x + cell.y, 2.0) < 0.5 ? u_checkerA : u_checkerB;
  vec3 color = u_linear ? toSrgb(c.rgb + toLinear(checker) * (1.0 - c.a)) : c.rgb + checker * (1.0 - c.a);
  if (u_grid) {
    // A one-device-pixel line starting at every document pixel boundary.
    vec2 f = fract(v_doc) * u_zoom;
    if (min(f.x, f.y) < 1.0) color = mix(color, u_gridColor.rgb, u_gridColor.a);
  }
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

/**
 * Blend-mode library: the same formulas as core/composite/blend.ts. Mode numbers
 * follow LAYER_BLEND_MODES (0 = normal … 26 = luminosity).
 */
const BLEND_LIB = `
uniform int u_mode;
uniform float u_opacity;
uniform float u_fill;
uniform bool u_special;
uniform bool u_hdr;

float colorBurn(float b, float s) { if (b >= 1.0) return 1.0; if (s <= 0.0) return 0.0; return 1.0 - min(1.0, (1.0 - b) / s); }
float colorDodge(float b, float s) { if (b <= 0.0) return 0.0; if (s >= 1.0) return 1.0; return min(1.0, b / (1.0 - s)); }
float fillSrc(float s) {
  float n = (u_mode == 4 || u_mode == 5) ? 1.0 : ((u_mode == 15 || u_mode == 16) ? 0.5 : 0.0);
  return n + (s - n) * (u_special ? u_fill : 1.0);
}
float blendCh(float b, float s) {
  switch (u_mode) {
    case 2: return min(b, s);
    case 3: return b * s;
    case 4: return colorBurn(b, fillSrc(s));
    case 5: return max(0.0, b + fillSrc(s) - 1.0);
    case 7: return max(b, s);
    case 8: return b + s - b * s;
    case 9: return colorDodge(b, fillSrc(s));
    case 10: { float v = b + fillSrc(s); return u_hdr ? v : min(1.0, v); }
    case 12: return b <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
    case 13: return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (sqrt(b) - b);
    case 14: return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
    case 15: { float f = fillSrc(s); return f <= 0.5 ? colorBurn(b, 2.0 * f) : colorDodge(b, 2.0 * (f - 0.5)); }
    case 16: return clamp(b + 2.0 * fillSrc(s) - 1.0, 0.0, 1.0);
    case 17: return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
    case 18: {
      float f = u_special ? u_fill : 1.0;
      if (f >= 1.0) return b + s >= 1.0 ? 1.0 : 0.0;
      return clamp((b - f * (1.0 - s)) / (1.0 - f), 0.0, 1.0);
    }
    case 19: return abs(b - fillSrc(s));
    case 20: return b + s - 2.0 * b * s;
    case 21: return max(0.0, b - s);
    case 22: {
      if (s <= 0.0) return b <= 0.0 ? 0.0 : (u_hdr ? 65504.0 : 1.0);
      return min(u_hdr ? 65504.0 : 1.0, b / s);
    }
  }
  return s;
}
float lumOf(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lumOf(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0 && !u_hdr) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lumOf(c))); }
float satOf(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float lo = min(min(c.r, c.g), c.b);
  float hi = max(max(c.r, c.g), c.b);
  return hi > lo ? (c - lo) * s / (hi - lo) : vec3(0.0);
}
vec3 blendColor(vec3 b, vec3 s) {
  switch (u_mode) {
    case 6: return s.r + s.g + s.b < b.r + b.g + b.b ? s : b;
    case 11: return s.r + s.g + s.b > b.r + b.g + b.b ? s : b;
    case 23: return setLum(setSat(s, satOf(b)), lumOf(b));
    case 24: return setLum(setSat(b, satOf(s)), lumOf(b));
    case 25: return setLum(s, lumOf(b));
    case 26: return setLum(b, lumOf(s));
  }
  return vec3(blendCh(b.r, s.r), blendCh(b.g, s.g), blendCh(b.b, s.b));
}
/** Composites straight colour cs with alpha ap onto premultiplied backdrop (see flatten.ts). */
vec4 compositeOver(vec4 back, vec3 cs, float ap) {
  float ab = back.a;
  vec3 cb = ab > 0.0 ? back.rgb / ab : vec3(0.0);
  float asB = ap * u_opacity * (u_special ? 1.0 : u_fill);
  float asT = u_special ? asB * u_fill : asB;
  vec3 B = ab > 0.0 ? blendColor(cb, cs) : vec3(0.0);
  return vec4(asT * (1.0 - ab) * cs + asB * ab * B + (1.0 - asB) * back.rgb, ab + (1.0 - ab) * asT);
}
`;

/** Where a blend pass reads its source colour from. */
export type BlendSource =
  | { kind: 'tile'; depth: 8 | 16 | 32; spp: number; colorChannels: number }
  | { kind: 'premultiplied' }
  | { kind: 'solid' };

/**
 * Blend pass for every mode other than Normal/Dissolve: reads the backdrop (the
 * current composite) and writes the full composite result into another texture.
 */
export function blendFS(source: BlendSource): string {
  let fetch: string;
  let decl: string;
  if (source.kind === 'tile') {
    const sampler = source.depth === 16 ? 'usampler2D' : 'sampler2D';
    const hasAlpha = source.spp > source.colorChannels;
    const rgb = source.colorChannels === 1 ? 't.rrr' : 't.rgb';
    const alpha = hasAlpha ? (source.colorChannels === 1 ? 't.g' : 't.a') : '1.0';
    decl = `uniform ${sampler} u_tile;\nuniform ivec2 u_srcOffset;\nuniform float u_scale;`;
    fetch = `vec4 t = vec4(texelFetch(u_tile, p + u_srcOffset, 0)) * u_scale;\n  vec3 cs = ${rgb};\n  float ap = ${alpha};`;
  } else if (source.kind === 'premultiplied') {
    decl = 'uniform sampler2D u_src;';
    fetch = 'vec4 t = texelFetch(u_src, p, 0);\n  float ap = t.a;\n  vec3 cs = ap > 0.0 ? t.rgb / ap : vec3(0.0);';
  } else {
    decl = 'uniform vec4 u_color; // straight colour + alpha';
    fetch = 'vec3 cs = u_color.rgb;\n  float ap = u_color.a;';
  }
  return `${HEADER}
${decl}
uniform sampler2D u_backdrop;
${BLEND_LIB}
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ${fetch}
  outColor = compositeOver(texelFetch(u_backdrop, p, 0), cs, ap);
}`;
}

/** Shared integer hash for Dissolve (same as dissolveNoise in core/composite/blend.ts). */
export const DISSOLVE_NOISE = `
float dissolveNoise(ivec2 q) {
  uint h = (uint(q.x) * 0x27d4eb2du) ^ (uint(q.y) * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return float(h) / 4294967296.0;
}`;

/** Dissolve: a pixel shows fully (alpha 1) when the noise is below its opacity; hardware-blended like Normal. */
export function dissolveTileFS(depth: 8 | 16 | 32, spp: number, colorChannels: number): string {
  const sampler = depth === 16 ? 'usampler2D' : 'sampler2D';
  const hasAlpha = spp > colorChannels;
  const rgb = colorChannels === 1 ? 't.rrr' : 't.rgb';
  const alpha = hasAlpha ? (colorChannels === 1 ? 't.g' : 't.a') : '1.0';
  return `${HEADER}
uniform ${sampler} u_tile;
uniform ivec2 u_srcOffset;
uniform float u_scale;
uniform float u_opacity;   // opacity × fill
uniform ivec2 u_docOrigin; // document position of the target's pixel (0, 0)
${DISSOLVE_NOISE}
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 t = vec4(texelFetch(u_tile, p + u_srcOffset, 0)) * u_scale;
  float a = ${alpha} * u_opacity;
  if (dissolveNoise(u_docOrigin + p) >= a) discard;
  outColor = vec4(${rgb}, 1.0);
}`;
}

/** Dissolve for a solid straight colour (the default pixel of unallocated tiles). */
export const DISSOLVE_SOLID_FS = `${HEADER}
uniform vec4 u_color;      // straight colour + alpha
uniform float u_opacity;   // opacity × fill
uniform ivec2 u_docOrigin;
${DISSOLVE_NOISE}
out vec4 outColor;
void main() {
  if (dissolveNoise(u_docOrigin + ivec2(gl_FragCoord.xy)) >= u_color.a * u_opacity) discard;
  outColor = vec4(u_color.rgb, 1.0);
}`;

/** Dissolve for a premultiplied source (an isolated group). */
export const DISSOLVE_PREMUL_FS = `${HEADER}
uniform sampler2D u_src;
uniform float u_opacity;
uniform ivec2 u_docOrigin;
${DISSOLVE_NOISE}
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(u_src, p, 0);
  if (t.a <= 0.0 || dissolveNoise(u_docOrigin + p) >= t.a * u_opacity) discard;
  outColor = vec4(t.rgb / t.a, 1.0);
}`;
