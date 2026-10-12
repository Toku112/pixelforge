# nodes/ — node types (CLAUDE.md §3.1): one folder per type with its parameters and CPU reference implementation.
# UI-agnostic: no Qt.

add_library(pf_nodes STATIC
    Builtins.cpp
    exposure/ExposureNode.cpp
    read/ReadNode.cpp
    shuffle/ShuffleNode.cpp
    viewer/ViewerNode.cpp)
pf_target_defaults(pf_nodes)
set_target_properties(pf_nodes PROPERTIES AUTOMOC OFF)
target_link_libraries(pf_nodes PUBLIC pf_core pf_io)
