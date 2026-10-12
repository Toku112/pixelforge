cmake_minimum_required(VERSION 3.28)
project(pixelforge_tile_size_spike LANGUAGES CXX)

# Throw-away measurement (PLAN Part C item 5). Never linked into the app. Uses the oneTBB the main build installed.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(TBB CONFIG REQUIRED)
add_executable(tile_bench tile_bench.cpp)
target_link_libraries(tile_bench PRIVATE TBB::tbb)
