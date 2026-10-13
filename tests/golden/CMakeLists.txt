# Golden-image tests (label golden). Expected images live next to their tests: <feature>/<case>.expected.exr.

pf_add_gtest(pf_test_golden_selftest LABEL golden
    SOURCES harness/HarnessGoldenTest.cpp
    LIBRARIES pf_test_golden)

pf_add_gtest(pf_test_golden_exposure LABEL golden
    SOURCES exposure/ExposureGoldenTest.cpp
    LIBRARIES pf_test_node_bench)

# Lossy EXR compressions: committed input files (tests/fixtures/exr) and golden images.
pf_add_gtest(pf_test_golden_exr LABEL golden
    SOURCES exr/ExrGoldenTest.cpp
    LIBRARIES pf_test_node_bench pf_test_exr)
target_compile_definitions(pf_test_golden_exr PRIVATE PF_EXR_FIXTURES_DIR="${PROJECT_SOURCE_DIR}/tests/fixtures/exr")
