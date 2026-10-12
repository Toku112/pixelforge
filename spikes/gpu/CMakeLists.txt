cmake_minimum_required(VERSION 3.28)
project(pixelforge_gpu_spike LANGUAGES C CXX OBJCXX)

# Throw-away spike (PLAN Part C item 2). Never linked into the app.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 20)

# QRhi is semi-public: its headers come with the GuiPrivate target (limited compatibility promise between Qt versions).
find_package(Qt6 6.11 REQUIRED COMPONENTS Gui GuiPrivate ShaderTools ShaderToolsPrivate)
find_package(OpenColorIO CONFIG QUIET)
find_package(Dawn CONFIG QUIET)
find_package(glslang CONFIG QUIET)

set(SPIKE_SHADER_DIR "${CMAKE_CURRENT_SOURCE_DIR}/shaders")

function(spike_common target)
    target_compile_definitions(${target} PRIVATE SPIKE_SHADER_DIR="${SPIKE_SHADER_DIR}")
    target_compile_options(${target} PRIVATE -Wall -Wextra)
    if(OpenColorIO_FOUND)
        target_compile_definitions(${target} PRIVATE SPIKE_WITH_OCIO)
        target_link_libraries(${target} PRIVATE OpenColorIO::OpenColorIO)
    endif()
endfunction()

# ---- Qt RHI
set(RHI_OCIO_SOURCES)
if(OpenColorIO_FOUND)
    set(RHI_OCIO_SOURCES rhi/rhi_ocio.cpp)
endif()
add_executable(rhi_bench rhi/rhi_bench.cpp ${RHI_OCIO_SOURCES})
target_link_libraries(rhi_bench PRIVATE Qt6::Gui Qt6::GuiPrivate Qt6::ShaderTools Qt6::ShaderToolsPrivate)
spike_common(rhi_bench)

add_executable(rhi_window rhi/rhi_window.cpp)
target_link_libraries(rhi_window PRIVATE Qt6::Gui Qt6::GuiPrivate Qt6::ShaderTools Qt6::ShaderToolsPrivate)
spike_common(rhi_window)

# ---- Dawn
if(Dawn_FOUND AND glslang_FOUND)
    set(DAWN_OCIO_SOURCES)
    if(OpenColorIO_FOUND)
        set(DAWN_OCIO_SOURCES dawn/dawn_ocio.cpp)
    endif()
    add_executable(dawn_bench dawn/dawn_bench.cpp ${DAWN_OCIO_SOURCES})
    target_link_libraries(dawn_bench PRIVATE dawn::webgpu_dawn glslang::glslang glslang::SPIRV
                                             glslang::glslang-default-resource-limits)
    spike_common(dawn_bench)

    add_executable(dawn_window dawn/dawn_window.mm)
    target_link_libraries(dawn_window PRIVATE dawn::webgpu_dawn Qt6::Gui "-framework QuartzCore" "-framework Cocoa")
    spike_common(dawn_window)
else()
    message(STATUS "Dawn or glslang not found: Dawn targets skipped")
endif()

if(OpenColorIO_FOUND)
    add_executable(ocio_probe common/ocio_probe.cpp)
    spike_common(ocio_probe)
endif()
