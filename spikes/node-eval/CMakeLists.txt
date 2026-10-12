cmake_minimum_required(VERSION 3.28)
project(pixelforge_node_eval_spike LANGUAGES CXX)

# Throw-away measurement (PLAN Part C item 7). Never linked into the app. Links the real libraries of a configured
# and built main release build: -DPF_BUILD_DIR=<repo>/build/macos-release, with CMAKE_PREFIX_PATH pointing at that
# build's vcpkg_installed/<triplet> for oneTBB and Imath.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
if(NOT PF_BUILD_DIR)
    message(FATAL_ERROR "set -DPF_BUILD_DIR=<repo>/build/macos-release (built first)")
endif()

find_package(TBB CONFIG REQUIRED)
find_package(Imath CONFIG REQUIRED)
add_executable(node_eval_bench node_eval_bench.cpp)
target_include_directories(node_eval_bench PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../src")
target_link_libraries(node_eval_bench PRIVATE
    "${PF_BUILD_DIR}/src/nodes/libpf_nodes.a" "${PF_BUILD_DIR}/src/io/libpf_io.a"
    "${PF_BUILD_DIR}/src/engine/libpf_engine.a" "${PF_BUILD_DIR}/src/core/libpf_core.a"
    TBB::tbb TBB::tbbmalloc Imath::Imath)
