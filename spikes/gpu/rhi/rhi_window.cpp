// GPU-layer spike, Qt RHI side: B8 (HDR/EDR window) and B9 (readback while the window renders).
//
// Frames   0–59: plain rendering (baseline frame interval).
// Frame      60: the window's own QRhi reads back an 8K RGBA32F texture (same-thread readback).
// Frames 120–239: a second, offscreen QRhi on a worker thread uploads and reads back 8K frames continuously while the
//                 window keeps rendering — the way the engine would export or feed CPU nodes.
// After frame 240 the statistics are printed and the window closes, unless --stay is given (for looking at EDR).
#include "rhi_util.h"

#include <QGuiApplication>
#include <QWindow>
#include <QPlatformSurfaceEvent>
#include <rhi/qrhi.h>

#include <atomic>
#include <memory>
#include <thread>

using namespace spike;

namespace {

struct FrameStats {
    std::vector<double> interval;  // ms between successive beginFrame calls
    std::vector<double> cpu;       // ms spent in beginFrame..endFrame
    double max(const std::vector<double>& v, size_t a, size_t b) const
    {
        double m = 0;
        for (size_t i = a; i < std::min(b, v.size()); ++i) m = std::max(m, v[i]);
        return m;
    }
    double avg(const std::vector<double>& v, size_t a, size_t b) const
    {
        double s = 0;
        size_t n = 0;
        for (size_t i = a; i < std::min(b, v.size()); ++i, ++n) s += v[i];
        return n ? s / double(n) : 0;
    }
};

class HdrWindow : public QWindow {
public:
    explicit HdrWindow(bool stay) : m_stay(stay)
    {
        setSurfaceType(QSurface::MetalSurface);
        setTitle(QStringLiteral("GPU spike — Qt RHI — HDR test card"));
        resize(1280, 720);
    }
    ~HdrWindow() override { releaseAll(); }

protected:
    void exposeEvent(QExposeEvent*) override
    {
        if (isExposed() && !m_rhi) init();
        if (isExposed()) render();
    }
    bool event(QEvent* e) override
    {
        if (e->type() == QEvent::UpdateRequest) render();
        if (e->type() == QEvent::PlatformSurface &&
            static_cast<QPlatformSurfaceEvent*>(e)->surfaceEventType() == QPlatformSurfaceEvent::SurfaceAboutToBeDestroyed)
            releaseAll();
        return QWindow::event(e);
    }

private:
    void init()
    {
        QRhiMetalInitParams params;
        m_rhi.reset(QRhi::create(QRhi::Metal, &params));
        m_sc.reset(m_rhi->newSwapChain());
        m_sc->setWindow(this);
        const char* fmtName = "SDR";
        if (m_sc->isFormatSupported(QRhiSwapChain::HDRExtendedDisplayP3Linear)) {
            m_sc->setFormat(QRhiSwapChain::HDRExtendedDisplayP3Linear);
            fmtName = "HDRExtendedDisplayP3Linear";
        } else if (m_sc->isFormatSupported(QRhiSwapChain::HDRExtendedSrgbLinear)) {
            m_sc->setFormat(QRhiSwapChain::HDRExtendedSrgbLinear);
            fmtName = "HDRExtendedSrgbLinear";
        }
        m_rp.reset(m_sc->newCompatibleRenderPassDescriptor());
        m_sc->setRenderPassDescriptor(m_rp.get());
        m_sc->createOrResize();

        const QRhiSwapChainHdrInfo hdr = m_sc->hdrInfo();
        std::printf("B8   swapchain format %s\n", fmtName);
        if (hdr.limitsType == QRhiSwapChainHdrInfo::ColorComponentValue)
            std::printf("B8   EDR headroom now %.2f, potential %.2f (1.0 = SDR white)\n",
                        hdr.limits.colorComponentValue.maxColorComponentValue,
                        hdr.limits.colorComponentValue.maxPotentialColorComponentValue);
        else
            std::printf("B8   luminance %.0f–%.0f nits, SDR white %.0f\n", hdr.limits.luminanceInNits.minLuminance,
                        hdr.limits.luminanceInNits.maxLuminance, hdr.sdrWhiteLevel);
        std::fflush(stdout);

        m_ubuf.reset(m_rhi->newBuffer(QRhiBuffer::Dynamic, QRhiBuffer::UniformBuffer, 16));
        m_ubuf->create();
        m_srb.reset(m_rhi->newShaderResourceBindings());
        m_srb->setBindings({QRhiShaderResourceBinding::uniformBuffer(0, QRhiShaderResourceBinding::FragmentStage,
                                                                     m_ubuf.get())});
        m_srb->create();
        m_ps.reset(m_rhi->newGraphicsPipeline());
        m_ps->setShaderStages({{QRhiShaderStage::Vertex, bakeFile("glsl/fullscreen.vert", QShader::VertexStage)},
                               {QRhiShaderStage::Fragment, bakeFile("glsl/hdrtest.frag", QShader::FragmentStage)}});
        m_ps->setVertexInputLayout({});
        m_ps->setShaderResourceBindings(m_srb.get());
        m_ps->setRenderPassDescriptor(m_rp.get());
        m_ps->create();

        // 8K texture for the same-thread readback at frame 60.
        m_img8k = makeTestImage(k8kW, k8kH);
        m_tex8k.reset(m_rhi->newTexture(QRhiTexture::RGBA32F, QSize(k8kW, k8kH)));
        m_tex8k->create();
        m_pendingUpload = true;
        m_t0 = nowMs();
    }

