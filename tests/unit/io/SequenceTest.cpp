// Image sequences on disk (io/sequence/Sequence.h, io/sequence/SequenceIndex.h, docs/specs/sequences.md,
// FORMAT_NOTES §23): scanning a pattern's files, gaps, detecting the sequence of a picked file, listing a folder,
// snapshots that show what changed, and the listing cache. Uses empty files in a temporary folder.

#include "io/sequence/Sequence.h"

#include "core/anim/FrameRange.h"
#include "io/ImageReader.h"
#include "io/sequence/FramePattern.h"
#include "io/sequence/SequenceIndex.h"
#include "support/nodes/TestBench.h"

#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <initializer_list>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace pf::io {
namespace {

using anim::FrameRange;

// The value of `optional`; throws (failing the test) when there is none.
template <class T>
T need(std::optional<T> optional) {
    if (!optional) {
        throw std::runtime_error("expected a value, got none");
    }
    return std::move(*optional);
}

// The message of the FileError `work` throws; empty when it throws none.
std::string fileErrorOf(const std::function<void()>& work) {
    try {
        work();
    } catch (const FileError& error) {
        return error.what();
    }
    return {};
}

class SequenceTest : public ::testing::Test {
public:
    testing::TemporaryFolder folder;

    void touch(std::initializer_list<std::string_view> files, std::string_view contents = "") const {
        for (const std::string_view name : files) {
            std::ofstream(folder.file(name), std::ios::binary) << contents;
        }
    }

    [[nodiscard]] FramePattern patternOf(const std::string& fileName) const {
        return need(FramePattern::parse(pathToUtf8(folder.file(fileName))));
    }

    static std::vector<std::int64_t> frames(const Sequence& sequence) {
        std::vector<std::int64_t> result;
        for (const SequenceFile& file : sequence.files()) {
            result.push_back(file.frame);
        }
        return result;
    }

