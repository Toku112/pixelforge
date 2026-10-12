# Licence check (targets check-licenses and update-third-party). Run with cmake -P.
#
# For every vcpkg port installed for the target triplet it reads the port's licence (the SPDX expression vcpkg records
# in share/<port>/vcpkg.spdx.json) and the licence text (share/<port>/copyright), then:
#   1. fails when the licence is not allowed by cmake/LicensePolicy.cmake ("A OR B" passes when one side is allowed,
#      "A AND B" only when both are);
#   2. fails when a shipped port has no licence text;
#   3. fails when the port's row in the generated table of docs/THIRD_PARTY.md is missing or out of date
#      (UPDATE=ON rewrites those rows instead; rows of ports not installed on this platform are kept);
#   4. fails when the app links a Qt module that is not in PF_QT_LGPL_MODULES.
#
# Inputs (-D): INSTALLED_DIR (vcpkg installed tree), TRIPLET, THIRD_PARTY_MD, QT_COMPONENTS (comma-separated),
# UPDATE (optional, ON/OFF).

cmake_minimum_required(VERSION 3.28)
include("${CMAKE_CURRENT_LIST_DIR}/../LicensePolicy.cmake")

foreach(_var IN ITEMS INSTALLED_DIR TRIPLET THIRD_PARTY_MD QT_COMPONENTS)
    if(NOT DEFINED ${_var})
        message(FATAL_ERROR "check_licenses.cmake: -D${_var}=... is required")
    endif()
endforeach()

set(_begin_marker "<!-- BEGIN vcpkg-ports")
set(_end_marker "<!-- END vcpkg-ports -->")
set(_errors "")

# Records one error message; the arguments are concatenated without separators.
macro(pf_error)
    string(CONCAT _pf_message ${ARGN})
    list(APPEND _errors "${_pf_message}")
endmacro()

include("${CMAKE_CURRENT_LIST_DIR}/spdx.cmake")

# ---- Installed ports --------------------------------------------------------------------------------------------

set(_share_dir "${INSTALLED_DIR}/${TRIPLET}/share")
file(GLOB _spdx_files LIST_DIRECTORIES false "${_share_dir}/*/vcpkg.spdx.json")
if(NOT _spdx_files)
    message(FATAL_ERROR "No vcpkg ports found in ${_share_dir} (configure the build first)")
endif()

set(_ports "")
foreach(_spdx_file IN LISTS _spdx_files)
    get_filename_component(_port_dir "${_spdx_file}" DIRECTORY)
    get_filename_component(_port "${_port_dir}" NAME)
    file(READ "${_spdx_file}" _json)
    string(JSON _package_count LENGTH "${_json}" packages)
    math(EXPR _last "${_package_count} - 1")
    set(_version "")
    foreach(_i RANGE ${_last})
        string(JSON _id GET "${_json}" packages ${_i} SPDXID)
        if(_id STREQUAL "SPDXRef-port")
            string(JSON _version GET "${_json}" packages ${_i} versionInfo)
            string(JSON _license GET "${_json}" packages ${_i} licenseConcluded)
            string(JSON _homepage ERROR_VARIABLE _no_homepage GET "${_json}" packages ${_i} homepage)
            if(_no_homepage)
                set(_homepage "")
            endif()
        endif()
    endforeach()
    if(_version STREQUAL "")
        pf_error("${_port}: no port entry in ${_spdx_file}")
        continue()
    endif()

    if(_port IN_LIST PF_BUILD_ONLY_PORTS)
        set(_ships "no (build/tests only)")
    else()
        set(_ships "yes")
    endif()

    pf_spdx_allowed("${_license}" _ok)
    if(NOT _ok)
        pf_error("${_port} ${_version}: licence '${_license}' is not allowed by cmake/LicensePolicy.cmake "
                            "(CLAUDE.md §1.2: ask the owner before adding it)")
    endif()
    if(_ships STREQUAL "yes" AND NOT EXISTS "${_port_dir}/copyright")
        pf_error("${_port}: no licence text (${_port_dir}/copyright)")
    endif()

    list(APPEND _ports "${_port}")
    set(_row_${_port} "| ${_port} | ${_version} | ${_license} | ${_ships} | ${_homepage} |")
