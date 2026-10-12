// GPU-layer spike, Dawn side: B8 (HDR/EDR window) and B9 (readback while the window renders).
// Same schedule as rhi/rhi_window.cpp. Dawn draws into the CAMetalLayer that Qt creates for a Metal QWindow;
// Dawn's own HDR option (SurfaceColorManagement) is rejected on macOS, so EDR is switched on directly on the layer.
#include "dawn_util.h"

#include <QGuiApplication>
#include <QWindow>

#import <Cocoa/Cocoa.h>
#import <QuartzCore/CAMetalLayer.h>

#include <atomic>
#include <thread>

using namespace spike;

namespace {

class DawnWindow : public QWindow {
public:
    explicit DawnWindow(bool stay) : m_stay(stay)
    {
        setSurfaceType(QSurface::MetalSurface);
        setTitle(QStringLiteral("GPU spike — Dawn — HDR test card"));
        resize(1280, 720);
    }
    ~DawnWindow() override { stopWorker(); }

protected:
    void exposeEvent(QExposeEvent*) override
    {
        if (isExposed() && !m_ready) init();
        if (isExposed()) render();
    }
    bool event(QEvent* e) override
    {
        if (e->type() == QEvent::UpdateRequest) render();
        return QWindow::event(e);
    }

private:
    void configure()
    {
        const QSize px = size() * devicePixelRatio();
        wgpu::SurfaceConfiguration c;
        c.device = m_g.device;
        c.format = m_format;
        c.usage = wgpu::TextureUsage::RenderAttachment;
        c.width = uint32_t(px.width());
        c.height = uint32_t(px.height());
        c.presentMode = wgpu::PresentMode::Fifo;
        m_surface.Configure(&c);
        m_configured = px;
        if (m_format == wgpu::TextureFormat::RGBA16Float) {
            // Not a Dawn feature: set EDR on the layer ourselves, after Dawn configured it.
            m_layer.wantsExtendedDynamicRangeContent = YES;
            CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceExtendedLinearDisplayP3);
            m_layer.colorspace = cs;
            CGColorSpaceRelease(cs);
        }
    }

    void init()
    {
        m_g = initGpu();
        NSView* view = reinterpret_cast<NSView*>(winId());
        std::printf("     Qt view layer class: %s\n", view.layer ? [[view.layer.class description] UTF8String] : "(none)");
        if ([view.layer isKindOfClass:[CAMetalLayer class]]) {
            m_layer = static_cast<CAMetalLayer*>(view.layer);
        } else {
            // Qt did not give the view a CAMetalLayer: add our own as a sublayer and keep it sized (more glue).
            view.wantsLayer = YES;
            m_layer = [CAMetalLayer layer];
            m_layer.frame = view.layer.bounds;
            m_layer.contentsScale = devicePixelRatio();
            m_layer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
            [view.layer addSublayer:m_layer];
            m_ownLayer = true;
        }
        wgpu::SurfaceSourceMetalLayer src;
        src.layer = (__bridge void*)m_layer;
        wgpu::SurfaceDescriptor sd;
        sd.nextInChain = &src;
        m_surface = m_g.instance.CreateSurface(&sd);

        wgpu::SurfaceCapabilities caps;
        m_surface.GetCapabilities(m_g.adapter, &caps);
        m_format = caps.formats[0];
        for (size_t i = 0; i < caps.formatCount; ++i)
            if (caps.formats[i] == wgpu::TextureFormat::RGBA16Float) m_format = wgpu::TextureFormat::RGBA16Float;
        configure();
        std::printf("B8   surface format %s; EDR set on the CAMetalLayer by hand: %s\n",
                    m_format == wgpu::TextureFormat::RGBA16Float ? "RGBA16Float" : "8-bit (no HDR)",
                    m_layer.wantsExtendedDynamicRangeContent ? "yes" : "no");
        NSScreen* screen = view.window.screen ?: NSScreen.mainScreen;
        std::printf("B8   EDR headroom now %.2f, potential %.2f (from NSScreen, Dawn has no query)\n",
                    double(screen.maximumExtendedDynamicRangeColorComponentValue),
                    double(screen.maximumPotentialExtendedDynamicRangeColorComponentValue));
        std::fflush(stdout);

        wgpu::ShaderModule m = wgslModule(m_g, readText("wgsl/hdrtest.wgsl"));
        wgpu::BindGroupLayout bgl;
        {
            wgpu::BindGroupLayoutEntry e = bufEntry(0, wgpu::BufferBindingType::Uniform, wgpu::ShaderStage::Fragment);
            wgpu::BindGroupLayoutDescriptor d;
            d.entryCount = 1;
            d.entries = &e;
            bgl = m_g.device.CreateBindGroupLayout(&d);
        }
        wgpu::PipelineLayoutDescriptor pld;
        pld.bindGroupLayoutCount = 1;
        pld.bindGroupLayouts = &bgl;
        wgpu::ColorTargetState target;
        target.format = m_format;
        wgpu::FragmentState fs;
        fs.module = m;
        fs.entryPoint = "fs";
        fs.targetCount = 1;
        fs.targets = &target;
        wgpu::RenderPipelineDescriptor rpd;
        rpd.layout = m_g.device.CreatePipelineLayout(&pld);
        rpd.vertex.module = m;
        rpd.vertex.entryPoint = "vs";
        rpd.fragment = &fs;
        m_pipeline = m_g.device.CreateRenderPipeline(&rpd);
        const float zero[4] = {};
        m_ubuf = newBuffer(m_g, wgpu::BufferUsage::Uniform, zero, sizeof zero);
        wgpu::BindGroupEntry be = bufferBinding(0, m_ubuf);
        wgpu::BindGroupDescriptor bgd;
        bgd.layout = bgl;
        bgd.entryCount = 1;
        bgd.entries = &be;
        m_bg = m_g.device.CreateBindGroup(&bgd);

        m_img8k = makeTestImage(k8kW, k8kH);
        m_tex8k = newFloatTex(m_g, k8kW, k8kH);
        upload(m_g, m_tex8k, m_img8k.data(), k8kW, k8kH);
        m_t0 = nowMs();
        m_ready = true;
    }

