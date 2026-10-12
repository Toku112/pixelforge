# gpu/ — the GPU layer

Our thin `gpu::` interface over Qt RHI (Metal / D3D12 / Vulkan, D-069): texture pool, uploads and readbacks,
shaders baked at run time from `shaders/`. The rest of the app never touches RHI directly, so the backend can change.
