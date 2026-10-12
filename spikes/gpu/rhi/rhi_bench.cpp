// GPU-layer spike, Qt RHI side: B1–B7 offscreen (see ../README.md).
// Shaders are Vulkan-style GLSL baked at run time with QShaderBaker (the LGPL runtime part of Qt Shader Tools),
// so this route needs no qsb build step.
#include "rhi_util.h"
#ifdef SPIKE_WITH_OCIO
void runOcioRhi(QRhi* rhi, QRhiTexture* src, const std::vector<float>& img4k);
#endif

#include <QGuiApplication>
#include <rhi/qrhi.h>

#include <cstring>
#include <memory>

using namespace spike;

namespace {

QRhi* g_rhi = nullptr;

QRhiTexture* newFloatTex(int w, int h, QRhiTexture::Flags flags = {})
{
    QRhiTexture* t = g_rhi->newTexture(QRhiTexture::RGBA32F, QSize(w, h), 1, flags);
    if (!t->create()) {
        std::fprintf(stderr, "texture %dx%d create failed\n", w, h);
        std::exit(2);
    }
    return t;
}

// Runs one offscreen frame: record(cb) then wait for the GPU. Returns wall-clock ms.
template <typename F>
double offscreenFrame(F&& record)
{
    const double t0 = nowMs();
    QRhiCommandBuffer* cb = nullptr;
    if (g_rhi->beginOffscreenFrame(&cb) != QRhi::FrameOpSuccess) std::exit(3);
    record(cb);
    g_rhi->endOffscreenFrame();
    return nowMs() - t0;
}

void upload(QRhiTexture* tex, const std::vector<float>& px, int w, int h, QRhiCommandBuffer* cb)
{
    QRhiResourceUpdateBatch* u = g_rhi->nextResourceUpdateBatch();
    QRhiTextureSubresourceUploadDescription sub(px.data(), quint32(px.size() * sizeof(float)));
    sub.setSourceSize(QSize(w, h));
    u->uploadTexture(tex, QRhiTextureUploadDescription({0, 0, sub}));
    cb->resourceUpdate(u);
}

std::vector<float> readBack(QRhiTexture* tex, double* ms = nullptr)
{
    QRhiReadbackResult res;
    const double t = offscreenFrame([&](QRhiCommandBuffer* cb) {
        QRhiResourceUpdateBatch* u = g_rhi->nextResourceUpdateBatch();
        u->readBackTexture(QRhiReadbackDescription(tex), &res);
        cb->resourceUpdate(u);
    });
    if (ms) *ms = t;
    std::vector<float> out(size_t(res.data.size()) / sizeof(float));
    std::memcpy(out.data(), res.data.constData(), size_t(res.data.size()));
    return out;
}

using Stage = QRhiShaderResourceBinding;
constexpr auto kCS = QRhiShaderResourceBinding::ComputeStage;

}  // namespace

