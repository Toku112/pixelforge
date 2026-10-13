#include "support/nodes/TestBench.h"

#include "core/image/Rect.h"
#include "io/Formats.h"
#include "nodes/Builtins.h"

#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <optional>
#include <random>
#include <stdexcept>
#include <system_error>
#include <utility>
#include <vector>

namespace pf::testing {
namespace {

constexpr std::array<char, 8> magic{'P', 'F', 'T', 'E', 'S', 'T', '1', '\0'};

template <class T>
void put(std::ofstream& out, const T& value) {
    std::array<char, sizeof(T)> bytes{};
    std::memcpy(bytes.data(), &value, sizeof(T));
    out.write(bytes.data(), bytes.size());
}

template <class T>
T get(std::ifstream& in) {
    std::array<char, sizeof(T)> bytes{};
    in.read(bytes.data(), bytes.size());
    T value{};
    std::memcpy(&value, bytes.data(), sizeof(T));
    return value;
}

void putRect(std::ofstream& out, const image::Rect& rect) {
    for (const int v : {rect.x0, rect.y0, rect.x1, rect.y1}) {
        put(out, static_cast<std::int32_t>(v));
    }
}

image::Rect getRect(std::ifstream& in) {
    image::Rect rect;
    rect.x0 = get<std::int32_t>(in);
    rect.y0 = get<std::int32_t>(in);
    rect.x1 = get<std::int32_t>(in);
    rect.y1 = get<std::int32_t>(in);
    return rect;
}

class TestReader final : public io::ImageReader {
public:
    TestReader(std::filesystem::path file, std::shared_ptr<TestFormatCounters> counters)
        : m_file(std::move(file)),
          m_counters(std::move(counters)) {
        std::ifstream in(m_file, std::ios::binary);
        std::array<char, 8> header{};
        in.read(header.data(), header.size());
        if (!in || header != magic) {
            throw io::FileError("cannot open " + io::pathToUtf8(m_file) + ": not a test image");
        }
        m_info.displayWindow = getRect(in);
        m_info.dataWindow = getRect(in);
        const auto count = get<std::uint32_t>(in);
        for (std::uint32_t i = 0; i < count; ++i) {
            std::string name(get<std::uint32_t>(in), '\0');
            in.read(name.data(), static_cast<std::streamsize>(name.size()));
            m_info.channels.insert(name);
        }
        m_samplesStart = in.tellg();
        ++m_counters->opens;
    }

    [[nodiscard]] const io::ImageFileInfo& info() const override { return m_info; }

