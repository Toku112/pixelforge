# Qt comes from the official binaries (D-059), pinned to one version (D-068). It is not a vcpkg dependency.
#
# PF_QT_ROOT is the Qt install prefix, e.g. ~/Qt/6.11.3/macos. It defaults to the aqtinstall locations of README.md
# and can be overridden on the command line (-DPF_QT_ROOT=...) or with the PF_QT_ROOT environment variable.

set(PF_QT_VERSION 6.11.3)

# Qt modules the app links. Each one must be available under LGPL-3.0 (checked by check-licenses against
# PF_QT_LGPL_MODULES in cmake/LicensePolicy.cmake); add new ones there only after checking their licence.
set(PF_QT_COMPONENTS Core Gui Widgets)

if(DEFINED ENV{PF_QT_ROOT})
    set(_pf_qt_default "$ENV{PF_QT_ROOT}")
elseif(APPLE)
    set(_pf_qt_default "$ENV{HOME}/Qt/${PF_QT_VERSION}/macos")
elseif(WIN32)
    set(_pf_qt_default "C:/Qt/${PF_QT_VERSION}/msvc2022_64")
else()
    set(_pf_qt_default "$ENV{HOME}/Qt/${PF_QT_VERSION}/gcc_64")
endif()
set(PF_QT_ROOT "${_pf_qt_default}" CACHE PATH "Qt ${PF_QT_VERSION} install prefix")

if(NOT EXISTS "${PF_QT_ROOT}/lib/cmake/Qt6/Qt6Config.cmake")
    message(FATAL_ERROR "Qt ${PF_QT_VERSION} not found in '${PF_QT_ROOT}'. Install it as described in README.md, "
                        "or pass -DPF_QT_ROOT=<Qt install prefix>.")
endif()
list(PREPEND CMAKE_PREFIX_PATH "${PF_QT_ROOT}")

find_package(Qt6 ${PF_QT_VERSION} EXACT REQUIRED COMPONENTS ${PF_QT_COMPONENTS})
qt_standard_project_setup()
