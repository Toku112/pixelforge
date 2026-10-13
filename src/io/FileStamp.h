#pragma once

// A file's size and modification time: when either changes, the file was rewritten (a renderer wrote the frame
// again), so cached results that came from it are stale. The Read node puts the stamp into its hash; live file
// linking (PLAN B0.2) builds on it.

#include <cstdint>
#include <filesystem>

namespace pf::io {

struct FileStamp {
    bool exists = false;
    std::uintmax_t size = 0;
    // Modification time in the file system's clock ticks. File systems differ in precision (APFS, NTFS and ext4
    // record fractions of a second, older ones whole seconds); a rewrite in the same tick is caught by the size.
    std::int64_t modified = 0;

    friend bool operator==(const FileStamp&, const FileStamp&) = default;
};

// The stamp of `file`; {exists = false} when it does not exist or cannot be examined. Reads the file system, so
// never on the UI thread.
[[nodiscard]] FileStamp fileStamp(const std::filesystem::path& file) noexcept;

// The stamp of a folder: its modification time, which changes when files are added to it, removed from it or renamed
// in it (not when a file's contents change); size 0. {exists = false} when `folder` is not a folder or cannot be
// examined. Never on the UI thread.
[[nodiscard]] FileStamp folderStamp(const std::filesystem::path& folder) noexcept;

} // namespace pf::io
