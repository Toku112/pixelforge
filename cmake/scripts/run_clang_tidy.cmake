# clang-tidy over our sources (target tidy), using the build's compile_commands.json. Run with cmake -P.
# Inputs (-D): CLANG_TIDY (executable), RUN_CLANG_TIDY (optional: LLVM's parallel runner script), BUILD_DIR,
# SOURCE_DIR.

cmake_minimum_required(VERSION 3.28)

set(_db "${BUILD_DIR}/compile_commands.json")
if(NOT EXISTS "${_db}")
    message(FATAL_ERROR "${_db} not found (configure with CMAKE_EXPORT_COMPILE_COMMANDS=ON, as the presets do)")
endif()

# Our sources only: generated files (moc) and third-party code live outside src/ and tests/.
set(_our_files "^${SOURCE_DIR}/(src|tests)/")

if(RUN_CLANG_TIDY)
    cmake_host_system_information(RESULT _jobs QUERY NUMBER_OF_LOGICAL_CORES)
    execute_process(COMMAND "${RUN_CLANG_TIDY}" -p "${BUILD_DIR}" -clang-tidy-binary "${CLANG_TIDY}" -quiet -j ${_jobs}
                            "${_our_files}"
                    RESULT_VARIABLE _result)
    if(NOT _result EQUAL 0)
        message(FATAL_ERROR "clang-tidy found problems")
    endif()
    return()
endif()

file(READ "${_db}" _json)
string(JSON _count LENGTH "${_json}")
set(_files "")
if(_count GREATER 0)
    math(EXPR _last "${_count} - 1")
    foreach(_i RANGE ${_last})
        string(JSON _file GET "${_json}" ${_i} file)
        file(TO_CMAKE_PATH "${_file}" _file)
        if(_file MATCHES "${_our_files}")
            list(APPEND _files "${_file}")
        endif()
    endforeach()
endif()
list(REMOVE_DUPLICATES _files)

set(_failed "")
foreach(_file IN LISTS _files)
    execute_process(COMMAND "${CLANG_TIDY}" -p "${BUILD_DIR}" --quiet "${_file}" RESULT_VARIABLE _result)
    if(NOT _result EQUAL 0)
        list(APPEND _failed "${_file}")
    endif()
endforeach()
list(LENGTH _files _file_count)
if(_failed)
    list(JOIN _failed "\n  " _failed_text)
    message(FATAL_ERROR "clang-tidy found problems in:\n  ${_failed_text}")
endif()
message(STATUS "clang-tidy: ${_file_count} files clean")
