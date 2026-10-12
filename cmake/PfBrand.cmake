# Reads the product name and bundle identifier from src/app/Brand.h, the only place they are written (CLAUDE.md §1).
# Sets PF_APP_NAME and PF_APP_BUNDLE_ID.

set(_pf_brand_header "${CMAKE_CURRENT_LIST_DIR}/../src/app/Brand.h")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_pf_brand_header}")

foreach(_pf_key IN ITEMS APP_NAME APP_BUNDLE_ID)
    file(STRINGS "${_pf_brand_header}" _pf_line REGEX "std::string_view ${_pf_key} = \"[^\"]+\";")
    if(NOT _pf_line MATCHES "${_pf_key} = \"([^\"]+)\"")
        message(FATAL_ERROR "${_pf_key} not found in ${_pf_brand_header} (expected: std::string_view ${_pf_key} = \"...\";)")
    endif()
    set(PF_${_pf_key} "${CMAKE_MATCH_1}")
endforeach()
