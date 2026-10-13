cmake_minimum_required(VERSION 3.28)
project(pixelforge_exr_read_spike LANGUAGES C CXX)

# Throw-away measurement (PLAN Part C item 9). Never linked into the app. Links the io and core libraries of a
# configured and built main release build: -DPF_BUILD_DIR=<repo>/build/macos-release, with CMAKE_PREFIX_PATH pointing
# at that build's vcpkg_installed/<triplet> for OpenEXR, Imath and oneTBB.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
if(NOT PF_BUILD_DIR)
    message(FATAL_ERROR "set -DPF_BUILD_DIR=<repo>/build/macos-release (built first)")
endif()

find_package(Imath CONFIG REQUIRED)
find_package(OpenEXR CONFIG REQUIRED)
find_package(TBB CONFIG REQUIRED)
add_executable(exr_read_bench exr_read_bench.cpp)
target_include_directories(exr_read_bench PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../src")
target_link_libraries(exr_read_bench PRIVATE
    "${PF_BUILD_DIR}/src/io/libpf_io.a" "${PF_BUILD_DIR}/src/core/libpf_core.a"
    OpenEXR::OpenEXR OpenEXR::OpenEXRCore Imath::Imath TBB::tbb)