    static std::vector<std::string> names(const Sequence& sequence) {
        std::vector<std::string> result;
        for (const SequenceFile& file : sequence.files()) {
            result.push_back(file.name);
        }
        return result;
    }
};

TEST_F(SequenceTest, ScansThePatternsFilesWithTheirGaps) {
    touch({"render.0001.exr", "render.0002.exr", "render.0003.exr", "render.0007.exr", "render.0010.exr",
           "render.0004.tif", "other.0005.exr", "render.0005.exr.tmp", "notes.txt"});
    std::filesystem::create_directory(folder.file("render.0006.exr")); // a folder, not a frame
    const Sequence sequence = scanSequence(patternOf("render.####.exr"));
    EXPECT_EQ(frames(sequence), (std::vector<std::int64_t>{1, 2, 3, 7, 10}));
    EXPECT_EQ(sequence.range(), (FrameRange{.first = 1, .last = 10}));
    EXPECT_EQ(sequence.path(sequence.files()[3]), folder.file("render.0007.exr"));

    EXPECT_EQ(sequence.missing({.first = 1, .last = 10}),
              (std::vector<FrameRange>{{.first = 4, .last = 6}, {.first = 8, .last = 9}}));
    EXPECT_EQ(anim::toString(sequence.missing({.first = -1, .last = 12})), "-1–0, 4–6, 8–9, 11–12");
    EXPECT_TRUE(sequence.missing({.first = 1, .last = 3}).empty());
    EXPECT_EQ(sequence.missing({.first = 20, .last = 1'000'000}),
              (std::vector<FrameRange>{{.first = 20, .last = 1'000'000}}));
}

TEST_F(SequenceTest, FindsNeighbouringFrames) {
    touch({"f.0002.exr", "f.0005.exr", "f.0009.exr"});
    const Sequence sequence = scanSequence(patternOf("f.####.exr"));
    EXPECT_EQ(sequence.find(5)->name, "f.0005.exr");
    EXPECT_EQ(sequence.find(4), nullptr);
    EXPECT_EQ(sequence.before(5)->frame, 2);
    EXPECT_EQ(sequence.before(4)->frame, 2);
    EXPECT_EQ(sequence.before(2), nullptr);
    EXPECT_EQ(sequence.after(5)->frame, 9);
    EXPECT_EQ(sequence.after(9), nullptr);
    EXPECT_EQ(sequence.nearest(5)->frame, 5);
    EXPECT_EQ(sequence.nearest(7)->frame, 5); // equally near: the earlier one
    EXPECT_EQ(sequence.nearest(8)->frame, 9);
    EXPECT_EQ(sequence.nearest(-100)->frame, 2);
    EXPECT_EQ(sequence.nearest(100)->frame, 9);

    const Sequence none = scanSequence(patternOf("g.####.exr"));
    EXPECT_TRUE(none.empty());
    EXPECT_EQ(none.range(), std::nullopt);
    EXPECT_EQ(none.nearest(1), nullptr);
    EXPECT_EQ(none.missing({.first = 1, .last = 3}), (std::vector<FrameRange>{{.first = 1, .last = 3}}));
}

TEST_F(SequenceTest, MixedPaddingAndNegativeFrames) {
    touch({"f.01.exr", "f.002.exr", "f.3.exr", "f.0004.exr", "f.-0002.exr", "f.-001.exr"});
    EXPECT_EQ(frames(scanSequence(patternOf("f.##.exr"))), (std::vector<std::int64_t>{-2, -1, 1, 2, 3, 4}));

    // Two files of one frame: the pattern's own spelling wins, else the first by name.
    touch({"g.1.exr", "g.0001.exr", "g.01.exr", "g.002.exr", "g.02.exr"});
    const Sequence sequence = scanSequence(patternOf("g.####.exr"));
    EXPECT_EQ(names(sequence), (std::vector<std::string>{"g.0001.exr", "g.002.exr"}));
}

TEST_F(SequenceTest, UnreadableFoldersAreErrors) {
    const std::string missing =
        fileErrorOf([&] { (void)scanSequence(FramePattern(folder.file("missing"), "f.", 4, ".exr")); });
    EXPECT_EQ(missing.rfind("cannot read the folder ", 0), 0U) << missing;
    EXPECT_NE(missing.find("missing: it does not exist"), std::string::npos) << missing;

    touch({"plain.txt"});
    const std::string notAFolder =
        fileErrorOf([&] { (void)scanSequence(FramePattern(folder.file("plain.txt"), "f.", 4, ".exr")); });
    EXPECT_NE(notAFolder.find("plain.txt: it is not a folder"), std::string::npos) << notAFolder;
    EXPECT_FALSE(fileErrorOf([&] { (void)scanFolder(folder.file("missing")); }).empty());
}

TEST_F(SequenceTest, DetectsTheSequenceOfAPickedFile) {
    touch({"render0001.exr", "render0002.exr", "render0003.exr", "render0005.exr", "render0001.png", "Render0004.exr"});
    const Sequence sequence = need(detectSequence(folder.file("render0002.exr")));
    EXPECT_EQ(sequence.pattern(), FramePattern(folder.path(), "render", 4, ".exr"));
    EXPECT_EQ(sequence.pattern().text(), pathToUtf8(folder.file("render####.exr")));
    EXPECT_EQ(frames(sequence), (std::vector<std::int64_t>{1, 2, 3, 5}));

    // A numbered file alone, and a file without a number, are stills.
    EXPECT_EQ(detectSequence(folder.file("render0001.png")), std::nullopt);
    touch({"beauty.exr"});
    EXPECT_EQ(detectSequence(folder.file("beauty.exr")), std::nullopt);
}

TEST_F(SequenceTest, DetectedPaddingFollowsTheFiles) {
    const auto padding = [&](std::initializer_list<std::string_view> files) {
        const testing::TemporaryFolder where;
        for (const std::string_view name : files) {
            std::ofstream(where.file(name)) << "";
        }
        return need(detectSequence(where.file(*files.begin()))).pattern().padding();
    };
    EXPECT_EQ(padding({"a.0001.exr", "a.0002.exr"}), 4);
    EXPECT_EQ(padding({"a.1001.exr", "a.1002.exr"}), 4);
    EXPECT_EQ(padding({"a.8.exr", "a.9.exr", "a.10.exr", "a.11.exr"}), 1); // unpadded
    EXPECT_EQ(padding({"a.998.exr", "a.999.exr", "a.1000.exr"}), 3);       // padding outgrown
    EXPECT_EQ(padding({"a.0998.exr", "a.0999.exr", "a.1000.exr"}), 4);
    EXPECT_EQ(padding({"a.01.exr", "a.002.exr", "a.003.exr"}), 3); // mixed: the most common
    EXPECT_EQ(padding({"a.-001.exr", "a.-002.exr"}), 3);           // only negative frames: they decide
    EXPECT_EQ(padding({"a.-001.exr", "a.0000.exr", "a.0001.exr"}), 4);
}

TEST_F(SequenceTest, AMinusSignWithoutASeparatorIsASignWhenTheFolderSaysSo) {
    // Blender without a separator writes frame −1 as "render-0001".
    touch({"render-0002.exr", "render-0001.exr", "render0000.exr", "render0001.exr"});
    const Sequence fromNegative = need(detectSequence(folder.file("render-0001.exr")));
    EXPECT_EQ(fromNegative.pattern().prefix(), "render");
    EXPECT_EQ(frames(fromNegative), (std::vector<std::int64_t>{-2, -1, 0, 1}));
    EXPECT_EQ(frames(need(detectSequence(folder.file("render0001.exr")))), frames(fromNegative));

    // Without the unsigned names, a dash is part of the name.
    touch({"shot-0001.exr", "shot-0002.exr"});
    const Sequence shot = need(detectSequence(folder.file("shot-0002.exr")));
    EXPECT_EQ(shot.pattern().prefix(), "shot-");
    EXPECT_EQ(frames(shot), (std::vector<std::int64_t>{1, 2}));
}

TEST_F(SequenceTest, ListsAFolderAsSequencesAndFiles) {
    touch({"beauty.0001.exr", "beauty.0002.exr", "beauty.0003.exr", "render-0001.exr", "render0000.exr",
           "render0001.exr", "IMG_4021.JPG", "IMG_4022.JPG", "notes.txt", "single.0001.exr", ".hidden.0001.exr",
           ".hidden.0002.exr", "._beauty.0001.exr"});
    std::filesystem::create_directory(folder.file("sub.0004.exr"));
    const FolderContents contents = scanFolder(folder.path());
    ASSERT_EQ(contents.sequences.size(), 3U);
    EXPECT_EQ(contents.sequences[0].pattern().fileNameText(), "IMG_####.JPG");
    EXPECT_EQ(contents.sequences[1].pattern().fileNameText(), "beauty.####.exr");
    EXPECT_EQ(frames(contents.sequences[1]), (std::vector<std::int64_t>{1, 2, 3}));
    EXPECT_EQ(contents.sequences[2].pattern().fileNameText(), "render####.exr");
    EXPECT_EQ(frames(contents.sequences[2]), (std::vector<std::int64_t>{-1, 0, 1}));
    EXPECT_EQ(contents.files, (std::vector<std::string>{"notes.txt", "single.0001.exr"}));

    // A listed sequence is what scanning its pattern finds.
    for (const Sequence& sequence : contents.sequences) {
        EXPECT_EQ(frames(scanSequence(sequence.pattern())), frames(sequence)) << sequence.pattern().text();
    }
}

TEST_F(SequenceTest, SnapshotsShowWhatChanged) {
    touch({"f.0001.exr", "f.0002.exr", "f.0003.exr", "f.0004.exr"}, "frame");
    const FramePattern pattern = patternOf("f.####.exr");
    const Sequence before = scanSequence(pattern, {.stamps = true});
    EXPECT_TRUE(before.files()[0].stamp.exists);
    EXPECT_EQ(before.files()[0].stamp.size, 5U);
    EXPECT_TRUE(compare(before, scanSequence(pattern, {.stamps = true})).empty());

    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    touch({"f.0002.exr"}, "rendered again"); // rewritten
    std::filesystem::remove(folder.file("f.0003.exr"));
    touch({"f.0005.exr", "f.0000.exr"}); // new frames
    std::filesystem::rename(folder.file("f.0004.exr"), folder.file("f.4.exr"));
    const SequenceChanges changes = compare(before, scanSequence(pattern, {.stamps = true}));
    EXPECT_EQ(changes.added, (std::vector<std::int64_t>{0, 5}));
    EXPECT_EQ(changes.removed, (std::vector<std::int64_t>{3}));
    EXPECT_EQ(changes.changed, (std::vector<std::int64_t>{2, 4}));
    EXPECT_FALSE(changes.empty());
}

TEST_F(SequenceTest, TheIndexListsAFolderAgainOnlyWhenItChanges) {
    touch({"f.0001.exr", "f.0002.exr"});
    const SequenceIndex index;
    const FramePattern pattern = patternOf("f.####.exr");
    const std::shared_ptr<const Sequence> first = index.get(pattern);
    EXPECT_EQ(frames(*first), (std::vector<std::int64_t>{1, 2}));
    EXPECT_EQ(index.get(pattern), first);
    EXPECT_EQ(index.listings(), 1U);

    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    touch({"f.0003.exr"});
    EXPECT_EQ(frames(*index.get(pattern)), (std::vector<std::int64_t>{1, 2, 3}));
    EXPECT_EQ(index.listings(), 2U);
    EXPECT_EQ(frames(*index.get(pattern)), (std::vector<std::int64_t>{1, 2, 3}));
    EXPECT_EQ(index.listings(), 2U);

    (void)index.get(pattern, true); // forced
    EXPECT_EQ(index.listings(), 3U);
    (void)index.get(patternOf("f.@@@@.exr")); // the same pattern written differently
    EXPECT_EQ(index.listings(), 3U);
    (void)index.get(patternOf("f.##.exr")); // another padding: listed on its own
    EXPECT_EQ(index.listings(), 4U);

    SequenceIndex small(1);
    (void)small.get(pattern);
    (void)small.get(patternOf("g.####.exr"));
    (void)small.get(pattern); // pushed out by g
    EXPECT_EQ(small.listings(), 3U);
    small.clear();
    (void)small.get(pattern);
    EXPECT_EQ(small.listings(), 4U);

    EXPECT_THROW((void)index.get(FramePattern(folder.file("missing"), "f.", 4, ".exr")), FileError);
}

} // namespace
} // namespace pf::io