int main(int argc, char** argv)
{
    QGuiApplication app(argc, argv);

    QRhiMetalInitParams params;
    std::unique_ptr<QRhi> rhi(QRhi::create(QRhi::Metal, &params));
    if (!rhi) {
        std::fprintf(stderr, "QRhi Metal init failed\n");
        return 1;
    }
    g_rhi = rhi.get();
    std::printf("Qt RHI %s on %s, backend %s\n", qVersion(), rhi->driverInfo().deviceName.constData(),
                rhi->backendName());
    std::printf("  compute=%d timestamps=%d maxTexture=%d RGBA32F load/store=%d RGBA16F load/store=%d\n",
                rhi->isFeatureSupported(QRhi::Compute), rhi->isFeatureSupported(QRhi::Timestamps),
                rhi->resourceLimit(QRhi::TextureSizeMax),
                rhi->isTextureFormatSupported(QRhiTexture::RGBA32F, QRhiTexture::UsedWithLoadStore),
                rhi->isTextureFormatSupported(QRhiTexture::RGBA16F, QRhiTexture::UsedWithLoadStore));

    // ---- B1/B2: 8K upload and readback.
    {
        const auto img = makeTestImage(k8kW, k8kH);
        const double bytes = double(img.size() * sizeof(float));
        std::unique_ptr<QRhiTexture> tex(newFloatTex(k8kW, k8kH));
        std::vector<double> up, down;
        bool ok = true;
        for (int i = 0; i < kTransferRepeats; ++i) {
            up.push_back(offscreenFrame([&](QRhiCommandBuffer* cb) { upload(tex.get(), img, k8kW, k8kH, cb); }));
            double ms = 0;
            const auto back = readBack(tex.get(), &ms);
            down.push_back(ms);
            ok = ok && back.size() == img.size() && std::memcmp(back.data(), img.data(), size_t(bytes)) == 0;
        }
        report("B1", "upload 7680x4320 RGBA32F (531 MB), median of 5",
               fmt("%.1f ms  %.2f GB/s", median(up), gbPerSec(bytes, median(up))));
        report("B2", "readback same, median of 5",
               fmt("%.1f ms  %.2f GB/s  bit-exact=", median(down), gbPerSec(bytes, median(down))) +
                   (ok ? "yes" : "NO"));
    }

    // ---- B3: 16384² as 16 tiles of 4096², plus one single 16384² texture.
    {
        const auto tileImg = makeTestImage(kTile, kTile);
        const double bytes = double(tileImg.size() * sizeof(float)) * kTilesPerSide * kTilesPerSide;
        std::vector<std::unique_ptr<QRhiTexture>> tiles;
        for (int i = 0; i < kTilesPerSide * kTilesPerSide; ++i) tiles.emplace_back(newFloatTex(kTile, kTile));
        const double ms = offscreenFrame([&](QRhiCommandBuffer* cb) {
            for (auto& t : tiles) upload(t.get(), tileImg, kTile, kTile, cb);
        });
        report("B3", "upload 16384x16384 RGBA32F as 16 tiles (4.3 GB)",
               fmt("%.0f ms  %.2f GB/s", ms, gbPerSec(bytes, ms)));
        tiles.clear();
        QRhiTexture* big = rhi->newTexture(QRhiTexture::RGBA32F, QSize(16384, 16384));
        report("B3", "single 16384x16384 RGBA32F texture", big->create() ? "created" : "FAILED");
        delete big;
    }

    // ---- Shared 4K source for B4/B5.
    const auto img4k = makeTestImage(k4kW, k4kH);
    std::unique_ptr<QRhiTexture> src(newFloatTex(k4kW, k4kH));
    std::unique_ptr<QRhiTexture> dstA(newFloatTex(k4kW, k4kH, QRhiTexture::UsedWithLoadStore));
    std::unique_ptr<QRhiTexture> dstB(newFloatTex(k4kW, k4kH, QRhiTexture::UsedWithLoadStore));
    offscreenFrame([&](QRhiCommandBuffer* cb) { upload(src.get(), img4k, k4kW, k4kH, cb); });
    std::unique_ptr<QRhiSampler> nearest(rhi->newSampler(QRhiSampler::Nearest, QRhiSampler::Nearest,
                                                         QRhiSampler::None, QRhiSampler::ClampToEdge,
                                                         QRhiSampler::ClampToEdge));
    nearest->create();
    const int gx = (k4kW + 15) / 16, gy = (k4kH + 15) / 16;

    // ---- B4: grade.
    {
        double bakeMs = 0;
        const QShader cs = bakeFile("glsl/grade.comp", QShader::ComputeStage, &bakeMs);
        GradeParams gp;
        float ubo[16];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 4; ++c) ubo[r * 4 + c] = gp.m[r][c];
        ubo[12] = gp.exposure, ubo[13] = gp.gain, ubo[14] = gp.offset, ubo[15] = gp.gamma;
        std::unique_ptr<QRhiBuffer> ub(rhi->newBuffer(QRhiBuffer::Immutable, QRhiBuffer::UniformBuffer, sizeof ubo));
        ub->create();
        std::unique_ptr<QRhiShaderResourceBindings> srb(rhi->newShaderResourceBindings());
        srb->setBindings({Stage::sampledTexture(0, kCS, src.get(), nearest.get()),
                          Stage::imageStore(1, kCS, dstA.get(), 0), Stage::uniformBuffer(2, kCS, ub.get())});
        srb->create();
        std::unique_ptr<QRhiComputePipeline> cp(rhi->newComputePipeline());
        cp->setShaderStage({QRhiShaderStage::Compute, cs});
        cp->setShaderResourceBindings(srb.get());
        cp->create();
        auto run = [&](int n) {
            return offscreenFrame([&](QRhiCommandBuffer* cb) {
                QRhiResourceUpdateBatch* u = rhi->nextResourceUpdateBatch();
                u->uploadStaticBuffer(ub.get(), ubo);
                cb->beginComputePass(u);
                cb->setComputePipeline(cp.get());
                cb->setShaderResources();
                for (int i = 0; i < n; ++i) cb->dispatch(gx, gy, 1);
                cb->endComputePass();
            });
        };
        const double ms = perIterationMs(run, kGradeRepeats);
        const auto out = readBack(dstA.get());
        float err = 0;
        for (auto [x, y] : checkPoints(k4kW, k4kH)) {
            const size_t i = (size_t(y) * k4kW + size_t(x)) * 4;
            const auto ref = cpuGrade(&img4k[i], gp);
            err = std::max(err, maxAbsDiff(ref.data(), &out[i], 4));
        }
        report("B4", "grade 3840x2160 RGBA32F, per dispatch (20 in one frame)",
               fmt("%.3f ms  %.0f GB/s  (max err %.2g)", ms, gbPerSec(2.0 * img4k.size() * sizeof(float), ms), err) +
                   fmt("  shader bake %.0f ms", bakeMs));
    }

    // ---- B5: separable Gaussian.
    {
        const QShader cs = bakeFile("glsl/blur.comp", QShader::ComputeStage);
        const auto wts = gaussianWeights(kBlurRadius);
        std::unique_ptr<QRhiBuffer> wb(rhi->newBuffer(QRhiBuffer::Immutable, QRhiBuffer::StorageBuffer,
                                                      quint32(wts.size() * sizeof(float))));
        wb->create();
        const int dirH[4] = {1, 0, kBlurRadius, 0}, dirV[4] = {0, 1, kBlurRadius, 0};
        std::unique_ptr<QRhiBuffer> ubH(rhi->newBuffer(QRhiBuffer::Immutable, QRhiBuffer::UniformBuffer, 16));
        std::unique_ptr<QRhiBuffer> ubV(rhi->newBuffer(QRhiBuffer::Immutable, QRhiBuffer::UniformBuffer, 16));
        ubH->create();
        ubV->create();
        // H: src -> dstA, V: dstA -> dstB. dstA is sampled in the V pass.
        std::unique_ptr<QRhiShaderResourceBindings> srbH(rhi->newShaderResourceBindings());
        srbH->setBindings({Stage::sampledTexture(0, kCS, src.get(), nearest.get()),
                           Stage::imageStore(1, kCS, dstA.get(), 0), Stage::bufferLoad(2, kCS, wb.get()),
                           Stage::uniformBuffer(3, kCS, ubH.get())});
        srbH->create();
        std::unique_ptr<QRhiShaderResourceBindings> srbV(rhi->newShaderResourceBindings());
        srbV->setBindings({Stage::sampledTexture(0, kCS, dstA.get(), nearest.get()),
                           Stage::imageStore(1, kCS, dstB.get(), 0), Stage::bufferLoad(2, kCS, wb.get()),
                           Stage::uniformBuffer(3, kCS, ubV.get())});
        srbV->create();
        std::unique_ptr<QRhiComputePipeline> cp(rhi->newComputePipeline());
        cp->setShaderStage({QRhiShaderStage::Compute, cs});
        cp->setShaderResourceBindings(srbH.get());
        cp->create();
        auto run = [&](int n) {
            return offscreenFrame([&](QRhiCommandBuffer* cb) {
                QRhiResourceUpdateBatch* u = rhi->nextResourceUpdateBatch();
                u->uploadStaticBuffer(wb.get(), wts.data());
                u->uploadStaticBuffer(ubH.get(), dirH);
                u->uploadStaticBuffer(ubV.get(), dirV);
                cb->beginComputePass(u);
                cb->setComputePipeline(cp.get());
                for (int i = 0; i < n; ++i) {
                    cb->setShaderResources(srbH.get());
                    cb->dispatch(gx, gy, 1);
                    cb->setShaderResources(srbV.get());
                    cb->dispatch(gx, gy, 1);
                }
                cb->endComputePass();
            });
        };
        const double ms = perIterationMs(run, kBlurRepeats) / 2.0;  // one iteration = H + V
        const auto out = readBack(dstB.get());
        float err = 0;
        for (auto [x, y] : checkPoints(k4kW, k4kH)) {
            const auto ref = cpuBlurHV(img4k, k4kW, k4kH, x, y, wts, kBlurRadius);
            err = std::max(err, maxAbsDiff(ref.data(), &out[(size_t(y) * k4kW + size_t(x)) * 4], 4));
        }
        report("B5", "Gaussian r=64 3840x2160 RGBA32F, per pass (H or V)",
               fmt("%.2f ms  (max err %.2g)", ms, err));
    }

    // ---- B6: linear filtering of RGBA32F.
    {
        const QShader cs = bakeFile("glsl/filter.comp", QShader::ComputeStage);
        std::unique_ptr<QRhiTexture> two(newFloatTex(2, 1));
        std::unique_ptr<QRhiTexture> one(newFloatTex(1, 1, QRhiTexture::UsedWithLoadStore));
        const std::vector<float> texels = {0, 0, 0, 1, 1, 2, 4, 1};
        std::unique_ptr<QRhiSampler> lin(rhi->newSampler(QRhiSampler::Linear, QRhiSampler::Linear,
                                                         QRhiSampler::None, QRhiSampler::ClampToEdge,
                                                         QRhiSampler::ClampToEdge));
        lin->create();
        std::unique_ptr<QRhiShaderResourceBindings> srb(rhi->newShaderResourceBindings());
        srb->setBindings({Stage::sampledTexture(0, kCS, two.get(), lin.get()), Stage::imageStore(1, kCS, one.get(), 0)});
        srb->create();
        std::unique_ptr<QRhiComputePipeline> cp(rhi->newComputePipeline());
        cp->setShaderStage({QRhiShaderStage::Compute, cs});
        cp->setShaderResourceBindings(srb.get());
        cp->create();
        offscreenFrame([&](QRhiCommandBuffer* cb) {
            QRhiResourceUpdateBatch* u = rhi->nextResourceUpdateBatch();
            QRhiTextureSubresourceUploadDescription sub(texels.data(), quint32(texels.size() * sizeof(float)));
            u->uploadTexture(two.get(), QRhiTextureUploadDescription({0, 0, sub}));
            cb->beginComputePass(u);
            cb->setComputePipeline(cp.get());
            cb->setShaderResources();
            cb->dispatch(1, 1, 1);
            cb->endComputePass();
        });
        const auto v = readBack(one.get());
        const bool filtered = std::fabs(v[0] - 0.5f) < 1e-5f && std::fabs(v[2] - 2.0f) < 1e-5f;
        report("B6", "RGBA32F linear filtering (expect 0.5 1 2)",
               fmt("%.4g %.4g %.4g", v[0], v[1], v[2]) + (filtered ? "  -> filtered" : "  -> NOT filtered"));
    }

#ifdef SPIKE_WITH_OCIO
    runOcioRhi(rhi.get(), src.get(), img4k);
#else
    report("B7", "OCIO display shader", "skipped (built without OpenColorIO)");
#endif
    return 0;
}
