/** Small WebGL2 helpers. */

export function compileProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile error: ${log}\n${source}`);
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/** A compiled program with cached uniform locations. */
export class Program {
  readonly program: WebGLProgram;
  readonly #gl: WebGL2RenderingContext;
  readonly #locations = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
    this.#gl = gl;
    this.program = compileProgram(gl, vertexSource, fragmentSource);
  }

  use(): this {
    this.#gl.useProgram(this.program);
    return this;
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.#locations.get(name);
    if (l === undefined) {
      l = this.#gl.getUniformLocation(this.program, name);
      this.#locations.set(name, l);
    }
    return l;
  }

  delete(): void {
    this.#gl.deleteProgram(this.program);
  }
}

/** Texture formats for tile sample data, by bit depth and samples per pixel (1–4). */
export function tileTextureFormat(gl: WebGL2RenderingContext, depth: 8 | 16 | 32, spp: number) {
  const i = spp - 1;
  if (depth === 8) {
    return {
      internal: [gl.R8, gl.RG8, gl.RGB8, gl.RGBA8][i]!,
      format: [gl.RED, gl.RG, gl.RGB, gl.RGBA][i]!,
      type: gl.UNSIGNED_BYTE,
    };
  }
  if (depth === 16) {
    return {
      internal: [gl.R16UI, gl.RG16UI, gl.RGB16UI, gl.RGBA16UI][i]!,
      format: [gl.RED_INTEGER, gl.RG_INTEGER, gl.RGB_INTEGER, gl.RGBA_INTEGER][i]!,
      type: gl.UNSIGNED_SHORT,
    };
  }
  return {
    internal: [gl.R32F, gl.RG32F, gl.RGB32F, gl.RGBA32F][i]!,
    format: [gl.RED, gl.RG, gl.RGB, gl.RGBA][i]!,
    type: gl.FLOAT,
  };
}

export function createTexture(
  gl: WebGL2RenderingContext,
  internal: number,
  width: number,
  height: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Could not create texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
