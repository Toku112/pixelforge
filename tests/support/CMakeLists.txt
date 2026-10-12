# Libraries used only by tests.

find_package(Imath CONFIG REQUIRED)
find_package(OpenEXR CONFIG REQUIRED)

# The golden-image harness (support/golden/Golden.h). It reads and writes EXR with OpenEXR directly, not through
# our io/ layer, so that a bug in the code under test cannot hide in the code that checks it.
add_library(pf_test_golden STATIC
    golden/Compare.cpp
    golden/DeltaE.cpp
    golden/ExrFile.cpp
    golden/Golden.cpp
    golden/GoldenImage.cpp)
pf_target_defaults(pf_test_golden)
set_target_properties(pf_test_golden PROPERTIES AUTOMOC OFF)
target_include_directories(pf_test_golden PUBLIC "${PROJECT_SOURCE_DIR}/tests")
target_link_libraries(pf_test_golden
    PUBLIC GTest::gtest
    PRIVATE OpenEXR::OpenEXR Imath::Imath)
target_compile_definitions(pf_test_golden PRIVATE
    PF_GOLDEN_EXPECTED_ROOT="${PROJECT_SOURCE_DIR}/tests/golden"
    PF_GOLDEN_OUTPUT_ROOT="${PROJECT_BINARY_DIR}/golden-output")
