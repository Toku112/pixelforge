#include "nodes/read/ReadNode.h"

#include "core/graph/Evaluation.h"
#include "core/graph/NodeOp.h"
#include "io/FileStamp.h"

#include <cstddef>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace pf::nodes {
namespace {

using graph::NodeContext;
using graph::OutputInfo;
using image::Image;
using image::Rect;
using image::TileCoord;

// Open files, most recently used first. Opening happens outside the lock (it reads the file's header), so two
// threads may open the same file at once; the second result simply replaces the first.
class OpenFiles {
public:
    explicit OpenFiles(std::shared_ptr<const io::FormatRegistry> formats) : m_formats(std::move(formats)) {}

    // The reader for `path` as the file is now (`stamp`); opens it when it is new or was rewritten. Throws
    // io::FileError.
    [[nodiscard]] std::shared_ptr<const io::ImageReader> get(const std::string& path,
                                                             const io::FileStamp& stamp) const {
        {
            const std::scoped_lock lock(m_mutex);
            for (auto entry = m_entries.begin(); entry != m_entries.end(); ++entry) {
                if (entry->path == path && entry->stamp == stamp) {
                    m_entries.splice(m_entries.begin(), m_entries, entry);
                    return entry->reader;
                }
            }
        }
        std::shared_ptr<const io::ImageReader> reader = m_formats->open(io::pathFromUtf8(path));
        const std::scoped_lock lock(m_mutex);
        std::erase_if(m_entries, [&](const Entry& entry) { return entry.path == path; });
        m_entries.push_front({.path = path, .stamp = stamp, .reader = reader});
        if (m_entries.size() > capacity) {
            m_entries.pop_back();
        }
        return reader;
    }

private:
    static constexpr std::size_t capacity = 64;

    struct Entry {
        std::string path;
        io::FileStamp stamp;
        std::shared_ptr<const io::ImageReader> reader;
    };

    std::shared_ptr<const io::FormatRegistry> m_formats;
    mutable std::mutex m_mutex;
    mutable std::list<Entry> m_entries;
};

class ReadOp final : public graph::NodeOp {
public:
    explicit ReadOp(std::shared_ptr<const io::FormatRegistry> formats) : m_files(std::move(formats)) {}

    void hashExtra(const NodeContext& node, graph::Hasher& hasher) const override {
        const std::string& path = node.params().getString("file");
        if (path.empty()) {
            return;
        }
        const io::FileStamp stamp = io::fileStamp(io::pathFromUtf8(path));
        hasher.addBool(stamp.exists).addUnsigned(stamp.size).addInteger(stamp.modified);
    }

    [[nodiscard]] OutputInfo info(const NodeContext& node, int proxyScale,
                                  std::span<const OutputInfo> /*inputs*/) const override {
        const std::shared_ptr<const io::ImageReader> reader = open(node);
        if (!reader) {
            return {};
        }
        const io::ImageFileInfo& file = reader->info();
        return {.displayWindow = graph::scaleForProxy(file.displayWindow, proxyScale),
                .dataWindow = graph::scaleForProxy(file.dataWindow, proxyScale),
                .channels = file.channels};
    }

    void render(const graph::RenderContext& context) const override {
        const std::shared_ptr<const io::ImageReader> reader = open(context.node());
        if (!reader) {
            return;
        }
        const int p = context.proxyScale();
        const Rect& region = context.region();
        const Image pixels = reader->read(
            context.channels(), {.x0 = region.x0 * p, .y0 = region.y0 * p, .x1 = region.x1 * p, .y1 = region.y1 * p});
        Image& output = context.output();
        context.forEachTile([&](TileCoord tile) {
            for (const std::string& channel : context.channels()) {
                const std::size_t to = output.channelIndex(channel);
                const std::optional<std::size_t> from = pixels.channels().indexOf(channel);
                if (!from) {
                    output.setTileConstant(to, tile, 0.0F); // the file changed since it was described
                } else if (p == 1) {
                    output.copyTile(to, tile, pixels, *from);
                } else {
                    downsample(pixels, *from, p, output.overwriteTile(to, tile));
                }
            }
        });
    }

private:
    // The open file the node names, or null when it names none.
    [[nodiscard]] std::shared_ptr<const io::ImageReader> open(const NodeContext& node) const {
        const std::string& path = node.params().getString("file");
        if (path.empty()) {
            return nullptr;
        }
        return m_files.get(path, io::fileStamp(io::pathFromUtf8(path)));
    }

    // Each output pixel is the average of the p × p full-resolution pixels it covers (0 outside the data window).
    static void downsample(const Image& pixels, std::size_t channel, int p, const image::MutableTile& out) {
        const Rect& rect = out.rect;
        const Rect source{.x0 = rect.x0 * p, .y0 = rect.y0 * p, .x1 = rect.x1 * p, .y1 = rect.y1 * p};
        const auto stride = static_cast<std::size_t>(source.width());
        std::vector<float> block(static_cast<std::size_t>(source.area()));
        pixels.read(channel, source, block, stride);
        const double scale = 1.0 / (static_cast<double>(p) * p);
        for (int y = rect.y0; y < rect.y1; ++y) {
            for (int x = rect.x0; x < rect.x1; ++x) {
                double sum = 0.0;
                const std::size_t column = static_cast<std::size_t>(x - rect.x0) * static_cast<std::size_t>(p);
                for (int j = 0; j < p; ++j) {
                    const std::size_t row = (static_cast<std::size_t>(((y - rect.y0) * p) + j) * stride) + column;
                    for (int i = 0; i < p; ++i) {
                        sum += static_cast<double>(block[row + static_cast<std::size_t>(i)]);
                    }
                }
                out.at(x, y) = static_cast<float>(sum * scale);
            }
        }
    }

    OpenFiles m_files;
};

} // namespace

std::shared_ptr<const graph::NodeDef> makeReadNodeDef(std::shared_ptr<const io::FormatRegistry> formats) {
    if (!formats) {
        throw std::invalid_argument("the Read node needs a format registry");
    }
    return std::make_shared<const graph::NodeDef>(graph::NodeDef{
        .typeId = std::string(readTypeId),
        .version = 1,
        .label = "Read",
        .category = "Image",
        .inputs = {},
        .hasOutput = true,
        .params = {graph::fileParam("file", "File")},
        .op = std::make_shared<const ReadOp>(std::move(formats)),
    });
}

} // namespace pf::nodes
