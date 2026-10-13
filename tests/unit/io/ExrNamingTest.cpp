// How EXR channel names become the engine's names (FORMAT_NOTES §22.2): views in one part (OpenEXR's rule), views
// in parts, and clashes between parts.

#include "io/exr/ExrNaming.h"

#include <gtest/gtest.h>

#include <string>
#include <vector>

namespace pf::io::exr {
namespace {

const std::vector<std::string> stereo{"left", "right"};

TEST(ExrNaming, ViewOfAChannelFollowsOpenExrsRule) {
    EXPECT_EQ(viewOfChannel("R", stereo), "left"); // no dot: the default view
    EXPECT_EQ(viewOfChannel("left.Z", stereo), "left");
    EXPECT_EQ(viewOfChannel("diffuse.left.R", stereo), "left");
    EXPECT_EQ(viewOfChannel("right.R", stereo), "right");
    EXPECT_EQ(viewOfChannel("diffuse.right.R", stereo), "right");
    EXPECT_EQ(viewOfChannel("tmp.R", stereo), "");           // no view
    EXPECT_EQ(viewOfChannel("right.diffuse.R", stereo), ""); // the view must be just before the channel
    EXPECT_EQ(viewOfChannel(".R", stereo), "");
    EXPECT_EQ(viewOfChannel("R", {}), "");
}

TEST(ExrNaming, RemovingAndInsertingViews) {
    EXPECT_EQ(withoutView("left.Z", "left"), "Z");
    EXPECT_EQ(withoutView("diffuse.left.R", "left"), "diffuse.R");
    EXPECT_EQ(withoutView("a.b.left.R", "left"), "a.b.R");
    EXPECT_EQ(withoutView("R", "left"), "R");
    EXPECT_EQ(withoutView("diffuse.right.R", "left"), "diffuse.right.R");
    EXPECT_EQ(withView("R", "right"), "right.R");
    EXPECT_EQ(withView("diffuse.R", "right"), "diffuse.right.R");
    EXPECT_EQ(withView("ViewLayer.Combined.R", "right"), "ViewLayer.Combined.right.R");
}

std::vector<std::string> namesOf(const std::vector<ChannelNaming>& namings) {
    std::vector<std::string> names;
    names.reserve(namings.size());
    for (const ChannelNaming& naming : namings) {
        names.push_back(naming.name);
    }
    return names;
}

TEST(ExrNaming, OnePartWithoutViewsKeepsEveryName) {
    const std::vector<StoredChannel> channels{
        {.storedName = "R"}, {.storedName = "DiffuseLighting.R"}, {.storedName = "Z"}};
    const std::vector<ChannelNaming> named = nameChannels(channels, {}, false);
    EXPECT_EQ(namesOf(named), (std::vector<std::string>{"R", "DiffuseLighting.R", "Z"}));
    for (const ChannelNaming& naming : named) {
        EXPECT_TRUE(naming.note.empty());
        EXPECT_TRUE(naming.view.empty());
    }
}

TEST(ExrNaming, ViewsInOnePart) {
    const std::vector<StoredChannel> channels{{.storedName = "R"},
                                              {.storedName = "left.Z"},
                                              {.storedName = "right.R"},
                                              {.storedName = "diffuse.left.G"},
                                              {.storedName = "diffuse.right.G"},
                                              {.storedName = "tmp.B"}};
    const std::vector<ChannelNaming> named = nameChannels(channels, stereo, false);
    EXPECT_EQ(namesOf(named), (std::vector<std::string>{"R", "Z", "right.R", "diffuse.G", "diffuse.right.G", "tmp.B"}));
    EXPECT_EQ(named[2].view, "right");
    EXPECT_EQ(named[4].view, "right");
    EXPECT_EQ(named[1].view, "");
    EXPECT_EQ(named[5].view, "");
}

TEST(ExrNaming, ViewsInParts) {
    const std::vector<StoredChannel> channels{
        {.part = 0, .partName = "left", .partView = "left", .storedName = "R"},
        {.part = 0, .partName = "left", .partView = "left", .storedName = "diffuse.R"},
        {.part = 1, .partName = "right", .partView = "right", .storedName = "R"},
        {.part = 1, .partName = "right", .partView = "right", .storedName = "diffuse.R"},
        {.part = 2, .partName = "depth", .partView = "", .storedName = "Z"}};
    const std::vector<ChannelNaming> named = nameChannels(channels, stereo, true);
    EXPECT_EQ(namesOf(named), (std::vector<std::string>{"R", "diffuse.R", "right.R", "diffuse.right.R", "Z"}));
    EXPECT_EQ(named[2].view, "right");
    EXPECT_EQ(named[0].view, "");
}

TEST(ExrNaming, ClashesArePrefixedWithThePartNameOrLeftOut) {
    const std::vector<StoredChannel> channels{{.part = 0, .partName = "diffuse", .storedName = "R"},
                                              {.part = 1, .partName = "specular", .storedName = "R"},
                                              {.part = 2, .partName = "", .storedName = "R"},
                                              {.part = 3, .partName = "x", .storedName = "specular.R"},
                                              {.part = 4, .partName = "specular", .storedName = "R"}};
    const std::vector<ChannelNaming> named = nameChannels(channels, {}, true);
    EXPECT_EQ(namesOf(named), (std::vector<std::string>{"R", "specular.R", "", "x.specular.R", ""}));
    EXPECT_EQ(named[1].note,
              "channel 'R' of part 'specular' is shown as 'specular.R': an earlier part has a channel named 'R'");
    EXPECT_EQ(named[2].note, "channel 'R' of part '#3' is left out: another channel is named 'R'");
    EXPECT_FALSE(named[3].note.empty());
    EXPECT_FALSE(named[4].note.empty());
}

TEST(ExrNaming, ClashesInOnePartAfterRemovingTheDefaultView) {
    // "diffuse.R" belongs to no view; "diffuse.left.R" belongs to the default view and would also be "diffuse.R".
    const std::vector<StoredChannel> channels{{.storedName = "diffuse.R"}, {.storedName = "diffuse.left.R"}};
    const std::vector<ChannelNaming> named = nameChannels(channels, stereo, false);
    EXPECT_EQ(namesOf(named), (std::vector<std::string>{"diffuse.R", ""}));
    EXPECT_EQ(named[1].note, "channel 'diffuse.left.R' is left out: another channel is named 'diffuse.R'");
}

} // namespace
} // namespace pf::io::exr
