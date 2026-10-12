#pragma once

// The product's name and identifiers. "PixelForge" is a working title: to rename the app, change it here only
// (CLAUDE.md §1). CMake reads these two lines too (cmake/PfBrand.cmake), so keep each value a plain string literal
// on one line. Never use another vendor's product names here (CLAUDE.md §1.2).

#include <string_view>

namespace pf {

inline constexpr std::string_view APP_NAME = "PixelForge";

// Reverse-DNS identifier: macOS bundle identifier, settings location.
inline constexpr std::string_view APP_BUNDLE_ID = "org.pixelforge.app";

} // namespace pf
