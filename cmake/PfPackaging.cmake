# Install rules and the package target (CPack): a .dmg with the .app on macOS, a .zip on Windows, a .tar.gz on
# Linux. Qt's libraries and plugins are copied next to the app by Qt's own deployment tool (macdeployqt/windeployqt),
# so Qt stays dynamically linked (LGPL, CLAUDE.md §1.2). Signing, notarising and installers come later (PLAN Part C
# item 16, Phase 15).

include(GNUInstallDirs)

install(TARGETS pf_app
    BUNDLE DESTINATION .
    RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")

qt_generate_deploy_app_script(TARGET pf_app OUTPUT_SCRIPT _pf_deploy_script NO_UNSUPPORTED_PLATFORM_ERROR)
install(SCRIPT "${_pf_deploy_script}")

# Licence texts of every shipped vcpkg port go into the package (most of them require it in binary distributions).
if(APPLE)
    set(_pf_licenses_dir "${PF_APP_NAME}.app/Contents/Resources/ThirdPartyLicenses")
else()
    set(_pf_licenses_dir "${CMAKE_INSTALL_DATADIR}/${PF_APP_NAME}/ThirdPartyLicenses")
endif()
install(CODE "
    include(\"${PROJECT_SOURCE_DIR}/cmake/LicensePolicy.cmake\")
    file(GLOB _pf_copyrights \"${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/share/*/copyright\")
    set(_pf_dest \"\$ENV{DESTDIR}\${CMAKE_INSTALL_PREFIX}/${_pf_licenses_dir}\")
    foreach(_pf_file IN LISTS _pf_copyrights)
        get_filename_component(_pf_port_dir \"\${_pf_file}\" DIRECTORY)
        get_filename_component(_pf_port \"\${_pf_port_dir}\" NAME)
        if(NOT _pf_port IN_LIST PF_BUILD_ONLY_PORTS)
            file(MAKE_DIRECTORY \"\${_pf_dest}\")
            file(COPY_FILE \"\${_pf_file}\" \"\${_pf_dest}/\${_pf_port}.txt\")
        endif()
    endforeach()
")

if(APPLE)
    # Deployment rewrites library paths inside the bundle, which invalidates the linker's ad-hoc signature; Apple
    # Silicon refuses to start unsigned code, so sign the finished bundle again (ad hoc, for local use only).
    install(CODE "
        execute_process(COMMAND codesign --force --deep --sign - \"\$ENV{DESTDIR}\${CMAKE_INSTALL_PREFIX}/${PF_APP_NAME}.app\"
                        RESULT_VARIABLE _pf_sign_result)
        if(NOT _pf_sign_result EQUAL 0)
            message(FATAL_ERROR \"codesign failed\")
        endif()
    ")
endif()

set(CPACK_PACKAGE_NAME "${PF_APP_NAME}")
set(CPACK_PACKAGE_VENDOR "${PF_APP_NAME}")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_FILE_NAME "${PF_APP_NAME}-${PROJECT_VERSION}-${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}")
set(CPACK_PACKAGE_DIRECTORY "${PROJECT_BINARY_DIR}/package")
set(CPACK_STRIP_FILES ON)
if(APPLE)
    set(CPACK_GENERATOR DragNDrop)
elseif(WIN32)
    set(CPACK_GENERATOR ZIP)
else()
    set(CPACK_GENERATOR TGZ)
endif()
include(CPack)
