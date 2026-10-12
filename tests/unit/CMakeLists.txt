# Unit tests (label unit).

add_test(NAME layering
    COMMAND "${CMAKE_COMMAND}" -DSOURCE_DIR=${PROJECT_SOURCE_DIR}
            -P "${PROJECT_SOURCE_DIR}/cmake/scripts/check_layering.cmake")
set_tests_properties(layering PROPERTIES LABELS unit)

add_test(NAME license_policy
    COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_SOURCE_DIR}/license_policy_test.cmake")
set_tests_properties(license_policy PROPERTIES LABELS unit)

pf_add_gtest(pf_test_golden_harness LABEL unit
    SOURCES
        golden_harness/CompareTest.cpp
        golden_harness/DeltaETest.cpp
        golden_harness/ExrFileTest.cpp
        golden_harness/GoldenTest.cpp
    LIBRARIES pf_test_golden)

pf_add_gtest(pf_test_core_image LABEL unit
    SOURCES
        core_image/AlphaTest.cpp
        core_image/ChannelSetTest.cpp
        core_image/ImageTest.cpp
        core_image/InterleavedTest.cpp
        core_image/RectTest.cpp
        core_image/SampleConversionTest.cpp
        core_image/TileTest.cpp
    LIBRARIES pf_core)
