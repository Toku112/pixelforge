// Prints the GPU shader OCIO generates for the B7 cases (Vulkan GLSL), with its textures and uniforms.
#include "ocio_common.h"

using namespace spike;

int main()
{
    for (const auto& c : ocioCases()) {
        auto proc = ocioProcessor(c.view);
        auto sd = OCIO::GpuShaderDesc::CreateShaderDesc();
        sd->setLanguage(OCIO::GPU_LANGUAGE_GLSL_VK_4_6);
        sd->setFunctionName("OCIODisplay");
        sd->setResourcePrefix("ocio_");
        sd->setDescriptorSetIndex(0, 4);
        proc->getDefaultGPUProcessor()->extractGpuShaderInfo(sd);
        std::printf("===== view %s: %u 1D/2D textures, %u 3D textures, %u uniforms (%zu bytes)\n", c.view,
                    sd->getNumTextures(), sd->getNum3DTextures(), sd->getNumUniforms(), sd->getUniformBufferSize());
        for (unsigned i = 0; i < sd->getNumTextures(); ++i) {
            const char *tn, *sn;
            unsigned w, h;
            OCIO::GpuShaderDesc::TextureType ch;
            OCIO::GpuShaderDesc::TextureDimensions dim;
            OCIO::Interpolation in;
            sd->getTexture(i, tn, sn, w, h, ch, dim, in);
            std::printf("  tex %s %ux%u ch=%d dim=%d binding=%u\n", tn, w, h, int(ch), int(dim), sd->getTextureShaderBindingIndex(i));
        }
        for (unsigned i = 0; i < sd->getNum3DTextures(); ++i) {
            const char *tn, *sn;
            unsigned e;
            OCIO::Interpolation in;
            sd->get3DTexture(i, tn, sn, e, in);
            std::printf("  3d %s edge=%u interp=%d binding=%u\n", tn, e, int(in), sd->get3DTextureShaderBindingIndex(i));
        }
        std::printf("%s\n", sd->getShaderText());
    }
}
