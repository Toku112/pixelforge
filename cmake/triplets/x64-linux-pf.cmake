# Linux x64: like vcpkg's x64-linux (static libraries). A triplet of our own keeps target libraries apart from
# vcpkg's build tools (host triplet x64-linux), so check-licenses sees only what ships.
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)
