#include "io/sequence/Sequence.h"

#include "io/ImageReader.h"

#include <algorithm>
#include <cstddef>
#include <iterator>
#include <map>
#include <system_error>
#include <utility>

namespace pf::io {
namespace {

// A regular file in a listed folder.
struct ListedFile {
    std::string name; // UTF-8
    std::filesystem::path path;
};

// The regular files in `folder` ("" is the current folder). Throws FileError when it cannot be listed.
std::vector<ListedFile> listFiles(const std::filesystem::path& folder) {
    const std::filesystem::path where = folder.empty() ? std::filesystem::path(".") : folder;
    const auto fail = [&](const std::string& why) {
        return FileError("cannot read the folder " + pathToUtf8(where) + ": " + why);
    };
    std::error_code error;
    if (!std::filesystem::exists(where, error)) {
        throw fail("it does not exist");
    }
    if (!std::filesystem::is_directory(where, error)) {
        throw fail("it is not a folder");
    }
    std::vector<ListedFile> files;
    std::filesystem::directory_iterator entry(where, std::filesystem::directory_options::skip_permission_denied, error);
    if (error) {
        throw fail(error.message());
    }
    for (; entry != std::filesystem::directory_iterator(); entry.increment(error)) {
        if (error) {
            throw fail(error.message());
        }
        std::error_code typeError;
        if (entry->is_regular_file(typeError)) {
            files.push_back({.name = pathToUtf8(entry->path().filename()), .path = entry->path()});
        }
    }
    if (error) {
        throw fail(error.message());
    }
    return files;
}

// Digits a file's name uses for its frame number (without the minus sign).
int writtenDigits(const SequenceFile& file, const std::string& prefix, const std::string& suffix) {
    return static_cast<int>(file.name.size() - prefix.size() - suffix.size()) - (file.frame < 0 ? 1 : 0);
}

int significantDigits(std::int64_t frame) {
    return static_cast<int>(std::to_string(frame < 0 ? -frame : frame).size());
}

// The padding the files use (FORMAT_NOTES §23.2): the digit count of the names written with leading zeros (the most
// common one; the smaller on a tie), else the smallest digit count. Non-negative frames decide when there are any.
int detectPadding(const std::vector<SequenceFile>& files, const std::string& prefix, const std::string& suffix) {
    const bool anyNonNegative = std::ranges::any_of(files, [](const SequenceFile& file) { return file.frame >= 0; });
    std::map<int, int> zeroPadded; // digit count → files
    int smallest = maxPadding;
    for (const SequenceFile& file : files) {
        if (anyNonNegative && file.frame < 0) {
            continue;
        }
        const int digits = writtenDigits(file, prefix, suffix);
        smallest = std::min(smallest, digits);
        if (digits > significantDigits(file.frame)) {
            ++zeroPadded[digits];
        }
    }
    int padding = smallest;
    int most = 0;
    for (const auto& [digits, count] : zeroPadded) {
        if (count > most) {
            padding = digits;
            most = count;
        }
    }
    return std::clamp(padding, 1, maxPadding);
}

// The listed files of `pattern`.
std::vector<SequenceFile> matching(const FramePattern& pattern, const std::vector<ListedFile>& listed,
                                   const ScanOptions& options = {}) {
    std::vector<SequenceFile> files;
    for (const ListedFile& file : listed) {
        if (const std::optional<std::int64_t> frame = pattern.frameOf(file.name)) {
            files.push_back(
                {.frame = *frame, .name = file.name, .stamp = options.stamps ? fileStamp(file.path) : FileStamp{}});
        }
    }
    return files;
}

} // namespace

Sequence::Sequence(FramePattern pattern, std::vector<SequenceFile> files)
    : m_pattern(std::move(pattern)),
      m_files(std::move(files)) {
    // Per frame, the pattern's own spelling first, then by name.
    const auto rank = [&](const SequenceFile& file) {
        const std::vector<std::string> spellings = m_pattern.fileNames(file.frame);
        return static_cast<std::size_t>(std::ranges::find(spellings, file.name) - spellings.begin());
    };
    std::ranges::sort(m_files, [&](const SequenceFile& a, const SequenceFile& b) {
        if (a.frame != b.frame) {
            return a.frame < b.frame;
        }
        const std::size_t rankA = rank(a);
        const std::size_t rankB = rank(b);
        return rankA != rankB ? rankA < rankB : a.name < b.name;
    });
    const auto repeats = std::ranges::unique(m_files, {}, &SequenceFile::frame);
    m_files.erase(repeats.begin(), repeats.end());
}

std::optional<anim::FrameRange> Sequence::range() const {
    if (m_files.empty()) {
        return std::nullopt;
    }
    return anim::FrameRange{.first = m_files.front().frame, .last = m_files.back().frame};
}

const SequenceFile* Sequence::find(std::int64_t frame) const {
    const auto it = std::ranges::lower_bound(m_files, frame, {}, &SequenceFile::frame);
    return it != m_files.end() && it->frame == frame ? &*it : nullptr;
}

const SequenceFile* Sequence::before(std::int64_t frame) const {
    const auto it = std::ranges::lower_bound(m_files, frame, {}, &SequenceFile::frame);
    return it == m_files.begin() ? nullptr : &*std::prev(it);
}

const SequenceFile* Sequence::after(std::int64_t frame) const {
    const auto it = std::ranges::upper_bound(m_files, frame, {}, &SequenceFile::frame);
    return it == m_files.end() ? nullptr : &*it;
}

const SequenceFile* Sequence::nearest(std::int64_t frame) const {
    if (const SequenceFile* exact = find(frame)) {
        return exact;
    }
    const SequenceFile* earlier = before(frame);
    const SequenceFile* later = after(frame);
    if (earlier == nullptr || later == nullptr) {
        return earlier != nullptr ? earlier : later;
    }
    return frame - earlier->frame <= later->frame - frame ? earlier : later;
}

std::vector<anim::FrameRange> Sequence::missing(const anim::FrameRange& range) const {
    std::vector<anim::FrameRange> runs;
    std::int64_t expected = range.first;
    for (auto it = std::ranges::lower_bound(m_files, range.first, {}, &SequenceFile::frame);
         it != m_files.end() && it->frame <= range.last; ++it) {
        if (it->frame > expected) {
            runs.push_back({.first = expected, .last = it->frame - 1});
        }
        expected = it->frame + 1;
    }
    if (expected <= range.last) {
        runs.push_back({.first = expected, .last = range.last});
    }
    return runs;
}

std::filesystem::path Sequence::path(const SequenceFile& file) const {
    return m_pattern.folder() / pathFromUtf8(file.name);
}

Sequence scanSequence(const FramePattern& pattern, const ScanOptions& options) {
    return {pattern, matching(pattern, listFiles(pattern.folder()), options)};
}

std::optional<Sequence> detectSequence(const std::filesystem::path& file) {
    const std::optional<FrameNumberedName> split = splitFrameNumber(pathToUtf8(file.filename()));
    if (!split) {
        return std::nullopt;
    }
    const std::filesystem::path folder = file.parent_path();
    const std::vector<ListedFile> listed = listFiles(folder);
    std::string prefix = split->prefix;
    std::vector<SequenceFile> files = matching(FramePattern(folder, prefix, 1, split->suffix), listed);
    // "render-0001.exr" next to "render0000.exr": the minus sign is a sign (§23.2).
    if (prefix.ends_with('-')) {
        std::string signless = prefix.substr(0, prefix.size() - 1);
        std::vector<SequenceFile> withSign = matching(FramePattern(folder, signless, 1, split->suffix), listed);
        if (withSign.size() > files.size()) {
            prefix = std::move(signless);
            files = std::move(withSign);
        }
    }
    if (files.size() < 2) {
        return std::nullopt;
    }
    const int padding = detectPadding(files, prefix, split->suffix);
    return Sequence(FramePattern(folder, prefix, padding, split->suffix), std::move(files));
}

FolderContents scanFolder(const std::filesystem::path& folder) {
    std::map<std::pair<std::string, std::string>, std::vector<SequenceFile>> groups; // (prefix, suffix) → files
    FolderContents contents;
    for (ListedFile& file : listFiles(folder)) {
        if (file.name.starts_with('.')) {
            continue;
        }
        if (std::optional<FrameNumberedName> split = splitFrameNumber(file.name)) {
            groups[{std::move(split->prefix), std::move(split->suffix)}].push_back(
                {.frame = split->frame, .name = std::move(file.name), .stamp = {}});
        } else {
            contents.files.push_back(std::move(file.name));
        }
    }
    // Groups "<name>-" next to a group "<name>" hold its negative frames (§23.2).
    for (auto group = groups.begin(); group != groups.end();) {
        const std::string& prefix = group->first.first;
        const auto signless = prefix.ends_with('-')
                                  ? groups.find({prefix.substr(0, prefix.size() - 1), group->first.second})
                                  : groups.end();
        if (signless == groups.end()) {
            ++group;
            continue;
        }
        std::vector<SequenceFile>& files = group->second;
        for (auto file = files.begin(); file != files.end();) {
            if (file->frame > 0) {
                signless->second.push_back({.frame = -file->frame, .name = std::move(file->name), .stamp = {}});
                file = files.erase(file);
            } else {
                ++file;
            }
        }
        group = files.empty() ? groups.erase(group) : std::next(group);
    }
    for (auto& [key, files] : groups) {
        if (files.size() < 2) {
            for (SequenceFile& file : files) {
                contents.files.push_back(std::move(file.name));
            }
            continue;
        }
        const int padding = detectPadding(files, key.first, key.second);
        contents.sequences.emplace_back(FramePattern(folder, key.first, padding, key.second), std::move(files));
    }
    std::ranges::sort(contents.files);
    std::ranges::sort(contents.sequences, {},
                      [](const Sequence& sequence) { return sequence.pattern().fileNameText(); });
    return contents;
}

SequenceChanges compare(const Sequence& before, const Sequence& after) {
    SequenceChanges changes;
    auto old = before.files().begin();
    auto now = after.files().begin();
    while (old != before.files().end() || now != after.files().end()) {
        if (now == after.files().end() || (old != before.files().end() && old->frame < now->frame)) {
            changes.removed.push_back(old->frame);
            ++old;
        } else if (old == before.files().end() || now->frame < old->frame) {
            changes.added.push_back(now->frame);
            ++now;
        } else {
            if (old->name != now->name || old->stamp != now->stamp) {
                changes.changed.push_back(now->frame);
            }
            ++old;
            ++now;
        }
    }
    return changes;
}

} // namespace pf::io
