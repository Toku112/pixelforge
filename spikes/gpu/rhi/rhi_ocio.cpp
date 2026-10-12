// B7 on Qt RHI: OCIO's Vulkan GLSL baked at run time by QShaderBaker, LUTs as RHI textures, result vs OCIO CPU.
#include "rhi_util.h"
#include "../common/ocio_common.h"

#include <memory>

using namespace spike;

void runOcioRhi(QRhi* rhi, QRhiTexture* src, const std::vector<float>& img4k)
{
    using B = QRhiShaderResourceBinding;
    constexpr auto kCS = QRhiShaderResourceBinding::ComputeStage;
    std::unique_ptr<QRhiTexture> dst(rhi->newTexture(QRhiTexture::RGBA32F, QSize(k4kW, k4kH), 1,
                                                     QRhiTexture::UsedWithLoadStore));
    dst->create();
    // All three address modes set: RHI's default for the third (W) axis is Repeat, which wraps 3D LUT lookups.
    std::unique_ptr<QRhiSampler> nearest(rhi->newSampler(QRhiSampler::Nearest, QRhiSampler::Nearest, QRhiSampler::None,
                                                         QRhiSampler::ClampToEdge, QRhiSampler::ClampToEdge,
                                                         QRhiSampler::ClampToEdge));
    std::unique_ptr<QRhiSampler> linear(rhi->newSampler(QRhiSampler::Linear, QRhiSampler::Linear, QRhiSampler::None,
                                                        QRhiSampler::ClampToEdge, QRhiSampler::ClampToEdge,
                                                        QRhiSampler::ClampToEdge));
    nearest->create();
    linear->create();

    for (const auto& c : ocioCases()) {
        auto proc = ocioProcessor(c.view);
        OcioGpu og = ocioGpu(proc);
        double bakeMs = 0;
        const QShader cs = bake(QByteArray::fromStdString(og.computeSource), QShader::ComputeStage,
                                QStringLiteral("ocio_%1.comp").arg(QString::fromLatin1(c.view)), &bakeMs);

        std::vector<std::unique_ptr<QRhiTexture>> luts;
        QList<QRhiShaderResourceBinding> bindings = {B::sampledTexture(1, kCS, src, nearest.get()),
                                                     B::imageStore(2, kCS, dst.get(), 0)};
        QRhiResourceUpdateBatch* u = rhi->nextResourceUpdateBatch();
        for (const OcioLut& l : ocioLuts(og)) {
            const auto fmt = l.channels == 1 ? QRhiTexture::R32F : QRhiTexture::RGBA32F;
            QRhiTexture* t = l.depth > 1 ? rhi->newTexture(fmt, int(l.width), int(l.height), int(l.depth), 1,
                                                           QRhiTexture::ThreeDimensional)
                                         : rhi->newTexture(fmt, QSize(int(l.width), int(l.height)));
            t->create();
            const size_t slice = size_t(l.width) * l.height * l.channels;
            QList<QRhiTextureUploadEntry> entries;
            for (unsigned z = 0; z < l.depth; ++z)
                entries.append(QRhiTextureUploadEntry(
                    int(z), 0,
                    QRhiTextureSubresourceUploadDescription(l.texels.data() + z * slice, quint32(slice * sizeof(float)))));
            QRhiTextureUploadDescription desc;
            desc.setEntries(entries.cbegin(), entries.cend());
            u->uploadTexture(t, desc);
            bindings.append(B::sampledTexture(int(l.binding), kCS, t, l.linear ? linear.get() : nearest.get()));
            luts.emplace_back(t);
        }
        std::unique_ptr<QRhiShaderResourceBindings> srb(rhi->newShaderResourceBindings());
        srb->setBindings(bindings.cbegin(), bindings.cend());
        srb->create();
        std::unique_ptr<QRhiComputePipeline> cp(rhi->newComputePipeline());
        cp->setShaderStage({QRhiShaderStage::Compute, cs});
        cp->setShaderResourceBindings(srb.get());
        if (!cp->create()) {
            report("B7", std::string("OCIO ") + c.view + " (RHI)", "pipeline FAILED");
            continue;
        }
        const int gx = (k4kW + 15) / 16, gy = (k4kH + 15) / 16;
        bool first = true;
        auto run = [&](int n) {
            const double t0 = nowMs();
            QRhiCommandBuffer* cb = nullptr;
            rhi->beginOffscreenFrame(&cb);
            cb->beginComputePass(first ? u : nullptr);
            first = false;
            cb->setComputePipeline(cp.get());
            cb->setShaderResources();
            for (int i = 0; i < n; ++i) cb->dispatch(gx, gy, 1);
            cb->endComputePass();
            rhi->endOffscreenFrame();
            return nowMs() - t0;
        };
        const double ms = perIterationMs(run, kGradeRepeats);

        QRhiReadbackResult res;
        QRhiCommandBuffer* cb = nullptr;
        rhi->beginOffscreenFrame(&cb);
        QRhiResourceUpdateBatch* rb = rhi->nextResourceUpdateBatch();
        rb->readBackTexture(QRhiReadbackDescription(dst.get()), &res);
        cb->resourceUpdate(rb);
        rhi->endOffscreenFrame();
        std::vector<float> gpu(img4k.size());
        std::memcpy(gpu.data(), res.data.constData(), gpu.size() * sizeof(float));
        const auto cpu = ocioCpu(proc, img4k, k4kW, k4kH);
        const auto err = compareDisplay(cpu, gpu);
        if (err.maxAbs > 1e-3f) {
            const size_t w = err.worst * 4;
            size_t nBad = 0;
            for (size_t i = 0; i < gpu.size(); i += 4)
                if (!std::isfinite(gpu[i]) || !std::isfinite(gpu[i + 1]) || !std::isfinite(gpu[i + 2])) ++nBad;
            std::printf("     worst pixel %zu (x %zu, y %zu): in %g %g %g -> cpu %g %g %g, gpu %g %g %g; non-finite GPU px %zu\n",
                        err.worst, err.worst % k4kW, err.worst / k4kW, img4k[w], img4k[w + 1], img4k[w + 2], cpu[w],
                        cpu[w + 1], cpu[w + 2], gpu[w], gpu[w + 1], gpu[w + 2], nBad);
        }
        report("B7", std::string("OCIO sRGB/") + c.view + " 4K vs OCIO CPU",
               fmt("max err %.2g, %.3f%% px > half 8-bit step", err.maxAbs, 100.0 * err.over8bitHalfStep) +
                   fmt("; %.2f ms/frame; bake %.0f ms", ms, bakeMs));
    }
}
