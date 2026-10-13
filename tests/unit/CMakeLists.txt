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

pf_add_gtest(pf_test_core_graph LABEL unit
    SOURCES
        core_anim/AnimCurveTest.cpp
        core_graph/GraphDeltaTest.cpp
        core_graph/GraphTest.cpp
        core_graph/ParamJsonTest.cpp
        core_graph/ParamTest.cpp
    LIBRARIES pf_test_graph_types)

pf_add_gtest(pf_test_core_json LABEL unit
    SOURCES
        core_json/JsonTest.cpp
    LIBRARIES pf_core)

pf_add_gtest(pf_test_core_commands LABEL unit
    SOURCES
        core_actions/ActionTest.cpp
        core_commands/GraphCommandsTest.cpp
        core_history/HistoryTest.cpp
    LIBRARIES pf_test_graph_types)

pf_add_gtest(pf_test_engine LABEL unit
    SOURCES
        engine/CancellationTest.cpp
        engine/EngineTest.cpp
        engine/EvaluatorTest.cpp
        engine/MemoryBudgetTest.cpp
        engine/ProgressTest.cpp
        engine/SchedulerTest.cpp
        engine/TilePoolTest.cpp
    LIBRARIES pf_engine)

pf_add_gtest(pf_test_io LABEL unit
    SOURCES
        io/ImageReaderTest.cpp
    LIBRARIES pf_test_node_bench)

pf_add_gtest(pf_test_nodes LABEL unit
    SOURCES
        nodes/ActionReplayTest.cpp
        nodes/ExposureTest.cpp
        nodes/ReadTest.cpp
        nodes/ShuffleTest.cpp
        nodes/ViewerTest.cpp
    LIBRARIES pf_test_node_bench pf_test_graph_types)
