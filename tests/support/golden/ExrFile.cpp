#include "support/golden/ExrFile.h"

#include <Imath/ImathBox.h>
#include <Imath/half.h>
#include <OpenEXR/ImfChannelList.h>
#include <OpenEXR/ImfFrameBuffer.h>
#include <OpenEXR/ImfHeader.h>
#include <OpenEXR/ImfInputFile.h>
#include <OpenEXR/ImfOutputFile.h>
#include <OpenEXR/ImfPartType.h>

#include <cstddef>
#include <exception>
#include <stdexcept>
#include <string>
#include <system_error>
#include <vector>

namespace pf::golden {
namespace {

// OpenEXR takes file names as UTF-8 on every platform.
std::string utf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return {text.begin(), text.end()};
}

Imath::Box2i toImath(const Box& box) {
    return {Imath::V2i(box.minX, box.minY), Imath::V2i(box.maxX, box.maxY)};
}

Box fromImath(const Imath::Box2i& box) {
    return {.minX = box.min.x, .minY = box.min.y, .maxX = box.max.x, .maxY = box.max.y};
}

Image readFile(const std::filesystem::path& path) {
    Imf::InputFile file(utf8(path).c_str());
    const Imf::Header& header = file.header();
    if (header.hasType() && Imf::isDeepData(header.type())) {
        throw std::runtime_error("deep data is not supported by the golden harness");
    }

    Image image;
    image.displayWindow = fromImath(header.displayWindow());
    image.dataWindow = fromImath(header.dataWindow());
    if (image.dataWindow.isEmpty()) {
        throw std::runtime_error("empty data window " + toString(image.dataWindow));
    }

    const Imf::ChannelList& channels = header.channels();
    for (auto it = channels.begin(); it != channels.end(); ++it) {
        if (it.channel().xSampling != 1 || it.channel().ySampling != 1) {
            throw std::runtime_error(std::string("channel '") + it.name() +
                                     "' is subsampled, which the golden harness does not support");
        }
        image.addChannel(it.name());
    }

    const Imath::Box2i dataWindow = toImath(image.dataWindow);
    const std::size_t rowStride = sizeof(float) * static_cast<std::size_t>(image.dataWindow.width());
    Imf::FrameBuffer frameBuffer;
    for (Channel& channel : image.channels) {
        frameBuffer.insert(channel.name,
                           Imf::Slice::Make(Imf::FLOAT, channel.samples.data(), dataWindow, sizeof(float), rowStride));
    }
    file.setFrameBuffer(frameBuffer);
    file.readPixels(dataWindow.min.y, dataWindow.max.y);
    return image;
}

void writeFile(const std::filesystem::path& path, const Image& image, SampleType type) {
    Imf::Header header(toImath(image.displayWindow), toImath(image.dataWindow));
    header.compression() = Imf::ZIP_COMPRESSION;
    const Imf::PixelType pixelType = type == SampleType::Half ? Imf::HALF : Imf::FLOAT;
    const std::size_t sampleSize = type == SampleType::Half ? sizeof(Imath::half) : sizeof(float);
    const std::size_t rowStride = sampleSize * static_cast<std::size_t>(image.dataWindow.width());

    std::vector<std::vector<Imath::half>> halfSamples; // keeps converted channels alive until writePixels()
    halfSamples.reserve(image.channels.size());
    Imf::FrameBuffer frameBuffer;
    for (const Channel& channel : image.channels) {
        header.channels().insert(channel.name, Imf::Channel(pixelType));
        const void* samples = channel.samples.data();
        if (type == SampleType::Half) {
            halfSamples.emplace_back(channel.samples.begin(), channel.samples.end());
            samples = halfSamples.back().data();
        }
        frameBuffer.insert(channel.name,
                           Imf::Slice::Make(pixelType, samples, toImath(image.dataWindow), sampleSize, rowStride));
    }

    Imf::OutputFile file(utf8(path).c_str(), header);
    file.setFrameBuffer(frameBuffer);
    file.writePixels(image.dataWindow.height());
}

} // namespace

Image readExr(const std::filesystem::path& path) {
    if (!std::filesystem::exists(path)) {
        throw std::runtime_error("cannot read EXR '" + utf8(path) + "': the file does not exist");
    }
    try {
        return readFile(path);
    } catch (const std::exception& error) {
        throw std::runtime_error("cannot read EXR '" + utf8(path) + "': " + error.what());
    }
}

void writeExr(const std::filesystem::path& path, const Image& image, SampleType type) {
    if (image.dataWindow.isEmpty()) {
        throw std::runtime_error("cannot write EXR '" + utf8(path) + "': empty data window");
    }
    for (const Channel& channel : image.channels) {
        if (channel.samples.size() != image.pixelCount()) {
            throw std::runtime_error("cannot write EXR '" + utf8(path) + "': channel '" + channel.name + "' has " +
                                     std::to_string(channel.samples.size()) + " samples for " +
                                     std::to_string(image.pixelCount()) + " pixels");
        }
    }

    // Written next to the target and renamed into place, so an interrupted write never leaves a broken file.
    std::filesystem::path temporary = path;
    temporary += ".partial";
    try {
        if (path.has_parent_path()) {
            std::filesystem::create_directories(path.parent_path());
        }
        writeFile(temporary, image, type);
        std::filesystem::rename(temporary, path);
    } catch (const std::exception& error) {
        std::error_code ignored;
        std::filesystem::remove(temporary, ignored);
        throw std::runtime_error("cannot write EXR '" + utf8(path) + "': " + error.what());
    }
}

} // namespace pf::golden