    void render()
    {
        if (!m_rhi || m_done) return;
        if (m_sc->currentPixelSize() != m_sc->surfacePixelSize()) m_sc->createOrResize();

        const double tBegin = nowMs();
        if (m_lastBegin > 0) m_stats.interval.push_back(tBegin - m_lastBegin);
        m_lastBegin = tBegin;

        if (m_rhi->beginFrame(m_sc.get()) != QRhi::FrameOpSuccess) {
            requestUpdate();
            return;
        }
        QRhiResourceUpdateBatch* u = m_rhi->nextResourceUpdateBatch();
        if (m_pendingUpload) {
            QRhiTextureSubresourceUploadDescription sub(m_img8k.data(), quint32(m_img8k.size() * sizeof(float)));
            u->uploadTexture(m_tex8k.get(), QRhiTextureUploadDescription({0, 0, sub}));
            m_pendingUpload = false;
        }
        if (m_frame == 60) {
            m_readbackStart = nowMs();
            m_readback.completed = [this] { m_readbackDone = nowMs(); m_readbackFrame = m_frame; };
            u->readBackTexture(QRhiReadbackDescription(m_tex8k.get()), &m_readback);
        }
        if (m_frame == 120) startWorker();
        const float params[4] = {float((tBegin - m_t0) / 1000.0), 4.0f, 0, 0};
        u->updateDynamicBuffer(m_ubuf.get(), 0, sizeof params, params);

        QRhiCommandBuffer* cb = m_sc->currentFrameCommandBuffer();
        const QSize sz = m_sc->currentPixelSize();
        cb->beginPass(m_sc->currentFrameRenderTarget(), Qt::black, {1.0f, 0}, u);
        cb->setGraphicsPipeline(m_ps.get());
        cb->setViewport({0, 0, float(sz.width()), float(sz.height())});
        cb->setShaderResources();
        cb->draw(3);
        cb->endPass();
        m_rhi->endFrame(m_sc.get());
        m_stats.cpu.push_back(nowMs() - tBegin);

        ++m_frame;
        if (m_frame == 240) {
            m_stopWorker = true;
            if (m_worker.joinable()) m_worker.join();
            printStats();
            if (!m_stay) {
                m_done = true;
                QMetaObject::invokeMethod(qApp, &QCoreApplication::quit, Qt::QueuedConnection);
                return;
            }
        }
        requestUpdate();
    }

