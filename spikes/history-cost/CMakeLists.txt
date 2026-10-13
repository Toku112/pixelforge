cmake_minimum_required(VERSION 3.28)
project(pixelforge_history_cost_spike LANGUAGES CXX)

# Throw-away measurement (PLAN Part C item 8). Never linked into the app. Links the core library of a configured and
# built main release build: -DPF_BUILD_DIR=<repo>/build/macos-release, with CMAKE_PREFIX_PATH pointing at that build's
# vcpkg_installed/<triplet> for Imath.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
if(NOT PF_BUILD_DIR)
    message(FATAL_ERROR "set -DPF_BUILD_DIR=<repo>/build/macos-release (built first)")
endif()

find_package(Imath CONFIG REQUIRED)
add_executable(history_cost_bench history_cost_bench.cpp)
target_include_directories(history_cost_bench PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../src")
target_link_libraries(history_cost_bench PRIVATE "${PF_BUILD_DIR}/src/core/libpf_core.a" Imath::Imath)
