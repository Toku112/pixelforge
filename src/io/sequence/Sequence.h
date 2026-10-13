#pragma once

// The files of a frame pattern on disk (docs/specs/sequences.md §3–5, FORMAT_NOTES §23.2–23.4): which frames exist,
// the gaps between them, the sequence a picked file belongs to, the sequences in a folder, and snapshots with file
// stamps that show what changed (groundwork for live linking, PLAN B0.2). Every function that lists a folder reads
// the file system: never on the UI thread.

#include "core/anim/FrameRange.h"
#include "io/FileStamp.h"
#include "io/sequence/FramePattern.h"

#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace pf::io {

struct SequenceFile {
    std::int64_t frame = 0;
    std::string name; // the file name (UTF-8), as written on disk
    FileStamp stamp;  // filled only by scans asked for stamps

    friend bool operator==(const SequenceFile&, const SequenceFile&) = default;
};

class Sequence {
public:
    // Sorts `files` by frame. Where two files have the same frame (written with different padding), the one spelled
    // as the pattern writes it is kept, else the first by name.
    Sequence(FramePattern pattern, std::vector<SequenceFile> files);

    [[nodiscard]] const FramePattern& pattern() const { return m_pattern; }
    // One file per frame, ascending.
    [[nodiscard]] std::span<const SequenceFile> files() const { return m_files; }
    [[nodiscard]] bool empty() const { return m_files.empty(); }
    // The first to the last frame that exists; nullopt when there is none.
    [[nodiscard]] std::optional<anim::FrameRange> range() const;

    // The file of `frame`, or null.
    [[nodiscard]] const SequenceFile* find(std::int64_t frame) const;
    // The file of the nearest frame before / after `frame`, or null.
    [[nodiscard]] const SequenceFile* before(std::int64_t frame) const;
    [[nodiscard]] const SequenceFile* after(std::int64_t frame) const;
    // The file of the frame nearest to `frame` (`frame` itself when it exists; the earlier one of two equally near),
    // or null when the sequence is empty.
    [[nodiscard]] const SequenceFile* nearest(std::int64_t frame) const;
    // The frames of `range` without a file, as runs (for "Missing: 7, 12–14").
    [[nodiscard]] std::vector<anim::FrameRange> missing(const anim::FrameRange& range) const;

    // Where a file of the sequence is.
    [[nodiscard]] std::filesystem::path path(const SequenceFile& file) const;

private:
    FramePattern m_pattern;
    std::vector<SequenceFile> m_files;
};

struct ScanOptions {
    bool stamps = false; // also read each file's size and modification time (one more file system call per file)
};

// The files of `pattern` that exist now: one listing of its folder. Throws FileError when the folder does not exist
// or cannot be listed.
[[nodiscard]] Sequence scanSequence(const FramePattern& pattern, const ScanOptions& options = {});

// The sequence `file` belongs to: the files in its folder whose names differ from it only in the frame number
// (§23.2), with the padding they use. nullopt when the name holds no frame number or no other file shares it (a
// still image). Throws FileError when the folder cannot be listed.
[[nodiscard]] std::optional<Sequence> detectSequence(const std::filesystem::path& file);

// What a folder holds: its sequences (two or more files of one pattern) and its other files. Hidden files (names
// starting with '.') and subfolders are left out.
struct FolderContents {
    std::vector<Sequence> sequences; // ordered by their pattern's file name
    std::vector<std::string> files;  // file names (UTF-8), ordered
};
// Throws FileError when the folder does not exist or cannot be listed.
[[nodiscard]] FolderContents scanFolder(const std::filesystem::path& folder);

// What changed between two scans (with stamps) of the same pattern.
struct SequenceChanges {
    std::vector<std::int64_t> added;   // frames that have a file now and had none
    std::vector<std::int64_t> removed; // frames whose file is gone
    std::vector<std::int64_t> changed; // frames whose file was rewritten or replaced (another stamp or name)

    [[nodiscard]] bool empty() const { return added.empty() && removed.empty() && changed.empty(); }
    friend bool operator==(const SequenceChanges&, const SequenceChanges&) = default;
};
[[nodiscard]] SequenceChanges compare(const Sequence& before, const Sequence& after);

} // namespace pf::io
