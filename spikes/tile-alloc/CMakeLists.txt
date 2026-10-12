cmake_minimum_required(VERSION 3.28)
project(pixelforge_tile_alloc_spike LANGUAGES CXX)

# Throw-away measurement (PLAN Part C item 6). Never linked into the app. Uses the oneTBB the main build installed.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(TBB CONFIG REQUIRED)
add_executable(alloc_bench alloc_bench.cpp)
target_link_libraries(alloc_bench PRIVATE TBB::tbb TBB::tbbmalloc)

# real_bench: the same measurement on the real core/image and engine/TilePool code, linked from a configured main
# build (-DPF_BUILD_DIR=build/macos-release, built first).
if(PF_BUILD_DIR)
    add_executable(real_bench real_bench.cpp)
    target_include_directories(real_bench PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../src")
    target_link_libraries(real_bench PRIVATE
        "${PF_BUILD_DIR}/src/engine/libpf_engine.a" "${PF_BUILD_DIR}/src/core/libpf_core.a" TBB::tbb TBB::tbbmalloc)
endif()
