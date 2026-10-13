#pragma once

// Frame numbers in file names and frame patterns (docs/specs/sequences.md §2–3, FORMAT_NOTES §23.1–23.2).
//
// A rendered frame's file name holds its frame number: "render.1001.exr", "render_1001.exr", "render1001.exr". A
// pattern stands for every frame of a sequence by putting a placeholder where the number goes: "render.####.exr",
// "render.@@@@.exr" or "render.%04d.exr". Names are compared as UTF-8 text, exactly (case included).

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace pf::io {

// Frame numbers in file names have at most 9 digits.
inline constexpr std::int64_t maxFileFrame = 999'999'999;
// Padding (digits written, with leading zeros) of a pattern: 1 to 9.
inline constexpr int maxPadding = 9;

// A file name split around its frame number: "shot_v2.1001.exr" → "shot_v2.", 1001, ".exr".
struct FrameNumberedName {
    std::string prefix;
    std::int64_t frame = 0;
    int digits = 0; // digits as written, without the minus sign ("0007" → 4)
    std::string suffix;

    friend bool operator==(const FrameNumberedName&, const FrameNumberedName&) = default;
};

// Splits a file name (UTF-8, no folder) at its frame number: the last run of digits before the extension (the last
// dot; a name without one has no extension). A '-' right before the digits is a minus sign when it starts the name
// or follows '.', '_' or ' '. nullopt when there are no such digits or more than 9 of them.
[[nodiscard]] std::optional<FrameNumberedName> splitFrameNumber(std::string_view fileName);

class FramePattern {
public:
    // A pattern from its parts; throws std::invalid_argument for a padding outside 1–9 or a prefix or suffix that
    // holds a folder separator.
    FramePattern(std::filesystem::path folder, std::string prefix, int padding, std::string suffix);

    // Reads a path (UTF-8) whose file name holds a placeholder: a run of '#' or of '@' (one digit each), or "%d" /
    // "%0Nd" (N = 1–9). The last placeholder in the file name counts. nullopt when the file name has none, or a
    // longer one than 9 digits.
    [[nodiscard]] static std::optional<FramePattern> parse(std::string_view pathUtf8);

    [[nodiscard]] const std::filesystem::path& folder() const { return m_folder; }
    [[nodiscard]] const std::string& prefix() const { return m_prefix; }
    [[nodiscard]] const std::string& suffix() const { return m_suffix; }
    [[nodiscard]] int padding() const { return m_padding; }

    // The file name of `frame` as the app writes it: at least `padding` digits, a minus sign before negative frames
    // ("-0005"). `frame` must lie within ±maxFileFrame.
    [[nodiscard]] std::string fileName(std::int64_t frame) const;
    // The names a file of `frame` may have with this padding: fileName(frame), and for negative frames also the
    // C-style spelling whose padding counts the minus sign ("-005").
    [[nodiscard]] std::vector<std::string> fileNames(std::int64_t frame) const;
    // The frame of a file name of this pattern, written with any padding and an optional minus sign; nullopt when
    // the name is not one of the pattern's.
    [[nodiscard]] std::optional<std::int64_t> frameOf(std::string_view fileName) const;

    // The pattern as text with '#' placeholders: "/renders/shot/render####.exr" (UTF-8).
    [[nodiscard]] std::string text() const;
    // The file name part of text(): "render####.exr".
    [[nodiscard]] std::string fileNameText() const;

    friend bool operator==(const FramePattern&, const FramePattern&) = default;

private:
    std::filesystem::path m_folder;
    std::string m_prefix;
    int m_padding = 1;
    std::string m_suffix;
};

} // namespace pf::io
