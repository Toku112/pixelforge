#include "io/FileStamp.h"

#include <system_error>

namespace pf::io {

FileStamp fileStamp(const std::filesystem::path& file) noexcept {
    std::error_code error;
    if (!std::filesystem::is_regular_file(file, error)) {
        return {};
    }
    const std::uintmax_t size = std::filesystem::file_size(file, error);
    if (error) {
        return {};
    }
    const std::filesystem::file_time_type modified = std::filesystem::last_write_time(file, error);
    if (error) {
        return {};
    }
    return {.exists = true, .size = size, .modified = static_cast<std::int64_t>(modified.time_since_epoch().count())};
}

FileStamp folderStamp(const std::filesystem::path& folder) noexcept {
    std::error_code error;
    if (!std::filesystem::is_directory(folder, error)) {
        return {};
    }
    const std::filesystem::file_time_type modified = std::filesystem::last_write_time(folder, error);
    if (error) {
        return {};
    }
    return {.exists = true, .size = 0, .modified = static_cast<std::int64_t>(modified.time_since_epoch().count())};
}

} // namespace pf::io
