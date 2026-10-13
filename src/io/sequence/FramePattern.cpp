#include "io/sequence/FramePattern.h"

#include "io/ImageReader.h"

#include <algorithm>
#include <cstddef>
#include <stdexcept>
#include <utility>

namespace pf::io {
namespace {

bool isDigit(char c) {
    return c >= '0' && c <= '9';
}

// The value of a run of 1–9 ASCII digits.
std::int64_t digitsValue(std::string_view digits) {
    std::int64_t value = 0;
    for (const char c : digits) {
        value = (value * 10) + (c - '0');
    }
    return value;
}

std::string padded(std::int64_t value, int digits) {
    std::string text = std::to_string(value);
    if (std::cmp_less(text.size(), digits)) {
        text.insert(0, static_cast<std::size_t>(digits) - text.size(), '0');
    }
    return text;
}

// '/' everywhere, and '\\' on Windows (on macOS and Linux it is an ordinary character in file names).
bool isSeparator(char c) {
#ifdef _WIN32
    return c == '/' || c == '\\';
#else
    return c == '/';
#endif
}

struct Placeholder {
    std::size_t begin = 0;
    std::size_t end = 0;
    int padding = 0; // more than maxPadding: too long
};

// The last placeholder in a file name.
std::optional<Placeholder> lastPlaceholder(std::string_view name) {
    std::optional<Placeholder> last;
    std::size_t i = 0;
    while (i < name.size()) {
        const char c = name[i];
        if (c == '#' || c == '@') {
            std::size_t j = i;
            while (j < name.size() && name[j] == c) {
                ++j;
            }
            last = Placeholder{.begin = i, .end = j, .padding = static_cast<int>(std::min<std::size_t>(j - i, 99))};
            i = j;
        } else if (c == '%' && i + 1 < name.size() && name[i + 1] == 'd') {
            last = Placeholder{.begin = i, .end = i + 2, .padding = 1};
            i += 2;
        } else if (c == '%' && i + 1 < name.size() && name[i + 1] == '0') {
            std::size_t j = i + 2;
            while (j < name.size() && isDigit(name[j]) && j - (i + 2) < 3) {
                ++j;
            }
            if (j > i + 2 && j < name.size() && name[j] == 'd') {
                const std::int64_t width = digitsValue(name.substr(i + 2, j - (i + 2)));
                if (width >= 1) {
                    last = Placeholder{.begin = i, .end = j + 1, .padding = static_cast<int>(width)};
                    i = j + 1;
                    continue;
                }
            }
            ++i;
        } else {
            ++i;
        }
    }
    return last;
}

} // namespace

std::optional<FrameNumberedName> splitFrameNumber(std::string_view fileName) {
    const std::size_t dot = fileName.rfind('.');
    const std::size_t stemEnd = dot == std::string_view::npos ? fileName.size() : dot;
    std::size_t end = stemEnd;
    while (end > 0 && !isDigit(fileName[end - 1])) {
        --end;
    }
    if (end == 0) {
        return std::nullopt;
    }
    std::size_t begin = end;
    while (begin > 0 && isDigit(fileName[begin - 1])) {
        --begin;
    }
    if (end - begin > static_cast<std::size_t>(maxPadding)) {
        return std::nullopt;
    }
    std::int64_t frame = digitsValue(fileName.substr(begin, end - begin));
    std::size_t prefixEnd = begin;
    if (begin > 0 && fileName[begin - 1] == '-' && frame != 0) {
        const bool atStart = begin == 1;
        const char before = atStart ? '\0' : fileName[begin - 2];
        if (atStart || before == '.' || before == '_' || before == ' ') {
            frame = -frame;
            prefixEnd = begin - 1;
        }
    }
    return FrameNumberedName{.prefix = std::string(fileName.substr(0, prefixEnd)),
                             .frame = frame,
                             .digits = static_cast<int>(end - begin),
                             .suffix = std::string(fileName.substr(end))};
}

FramePattern::FramePattern(std::filesystem::path folder, std::string prefix, int padding, std::string suffix)
    : m_folder(std::move(folder)),
      m_prefix(std::move(prefix)),
      m_padding(padding),
      m_suffix(std::move(suffix)) {
    if (padding < 1 || padding > maxPadding) {
        throw std::invalid_argument("a frame pattern's padding must be 1 to 9 digits, not " + std::to_string(padding));
    }
    for (const std::string* part : {&m_prefix, &m_suffix}) {
        for (const char c : *part) {
            if (isSeparator(c)) {
                throw std::invalid_argument("a frame pattern's file name cannot hold a folder separator");
            }
        }
    }
}

std::optional<FramePattern> FramePattern::parse(std::string_view pathUtf8) {
    const std::filesystem::path path = pathFromUtf8(pathUtf8);
    const std::string name = pathToUtf8(path.filename());
    const std::optional<Placeholder> placeholder = lastPlaceholder(name);
    if (!placeholder || placeholder->padding > maxPadding) {
        return std::nullopt;
    }
    return FramePattern(path.parent_path(), name.substr(0, placeholder->begin), placeholder->padding,
                        name.substr(placeholder->end));
}

std::string FramePattern::fileName(std::int64_t frame) const {
    if (frame < -maxFileFrame || frame > maxFileFrame) {
        throw std::out_of_range("frame " + std::to_string(frame) + " cannot be written in a file name");
    }
    return m_prefix + (frame < 0 ? "-" : "") + padded(frame < 0 ? -frame : frame, m_padding) + m_suffix;
}

std::vector<std::string> FramePattern::fileNames(std::int64_t frame) const {
    std::vector<std::string> names{fileName(frame)};
    if (frame < 0 && m_padding > 1) {
        std::string cStyle = m_prefix + "-" + padded(-frame, m_padding - 1) + m_suffix;
        if (cStyle != names.front()) {
            names.push_back(std::move(cStyle));
        }
    }
    return names;
}

std::optional<std::int64_t> FramePattern::frameOf(std::string_view fileName) const {
    if (fileName.size() <= m_prefix.size() + m_suffix.size() || !fileName.starts_with(m_prefix) ||
        !fileName.ends_with(m_suffix)) {
        return std::nullopt;
    }
    std::string_view middle = fileName.substr(m_prefix.size(), fileName.size() - m_prefix.size() - m_suffix.size());
    const bool negative = middle.front() == '-';
    if (negative) {
        middle.remove_prefix(1);
    }
    if (middle.empty() || middle.size() > static_cast<std::size_t>(maxPadding)) {
        return std::nullopt;
    }
    for (const char c : middle) {
        if (!isDigit(c)) {
            return std::nullopt;
        }
    }
    const std::int64_t value = digitsValue(middle);
    if (negative && value == 0) {
        return std::nullopt; // "-0000" is no frame number
    }
    return negative ? -value : value;
}

std::string FramePattern::fileNameText() const {
    return m_prefix + std::string(static_cast<std::size_t>(m_padding), '#') + m_suffix;
}

std::string FramePattern::text() const {
    return pathToUtf8(m_folder / pathFromUtf8(fileNameText()));
}

} // namespace pf::io
