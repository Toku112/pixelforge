cmake_minimum_required(VERSION 3.28)

# How to build: README.md and CLAUDE.md §9 (presets: macos-debug, macos-release, windows-*, linux-*).

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(PfBrand) # PF_APP_NAME, PF_APP_BUNDLE_ID from src/app/Brand.h

project(pixelforge
    VERSION 0.1.0
    DESCRIPTION "Node-based compositor for render passes with a full image-editing toolset"
    LANGUAGES C CXX)

if(NOT DEFINED VCPKG_TARGET_TRIPLET)
    message(FATAL_ERROR "vcpkg is not active. Configure with a preset (cmake --preset macos-debug) and make sure "
                        "VCPKG_ROOT is set (README.md).")
endif()

option(PF_BUILD_TESTS "Build the tests" ON)

include(PfCompileOptions)
include(PfQt)

add_subdirectory(src)

if(PF_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

include(PfDevTargets)
include(PfPackaging)
