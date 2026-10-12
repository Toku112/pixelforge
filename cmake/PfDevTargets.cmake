# Developer targets (CLAUDE.md §9): run, format, format-check, tidy, check-licenses, update-third-party.
# The package target comes from CPack (cmake/PfPackaging.cmake).

# ---- run: build and start the app ----
add_custom_target(run
    COMMAND "$<TARGET_FILE:pf_app>"
    DEPENDS pf_app
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL VERBATIM
    COMMENT "Starting ${PF_APP_NAME}")

# ---- LLVM tools, pinned to one major version so formatting and lint results match on every machine and in CI ----
set(PF_LLVM_TOOLS_MAJOR 21)

function(pf_validate_llvm_tool result_var candidate)
    execute_process(COMMAND "${candidate}" --version OUTPUT_VARIABLE _out ERROR_QUIET RESULT_VARIABLE _result)
    if(NOT _result EQUAL 0 OR NOT _out MATCHES "version ${PF_LLVM_TOOLS_MAJOR}\\.")
        set(${result_var} FALSE PARENT_SCOPE)
    endif()
endfunction()

set(_pf_llvm_hints
    "/opt/homebrew/opt/llvm@${PF_LLVM_TOOLS_MAJOR}/bin"
    "/usr/local/opt/llvm@${PF_LLVM_TOOLS_MAJOR}/bin"
    "/usr/lib/llvm-${PF_LLVM_TOOLS_MAJOR}/bin"
    "C:/Program Files/LLVM/bin")
if(APPLE)
    # Xcode ships clang-format (not clang-tidy).
    execute_process(COMMAND xcrun --find clang-format OUTPUT_VARIABLE _pf_xcrun_format
                    OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
    if(_pf_xcrun_format)
        get_filename_component(_pf_xcode_bin "${_pf_xcrun_format}" DIRECTORY)
        list(APPEND _pf_llvm_hints "${_pf_xcode_bin}")
    endif()
endif()

find_program(PF_CLANG_FORMAT NAMES clang-format-${PF_LLVM_TOOLS_MAJOR} clang-format
             HINTS ${_pf_llvm_hints} VALIDATOR pf_validate_llvm_tool)
find_program(PF_CLANG_TIDY NAMES clang-tidy-${PF_LLVM_TOOLS_MAJOR} clang-tidy
             HINTS ${_pf_llvm_hints} VALIDATOR pf_validate_llvm_tool)
find_program(PF_RUN_CLANG_TIDY NAMES run-clang-tidy-${PF_LLVM_TOOLS_MAJOR} run-clang-tidy run-clang-tidy.py
             HINTS ${_pf_llvm_hints})

set(_pf_llvm_install_hint "install LLVM ${PF_LLVM_TOOLS_MAJOR} (macOS: brew install llvm@${PF_LLVM_TOOLS_MAJOR})")

# ---- format / format-check ----
if(PF_CLANG_FORMAT)
    foreach(_pf_mode IN ITEMS fix check)
        if(_pf_mode STREQUAL "fix")
            set(_pf_target format)
        else()
            set(_pf_target format-check)
        endif()
        add_custom_target(${_pf_target}
            COMMAND "${CMAKE_COMMAND}" -DCLANG_FORMAT=${PF_CLANG_FORMAT} -DSOURCE_DIR=${PROJECT_SOURCE_DIR}
                    -DMODE=${_pf_mode} -P "${PROJECT_SOURCE_DIR}/cmake/scripts/run_clang_format.cmake"
            USES_TERMINAL VERBATIM)
    endforeach()
else()
    foreach(_pf_target IN ITEMS format format-check)
        add_custom_target(${_pf_target}
            COMMAND "${CMAKE_COMMAND}" -E echo "clang-format ${PF_LLVM_TOOLS_MAJOR} not found: ${_pf_llvm_install_hint}"
            COMMAND "${CMAKE_COMMAND}" -E false VERBATIM)
    endforeach()
endif()

# ---- tidy ----
if(PF_CLANG_TIDY)
    add_custom_target(tidy
        COMMAND "${CMAKE_COMMAND}" -DCLANG_TIDY=${PF_CLANG_TIDY} -DRUN_CLANG_TIDY=${PF_RUN_CLANG_TIDY}
                -DBUILD_DIR=${PROJECT_BINARY_DIR} -DSOURCE_DIR=${PROJECT_SOURCE_DIR}
                -P "${PROJECT_SOURCE_DIR}/cmake/scripts/run_clang_tidy.cmake"
        USES_TERMINAL VERBATIM)
    # Generated headers (moc, ui) must exist before clang-tidy reads the sources.
    add_dependencies(tidy pf_app)
else()
    add_custom_target(tidy
        COMMAND "${CMAKE_COMMAND}" -E echo "clang-tidy ${PF_LLVM_TOOLS_MAJOR} not found: ${_pf_llvm_install_hint}"
        COMMAND "${CMAKE_COMMAND}" -E false VERBATIM)
endif()

# ---- check-licenses / update-third-party ----
list(JOIN PF_QT_COMPONENTS "," _pf_qt_components)
foreach(_pf_update IN ITEMS OFF ON)
    if(_pf_update)
        set(_pf_target update-third-party)
    else()
        set(_pf_target check-licenses)
    endif()
    add_custom_target(${_pf_target}
        COMMAND "${CMAKE_COMMAND}" -DINSTALLED_DIR=${VCPKG_INSTALLED_DIR} -DTRIPLET=${VCPKG_TARGET_TRIPLET}
                -DTHIRD_PARTY_MD=${PROJECT_SOURCE_DIR}/docs/THIRD_PARTY.md -DQT_COMPONENTS=${_pf_qt_components}
                -DUPDATE=${_pf_update} -P "${PROJECT_SOURCE_DIR}/cmake/scripts/check_licenses.cmake"
        USES_TERMINAL VERBATIM)
endforeach()
