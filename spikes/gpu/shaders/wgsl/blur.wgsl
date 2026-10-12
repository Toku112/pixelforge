// B5: one pass of a separable Gaussian, clamp-to-edge. dirRadius = (dx, dy, radius, 0).
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<storage, read> w : array<f32>;
@group(0) @binding(3) var<uniform> dirRadius : vec4i;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id : vec3u) {
    let sz = vec2i(textureDimensions(dst));
    let p = vec2i(id.xy);
    if (p.x >= sz.x || p.y >= sz.y) { return; }
    let d = dirRadius.xy;
    let r = dirRadius.z;
    var acc = vec4f(0.0);
    for (var k = -r; k <= r; k++) {
        acc += w[k + r] * textureLoad(src, clamp(p + d * k, vec2i(0), sz - 1), 0);
    }
    textureStore(dst, p, acc);
}
