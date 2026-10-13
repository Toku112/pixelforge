# io/ — files (CLAUDE.md §3.1): the image format registry, file stamps, metadata, image sequences (PLAN item 10) and
# the formats: OpenEXR (item 9) on OpenEXR's low-level library; OpenImageIO's formats come later. Uses core; no Qt.

find_package(OpenEXR CONFIG REQUIRED)

add_library(pf_io STATIC
    FileStamp.cpp
    Formats.cpp
    ImageReader.cpp
    Metadata.cpp
    exr/ExrMetadata.cpp
    exr/ExrNaming.cpp
    exr/ExrReader.cpp
    sequence/FramePattern.cpp
    sequence/Sequence.cpp
    sequence/SequenceIndex.cpp)
pf_target_defaults(pf_io)
set_target_properties(pf_io PROPERTIES AUTOMOC OFF)
target_link_libraries(pf_io
    PUBLIC pf_core
    PRIVATE OpenEXR::OpenEXRCore)
