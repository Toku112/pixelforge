// Channel names and channel sets (core/image/ChannelSet.h, FORMAT_NOTES §19.2).

#include "core/image/ChannelSet.h"

#include <gtest/gtest.h>

#include <stdexcept>
#include <string>
#include <vector>

namespace pf::image {
namespace {

std::vector<std::string> namesOf(const ChannelSet& set) {
    return set.names();
}

TEST(ChannelName, LayerAndSuffix) {
    EXPECT_EQ(layerOf("R"), "");
    EXPECT_EQ(suffixOf("R"), "R");
    EXPECT_EQ(layerOf("diffuse_direct.R"), "diffuse_direct");
    EXPECT_EQ(suffixOf("diffuse_direct.R"), "R");
    // Cycles: ViewLayer.Pass.Channel — the layer is everything before the last dot.
    EXPECT_EQ(layerOf("ViewLayer.Combined.A"), "ViewLayer.Combined");
    EXPECT_EQ(suffixOf("ViewLayer.Combined.A"), "A");
    EXPECT_EQ(layerOf("CryptoObject00.G"), "CryptoObject00");
}

TEST(ChannelName, CanonicalOrderWithinALayer) {
    const ChannelSet set{"Z", "A", "B", "id", "G", "R", "V", "U", "W", "Y", "X"};
    EXPECT_EQ(namesOf(set), (std::vector<std::string>{"R", "G", "B", "A", "X", "Y", "Z", "W", "U", "V", "id"}));
}

TEST(ChannelName, CanonicalOrderAcrossLayers) {
    const ChannelSet set{"specular.B", "A", "diffuse.R", "R", "diffuse.A", "specular.R", "diffuse.G"};
    // The main layer first, then layers by name.
    EXPECT_EQ(namesOf(set),
              (std::vector<std::string>{"R", "A", "diffuse.R", "diffuse.G", "diffuse.A", "specular.R", "specular.B"}));
}

TEST(ChannelName, OrderIsCaseSensitiveAndOtherSuffixesSortByBytes) {
    const ChannelSet set{"r", "R", "depth", "Depth", "alpha"};
    EXPECT_EQ(namesOf(set), (std::vector<std::string>{"R", "Depth", "alpha", "depth", "r"}));
}

TEST(ChannelSet, OrderDoesNotDependOnInsertionOrder) {
    const ChannelSet a{"R", "G", "B", "A", "Z", "N.X", "N.Y", "N.Z"};
    const ChannelSet b{"N.Z", "Z", "A", "N.X", "B", "G", "N.Y", "R"};
    EXPECT_EQ(a, b);
}

TEST(ChannelSet, InsertEraseContains) {
    ChannelSet set;
    EXPECT_TRUE(set.empty());
    EXPECT_TRUE(set.insert("G"));
    EXPECT_TRUE(set.insert("R"));
    EXPECT_FALSE(set.insert("R")); // already there
    EXPECT_EQ(set.size(), 2U);
    EXPECT_TRUE(set.contains("R"));
    EXPECT_FALSE(set.contains("B"));
    EXPECT_EQ(set.indexOf("R"), 0U);
    EXPECT_EQ(set.indexOf("G"), 1U);
    EXPECT_EQ(set.indexOf("B"), std::nullopt);
    EXPECT_EQ(set[1], "G");

    EXPECT_TRUE(set.erase("R"));
    EXPECT_FALSE(set.erase("R"));
    EXPECT_EQ(namesOf(set), std::vector<std::string>{"G"});
}

TEST(ChannelSet, DuplicatesAreKeptOnce) {
    const ChannelSet set{"R", "R", "G"};
    EXPECT_EQ(set.size(), 2U);
    const ChannelSet fromVector(std::vector<std::string>{"A", "A"});
    EXPECT_EQ(fromVector.size(), 1U);
}

TEST(ChannelSet, EmptyNamesAreRefused) {
    ChannelSet set;
    EXPECT_THROW(set.insert(""), std::invalid_argument);
    EXPECT_THROW((ChannelSet{"R", ""}), std::invalid_argument);
}

TEST(ChannelSet, Layers) {
    const ChannelSet set{"R", "G", "diffuse.R", "diffuse.G", "ViewLayer.Depth.Z", "A"};
    EXPECT_EQ(set.layers(), (std::vector<std::string>{"", "ViewLayer.Depth", "diffuse"}));
    EXPECT_EQ(namesOf(set.inLayer("diffuse")), (std::vector<std::string>{"diffuse.R", "diffuse.G"}));
    EXPECT_EQ(namesOf(set.inLayer("")), (std::vector<std::string>{"R", "G", "A"}));
    EXPECT_TRUE(set.inLayer("missing").empty());
}

TEST(ChannelSet, SetOperations) {
    const ChannelSet rgb{"R", "G", "B"};
    const ChannelSet ga{"G", "A"};
    EXPECT_EQ(unite(rgb, ga), (ChannelSet{"R", "G", "B", "A"}));
    EXPECT_EQ(intersect(rgb, ga), ChannelSet{"G"});
    EXPECT_EQ(subtract(rgb, ga), (ChannelSet{"R", "B"}));
    EXPECT_EQ(subtract(ga, rgb), ChannelSet{"A"});
    EXPECT_EQ(intersect(rgb, ChannelSet{}), ChannelSet{});
}

} // namespace
} // namespace pf::image
