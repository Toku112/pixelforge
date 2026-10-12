// GPU-layer spike, Dawn side: B1–B7 offscreen (see ../README.md). Mirrors rhi/rhi_bench.cpp test for test.
#include "dawn_util.h"
#ifdef SPIKE_WITH_OCIO
void runOcioDawn(spike::Gpu& g, const wgpu::Texture& src, const std::vector<float>& img4k);
#endif

using namespace spike;

namespace {

template <typename Record>
double submitAndWait(Gpu& g, Record&& record)
{
    const double t0 = nowMs();
    wgpu::CommandEncoder enc = g.device.CreateCommandEncoder();
    record(enc);
    wgpu::CommandBuffer cmd = enc.Finish();
    g.queue.Submit(1, &cmd);
    waitIdle(g);
    return nowMs() - t0;
}

bool tryCreate(Gpu& g, int w, int h)
{
    g.device.PushErrorScope(wgpu::ErrorFilter::OutOfMemory);
    g.device.PushErrorScope(wgpu::ErrorFilter::Validation);
    wgpu::Texture t = newFloatTex(g, w, h);
    bool ok = true;
    auto check = [&](wgpu::PopErrorScopeStatus, wgpu::ErrorType type, wgpu::StringView) {
        if (type != wgpu::ErrorType::NoError) ok = false;
    };
    g.instance.WaitAny(g.device.PopErrorScope(wgpu::CallbackMode::WaitAnyOnly, check), UINT64_MAX);
    g.instance.WaitAny(g.device.PopErrorScope(wgpu::CallbackMode::WaitAnyOnly, check), UINT64_MAX);
    return ok;
}

}  // namespace

