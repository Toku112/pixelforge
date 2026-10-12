# io/ — files (CLAUDE.md §3.1): the image format registry and file stamps; formats arrive with PLAN items 9–10 and
# later phases. Uses core; no Qt.

add_library(pf_io STATIC
    FileStamp.cpp
    ImageReader.cpp)
pf_target_defaults(pf_io)
set_target_properties(pf_io PROPERTIES AUTOMOC OFF)
target_link_libraries(pf_io PUBLIC pf_core)