endforeach()

# ---- docs/THIRD_PARTY.md table ----------------------------------------------------------------------------------

file(READ "${THIRD_PARTY_MD}" _md)
string(FIND "${_md}" "${_begin_marker}" _begin)
string(FIND "${_md}" "${_end_marker}" _end)
if(_begin EQUAL -1 OR _end EQUAL -1 OR _end LESS _begin)
    message(FATAL_ERROR "${THIRD_PARTY_MD}: the generated table markers '${_begin_marker} ...' and '${_end_marker}' "
                        "are missing")
endif()
string(SUBSTRING "${_md}" ${_begin} -1 _from_begin)
string(FIND "${_from_begin}" "\n" _begin_line_len)
math(EXPR _table_start "${_begin} + ${_begin_line_len} + 1")
math(EXPR _table_len "${_end} - ${_table_start}")
string(SUBSTRING "${_md}" ${_table_start} ${_table_len} _table)

# Existing rows by port name (header and separator rows skipped).
set(_listed_ports "")
string(REPLACE "\n" ";" _table_lines "${_table}")
foreach(_line IN LISTS _table_lines)
    if(_line MATCHES "^\\| *([A-Za-z0-9][A-Za-z0-9._+-]*) *\\|" AND NOT CMAKE_MATCH_1 STREQUAL "Port")
        set(_listed_${CMAKE_MATCH_1} "${_line}")
        list(APPEND _listed_ports "${CMAKE_MATCH_1}")
    endif()
endforeach()

if(UPDATE)
    set(_all_ports ${_listed_ports} ${_ports})
    list(REMOVE_DUPLICATES _all_ports)
    list(SORT _all_ports CASE INSENSITIVE)
    set(_new_table "| Port | Version | Licence (SPDX) | Ships | Homepage |\n|---|---|---|---|---|\n")
    foreach(_port IN LISTS _all_ports)
        if(DEFINED _row_${_port})
            string(APPEND _new_table "${_row_${_port}}\n")
        else()
            string(APPEND _new_table "${_listed_${_port}}\n")
        endif()
    endforeach()
    string(SUBSTRING "${_md}" 0 ${_table_start} _head)
    string(SUBSTRING "${_md}" ${_end} -1 _tail)
    file(WRITE "${THIRD_PARTY_MD}" "${_head}${_new_table}${_tail}")
    message(STATUS "update-third-party: wrote the vcpkg port table of ${THIRD_PARTY_MD}")
else()
    foreach(_port IN LISTS _ports)
        if(NOT DEFINED _listed_${_port})
            pf_error("${_port}: not listed in ${THIRD_PARTY_MD} — add this row (or build update-third-party):\n"
                                "    ${_row_${_port}}")
        elseif(NOT _listed_${_port} STREQUAL _row_${_port})
            pf_error("${_port}: row in ${THIRD_PARTY_MD} is out of date — expected (or build update-third-party):\n"
                                "    ${_row_${_port}}")
        endif()
    endforeach()
endif()

# ---- Qt modules -------------------------------------------------------------------------------------------------

string(REPLACE "," ";" _qt_components "${QT_COMPONENTS}")
foreach(_module IN LISTS _qt_components)
    if(NOT _module IN_LIST PF_QT_LGPL_MODULES)
        pf_error("Qt module '${_module}' is not in PF_QT_LGPL_MODULES (check that it is available under "
                            "LGPL-3.0 before adding it)")
    endif()
endforeach()

# ---- Result -----------------------------------------------------------------------------------------------------

list(LENGTH _ports _port_count)
if(_errors)
    list(JOIN _errors "\n  - " _error_text)
    message(FATAL_ERROR "check-licenses failed (${TRIPLET}):\n  - ${_error_text}")
endif()
if(NOT UPDATE)
    message(STATUS "check-licenses: ${_port_count} vcpkg ports (${TRIPLET}) allowed and listed in THIRD_PARTY.md; "
                   "Qt modules ${QT_COMPONENTS} are LGPL-3.0")
endif()