int main()
{
    Gpu g = initGpu();
    wgpu::Limits lim;
    g.device.GetLimits(&lim);
    std::printf("Dawn on %s\n", g.adapterName.c_str());
    std::printf("  maxTexture=%u maxBuffer=%llu MB float32-filterable=%d\n", lim.maxTextureDimension2D,
                (unsigned long long)(lim.maxBufferSize >> 20), int(g.float32Filterable));

    // ---- B1/B2
    {
        const auto img = makeTestImage(k8kW, k8kH);
        const double bytes = double(img.size() * sizeof(float));
        wgpu::Texture tex = newFloatTex(g, k8kW, k8kH);
        std::vector<double> up, down;
        bool ok = true;
        for (int i = 0; i < kTransferRepeats; ++i) {
            double t0 = nowMs();
            upload(g, tex, img.data(), k8kW, k8kH);
            waitIdle(g);
            up.push_back(nowMs() - t0);
            t0 = nowMs();
            const auto back = readBack(g, tex, k8kW, k8kH);
            down.push_back(nowMs() - t0);
            ok = ok && back.size() == img.size() && std::memcmp(back.data(), img.data(), size_t(bytes)) == 0;
        }
        report("B1", "upload 7680x4320 RGBA32F (531 MB), median of 5",
               fmt("%.1f ms  %.2f GB/s", median(up), gbPerSec(bytes, median(up))));
        report("B2", "readback same, median of 5",
               fmt("%.1f ms  %.2f GB/s  bit-exact=", median(down), gbPerSec(bytes, median(down))) + (ok ? "yes" : "NO"));

        // Variant an engine would use: one persistent staging buffer each way, mapped and reused every frame.
        const uint32_t row = k8kW * 16;
        wgpu::BufferDescriptor bd;
        bd.size = uint64_t(row) * k8kH;
        bd.usage = wgpu::BufferUsage::MapWrite | wgpu::BufferUsage::CopySrc;
        wgpu::Buffer upBuf = g.device.CreateBuffer(&bd);
        bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
        wgpu::Buffer downBuf = g.device.CreateBuffer(&bd);
        std::vector<float> back(img.size());
        wgpu::TexelCopyTextureInfo tci;
        tci.texture = tex;
        const wgpu::Extent3D ext{k8kW, k8kH, 1};
        auto mapWait = [&](wgpu::Buffer& b, wgpu::MapMode mode) {
            g.instance.WaitAny(b.MapAsync(mode, 0, bd.size, wgpu::CallbackMode::WaitAnyOnly,
                                          [](wgpu::MapAsyncStatus, wgpu::StringView) {}),
                               UINT64_MAX);
        };
        up.clear();
        down.clear();
        for (int i = 0; i < kTransferRepeats + 1; ++i) {
            double t0 = nowMs();
            mapWait(upBuf, wgpu::MapMode::Write);
            std::memcpy(upBuf.GetMappedRange(), img.data(), size_t(bytes));
            upBuf.Unmap();
            submitAndWait(g, [&](wgpu::CommandEncoder& enc) {
                wgpu::TexelCopyBufferInfo bi;
                bi.buffer = upBuf;
                bi.layout.bytesPerRow = row;
                bi.layout.rowsPerImage = k8kH;
                enc.CopyBufferToTexture(&bi, &tci, &ext);
            });
            if (i > 0) up.push_back(nowMs() - t0);  // first round includes buffer zero-initialisation
            t0 = nowMs();
            submitAndWait(g, [&](wgpu::CommandEncoder& enc) {
                wgpu::TexelCopyBufferInfo bi;
                bi.buffer = downBuf;
                bi.layout.bytesPerRow = row;
                bi.layout.rowsPerImage = k8kH;
                enc.CopyTextureToBuffer(&tci, &bi, &ext);
            });
            mapWait(downBuf, wgpu::MapMode::Read);
            std::memcpy(back.data(), downBuf.GetConstMappedRange(), size_t(bytes));
            downBuf.Unmap();
            if (i > 0) down.push_back(nowMs() - t0);
        }
        report("B1", "  upload via reused staging buffer, median of 5",
               fmt("%.1f ms  %.2f GB/s", median(up), gbPerSec(bytes, median(up))));
        report("B2", "  readback via reused staging buffer, median of 5",
               fmt("%.1f ms  %.2f GB/s  bit-exact=", median(down), gbPerSec(bytes, median(down))) +
                   (std::memcmp(back.data(), img.data(), size_t(bytes)) == 0 ? "yes" : "NO"));
    }

    // ---- B3
    {
        const auto tileImg = makeTestImage(kTile, kTile);
        const double bytes = double(tileImg.size() * sizeof(float)) * kTilesPerSide * kTilesPerSide;
        std::vector<wgpu::Texture> tiles;
        for (int i = 0; i < kTilesPerSide * kTilesPerSide; ++i) tiles.push_back(newFloatTex(g, kTile, kTile));
        const double t0 = nowMs();
        for (auto& t : tiles) upload(g, t, tileImg.data(), kTile, kTile);
        waitIdle(g);
        const double ms = nowMs() - t0;
        report("B3", "upload 16384x16384 RGBA32F as 16 tiles (4.3 GB)", fmt("%.0f ms  %.2f GB/s", ms, gbPerSec(bytes, ms)));
        tiles.clear();
        report("B3", "single 16384x16384 RGBA32F texture", tryCreate(g, 16384, 16384) ? "created" : "FAILED");
    }

    // ---- Shared 4K source.
    const auto img4k = makeTestImage(k4kW, k4kH);
    wgpu::Texture src = newFloatTex(g, k4kW, k4kH);
    wgpu::Texture dstA = newFloatTex(g, k4kW, k4kH, wgpu::TextureUsage::StorageBinding);
    wgpu::Texture dstB = newFloatTex(g, k4kW, k4kH, wgpu::TextureUsage::StorageBinding);
    upload(g, src, img4k.data(), k4kW, k4kH);
    waitIdle(g);
    const uint32_t gx = (k4kW + 15) / 16, gy = (k4kH + 15) / 16;
    const auto unfilterable = wgpu::TextureSampleType::UnfilterableFloat;

    // ---- B4
    {
        const double t0 = nowMs();
        wgpu::ShaderModule m = wgslModule(g, readText("wgsl/grade.wgsl"));
        wgpu::BindGroupLayout bgl;
        wgpu::ComputePipeline cp = computePipeline(
            g, m, {texEntry(0, unfilterable), storeEntry(1), bufEntry(2, wgpu::BufferBindingType::Uniform)}, &bgl);
        const double compileMs = nowMs() - t0;
        GradeParams gp;
        float ubo[16];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 4; ++c) ubo[r * 4 + c] = gp.m[r][c];
        ubo[12] = gp.exposure, ubo[13] = gp.gain, ubo[14] = gp.offset, ubo[15] = gp.gamma;
        wgpu::Buffer ub = newBuffer(g, wgpu::BufferUsage::Uniform, ubo, sizeof ubo);
        wgpu::BindGroup bg = bindGroup(g, bgl, {viewBinding(0, src), viewBinding(1, dstA), bufferBinding(2, ub)});
        auto run = [&](int n) {
            return submitAndWait(g, [&](wgpu::CommandEncoder& enc) {
                wgpu::ComputePassEncoder pass = enc.BeginComputePass();
                pass.SetPipeline(cp);
                pass.SetBindGroup(0, bg);
                for (int i = 0; i < n; ++i) pass.DispatchWorkgroups(gx, gy, 1);
                pass.End();
            });
        };
        const double ms = perIterationMs(run, kGradeRepeats);
        const auto out = readBack(g, dstA, k4kW, k4kH);
        float err = 0;
        for (auto [x, y] : checkPoints(k4kW, k4kH)) {
            const size_t i = (size_t(y) * k4kW + size_t(x)) * 4;
            const auto ref = cpuGrade(&img4k[i], gp);
            err = std::max(err, maxAbsDiff(ref.data(), &out[i], 4));
        }
        report("B4", "grade 3840x2160 RGBA32F, per dispatch (20 in one frame)",
               fmt("%.3f ms  %.0f GB/s  (max err %.2g)", ms, gbPerSec(2.0 * img4k.size() * sizeof(float), ms), err) +
                   fmt("  shader+pipeline %.0f ms", compileMs));
    }

    // ---- B5
    {
        wgpu::ShaderModule m = wgslModule(g, readText("wgsl/blur.wgsl"));
        wgpu::BindGroupLayout bgl;
        wgpu::ComputePipeline cp = computePipeline(g, m,
                                                   {texEntry(0, unfilterable), storeEntry(1),
                                                    bufEntry(2, wgpu::BufferBindingType::ReadOnlyStorage),
                                                    bufEntry(3, wgpu::BufferBindingType::Uniform)},
                                                   &bgl);
        const auto wts = gaussianWeights(kBlurRadius);
        wgpu::Buffer wb = newBuffer(g, wgpu::BufferUsage::Storage, wts.data(), wts.size() * sizeof(float));
        const int dirH[4] = {1, 0, kBlurRadius, 0}, dirV[4] = {0, 1, kBlurRadius, 0};
        wgpu::Buffer ubH = newBuffer(g, wgpu::BufferUsage::Uniform, dirH, sizeof dirH);
        wgpu::Buffer ubV = newBuffer(g, wgpu::BufferUsage::Uniform, dirV, sizeof dirV);
        wgpu::BindGroup bgH = bindGroup(g, bgl, {viewBinding(0, src), viewBinding(1, dstA), bufferBinding(2, wb), bufferBinding(3, ubH)});
        wgpu::BindGroup bgV = bindGroup(g, bgl, {viewBinding(0, dstA), viewBinding(1, dstB), bufferBinding(2, wb), bufferBinding(3, ubV)});
        auto run = [&](int n) {
            return submitAndWait(g, [&](wgpu::CommandEncoder& enc) {
                wgpu::ComputePassEncoder pass = enc.BeginComputePass();
                pass.SetPipeline(cp);
                for (int i = 0; i < n; ++i) {
                    pass.SetBindGroup(0, bgH);
                    pass.DispatchWorkgroups(gx, gy, 1);
                    pass.SetBindGroup(0, bgV);
                    pass.DispatchWorkgroups(gx, gy, 1);
                }
                pass.End();
            });
        };
        const double ms = perIterationMs(run, kBlurRepeats) / 2.0;
        const auto out = readBack(g, dstB, k4kW, k4kH);
        float err = 0;
        for (auto [x, y] : checkPoints(k4kW, k4kH)) {
            const auto ref = cpuBlurHV(img4k, k4kW, k4kH, x, y, wts, kBlurRadius);
            err = std::max(err, maxAbsDiff(ref.data(), &out[(size_t(y) * k4kW + size_t(x)) * 4], 4));
        }
        report("B5", "Gaussian r=64 3840x2160 RGBA32F, per pass (H or V)", fmt("%.2f ms  (max err %.2g)", ms, err));
    }

    // ---- B6
    if (!g.float32Filterable) {
        report("B6", "RGBA32F linear filtering", "feature float32-filterable NOT available");
    } else {
        wgpu::ShaderModule m = wgslModule(g, readText("wgsl/filter.wgsl"));
        wgpu::BindGroupLayout bgl;
        wgpu::ComputePipeline cp = computePipeline(
            g, m, {texEntry(0, wgpu::TextureSampleType::Float), storeEntry(1), samplerEntry(2, wgpu::SamplerBindingType::Filtering)},
            &bgl);
        wgpu::Texture two = newFloatTex(g, 2, 1);
        wgpu::Texture one = newFloatTex(g, 1, 1, wgpu::TextureUsage::StorageBinding);
        const float texels[8] = {0, 0, 0, 1, 1, 2, 4, 1};
        upload(g, two, texels, 2, 1);
        wgpu::SamplerDescriptor sd;
        sd.magFilter = sd.minFilter = wgpu::FilterMode::Linear;
        wgpu::Sampler lin = g.device.CreateSampler(&sd);
        wgpu::BindGroup bg = bindGroup(g, bgl, {viewBinding(0, two), viewBinding(1, one), samplerBinding(2, lin)});
        submitAndWait(g, [&](wgpu::CommandEncoder& enc) {
            wgpu::ComputePassEncoder pass = enc.BeginComputePass();
            pass.SetPipeline(cp);
            pass.SetBindGroup(0, bg);
            pass.DispatchWorkgroups(1, 1, 1);
            pass.End();
        });
        const auto v = readBack(g, one, 1, 1);
        const bool filtered = std::fabs(v[0] - 0.5f) < 1e-5f && std::fabs(v[2] - 2.0f) < 1e-5f;
        report("B6", "RGBA32F linear filtering (expect 0.5 1 2)",
               fmt("%.4g %.4g %.4g", v[0], v[1], v[2]) + (filtered ? "  -> filtered" : "  -> NOT filtered"));
    }

#ifdef SPIKE_WITH_OCIO
    runOcioDawn(g, src, img4k);
#else
    report("B7", "OCIO display shader", "skipped (built without OpenColorIO)");
#endif
    return 0;
}
