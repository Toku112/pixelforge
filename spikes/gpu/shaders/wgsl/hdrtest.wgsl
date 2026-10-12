// B8/B9 test card, same as glsl/fullscreen.vert + glsl/hdrtest.frag.
struct VOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f }
@group(0) @binding(0) var<uniform> params : vec4f;  // x = seconds, y = ramp maximum

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VOut {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    var o : VOut;
    o.uv = p;
    o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
    return o;
}

@fragment
fn fs(v : VOut) -> @location(0) vec4f {
    var c : vec3f;
    if (v.uv.y < 0.4) {
        c = vec3f(v.uv.x * params.y);
    } else if (v.uv.y < 0.7) {
        c = vec3f(select(2.0, 1.0, v.uv.x < 0.5));
    } else {
        c = select(vec3f(0.05), vec3f(1.0), abs(v.uv.x - fract(params.x * 0.5)) < 0.02);
    }
    return vec4f(c, 1.0);
}
