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
