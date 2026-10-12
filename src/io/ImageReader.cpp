#include "io/ImageReader.h"

#include <algorithm>
#include <cctype>
#include <system_error>
#include <utility>

namespace pf::io {
namespace {

std::string lowerCase(std::string text) {
    std::ranges::transform(text, text.begin(),
                           [](char c) { return static_cast<char>(std::tolower(static_cast<unsigned char>(c))); });
    return text;
}

// "exr" for "/renders/beauty.0001.EXR".
std::string extensionOf(const std::filesystem::path& file) {
    std::string extension = pathToUtf8(file.extension());
    if (!extension.empty() && extension.front() == '.') {
        extension.erase(0, 1);
    }
    return lowerCase(std::move(extension));
}

} // namespace

void FormatRegistry::add(ImageFormat format) {
    if (format.name.empty() || format.extensions.empty() || !format.open) {
        throw std::invalid_argument("an image format needs a name, extensions and an open function");
    }
    for (std::string& extension : format.extensions) {
        extension = lowerCase(extension);
        for (const ImageFormat& existing : m_formats) {
            if (std::ranges::find(existing.extensions, extension) != existing.extensions.end()) {
                throw std::invalid_argument("the extension ." + extension + " belongs to " + existing.name +
                                            " already");
            }
        }
    }
    m_formats.push_back(std::move(format));
}

const ImageFormat* FormatRegistry::formatFor(const std::filesystem::path& file) const {
    const std::string extension = extensionOf(file);
    for (const ImageFormat& format : m_formats) {
        if (std::ranges::find(format.extensions, extension) != format.extensions.end()) {
            return &format;
        }
    }
    return nullptr;
}

std::unique_ptr<ImageReader> FormatRegistry::open(const std::filesystem::path& file) const {
    const std::string name = pathToUtf8(file);
    std::error_code error;
    if (!std::filesystem::is_regular_file(file, error)) {
        throw FileError("cannot open " + name + ": " +
                        (std::filesystem::exists(file, error) ? "it is not a file" : "the file does not exist"));
    }
    const ImageFormat* format = formatFor(file);
    if (format == nullptr) {
        throw FileError("cannot open " + name + ": no image format reads ." + extensionOf(file) + " files");
    }
    return format->open(file);
}

std::filesystem::path pathFromUtf8(std::string_view utf8) {
    return {std::u8string(utf8.begin(), utf8.end())};
}

std::string pathToUtf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return {text.begin(), text.end()};
}

} // namespace pf::io
