# Tests (CLAUDE.md §4): unit, golden and integration tests, selected with ctest -L <label>.

add_test(NAME layering
    COMMAND "${CMAKE_COMMAND}" -DSOURCE_DIR=${PROJECT_SOURCE_DIR}
            -P "${PROJECT_SOURCE_DIR}/cmake/scripts/check_layering.cmake")
set_tests_properties(layering PROPERTIES LABELS unit)

add_test(NAME license_policy
    COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_SOURCE_DIR}/license_policy_test.cmake")
set_tests_properties(license_policy PROPERTIES LABELS unit)