    void startReadback()
    {
        const uint32_t row = k8kW * 16;
        wgpu::BufferDescriptor bd;
        bd.size = uint64_t(row) * k8kH;
        bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
        m_rbBuf = m_g.device.CreateBuffer(&bd);
        wgpu::CommandEncoder enc = m_g.device.CreateCommandEncoder();
        wgpu::TexelCopyTextureInfo s;
        s.texture = m_tex8k;
        wgpu::TexelCopyBufferInfo d;
        d.buffer = m_rbBuf;
        d.layout.bytesPerRow = row;
        d.layout.rowsPerImage = k8kH;
        const wgpu::Extent3D ext{k8kW, k8kH, 1};
        enc.CopyTextureToBuffer(&s, &d, &ext);
        wgpu::CommandBuffer cmd = enc.Finish();
        m_g.queue.Submit(1, &cmd);
        m_readbackStart = nowMs();
        m_rbBuf.MapAsync(wgpu::MapMode::Read, 0, bd.size, wgpu::CallbackMode::AllowProcessEvents,
                         [this](wgpu::MapAsyncStatus, wgpu::StringView) {
                             // Mapped memory is a direct pointer; copying it out is our choice. Copy here, on the
                             // UI thread, to compare like for like with RHI's readback (which always copies).
                             const auto* p = static_cast<const float*>(m_rbBuf.GetConstMappedRange());
                             m_rbCopy.assign(p, p + size_t(k8kW) * k8kH * 4);
                             m_rbBuf.Unmap();
                             m_readbackDone = nowMs();
                             m_readbackFrame = m_frame;
                         });
    }

