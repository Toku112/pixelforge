# clang-format over our sources (targets format and format-check). Run with cmake -P.
# Inputs (-D): CLANG_FORMAT (executable), SOURCE_DIR (repository root), MODE (fix or check).

cmake_minimum_required(VERSION 3.28)

file(GLOB_RECURSE _files LIST_DIRECTORIES false
     "${SOURCE_DIR}/src/*.h" "${SOURCE_DIR}/src/*.hpp" "${SOURCE_DIR}/src/*.cpp" "${SOURCE_DIR}/src/*.mm"
     "${SOURCE_DIR}/tests/*.h" "${SOURCE_DIR}/tests/*.cpp")
list(FILTER _files EXCLUDE REGEX "/tests/fixtures/")

if(MODE STREQUAL "check")
    set(_args --dry-run --Werror)
else()
    set(_args -i)
endif()

# Batches of files keep the command line short enough for Windows.
set(_failed FALSE)
set(_batch "")
list(LENGTH _files _count)
foreach(_file IN LISTS _files)
    list(APPEND _batch "${_file}")
    list(LENGTH _batch _batch_size)
    if(_batch_size EQUAL 50)
        execute_process(COMMAND "${CLANG_FORMAT}" ${_args} ${_batch} RESULT_VARIABLE _result)
        if(NOT _result EQUAL 0)
            set(_failed TRUE)
        endif()
        set(_batch "")
    endif()
endforeach()
if(_batch)
    execute_process(COMMAND "${CLANG_FORMAT}" ${_args} ${_batch} RESULT_VARIABLE _result)
    if(NOT _result EQUAL 0)
        set(_failed TRUE)
    endif()
endif()

if(_failed)
    message(FATAL_ERROR "clang-format: some files are not formatted (build the 'format' target to fix them)")
endif()
message(STATUS "clang-format (${MODE}): ${_count} files")
