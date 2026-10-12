// Small Dawn (WebGPU) helpers shared by the spike's Dawn programs.
#pragma once

#include "../common/bench_common.h"

#include <webgpu/webgpu_cpp.h>

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>

namespace spike {

struct Gpu {
    wgpu::Instance instance;
    wgpu::Adapter adapter;
    wgpu::Device device;
    wgpu::Queue queue;
    bool float32Filterable = false;
    std::string adapterName;
};

inline std::string sv(wgpu::StringView s) { return s.data ? std::string(s.data, s.length == WGPU_STRLEN ? std::strlen(s.data) : s.length) : std::string(); }

// Instance with blocking waits and SPIR-V input allowed (B7 feeds OpenColorIO shaders as SPIR-V);
// device with the adapter's full limits (WebGPU's defaults cap textures at 8192 and buffers at 256 MB).
inline Gpu initGpu()
{
    Gpu g;
    const wgpu::InstanceFeatureName instFeatures[] = {wgpu::InstanceFeatureName::TimedWaitAny,
                                                      wgpu::InstanceFeatureName::ShaderSourceSPIRV};
    wgpu::InstanceDescriptor idesc;
    idesc.requiredFeatureCount = 2;
    idesc.requiredFeatures = instFeatures;
    g.instance = wgpu::CreateInstance(&idesc);

    wgpu::RequestAdapterOptions opts;
    opts.powerPreference = wgpu::PowerPreference::HighPerformance;
    g.instance.WaitAny(g.instance.RequestAdapter(&opts, wgpu::CallbackMode::WaitAnyOnly,
                                                 [&](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView m) {
                                                     if (s != wgpu::RequestAdapterStatus::Success) {
                                                         std::fprintf(stderr, "adapter: %s\n", sv(m).c_str());
                                                         std::exit(1);
                                                     }
                                                     g.adapter = std::move(a);
                                                 }),
                       UINT64_MAX);
    wgpu::AdapterInfo info;
    g.adapter.GetInfo(&info);
    g.adapterName = sv(info.device) + " (" + sv(info.description) + ")";

    wgpu::Limits limits;
    g.adapter.GetLimits(&limits);
    std::vector<wgpu::FeatureName> features;
    g.float32Filterable = g.adapter.HasFeature(wgpu::FeatureName::Float32Filterable);
    if (g.float32Filterable) features.push_back(wgpu::FeatureName::Float32Filterable);

    wgpu::DeviceDescriptor ddesc;
    // Experiments only: SPIKE_DAWN_TOGGLES="allow_unsafe_apis,disable_robustness" etc.
    static std::vector<std::string> toggleStore;
    static std::vector<const char*> toggles;
    static wgpu::DawnTogglesDescriptor togglesDesc;
    if (const char* env = std::getenv("SPIKE_DAWN_TOGGLES"); env && toggles.empty()) {
        std::stringstream ss(env);
        for (std::string s; std::getline(ss, s, ',');) toggleStore.push_back(s);
        for (auto& s : toggleStore) toggles.push_back(s.c_str());
        togglesDesc.enabledToggleCount = toggles.size();
        togglesDesc.enabledToggles = toggles.data();
    }
    if (!toggles.empty()) ddesc.nextInChain = &togglesDesc;
    ddesc.requiredLimits = &limits;
    ddesc.requiredFeatureCount = features.size();
    ddesc.requiredFeatures = features.data();
    ddesc.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView m) {
        std::fprintf(stderr, "Dawn error: %s\n", sv(m).c_str());
        std::exit(4);
    });
    g.instance.WaitAny(g.adapter.RequestDevice(&ddesc, wgpu::CallbackMode::WaitAnyOnly,
                                               [&](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView m) {
                                                   if (s != wgpu::RequestDeviceStatus::Success) {
                                                       std::fprintf(stderr, "device: %s\n", sv(m).c_str());
                                                       std::exit(1);
                                                   }
                                                   g.device = std::move(d);
                                               }),
                       UINT64_MAX);
    g.queue = g.device.GetQueue();
    return g;
}

