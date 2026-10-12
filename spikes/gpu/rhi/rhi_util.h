// Small Qt RHI helpers shared by the spike's RHI programs.
#pragma once

#include "../common/bench_common.h"

#include <QFile>
#include <rhi/qrhi.h>
#include <rhi/qshaderbaker.h>

#include <cstdlib>

namespace spike {

// Bakes Vulkan-style GLSL at run time for every backend RHI may use (SPIR-V for Vulkan, MSL for Metal, HLSL for
// D3D). This uses only the LGPL runtime library of Qt Shader Tools; the GPL-3 `qsb` tool is not needed.
inline QShader bake(const QByteArray& source, QShader::Stage stage, const QString& name, double* bakeMs = nullptr)
{
    const double t0 = nowMs();
    QShaderBaker baker;
    baker.setGeneratedShaderVariants({QShader::StandardShader});
    baker.setGeneratedShaders({{QShader::SpirvShader, 100}, {QShader::MslShader, QShaderVersion(20)},
                               {QShader::HlslShader, QShaderVersion(50)}});
    baker.setSourceString(source, stage, name);
    QShader s = baker.bake();
    if (bakeMs) *bakeMs = nowMs() - t0;
    if (!s.isValid()) {
        std::fprintf(stderr, "shader %s failed: %s\n", qPrintable(name), qPrintable(baker.errorMessage()));
        std::exit(2);
    }
    return s;
}

inline QByteArray readShaderFile(const char* relPath)
{
    QFile f(QStringLiteral(SPIKE_SHADER_DIR "/") + QString::fromLatin1(relPath));
    if (!f.open(QIODevice::ReadOnly)) {
        std::fprintf(stderr, "cannot open shader %s\n", relPath);
        std::exit(2);
    }
    return f.readAll();
}

inline QShader bakeFile(const char* relPath, QShader::Stage stage, double* bakeMs = nullptr)
{
    return bake(readShaderFile(relPath), stage, QString::fromLatin1(relPath), bakeMs);
}

}  // namespace spike
