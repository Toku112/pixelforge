#version 440
// B8/B9 test card in scene-linear values (the swapchain is extended-range linear when HDR is available):
//   one band: a ramp from 0 to params.y (e.g. 4.0) — on an HDR/EDR screen the right part keeps getting brighter;
//   one band: left half 1.0 (normal white), right half 2.0 — brighter only with HDR/EDR;
//   one band: a moving bar, so stalls are easy to see.
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform U { vec4 params; };  // x = seconds, y = ramp maximum

void main()
{
    vec3 c;
    if (uv.y < 0.4)
        c = vec3(uv.x * params.y);
    else if (uv.y < 0.7)
        c = vec3(uv.x < 0.5 ? 1.0 : 2.0);
    else
        c = abs(uv.x - fract(params.x * 0.5)) < 0.02 ? vec3(1.0) : vec3(0.05);
    fragColor = vec4(c, 1.0);
}