inline void waitIdle(Gpu& g)
{
    g.instance.WaitAny(g.queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly,
                                                   [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {}),
                       UINT64_MAX);
}

inline std::string readText(const char* relPath)
{
    std::ifstream f(std::string(SPIKE_SHADER_DIR "/") + relPath);
    if (!f) {
        std::fprintf(stderr, "cannot open %s\n", relPath);
        std::exit(2);
    }
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

inline wgpu::ShaderModule wgslModule(Gpu& g, const std::string& code)
{
    wgpu::ShaderSourceWGSL src;
    src.code = code.c_str();
    wgpu::ShaderModuleDescriptor d;
    d.nextInChain = &src;
    return g.device.CreateShaderModule(&d);
}

inline wgpu::Texture newFloatTex(Gpu& g, int w, int h, wgpu::TextureUsage extra = wgpu::TextureUsage::None)
{
    wgpu::TextureDescriptor d;
    d.size = {uint32_t(w), uint32_t(h), 1};
    d.format = wgpu::TextureFormat::RGBA32Float;
    d.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst | wgpu::TextureUsage::CopySrc | extra;
    return g.device.CreateTexture(&d);
}

inline void upload(Gpu& g, const wgpu::Texture& t, const float* px, int w, int h)
{
    wgpu::TexelCopyTextureInfo dst;
    dst.texture = t;
    wgpu::TexelCopyBufferLayout layout;
    layout.bytesPerRow = uint32_t(w) * 16;
    layout.rowsPerImage = uint32_t(h);
    const wgpu::Extent3D ext{uint32_t(w), uint32_t(h), 1};
    g.queue.WriteTexture(&dst, px, size_t(w) * size_t(h) * 16, &layout, &ext);
}

// Copies the texture into a mappable buffer (rows padded to 256 bytes), waits, and unpads into a float vector.
inline std::vector<float> readBack(Gpu& g, const wgpu::Texture& t, int w, int h)
{
    const uint32_t row = uint32_t(w) * 16, padded = (row + 255u) & ~255u;
    wgpu::BufferDescriptor bd;
    bd.size = uint64_t(padded) * uint64_t(h);
    bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
    wgpu::Buffer buf = g.device.CreateBuffer(&bd);
    wgpu::CommandEncoder enc = g.device.CreateCommandEncoder();
    wgpu::TexelCopyTextureInfo src;
    src.texture = t;
    wgpu::TexelCopyBufferInfo dst;
    dst.buffer = buf;
    dst.layout.bytesPerRow = padded;
    dst.layout.rowsPerImage = uint32_t(h);
    const wgpu::Extent3D ext{uint32_t(w), uint32_t(h), 1};
    enc.CopyTextureToBuffer(&src, &dst, &ext);
    wgpu::CommandBuffer cmd = enc.Finish();
    g.queue.Submit(1, &cmd);
    g.instance.WaitAny(buf.MapAsync(wgpu::MapMode::Read, 0, bd.size, wgpu::CallbackMode::WaitAnyOnly,
                                    [](wgpu::MapAsyncStatus s, wgpu::StringView m) {
                                        if (s != wgpu::MapAsyncStatus::Success)
                                            std::fprintf(stderr, "map: %s\n", sv(m).c_str());
                                    }),
                       UINT64_MAX);
    const auto* p = static_cast<const uint8_t*>(buf.GetConstMappedRange(0, bd.size));
    std::vector<float> out(size_t(w) * size_t(h) * 4);
    for (int y = 0; y < h; ++y) std::memcpy(&out[size_t(y) * size_t(w) * 4], p + size_t(y) * padded, row);
    buf.Unmap();
    return out;
}

// Bind group layout entry helpers (explicit layouts: RGBA32F is "unfilterable-float" unless float32-filterable).
inline wgpu::BindGroupLayoutEntry texEntry(uint32_t b, wgpu::TextureSampleType t)
{
    wgpu::BindGroupLayoutEntry e;
    e.binding = b;
    e.visibility = wgpu::ShaderStage::Compute;
    e.texture.sampleType = t;
    e.texture.viewDimension = wgpu::TextureViewDimension::e2D;
    return e;
}
inline wgpu::BindGroupLayoutEntry storeEntry(uint32_t b)
{
    wgpu::BindGroupLayoutEntry e;
    e.binding = b;
    e.visibility = wgpu::ShaderStage::Compute;
    e.storageTexture.access = wgpu::StorageTextureAccess::WriteOnly;
    e.storageTexture.format = wgpu::TextureFormat::RGBA32Float;
    e.storageTexture.viewDimension = wgpu::TextureViewDimension::e2D;
    return e;
}
inline wgpu::BindGroupLayoutEntry bufEntry(uint32_t b, wgpu::BufferBindingType t,
                                           wgpu::ShaderStage stage = wgpu::ShaderStage::Compute)
{
    wgpu::BindGroupLayoutEntry e;
    e.binding = b;
    e.visibility = stage;
    e.buffer.type = t;
    return e;
}
inline wgpu::BindGroupLayoutEntry samplerEntry(uint32_t b, wgpu::SamplerBindingType t)
{
    wgpu::BindGroupLayoutEntry e;
    e.binding = b;
    e.visibility = wgpu::ShaderStage::Compute;
    e.sampler.type = t;
    return e;
}

inline wgpu::ComputePipeline computePipeline(Gpu& g, const wgpu::ShaderModule& m,
                                             std::initializer_list<wgpu::BindGroupLayoutEntry> entries,
                                             wgpu::BindGroupLayout* outLayout)
{
    std::vector<wgpu::BindGroupLayoutEntry> v(entries);
    wgpu::BindGroupLayoutDescriptor bld;
    bld.entryCount = v.size();
    bld.entries = v.data();
    *outLayout = g.device.CreateBindGroupLayout(&bld);
    wgpu::PipelineLayoutDescriptor pld;
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = outLayout;
    wgpu::ComputePipelineDescriptor cpd;
    cpd.layout = g.device.CreatePipelineLayout(&pld);
    cpd.compute.module = m;
    cpd.compute.entryPoint = "main";
    return g.device.CreateComputePipeline(&cpd);
}

inline wgpu::Buffer newBuffer(Gpu& g, wgpu::BufferUsage usage, const void* data, size_t size)
{
    wgpu::BufferDescriptor d;
    d.size = (size + 3) & ~size_t(3);
    d.usage = usage | wgpu::BufferUsage::CopyDst;
    wgpu::Buffer b = g.device.CreateBuffer(&d);
    g.queue.WriteBuffer(b, 0, data, size);
    return b;
}

inline wgpu::BindGroupEntry viewBinding(uint32_t b, const wgpu::Texture& t)
{
    wgpu::BindGroupEntry e;
    e.binding = b;
    e.textureView = t.CreateView();
    return e;
}
inline wgpu::BindGroupEntry bufferBinding(uint32_t b, const wgpu::Buffer& buf)
{
    wgpu::BindGroupEntry e;
    e.binding = b;
    e.buffer = buf;
    return e;
}
inline wgpu::BindGroupEntry samplerBinding(uint32_t b, const wgpu::Sampler& s)
{
    wgpu::BindGroupEntry e;
    e.binding = b;
    e.sampler = s;
    return e;
}

inline wgpu::BindGroup bindGroup(Gpu& g, const wgpu::BindGroupLayout& l, std::initializer_list<wgpu::BindGroupEntry> entries)
{
    std::vector<wgpu::BindGroupEntry> v(entries);
    wgpu::BindGroupDescriptor d;
    d.layout = l;
    d.entryCount = v.size();
    d.entries = v.data();
    return g.device.CreateBindGroup(&d);
}

}  // namespace spike
