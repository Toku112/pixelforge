// B7 on Dawn: the same OCIO Vulkan GLSL as the RHI side, compiled to SPIR-V with glslang and handed to Dawn
// (Tint's SPIR-V reader translates it). OCIO does not generate WGSL, so this extra step is part of Dawn's cost.
#include "dawn_util.h"
#include "../common/ocio_common.h"

#include <glslang/Public/ResourceLimits.h>
#include <glslang/Public/ShaderLang.h>
#include <glslang/SPIRV/GlslangToSpv.h>

#include <regex>

using namespace spike;

namespace {

bool glslToSpirv(const std::string& src, std::vector<uint32_t>& spv, std::string& log)
{
    static const bool inited = glslang::InitializeProcess();
    (void)inited;
    glslang::TShader sh(EShLangCompute);
    const char* s = src.c_str();
    sh.setStrings(&s, 1);
    sh.setEnvInput(glslang::EShSourceGlsl, EShLangCompute, glslang::EShClientVulkan, 100);
    sh.setEnvClient(glslang::EShClientVulkan, glslang::EShTargetVulkan_1_1);
    sh.setEnvTarget(glslang::EShTargetSpv, glslang::EShTargetSpv_1_3);
    if (!sh.parse(GetDefaultResources(), 450, false, EShMsgDefault)) {
        log = sh.getInfoLog();
        return false;
    }
    glslang::TProgram prog;
    prog.addShader(&sh);
    if (!prog.link(EShMsgDefault)) {
        log = prog.getInfoLog();
        return false;
    }
    glslang::GlslangToSpv(*prog.getIntermediate(EShLangCompute), spv);
    return true;
}

// WebGPU has no combined texture+sampler, and Tint renumbers bindings when it splits them, so the GLSL is rewritten
// first: every `uniform samplerXD name;` becomes `textureXD name_t` (same binding) + `sampler name_s` (binding + 32),
// and every `texture(name,` becomes `texture(samplerXD(name_t, name_s),`. RHI needs none of this.
std::string splitCombinedSamplers(std::string src)
{
    const std::regex decl(R"(layout\(set\s*=\s*0,\s*binding\s*=\s*(\d+)\)\s*uniform\s+sampler([123]D)\s+(\w+)\s*;)");
    std::vector<std::pair<std::string, std::string>> names;  // name, dimension
    std::string out;
    auto it = std::sregex_iterator(src.begin(), src.end(), decl);
    size_t last = 0;
    for (; it != std::sregex_iterator(); ++it) {
        const auto& m = *it;
        const int binding = std::stoi(m[1]);
        out += src.substr(last, size_t(m.position()) - last);
        out += "layout(set = 0, binding = " + std::to_string(binding) + ") uniform texture" + m[2].str() + " " +
               m[3].str() + "_t; layout(set = 0, binding = " + std::to_string(binding + 32) + ") uniform sampler " +
               m[3].str() + "_s;";
        names.emplace_back(m[3], m[2]);
        last = size_t(m.position() + m.length());
    }
    out += src.substr(last);
    for (const auto& [name, dim] : names) {
        const std::regex use("(texture(?:Lod)?|texelFetch)\\(\\s*" + name + "\\s*,");
        out = std::regex_replace(out, use, "$1(sampler" + dim + "(" + name + "_t, " + name + "_s),");
    }
    return out;
}

}  // namespace

