# Licence policy (CLAUDE.md §1.2, D-064), read by cmake/scripts/check_licenses.cmake (target check-licenses).
# Changing anything here needs the owner's approval for licences outside the default list; record it in
# docs/DECISIONS.md.

# SPDX identifiers allowed for anything we ship. MPL-2.0 only as a separate, unmodified module. CC0-1.0 and 0BSD
# (public-domain style, no conditions) approved by the owner on 2026-10-12 (D-071).
set(PF_ALLOWED_LICENSES
    MIT
    BSD-2-Clause
    BSD-3-Clause
    Apache-2.0
    ISC
    Zlib
    BSL-1.0
    MPL-2.0
    CC0-1.0
    0BSD)

# SPDX licence exceptions ("<licence> WITH <exception>") that only grant extra permissions.
set(PF_ALLOWED_LICENSE_EXCEPTIONS LLVM-exception)

# LGPL is allowed only for owner-approved components, dynamically linked. Qt comes from the official binaries (not
# vcpkg); FFmpeg (approved, D-064) gets a dynamic-linkage check here when it is added in Phase 1. Until then any LGPL
# vcpkg port fails the check.

# vcpkg ports used only to build or test, never shipped. They are still listed in docs/THIRD_PARTY.md.
set(PF_BUILD_ONLY_PORTS gtest)

# Qt modules the app may link: each one checked to be available under LGPL-3.0. Some Qt modules are GPL-only
# (e.g. Charts, Data Visualization, Graphs, Quick 3D, Virtual Keyboard) and must never be added.
set(PF_QT_LGPL_MODULES Core Gui Widgets)
