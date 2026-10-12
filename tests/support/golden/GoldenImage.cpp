#include "support/golden/GoldenImage.h"

#include <algorithm>
#include <stdexcept>

namespace pf::golden {

std::string toString(const Box& box) {
    return "(" + std::to_string(box.minX) + ", " + std::to_string(box.minY) + ")–(" + std::to_string(box.maxX) + ", " +
           std::to_string(box.maxY) + ")";
}

Image Image::create(const Box& display, const Box& data, std::initializer_list<std::string_view> channelNames) {
    if (data.isEmpty()) {
        throw std::invalid_argument("golden image: empty data window " + toString(data));
    }
    Image image;
    image.displayWindow = display;
    image.dataWindow = data;
    for (const std::string_view name : channelNames) {
        image.addChannel(name);
    }
    return image;
}

std::size_t Image::pixelCount() const {
    if (dataWindow.isEmpty()) {
        return 0;
    }
    return static_cast<std::size_t>(dataWindow.width()) * static_cast<std::size_t>(dataWindow.height());
}

std::size_t Image::indexOf(int x, int y) const {
    if (!dataWindow.contains(x, y)) {
        throw std::out_of_range("golden image: pixel (" + std::to_string(x) + ", " + std::to_string(y) +
                                ") is outside the data window " + toString(dataWindow));
    }
    return (static_cast<std::size_t>(y - dataWindow.minY) * static_cast<std::size_t>(dataWindow.width())) +
           static_cast<std::size_t>(x - dataWindow.minX);
}

const Channel* Image::find(std::string_view name) const {
    const auto found = std::ranges::find(channels, name, &Channel::name);
    return found == channels.end() ? nullptr : &*found;
}

Channel* Image::find(std::string_view name) {
    const auto found = std::ranges::find(channels, name, &Channel::name);
    return found == channels.end() ? nullptr : &*found;
}

const Channel& Image::channel(std::string_view name) const {
    const Channel* found = find(name);
    if (found == nullptr) {
        throw std::out_of_range("golden image: no channel '" + std::string(name) + "'");
    }
    return *found;
}

Channel& Image::channel(std::string_view name) {
    Channel* found = find(name);
    if (found == nullptr) {
        throw std::out_of_range("golden image: no channel '" + std::string(name) + "'");
    }
    return *found;
}

Channel& Image::addChannel(std::string_view name, float value) {
    if (name.empty()) {
        throw std::invalid_argument("golden image: empty channel name");
    }
    if (find(name) != nullptr) {
        throw std::invalid_argument("golden image: duplicate channel '" + std::string(name) + "'");
    }
    return channels.emplace_back(
        Channel{.name = std::string(name), .samples = std::vector<float>(pixelCount(), value)});
}

} // namespace pf::golden
