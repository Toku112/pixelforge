# Compiler settings for our own targets (CLAUDE.md §2: C++20, warnings as errors, ASan/UBSan in debug builds).
# Third-party headers come from imported targets, which CMake treats as system headers, so their warnings stay quiet.

option(PF_WARNINGS_AS_ERRORS "Treat compiler warnings in our code as errors" ON)
set(PF_SANITIZERS "" CACHE STRING "Sanitizers for the whole build, e.g. 'address;undefined' (set by the debug presets)")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Sanitizers apply to everything we compile and link (our libraries, tests and the app); vcpkg libraries and Qt are
# prebuilt without them, which ASan and UBSan support.
if(PF_SANITIZERS)
    if(MSVC)
        # MSVC has AddressSanitizer only; its runtime checks (/RTC1) are incompatible with it.
        if(NOT "address" IN_LIST PF_SANITIZERS)
            message(FATAL_ERROR "MSVC supports only the 'address' sanitizer (PF_SANITIZERS='${PF_SANITIZERS}')")
        endif()
        string(REPLACE "/RTC1" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
        string(REPLACE "/RTC1" "" CMAKE_C_FLAGS_DEBUG "${CMAKE_C_FLAGS_DEBUG}")
        add_compile_options(/fsanitize=address /Zi)
        add_link_options(/INCREMENTAL:NO)
    else()
        list(JOIN PF_SANITIZERS "," _pf_sanitizer_list)
        add_compile_options(-fsanitize=${_pf_sanitizer_list} -fno-omit-frame-pointer -fno-sanitize-recover=all)
        add_link_options(-fsanitize=${_pf_sanitizer_list})
    endif()
endif()

# Warning flags, applied per target by pf_target_defaults().
if(MSVC)
    set(PF_WARNING_FLAGS /W4 /permissive- /utf-8 /Zc:__cplusplus /Zc:preprocessor /EHsc /external:W0)
else()
    # -Wconversion catches silent float/double/int narrowing, the classic image-maths bug. Sign conversions
    # (int index into a size_t container) are not flagged: too noisy for the value they add (D-070).
    set(PF_WARNING_FLAGS
        -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -Wdouble-promotion -Wold-style-cast
        -Wnon-virtual-dtor -Woverloaded-virtual -Wcast-align -Wformat=2 -Wimplicit-fallthrough)
    if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
        list(APPEND PF_WARNING_FLAGS -Wduplicated-cond -Wduplicated-branches -Wlogical-op -Wmisleading-indentation)
        # GCC 13 reports designated initializers that leave out fields with default values
        # ({.priority = Priority::Viewer}), the intended way to fill options structs; Clang and MSVC do not (D-074).
        list(APPEND PF_WARNING_FLAGS -Wno-missing-field-initializers)
    endif()
endif()

# Every target we define calls this: C++20, our warnings, warnings as errors, src/ as the include root.
function(pf_target_defaults target)
    target_compile_features(${target} PUBLIC cxx_std_20)
    target_compile_options(${target} PRIVATE ${PF_WARNING_FLAGS})
    set_target_properties(${target} PROPERTIES COMPILE_WARNING_AS_ERROR ${PF_WARNINGS_AS_ERRORS})
    target_include_directories(${target} PUBLIC "$<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/src>")
    # Static libraries must come after every library that uses them, so one used by two others (Imath, by core and
    # by OpenEXR) can appear twice on a link line. Apple's linker handles that but warns; the warning means nothing.
    if(APPLE)
        target_link_options(${target} PRIVATE "LINKER:-no_warn_duplicate_libraries")
    endif()
endfunction()
