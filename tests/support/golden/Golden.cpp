#include "support/golden/Golden.h"

#include "support/golden/ExrFile.h"

#include <algorithm>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <string>
#include <system_error>

// Set by tests/support/CMakeLists.txt.
#if !defined(PF_GOLDEN_EXPECTED_ROOT) || !defined(PF_GOLDEN_OUTPUT_ROOT)
#error "PF_GOLDEN_EXPECTED_ROOT and PF_GOLDEN_OUTPUT_ROOT must be defined by the build"
#endif

namespace pf::golden {
namespace {

std::string environmentValue(const char* name) {
#ifdef _WIN32
    char* value = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) {
        return {};
    }
    std::string result(value);
    std::free(value);
    return result;
#else
    // Read while tests run on one thread; nothing in the tests changes the environment.
    const char* value = std::getenv(name); // NOLINT(concurrency-mt-unsafe)
    return value == nullptr ? std::string() : std::string(value);
#endif
}

bool isValidSegment(std::string_view segment) {
    return !segment.empty() && std::ranges::all_of(segment, [](char c) {
        const bool letterOrDigit = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
        return letterOrDigit || c == '_' || c == '-';
    });
}

// The build passes the folders as UTF-8 string literals (MSVC compiles with /utf-8).
std::filesystem::path pathFromUtf8(std::string_view text) {
    return {std::u8string(text.begin(), text.end())};
}

std::string utf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return {text.begin(), text.end()};
}

std::string indented(const std::string& text) {
    std::string result = "  ";
    for (const char c : text) {
        result += c;
        if (c == '\n') {
            result += "  ";
        }
    }
    return result;
}

} // namespace

GoldenSettings defaultGoldenSettings() {
    return {.expectedRoot = pathFromUtf8(PF_GOLDEN_EXPECTED_ROOT),
            .outputRoot = pathFromUtf8(PF_GOLDEN_OUTPUT_ROOT),
            .update = environmentValue("PF_GOLDEN_UPDATE") == "1"};
}

::testing::AssertionResult matchesGolden(const Image& actual, std::string_view caseId, const CompareOptions& options,
                                         const GoldenSettings& settings) {
    const std::size_t slash = caseId.find('/');
    if (slash == std::string_view::npos || !isValidSegment(caseId.substr(0, slash)) ||
        !isValidSegment(caseId.substr(slash + 1))) {
        return ::testing::AssertionFailure() << "invalid golden case id '" << caseId
                                             << "': expected \"<feature>/<case>\" (letters, digits, '_', '-')";
    }
    const std::string feature(caseId.substr(0, slash));
    const std::string name(caseId.substr(slash + 1));
    const std::filesystem::path expectedPath = settings.expectedRoot / feature / (name + ".expected.exr");
    const std::filesystem::path actualPath = settings.outputRoot / feature / (name + ".actual.exr");
    const std::filesystem::path differencePath = settings.outputRoot / feature / (name + ".diff.exr");

    // Output from an earlier run is removed, so the output folder only ever shows current failures.
    std::error_code ignored;
    std::filesystem::remove(actualPath, ignored);
    std::filesystem::remove(differencePath, ignored);

    try {
        if (!std::filesystem::exists(expectedPath)) {
            if (settings.update) {
                writeExr(expectedPath, actual);
                std::cout << "[golden] created " << utf8(expectedPath) << '\n';
                return ::testing::AssertionSuccess();
            }
            writeExr(actualPath, actual);
            return ::testing::AssertionFailure()
                   << "golden " << caseId << ": there is no expected image " << utf8(expectedPath)
                   << "\n  actual image: " << utf8(actualPath)
                   << "\n  if the actual image is right, build the update-golden target to make it the expected one";
        }

        const CompareResult result = compare(actual, readExr(expectedPath), options);
        if (result.passed) {
            return ::testing::AssertionSuccess();
        }
        if (settings.update) {
            writeExr(expectedPath, actual);
            std::cout << "[golden] updated " << utf8(expectedPath) << '\n';
            return ::testing::AssertionSuccess();
        }

        writeExr(actualPath, actual);
        ::testing::AssertionResult failure = ::testing::AssertionFailure();
        failure << "golden " << caseId << " differs from " << utf8(expectedPath) << ":\n"
                << indented(result.describe()) << "\n  actual image: " << utf8(actualPath);
        if (result.difference) {
            writeExr(differencePath, *result.difference);
            failure << "\n  difference image: " << utf8(differencePath);
        }
        return failure;
    } catch (const std::exception& error) {
        return ::testing::AssertionFailure() << "golden " << caseId << ": " << error.what();
    }
}

} // namespace pf::golden