    void startWorker()
    {
        m_worker = std::thread([this] {
            QRhiMetalInitParams params;
            std::unique_ptr<QRhi> rhi(QRhi::create(QRhi::Metal, &params));
            std::unique_ptr<QRhiTexture> tex(rhi->newTexture(QRhiTexture::RGBA32F, QSize(k8kW, k8kH)));
            tex->create();
            while (!m_stopWorker) {
                QRhiCommandBuffer* cb = nullptr;
                const double t0 = nowMs();
                rhi->beginOffscreenFrame(&cb);
                QRhiResourceUpdateBatch* u = rhi->nextResourceUpdateBatch();
                QRhiTextureSubresourceUploadDescription sub(m_img8k.data(), quint32(m_img8k.size() * sizeof(float)));
                u->uploadTexture(tex.get(), QRhiTextureUploadDescription({0, 0, sub}));
                QRhiReadbackResult res;
                u->readBackTexture(QRhiReadbackDescription(tex.get()), &res);
                cb->resourceUpdate(u);
                rhi->endOffscreenFrame();
                m_workerRoundTrips.push_back(nowMs() - t0);
            }
        });
    }

    void printStats()
    {
        const auto& s = m_stats;
        report("B9", "frame interval, frames 5–59 (baseline): avg / worst",
               fmt("%.2f / %.2f ms", s.avg(s.interval, 5, 59), s.max(s.interval, 5, 59)));
        const QRhiSwapChainHdrInfo hdr = m_sc->hdrInfo();
        if (hdr.limitsType == QRhiSwapChainHdrInfo::ColorComponentValue)
            report("B8", "EDR headroom after showing values > 1 for 4 s",
                   fmt("%.2f (potential %.2f)", hdr.limits.colorComponentValue.maxColorComponentValue,
                       hdr.limits.colorComponentValue.maxPotentialColorComponentValue));
        report("B9", "same-thread 8K readback at frame 60: worst frame 58–70",
               fmt("%.2f ms interval, %.2f ms CPU in frame", s.max(s.interval, 58, 70), s.max(s.cpu, 58, 70)));
        report("B9", "  readback latency",
               fmt("%.1f ms, done in frame %.0f", m_readbackDone - m_readbackStart, double(m_readbackFrame)));
        report("B9", "worker-thread 8K upload+readback, frames 120–239: avg / worst",
               fmt("%.2f / %.2f ms", s.avg(s.interval, 121, 239), s.max(s.interval, 121, 239)));
        report("B9", "  worker round trips (upload + readback of 531 MB)",
               fmt("%.0f done, median %.1f ms", double(m_workerRoundTrips.size()), median(m_workerRoundTrips)));
    }

    void releaseAll()
    {
        m_stopWorker = true;
        if (m_worker.joinable()) m_worker.join();
        m_ps.reset();
        m_srb.reset();
        m_ubuf.reset();
        m_tex8k.reset();
        m_rp.reset();
        m_sc.reset();
        m_rhi.reset();
    }

    bool m_stay = false, m_done = false, m_pendingUpload = false;
    std::unique_ptr<QRhi> m_rhi;
    std::unique_ptr<QRhiSwapChain> m_sc;
    std::unique_ptr<QRhiRenderPassDescriptor> m_rp;
    std::unique_ptr<QRhiBuffer> m_ubuf;
    std::unique_ptr<QRhiShaderResourceBindings> m_srb;
    std::unique_ptr<QRhiGraphicsPipeline> m_ps;
    std::unique_ptr<QRhiTexture> m_tex8k;
    std::vector<float> m_img8k;
    QRhiReadbackResult m_readback;
    double m_t0 = 0, m_lastBegin = 0, m_readbackStart = 0, m_readbackDone = 0;
    int m_frame = 0, m_readbackFrame = -1;
    FrameStats m_stats;
    std::thread m_worker;
    std::atomic<bool> m_stopWorker{false};
    std::vector<double> m_workerRoundTrips;
};

}  // namespace

int main(int argc, char** argv)
{
    QGuiApplication app(argc, argv);
    const bool stay = app.arguments().contains(QStringLiteral("--stay"));
    HdrWindow w(stay);
    w.show();
    return app.exec();
}