    void render()
    {
        if (!m_ready || m_done) return;
        if (size() * devicePixelRatio() != m_configured) configure();
        const double tBegin = nowMs();
        if (m_lastBegin > 0) m_interval.push_back(tBegin - m_lastBegin);
        m_lastBegin = tBegin;

        m_g.instance.ProcessEvents();
        if (m_frame == 60) startReadback();
        if (m_frame == 120) startWorker();

        wgpu::SurfaceTexture st;
        m_surface.GetCurrentTexture(&st);
        if (st.status != wgpu::SurfaceGetCurrentTextureStatus::SuccessOptimal &&
            st.status != wgpu::SurfaceGetCurrentTextureStatus::SuccessSuboptimal) {
            configure();
            requestUpdate();
            return;
        }
        const float params[4] = {float((tBegin - m_t0) / 1000.0), 4.0f, 0, 0};
        m_g.queue.WriteBuffer(m_ubuf, 0, params, sizeof params);
        wgpu::RenderPassColorAttachment att;
        att.view = st.texture.CreateView();
        att.loadOp = wgpu::LoadOp::Clear;
        att.storeOp = wgpu::StoreOp::Store;
        att.clearValue = {0, 0, 0, 1};
        wgpu::RenderPassDescriptor rp;
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &att;
        wgpu::CommandEncoder enc = m_g.device.CreateCommandEncoder();
        wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
        pass.SetPipeline(m_pipeline);
        pass.SetBindGroup(0, m_bg);
        pass.Draw(3);
        pass.End();
        wgpu::CommandBuffer cmd = enc.Finish();
        m_g.queue.Submit(1, &cmd);
        m_surface.Present();
        m_cpu.push_back(nowMs() - tBegin);

        ++m_frame;
        if (m_frame == 240) {
            stopWorker();
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
            Gpu g = initGpu();
            wgpu::Texture tex = newFloatTex(g, k8kW, k8kH);
            while (!m_stopWorker) {
                const double t0 = nowMs();
                upload(g, tex, m_img8k.data(), k8kW, k8kH);
                const auto back = readBack(g, tex, k8kW, k8kH);
                m_workerRoundTrips.push_back(nowMs() - t0);
            }
        });
    }
    void stopWorker()
    {
        m_stopWorker = true;
        if (m_worker.joinable()) m_worker.join();
    }

    static double maxOf(const std::vector<double>& v, size_t a, size_t b)
    {
        double m = 0;
        for (size_t i = a; i < std::min(b, v.size()); ++i) m = std::max(m, v[i]);
        return m;
    }
    static double avgOf(const std::vector<double>& v, size_t a, size_t b)
    {
        double s = 0;
        size_t n = 0;
        for (size_t i = a; i < std::min(b, v.size()); ++i, ++n) s += v[i];
        return n ? s / double(n) : 0;
    }

    void printStats()
    {
        report("B9", "frame interval, frames 5–59 (baseline): avg / worst",
               fmt("%.2f / %.2f ms", avgOf(m_interval, 5, 59), maxOf(m_interval, 5, 59)));
        NSScreen* screen = reinterpret_cast<NSView*>(winId()).window.screen ?: NSScreen.mainScreen;
        report("B8", "EDR headroom after showing values > 1 for 4 s",
               fmt("%.2f (potential %.2f)", double(screen.maximumExtendedDynamicRangeColorComponentValue),
                   double(screen.maximumPotentialExtendedDynamicRangeColorComponentValue)));
        report("B9", "same-thread 8K readback at frame 60: worst frame 58–70",
               fmt("%.2f ms interval, %.2f ms CPU in frame", maxOf(m_interval, 58, 70), maxOf(m_cpu, 58, 70)));
        report("B9", "  readback latency",
               fmt("%.1f ms, done in frame %.0f", m_readbackDone - m_readbackStart, double(m_readbackFrame)));
        report("B9", "worker-thread 8K upload+readback, frames 120–239: avg / worst",
               fmt("%.2f / %.2f ms", avgOf(m_interval, 121, 239), maxOf(m_interval, 121, 239)));
        report("B9", "  worker round trips (upload + readback of 531 MB)",
               fmt("%.0f done, median %.1f ms", double(m_workerRoundTrips.size()), median(m_workerRoundTrips)));
    }

    bool m_stay = false, m_ready = false, m_done = false, m_ownLayer = false;
    Gpu m_g;
    CAMetalLayer* m_layer = nil;
    wgpu::Surface m_surface;
    wgpu::TextureFormat m_format = wgpu::TextureFormat::Undefined;
    QSize m_configured;
    wgpu::RenderPipeline m_pipeline;
    wgpu::Buffer m_ubuf, m_rbBuf;
    wgpu::BindGroup m_bg;
    wgpu::Texture m_tex8k;
    std::vector<float> m_img8k, m_rbCopy;
    double m_t0 = 0, m_lastBegin = 0, m_readbackStart = 0, m_readbackDone = 0;
    int m_frame = 0, m_readbackFrame = -1;
    std::vector<double> m_interval, m_cpu, m_workerRoundTrips;
    std::thread m_worker;
    std::atomic<bool> m_stopWorker{false};
};

}  // namespace

int main(int argc, char** argv)
{
    QGuiApplication app(argc, argv);
    DawnWindow w(app.arguments().contains(QStringLiteral("--stay")));
    w.show();
    return app.exec();
}
