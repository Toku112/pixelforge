# Tests (CLAUDE.md §4): unit, golden and integration tests, selected with ctest -L <label> (tests/README.md).
# Test helpers (pf_add_gtest, update-golden): cmake/PfTesting.cmake.

add_subdirectory(support)
add_subdirectory(unit)
add_subdirectory(golden)
add_subdirectory(integration)
