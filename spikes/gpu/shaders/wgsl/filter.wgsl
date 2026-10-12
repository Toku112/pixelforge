// B6: sample a 2x1 RGBA32F texture half-way between its texels with a linear sampler (needs float32-filterable).
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var smp : sampler;

@compute @workgroup_size(1)
fn main() {
    textureStore(dst, vec2i(0), textureSampleLevel(src, smp, vec2f(0.5, 0.5), 0.0));
}
