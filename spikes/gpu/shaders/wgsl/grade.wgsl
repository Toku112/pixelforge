// B4: per-pixel grade. Same maths as spike::cpuGrade and glsl/grade.comp.
struct Params { m0 : vec4f, m1 : vec4f, m2 : vec4f, eggg : vec4f }  // exposure, gain, offset, gamma
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> P : Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id : vec3u) {
    let sz = textureDimensions(dst);
    if (id.x >= sz.x || id.y >= sz.y) { return; }
    let p = vec2i(id.xy);
    let c = textureLoad(src, p, 0);
    let e = c.rgb * P.eggg.x;
    let g = vec3f(dot(P.m0.xyz, e), dot(P.m1.xyz, e), dot(P.m2.xyz, e)) * P.eggg.y + P.eggg.z;
    let o = sign(g) * pow(abs(g), vec3f(P.eggg.w));
    textureStore(dst, p, vec4f(o, c.a));
}