    [[nodiscard]] image::Image read(const image::ChannelSet& channels, const image::Rect& region,
                                    const io::ParallelFor& /*parallel*/) const override {
        ++m_counters->reads;
        const image::Rect window = image::intersect(region, m_info.dataWindow);
        const image::ChannelSet wanted = image::intersect(channels, m_info.channels);
        image::Image result(m_info.displayWindow, window, wanted);
        if (window.isEmpty()) {
            return result;
        }
        std::ifstream in(m_file, std::ios::binary);
        const auto planeSize = static_cast<std::size_t>(m_info.dataWindow.area());
        std::vector<float> plane(planeSize);
        for (const std::string& channel : wanted) {
            ++m_counters->channelsRead;
            const std::optional<std::size_t> index = m_info.channels.indexOf(channel);
            if (!index) {
                continue;
            }
            const std::streamoff planeBytes =
                static_cast<std::streamoff>(planeSize) * static_cast<std::streamoff>(sizeof(float));
            in.seekg(m_samplesStart + (static_cast<std::streamoff>(*index) * planeBytes));
            std::vector<char> bytes(planeSize * sizeof(float));
            in.read(bytes.data(), static_cast<std::streamsize>(bytes.size()));
            std::memcpy(plane.data(), bytes.data(), bytes.size());
            if (!in) {
                throw io::FileError("cannot read " + io::pathToUtf8(m_file) + ": the file is cut short");
            }
            result.write(result.channelIndex(channel), m_info.dataWindow, plane,
                         static_cast<std::size_t>(m_info.dataWindow.width()));
        }
        return result;
    }

private:
    std::filesystem::path m_file;
    std::shared_ptr<TestFormatCounters> m_counters;
    io::ImageFileInfo m_info;
    std::streampos m_samplesStart;
};

} // namespace

void writeTestImage(const std::filesystem::path& file, const image::Image& image) {
    std::ofstream out(file, std::ios::binary | std::ios::trunc);
    out.write(magic.data(), magic.size());
    putRect(out, image.displayWindow());
    putRect(out, image.dataWindow());
    put(out, static_cast<std::uint32_t>(image.channelCount()));
    for (const std::string& channel : image.channels()) {
        put(out, static_cast<std::uint32_t>(channel.size()));
        out.write(channel.data(), static_cast<std::streamsize>(channel.size()));
    }
    const image::Rect& data = image.dataWindow();
    std::vector<float> plane(static_cast<std::size_t>(data.area()));
    for (std::size_t c = 0; c < image.channelCount(); ++c) {
        image.read(c, data, plane, static_cast<std::size_t>(data.width()));
        std::vector<char> bytes(plane.size() * sizeof(float));
        std::memcpy(bytes.data(), plane.data(), bytes.size());
        out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    }
    if (!out) {
        throw std::runtime_error("cannot write " + io::pathToUtf8(file));
    }
}

io::ImageFormat testImageFormat(std::shared_ptr<TestFormatCounters> counters) {
    return {.name = "Test image",
            .extensions = {"pftest"},
            .open = [counters = std::move(counters)](const std::filesystem::path& file) {
                return std::make_unique<TestReader>(file, counters);
            }};
}

TemporaryFolder::TemporaryFolder() {
    std::random_device random;
    m_path =
        std::filesystem::temp_directory_path() / ("pf-test-" + std::to_string(random()) + std::to_string(random()));
    std::filesystem::create_directories(m_path);
}

TemporaryFolder::~TemporaryFolder() {
    std::error_code ignored;
    std::filesystem::remove_all(m_path, ignored);
}

std::filesystem::path TemporaryFolder::file(std::string_view name) const {
    return m_path / io::pathFromUtf8(name);
}

NodeBench::NodeBench() {
    io::addBuiltinFormats(*formats);
    formats->add(testImageFormat(counters));
    nodes::registerBuiltinNodes(types, formats);
}

graph::NodeId NodeBench::add(std::string_view typeId) {
    const std::shared_ptr<const graph::NodeDef> def = types.find(typeId);
    if (!def) {
        throw std::invalid_argument("no node type " + std::string(typeId));
    }
    return graph.addNode(def);
}

graph::NodeId NodeBench::read(const image::Image& image, std::string_view name) {
    const std::filesystem::path file = folder.file(name);
    writeTestImage(file, image);
    const graph::NodeId node = add("Read");
    graph.setValue(node, "file", io::pathToUtf8(file));
    return node;
}

image::Image NodeBench::evaluate(graph::NodeId node, const image::ChannelSet& channels, double frame, int proxyScale) {
    constexpr image::Rect everything{.x0 = -image::maxCoordinate / 2,
                                     .y0 = -image::maxCoordinate / 2,
                                     .x1 = image::maxCoordinate / 2,
                                     .y1 = image::maxCoordinate / 2};
    return evaluator.evaluate(
        graph, {.node = node, .frame = frame, .region = everything, .channels = channels, .proxyScale = proxyScale});
}

golden::Image toGolden(const image::Image& image) {
    const auto box = [](const image::Rect& r) {
        return golden::Box{.minX = r.x0, .minY = r.y0, .maxX = r.x1 - 1, .maxY = r.y1 - 1};
    };
    golden::Image result{
        .displayWindow = box(image.displayWindow()), .dataWindow = box(image.dataWindow()), .channels = {}};
    const image::Rect& data = image.dataWindow();
    for (std::size_t c = 0; c < image.channelCount(); ++c) {
        golden::Channel& channel = result.addChannel(image.channels()[c]);
        image.read(c, data, channel.samples, static_cast<std::size_t>(data.width()));
    }
    return result;
}

} // namespace pf::testing
