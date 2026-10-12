# Test helpers (CLAUDE.md §4 step 3). Every test carries exactly one label, so `ctest -L <label>` runs one kind:
#   unit         maths and models (GoogleTest);
#   golden       an image in, the expected EXR out, compared in float (tests/support/golden);
#   integration  user workflows driving the app headless.

find_package(GTest CONFIG REQUIRED)
include(GoogleTest)

set(PF_TEST_LABELS unit golden integration)

# update-golden: re-runs the golden tests in update mode, which rewrites the expected image of every golden test
# that fails or has none (tests/README.md). Only for changes that were reviewed; the build never does this by itself.
add_custom_target(update-golden
    COMMAND "${CMAKE_COMMAND}" -E env PF_GOLDEN_UPDATE=1
            "${CMAKE_CTEST_COMMAND}" --test-dir "${PROJECT_BINARY_DIR}" -L golden --output-on-failure
    USES_TERMINAL VERBATIM
    COMMENT "Updating the expected images of failing golden tests")

# pf_add_gtest(<target> LABEL <unit|golden|integration> SOURCES <files...> [LIBRARIES <targets...>])
#
# A GoogleTest program. Each TEST() becomes its own CTest test, named <target>.<Suite>.<Test>.
function(pf_add_gtest target)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "LABEL" "SOURCES;LIBRARIES")
    if(NOT arg_LABEL IN_LIST PF_TEST_LABELS)
        message(FATAL_ERROR "pf_add_gtest(${target}): LABEL must be one of ${PF_TEST_LABELS}, got '${arg_LABEL}'")
    endif()
    if(NOT arg_SOURCES)
        message(FATAL_ERROR "pf_add_gtest(${target}): no SOURCES")
    endif()

    add_executable(${target} ${arg_SOURCES})
    pf_target_defaults(${target})
    set_target_properties(${target} PROPERTIES AUTOMOC OFF) # Qt's moc only where a test uses Qt (none yet)
    target_link_libraries(${target} PRIVATE ${arg_LIBRARIES} GTest::gtest GTest::gtest_main)

    # Tests are listed when CTest runs, not during the build, so the build never starts test programs (they may
    # need DLLs on PATH on Windows, and sanitizer reports belong to the test run).
    gtest_discover_tests(${target}
        DISCOVERY_MODE PRE_TEST
        TEST_PREFIX "${target}."
        PROPERTIES LABELS ${arg_LABEL})

    if(arg_LABEL STREQUAL "golden")
        add_dependencies(update-golden ${target})
    endif()
endfunction()
