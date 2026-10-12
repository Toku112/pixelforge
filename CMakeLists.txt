cmake_minimum_required(VERSION 3.28)

# Static libraries appear once on link lines where the linker does not need repeats (Apple's linker warns about
# duplicates, e.g. GoogleTest pulled in by a test and by a test-support library). New in CMake 3.29.
if(POLICY CMP0156)
    cmake_policy(SET CMP0156 NEW)
endif()

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

if(PF_BUILD_TESTS)
    enable_testing()
    include(PfTesting) # before src/, whose layers will add their own tests
endif()

add_subdirectory(src)

if(PF_BUILD_TESTS)
    add_subdirectory(tests)
endif()

include(PfDevTargets)
include(PfPackaging)
