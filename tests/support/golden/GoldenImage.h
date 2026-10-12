#pragma once

// The image type of the golden-image harness: named float channels over a data window, inside a display window,
// laid out as in OpenEXR. The harness has its own small type (instead of the app's core/image) so that a bug in the
// code under test can never hide in the code that checks it.

#include <cstddef>
#include <initializer_list>
#include <string>
#include <string_view>
#include <vector>

namespace pf::golden {

// Inclusive pixel rectangle, as in OpenEXR: a 1 × 1 box has min == max. Coordinates may be negative.
struct Box {
    int minX = 0;
    int minY = 0;
    int maxX = -1;
    int maxY = -1;

    [[nodiscard]] int width() const { return maxX - minX + 1; }
    [[nodiscard]] int height() const { return maxY - minY + 1; }
    [[nodiscard]] bool isEmpty() const { return maxX < minX || maxY < minY; }
    [[nodiscard]] bool contains(int x, int y) const { return x >= minX && x <= maxX && y >= minY && y <= maxY; }

    friend bool operator==(const Box&, const Box&) = default;
};

[[nodiscard]] std::string toString(const Box& box);

struct Channel {
    std::string name;           // full EXR channel name: "R", "A", "Z", "diffuse_direct.R", "CryptoObject00.G"
    std::vector<float> samples; // one per pixel of the data window, row by row from (minX, minY)
};

struct Image {
    Box displayWindow; // the frame
    Box dataWindow;    // where pixels exist; may be larger or smaller than the frame
    std::vector<Channel> channels;

    // An image with the given channels, every sample 0. Throws std::invalid_argument for an empty data window or a
    // duplicate channel name.
    [[nodiscard]] static Image create(const Box& displayWindow, const Box& dataWindow,
                                      std::initializer_list<std::string_view> channelNames);

    [[nodiscard]] std::size_t pixelCount() const;

    // Index of pixel (x, y) in Channel::samples; (x, y) must lie inside the data window.
    [[nodiscard]] std::size_t indexOf(int x, int y) const;

    [[nodiscard]] const Channel* find(std::string_view name) const;
    [[nodiscard]] Channel* find(std::string_view name);

    // The channel with this name; throws std::out_of_range when it does not exist.
    [[nodiscard]] const Channel& channel(std::string_view name) const;
    [[nodiscard]] Channel& channel(std::string_view name);

    // Adds a channel filled with `value`; throws std::invalid_argument when the name exists already.
    Channel& addChannel(std::string_view name, float value = 0.0F);
};

} // namespace pf::golden
