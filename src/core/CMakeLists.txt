# core/ — the pure model (CLAUDE.md §3.1): the C++ standard library and Imath only.

find_package(Imath CONFIG REQUIRED)

add_library(pf_core STATIC
    actions/Action.cpp
    anim/AnimCurve.cpp
    anim/FrameRange.cpp
    commands/Command.cpp
    commands/GraphCommands.cpp
    graph/Evaluation.cpp
    graph/Graph.cpp
    graph/GraphDelta.cpp
    graph/Hash.cpp
    graph/Node.cpp
    graph/NodeDef.cpp
    graph/Param.cpp
    graph/ParamJson.cpp
    history/History.cpp
    image/Alpha.cpp
    image/ChannelSet.cpp
    image/Image.cpp
    image/Interleaved.cpp
    image/Rect.cpp
    image/SampleConversion.cpp
    image/Tile.cpp
    json/Json.cpp)
pf_target_defaults(pf_core)
set_target_properties(pf_core PROPERTIES AUTOMOC OFF)
target_link_libraries(pf_core PRIVATE Imath::Imath)