void runOcioDawn(Gpu& g, const wgpu::Texture& src, const std::vector<float>& img4k)
{
    wgpu::Texture dst = newFloatTex(g, k4kW, k4kH, wgpu::TextureUsage::StorageBinding);
    wgpu::SamplerDescriptor sd;
    wgpu::Sampler nearest = g.device.CreateSampler(&sd);
    sd.magFilter = sd.minFilter = wgpu::FilterMode::Linear;
    wgpu::Sampler linear = g.device.CreateSampler(&sd);

    for (const auto& c : ocioCases()) {
        auto proc = ocioProcessor(c.view);
        OcioGpu og = ocioGpu(proc);
        const double t0 = nowMs();
        std::vector<uint32_t> spv;
        std::string log;
        const std::string glsl = splitCombinedSamplers(og.computeSource);
        if (!glslToSpirv(glsl, spv, log)) {
            report("B7", std::string("OCIO ") + c.view + " (Dawn)", "glslang FAILED: " + log.substr(0, 200));
            continue;
        }
        const double glslangMs = nowMs() - t0;

        // Shader module and pipeline creation are checked with error scopes so a failure is reported, not fatal.
        g.device.PushErrorScope(wgpu::ErrorFilter::Validation);
        wgpu::ShaderSourceSPIRV spirv;
        spirv.codeSize = uint32_t(spv.size());
        spirv.code = spv.data();
        wgpu::ShaderModuleDescriptor md;
        md.nextInChain = &spirv;
        wgpu::ShaderModule m = g.device.CreateShaderModule(&md);
        wgpu::ComputePipelineDescriptor cpd;  // layout = auto: Dawn derives it from the translated shader
        cpd.compute.module = m;
        cpd.compute.entryPoint = "main";
        wgpu::ComputePipeline cp = g.device.CreateComputePipeline(&cpd);
        std::string err;
        g.instance.WaitAny(g.device.PopErrorScope(wgpu::CallbackMode::WaitAnyOnly,
                                                  [&](wgpu::PopErrorScopeStatus, wgpu::ErrorType t, wgpu::StringView msg) {
                                                      if (t != wgpu::ErrorType::NoError) err = sv(msg);
                                                  }),
                           UINT64_MAX);
        const double compileMs = nowMs() - t0;
        if (!err.empty()) {
            report("B7", std::string("OCIO ") + c.view + " (Dawn)", "pipeline FAILED: " + err.substr(0, 400));
            continue;
        }

        std::vector<wgpu::BindGroupEntry> entries = {viewBinding(1, src), samplerBinding(33, nearest), viewBinding(2, dst)};
        std::vector<wgpu::Texture> lutTextures;
        for (const OcioLut& l : ocioLuts(og)) {
            wgpu::TextureDescriptor td;
            td.size = {l.width, l.height, l.depth};
            td.dimension = l.depth > 1 ? wgpu::TextureDimension::e3D : wgpu::TextureDimension::e2D;
            td.format = l.channels == 1 ? wgpu::TextureFormat::R32Float : wgpu::TextureFormat::RGBA32Float;
            td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst;
            wgpu::Texture t = g.device.CreateTexture(&td);
            wgpu::TexelCopyTextureInfo dstInfo;
            dstInfo.texture = t;
            wgpu::TexelCopyBufferLayout layout;
            layout.bytesPerRow = l.width * l.channels * 4;
            layout.rowsPerImage = l.height;
            g.queue.WriteTexture(&dstInfo, l.texels.data(), l.texels.size() * sizeof(float), &layout, &td.size);
            entries.push_back(viewBinding(l.binding, t));
            entries.push_back(samplerBinding(l.binding + 32, l.linear ? linear : nearest));
            lutTextures.push_back(t);
        }
        g.device.PushErrorScope(wgpu::ErrorFilter::Validation);
        wgpu::BindGroupDescriptor bgd;
        bgd.layout = cp.GetBindGroupLayout(0);
        bgd.entryCount = entries.size();
        bgd.entries = entries.data();
        wgpu::BindGroup bg = g.device.CreateBindGroup(&bgd);
        g.instance.WaitAny(g.device.PopErrorScope(wgpu::CallbackMode::WaitAnyOnly,
                                                  [&](wgpu::PopErrorScopeStatus, wgpu::ErrorType t, wgpu::StringView msg) {
                                                      if (t != wgpu::ErrorType::NoError) err = sv(msg);
                                                  }),
                           UINT64_MAX);
        if (!err.empty()) {
            report("B7", std::string("OCIO ") + c.view + " (Dawn)", "bind group FAILED: " + err);
            continue;
        }

        const uint32_t gx = (k4kW + 15) / 16, gy = (k4kH + 15) / 16;
        auto run = [&](int n) {
            const double s = nowMs();
            wgpu::CommandEncoder enc = g.device.CreateCommandEncoder();
            wgpu::ComputePassEncoder pass = enc.BeginComputePass();
            pass.SetPipeline(cp);
            pass.SetBindGroup(0, bg);
            for (int i = 0; i < n; ++i) pass.DispatchWorkgroups(gx, gy, 1);
            pass.End();
            wgpu::CommandBuffer cmd = enc.Finish();
            g.queue.Submit(1, &cmd);
            waitIdle(g);
            return nowMs() - s;
        };
        const double ms = perIterationMs(run, kGradeRepeats);
        const auto gpu = readBack(g, dst, k4kW, k4kH);
        const auto e = compareDisplay(ocioCpu(proc, img4k, k4kW, k4kH), gpu);
        report("B7", std::string("OCIO sRGB/") + c.view + " 4K vs OCIO CPU",
               fmt("max err %.2g, %.3f%% px > half 8-bit step", e.maxAbs, 100.0 * e.over8bitHalfStep) +
                   fmt("; %.2f ms/frame; glslang %.0f ms + Tint/pipeline %.0f ms", ms, glslangMs, compileMs - glslangMs));
    }
}
