# One subdirectory per layer (CLAUDE.md §3.1). A layer gets its CMakeLists.txt and library target when its first
# code arrives; each target links only the layers it may depend on (checked by the "layering" test).

add_subdirectory(app)
