# Architecture check (CLAUDE.md §3.1), run by CTest as the test "layering". Run with cmake -P -DSOURCE_DIR=<repo>.
#
# Scans every #include in src/ and fails when a layer includes something it must not:
#   - core/ is the pure model: no Qt, no operating-system headers, no other layer of ours;
#   - nodes/ and tools/ are UI-agnostic: no Qt (GPU work goes through gpu::), no ui/;
#   - only ui/ and app/ include ui/;
#   - only app/ includes app/, except app/Brand.h (the product name), which any layer outside core/ may use.
# Linking enforces most of this too (core does not link Qt); this check also catches header-only slips.

cmake_minimum_required(VERSION 3.28)

if(NOT DEFINED SOURCE_DIR)
    message(FATAL_ERROR "check_layering.cmake: -DSOURCE_DIR=<repository root> is required")
endif()

set(_layers app core color engine nodes tools gpu io ui ai plugins)
set(_qt_include "^<Q[A-Za-z]*(/|>)|^<qt|^<QtCore|^<QtGui|^<QtWidgets")
set(_os_include "^<(windows\\.h|unistd\\.h|pthread\\.h|dlfcn\\.h|sys/|mach/|Cocoa/|AppKit/|Foundation/|Metal/|CoreFoundation/|objc/)")

set(_errors "")
file(GLOB_RECURSE _files LIST_DIRECTORIES false
     "${SOURCE_DIR}/src/*.h" "${SOURCE_DIR}/src/*.hpp" "${SOURCE_DIR}/src/*.cpp" "${SOURCE_DIR}/src/*.mm")

foreach(_file IN LISTS _files)
    file(RELATIVE_PATH _rel "${SOURCE_DIR}/src" "${_file}")
    string(REGEX MATCH "^[^/]+" _layer "${_rel}")
    file(STRINGS "${_file}" _includes REGEX "^[ \t]*#[ \t]*include")
    foreach(_line IN LISTS _includes)
        if(NOT _line MATCHES "#[ \t]*include[ \t]*([<\"][^>\"]+[>\"])")
            continue()
        endif()
        set(_inc "${CMAKE_MATCH_1}")
        string(REGEX REPLACE "^[<\"]|[>\"]$" "" _path "${_inc}")
        string(REGEX MATCH "^[^/]+" _target_layer "${_path}")
        set(_is_layer FALSE)
        if(_path MATCHES "/" AND _target_layer IN_LIST _layers)
            set(_is_layer TRUE)
        endif()

        set(_why "")
        if(_layer STREQUAL "core")
            if(_inc MATCHES "${_qt_include}")
                set(_why "core/ must not use Qt")
            elseif(_inc MATCHES "${_os_include}")
                set(_why "core/ must not use operating-system APIs")
            elseif(_is_layer AND NOT _target_layer STREQUAL "core")
                set(_why "core/ must not depend on ${_target_layer}/")
            endif()
        elseif(_layer STREQUAL "nodes" OR _layer STREQUAL "tools")
            if(_inc MATCHES "${_qt_include}")
                set(_why "${_layer}/ is UI-agnostic: no Qt (GPU work goes through gpu::)")
            elseif(_is_layer AND _target_layer STREQUAL "ui")
                set(_why "${_layer}/ is UI-agnostic: no ui/")
            endif()
        endif()
        if(_why STREQUAL "" AND _is_layer)
            if(_target_layer STREQUAL "ui" AND NOT _layer MATCHES "^(ui|app)$")
                set(_why "only ui/ and app/ may include ui/")
            elseif(_target_layer STREQUAL "app" AND NOT _layer STREQUAL "app" AND NOT _path STREQUAL "app/Brand.h")
                set(_why "only app/ may include app/ (except app/Brand.h)")
            endif()
        endif()
        if(NOT _why STREQUAL "")
            list(APPEND _errors "src/${_rel}: ${_inc} — ${_why}")
        endif()
    endforeach()
endforeach()

list(LENGTH _files _file_count)
if(_errors)
    list(JOIN _errors "\n  " _error_text)
    message(FATAL_ERROR "Layering violations (CLAUDE.md §3.1):\n  ${_error_text}")
endif()
message(STATUS "layering: ${_file_count} source files follow CLAUDE.md §3.1")
