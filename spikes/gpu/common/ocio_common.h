// B7 helpers: OpenColorIO display transforms from the user's Blender config, CPU reference and GPU shader text.
#pragma once

#include "bench_common.h"

#include <OpenColorIO/OpenColorIO.h>

#include <cstdlib>
#include <string>
#include <vector>

namespace spike {

namespace OCIO = OCIO_NAMESPACE;

inline const char* blenderConfigPath()
{
    // Phase 0 will search all install locations; the spike uses the owner's Blender 5.2.
    return "/Applications/Blender.app/Contents/Resources/5.2/datafiles/colormanagement/config.ocio";
}

struct OcioCase {
    const char* view;  // display "sRGB", input "Linear Rec.709"
};
inline std::vector<OcioCase> ocioCases() { return {{"AgX"}, {"ACES 2.0"}}; }

inline OCIO::ConstProcessorRcPtr ocioProcessor(const char* view)
{
    OCIO::ConstConfigRcPtr cfg = OCIO::Config::CreateFromFile(blenderConfigPath());
    OCIO::DisplayViewTransformRcPtr t = OCIO::DisplayViewTransform::Create();
    t->setSrc("Linear Rec.709");
    t->setDisplay("sRGB");
    t->setView(view);
    return cfg->getProcessor(t);
}

// CPU reference: OCIO's own CPU path on the whole image (RGBA, in place on a copy).
inline std::vector<float> ocioCpu(const OCIO::ConstProcessorRcPtr& proc, const std::vector<float>& img, int w, int h)
{
    std::vector<float> out = img;
    OCIO::PackedImageDesc desc(out.data(), w, h, 4);
    proc->getDefaultCPUProcessor()->apply(desc);
    return out;
}

// Max |difference| over RGB, plus the share of pixels that differ by more than half an 8-bit step (1/510).
struct OcioError {
    float maxAbs = 0;
    double over8bitHalfStep = 0;
    size_t worst = 0;  // pixel index of the largest difference
};
inline OcioError compareDisplay(const std::vector<float>& a, const std::vector<float>& b)
{
    OcioError e;
    size_t bad = 0;
    for (size_t i = 0; i < a.size(); i += 4) {
        float m = 0;
        for (int c = 0; c < 3; ++c) m = std::max(m, std::fabs(a[i + size_t(c)] - b[i + size_t(c)]));
        if (m > e.maxAbs) e.maxAbs = m, e.worst = i / 4;
        if (m > 1.0f / 510.0f) ++bad;
    }
    e.over8bitHalfStep = double(bad) / double(a.size() / 4);
    return e;
}

// The OCIO shader for one view, as Vulkan GLSL inside a compute shader that reads `srcImg` and writes `dstImg`.
// Bindings: 0 = OCIO uniform block (unused by these views), 1 = source, 2 = destination, 4… = OCIO's LUT textures.
// 1D LUTs are requested as 2D textures, which every backend supports.
struct OcioGpu {
    OCIO::GpuShaderDescRcPtr desc;
    std::string computeSource;
};
inline OcioGpu ocioGpu(const OCIO::ConstProcessorRcPtr& proc)
{
    OcioGpu g;
    g.desc = OCIO::GpuShaderDesc::CreateShaderDesc();
    g.desc->setLanguage(OCIO::GPU_LANGUAGE_GLSL_VK_4_6);
    g.desc->setFunctionName("OCIODisplay");
    g.desc->setResourcePrefix("ocio_");
    g.desc->setDescriptorSetIndex(0, 4);
    g.desc->setAllowTexture1D(false);
    proc->getDefaultGPUProcessor()->extractGpuShaderInfo(g.desc);
    g.computeSource = std::string("#version 450\n"
                                  "layout(local_size_x = 16, local_size_y = 16) in;\n"
                                  "layout(set = 0, binding = 1) uniform sampler2D srcImg;\n"
                                  "layout(set = 0, binding = 2, rgba32f) uniform writeonly image2D dstImg;\n") +
                      g.desc->getShaderText() +
                      "\nvoid main()\n{\n"
                      "    ivec2 p = ivec2(gl_GlobalInvocationID.xy);\n"
                      "    ivec2 sz = imageSize(dstImg);\n"
                      "    if (p.x >= sz.x || p.y >= sz.y) return;\n"
                      "    imageStore(dstImg, p, OCIODisplay(texelFetch(srcImg, p, 0)));\n"
                      "}\n";
    return g;
}

// A LUT texture to create: width × height × depth (depth 1 for 2D), 1 or 4 floats per texel, binding, linear or not.
struct OcioLut {
    unsigned width = 0, height = 0, depth = 1, channels = 4, binding = 0;
    bool linear = true;
    std::vector<float> texels;  // RGB LUTs are expanded to RGBA (no RGB32F format on GPUs)
};
inline std::vector<OcioLut> ocioLuts(const OcioGpu& g)
{
    std::vector<OcioLut> out;
    for (unsigned i = 0; i < g.desc->getNumTextures(); ++i) {
        const char *tn = nullptr, *sn = nullptr;
        OcioLut l;
        OCIO::GpuShaderDesc::TextureType ch;
        OCIO::GpuShaderDesc::TextureDimensions dim;
        OCIO::Interpolation interp;
        g.desc->getTexture(i, tn, sn, l.width, l.height, ch, dim, interp);
        const float* v = nullptr;
        g.desc->getTextureValues(i, v);
        l.binding = g.desc->getTextureShaderBindingIndex(i);
        l.linear = interp != OCIO::INTERP_NEAREST;
        const size_t n = size_t(l.width) * l.height;
        if (ch == OCIO::GpuShaderDesc::TEXTURE_RED_CHANNEL) {
            l.channels = 1;
            l.texels.assign(v, v + n);
        } else {
            l.texels.resize(n * 4);
            for (size_t k = 0; k < n; ++k)
                l.texels[k * 4] = v[k * 3], l.texels[k * 4 + 1] = v[k * 3 + 1], l.texels[k * 4 + 2] = v[k * 3 + 2],
                l.texels[k * 4 + 3] = 1.0f;
        }
        out.push_back(std::move(l));
    }
    for (unsigned i = 0; i < g.desc->getNum3DTextures(); ++i) {
        const char *tn = nullptr, *sn = nullptr;
        unsigned e = 0;
        OCIO::Interpolation interp;
        g.desc->get3DTexture(i, tn, sn, e, interp);
        const float* v = nullptr;
        g.desc->get3DTextureValues(i, v);
        OcioLut l;
        l.width = l.height = l.depth = e;
        l.binding = g.desc->get3DTextureShaderBindingIndex(i);
        l.linear = interp != OCIO::INTERP_NEAREST;
        const size_t n = size_t(e) * e * e;
        l.texels.resize(n * 4);
        for (size_t k = 0; k < n; ++k)
            l.texels[k * 4] = v[k * 3], l.texels[k * 4 + 1] = v[k * 3 + 1], l.texels[k * 4 + 2] = v[k * 3 + 2],
            l.texels[k * 4 + 3] = 1.0f;
        out.push_back(std::move(l));
    }
    return out;
}

}  // namespace spike
