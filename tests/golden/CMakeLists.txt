# Golden-image tests (label golden). Expected images live next to their tests: <feature>/<case>.expected.exr.

pf_add_gtest(pf_test_golden_selftest LABEL golden
    SOURCES harness/HarnessGoldenTest.cpp
    LIBRARIES pf_test_golden)

pf_add_gtest(pf_test_golden_exposure LABEL golden
    SOURCES exposure/ExposureGoldenTest.cpp
    LIBRARIES pf_test_node_bench)
