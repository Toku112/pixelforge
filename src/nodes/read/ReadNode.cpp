#include "nodes/read/ReadNode.h"

#include "core/anim/FrameRange.h"
#include "core/graph/Evaluation.h"
#include "core/graph/NodeOp.h"
#include "core/image/ChannelSet.h"
#include "io/FileStamp.h"
#include "io/sequence/FramePattern.h"
#include "io/sequence/Sequence.h"
#include "io/sequence/SequenceIndex.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <list>
#include <mutex>
#include <optional>
#include <stdexcept>
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

// What the node shows at a frame (docs/specs/sequences.md §4), worked out once per frame and evaluation.
class ReadFrame final : public graph::PreparedFrame {
public:
    enum class Show : std::uint8_t {
        Nothing,      // no file
        File,         // the file at `path`
        Black,        // nothing in the size and channels of the file at `path`
        Checkerboard, // a stand-in for a missing frame, in the size and channels of the file at `path`
    };

    ReadFrame(Show what, std::string file, io::FileStamp fileStamp)
        : show(what),
          path(std::move(file)),
          stamp(fileStamp) {}

    Show show;
    std::string path; // UTF-8
    io::FileStamp stamp;
};

enum class MissingFrames : std::uint8_t { Error, Hold, Black, Checkerboard };

// The stand-in for missing frames (FORMAT_NOTES §23.5): squares of 64 full-resolution pixels.
constexpr int checkerSquare = 64;
constexpr float checkerLight = 0.4F;
constexpr float checkerDark = 0.1F;

const ReadFrame& shown(const NodeContext& node) {
    const auto* frame = dynamic_cast<const ReadFrame*>(node.prepared());
    if (frame == nullptr) {
        throw std::logic_error("the Read node was not prepared for this frame");
    }
    return *frame;
}

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

// A Read node's sequence settings at one frame (docs/specs/sequences.md §4).
struct SequenceSettings {
    // The file frame asked for, before the range settings: the comp frame rounded, minus the offset. Every frame the
    // range settings give lies in the range, which lies within ±io::maxFileFrame (the parameters' limits, or frames
    // on disk), so it has a file name.
    std::int64_t frame = 0;
    bool autoRange = true;
    anim::FrameRange customRange;
    anim::OutsideRange before = anim::OutsideRange::Hold;
    anim::OutsideRange after = anim::OutsideRange::Hold;
    MissingFrames missing = MissingFrames::Checkerboard;
};

SequenceSettings sequenceSettings(const NodeContext& node) {
    const graph::ParamValues& params = node.params();
    const std::int64_t first = params.getInt("first");
    const std::int64_t last = params.getInt("last");
    return {.frame = anim::wholeFrame(node.frame()) - params.getInt("offset"),
            .autoRange = params.getBool("autoRange"),
            .customRange = {.first = std::min(first, last), .last = std::max(first, last)},
            .before = static_cast<anim::OutsideRange>(params.getInt("before")),
            .after = static_cast<anim::OutsideRange>(params.getInt("after")),
            .missing = static_cast<MissingFrames>(params.getInt("missing"))};
}

std::string folderText(const io::FramePattern& pattern) {
    return pattern.folder().empty() ? std::string("the current folder") : io::pathToUtf8(pattern.folder());
}

// The file at `path` shown as `show`; null when it is gone and the listing may be out of date (!final).
std::shared_ptr<const ReadFrame> showFile(ReadFrame::Show show, const std::filesystem::path& path, bool final) {
    const io::FileStamp stamp = io::fileStamp(path);
    if (!stamp.exists && !final) {
        return nullptr;
    }
    return std::make_shared<const ReadFrame>(show, io::pathToUtf8(path), stamp);
}

// What a sequence shows at one frame (FORMAT_NOTES §23.4), from a listing of its folder. The listing may be out of
// date (a file written or deleted within one tick of the folder's time, or a file system that updates folder times
// late): when it disagrees with the files themselves the result is null, unless `final`, and the caller lists the
// folder again.
std::shared_ptr<const ReadFrame> resolveFrame(const io::Sequence& sequence, const SequenceSettings& settings,
                                              bool final) {
    const io::FramePattern& pattern = sequence.pattern();
    const std::optional<anim::FrameRange> onDisk = sequence.range();
    if (!onDisk) {
        if (!final) {
            return nullptr;
        }
        throw io::FileError("no files match " + pattern.fileNameText() + " in " + folderText(pattern));
    }
    const anim::FrameRange range = settings.autoRange ? *onDisk : settings.customRange;
    const std::optional<std::int64_t> frame =
        anim::frameInRange(settings.frame, range, settings.before, settings.after);
    if (!frame) {
        const io::SequenceFile* reference = sequence.nearest(std::clamp(settings.frame, range.first, range.last));
        return showFile(ReadFrame::Show::Black, sequence.path(*reference), final);
    }

    if (const io::SequenceFile* file = sequence.find(*frame)) {
        const std::filesystem::path path = sequence.path(*file);
        const io::FileStamp stamp = io::fileStamp(path);
        if (stamp.exists) {
            return std::make_shared<const ReadFrame>(ReadFrame::Show::File, io::pathToUtf8(path), stamp);
        }
        if (!final) {
            return nullptr; // deleted since the listing
        }
    } else {
        for (const std::string& name : pattern.fileNames(*frame)) {
            const std::filesystem::path path = pattern.folder() / io::pathFromUtf8(name);
            const io::FileStamp stamp = io::fileStamp(path);
            if (stamp.exists) {
                if (!final) {
                    return nullptr; // written since the listing
                }
                return std::make_shared<const ReadFrame>(ReadFrame::Show::File, io::pathToUtf8(path), stamp);
            }
        }
    }

    switch (settings.missing) {
    case MissingFrames::Error:
        break;
    case MissingFrames::Hold: {
        const io::SequenceFile* held = sequence.before(*frame);
        if (held == nullptr || held->frame < range.first) {
            held = sequence.after(*frame);
        }
        if (held == nullptr || held->frame > range.last) {
            throw io::FileError("none of the frames " + anim::toString(std::vector{range}) + " of " +
                                pattern.fileNameText() + " exist in " + folderText(pattern));
        }
        return showFile(ReadFrame::Show::File, sequence.path(*held), final);
    }
    case MissingFrames::Black:
        return showFile(ReadFrame::Show::Black, sequence.path(*sequence.nearest(*frame)), final);
    case MissingFrames::Checkerboard:
        return showFile(ReadFrame::Show::Checkerboard, sequence.path(*sequence.nearest(*frame)), final);
    }
    throw io::FileError("frame " + std::to_string(*frame) + " of " + pattern.fileNameText() + " is missing (" +
                        pattern.fileName(*frame) + " does not exist in " + folderText(pattern) + ")");
}

class ReadOp final : public graph::NodeOp {
public:
    explicit ReadOp(std::shared_ptr<const io::FormatRegistry> formats) : m_files(std::move(formats)) {}

    [[nodiscard]] std::shared_ptr<const graph::PreparedFrame> prepare(const NodeContext& node) const override {
        const std::string& path = node.params().getString("file");
        if (path.empty()) {
            return std::make_shared<const ReadFrame>(ReadFrame::Show::Nothing, std::string(), io::FileStamp{});
        }
        if (const std::optional<io::FramePattern> pattern = io::FramePattern::parse(path)) {
            const SequenceSettings settings = sequenceSettings(node);
            if (std::shared_ptr<const ReadFrame> frame = resolveFrame(*m_sequences.get(*pattern), settings, false)) {
                return frame;
            }
            return resolveFrame(*m_sequences.get(*pattern, true), settings, true); // listed again
        }
        // A still: the same file at every frame.
        return std::make_shared<const ReadFrame>(ReadFrame::Show::File, path, io::fileStamp(io::pathFromUtf8(path)));
    }

    void hashExtra(const NodeContext& node, graph::Hasher& hasher) const override {
        const ReadFrame& frame = shown(node);
        hasher.addInteger(static_cast<int>(frame.show))
            .addText(frame.path)
            .addBool(frame.stamp.exists)
            .addUnsigned(frame.stamp.size)
            .addInteger(frame.stamp.modified);
    }

    [[nodiscard]] OutputInfo info(const NodeContext& node, int proxyScale,
                                  std::span<const OutputInfo> /*inputs*/) const override {
        const ReadFrame& frame = shown(node);
        if (frame.show == ReadFrame::Show::Nothing) {
            return {};
        }
        const std::shared_ptr<const io::ImageReader> reader = m_files.get(frame.path, frame.stamp);
        const io::ImageFileInfo& file = reader->info();
        if (file.channels.empty() && !file.notes.empty()) {
            // Nothing readable, and the reader says why (a file of deep data only).
            std::string why = file.notes.front();
            for (std::size_t i = 1; i < file.notes.size(); ++i) {
                why += "; " + file.notes[i];
            }
            throw io::FileError("cannot show " + frame.path + ": " + why);
        }
        OutputInfo info{.displayWindow = graph::scaleForProxy(file.displayWindow, proxyScale),
                        .dataWindow = graph::scaleForProxy(file.dataWindow, proxyScale),
                        .channels = file.channels};
        if (frame.show == ReadFrame::Show::Black) {
            info.dataWindow = {};
        } else if (frame.show == ReadFrame::Show::Checkerboard) {
            info.dataWindow = info.displayWindow;
        }
        return info;
    }

    void render(const graph::RenderContext& context) const override {
        const ReadFrame& frame = shown(context.node());
        if (frame.show == ReadFrame::Show::Checkerboard) {
            renderCheckerboard(context);
            return;
        }
        if (frame.show != ReadFrame::Show::File) {
            return; // nothing, or black: no data window, so no tiles
        }
        const std::shared_ptr<const io::ImageReader> reader = m_files.get(frame.path, frame.stamp);
        const int p = context.proxyScale();
        const Rect& region = context.region();
        // Decoding is spread over the evaluation's threads (and stops when it is cancelled).
        const io::ParallelFor parallel(
            [&](std::size_t count, const io::ParallelFor::Body& body) { context.tasks().forEach(count, body); });
        const Image pixels = reader->read(
            context.channels(), {.x0 = region.x0 * p, .y0 = region.y0 * p, .x1 = region.x1 * p, .y1 = region.y1 * p},
            parallel);
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

    // The main layer's colour channels (R, G, B, Y) get the checkerboard, its alpha 1, every other channel 0. The
    // squares are aligned to pixel (0, 0) and a whole number of proxy pixels wide at every proxy scale, so a proxy
    // frame is exactly the box-filtered full-resolution one (except along the right and bottom edge when the frame's
    // size is not a multiple of the proxy scale: those pixels are filled completely).
    static void renderCheckerboard(const graph::RenderContext& context) {
        const int square = checkerSquare / context.proxyScale();
        const auto cell = [square](int v) { return v >= 0 ? v / square : ((v + 1) / square) - 1; };
        Image& output = context.output();
        context.forEachTile([&](TileCoord tile) {
            for (const std::string& channel : context.channels()) {
                const std::size_t index = output.channelIndex(channel);
                const std::string_view suffix = image::suffixOf(channel);
                const bool mainLayer = image::layerOf(channel).empty();
                if (!mainLayer || (suffix != "R" && suffix != "G" && suffix != "B" && suffix != "Y")) {
                    output.setTileConstant(index, tile, mainLayer && suffix == "A" ? 1.0F : 0.0F);
                    continue;
                }
                const image::MutableTile out = output.overwriteTile(index, tile);
                for (int y = out.rect.y0; y < out.rect.y1; ++y) {
                    for (int x = out.rect.x0; x < out.rect.x1; ++x) {
                        out.at(x, y) = (cell(x) + cell(y)) % 2 == 0 ? checkerLight : checkerDark;
                    }
                }
            }
        });
    }

    OpenFiles m_files;
    io::SequenceIndex m_sequences;
};

graph::ParamDef fixed(graph::ParamDef def) {
    def.animatable = false;
    return def;
}

std::vector<graph::EnumItem> outsideItems() {
    return {{.id = "hold", .label = "Hold"},
            {.id = "loop", .label = "Loop"},
            {.id = "bounce", .label = "Bounce"},
            {.id = "black", .label = "Black"}};
}

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
        .params =
            {
                graph::fileParam("file", "File"),
                fixed(graph::boolParam("autoRange", "Frame range from files", true)),
                fixed(graph::intParam("first", "First frame", 1, -io::maxFileFrame, io::maxFileFrame)),
                fixed(graph::intParam("last", "Last frame", 1, -io::maxFileFrame, io::maxFileFrame)),
                fixed(graph::intParam("offset", "Frame offset", 0, -io::maxFileFrame, io::maxFileFrame)),
                fixed(graph::enumParam("before", "Before first frame", outsideItems(), 0)),
                fixed(graph::enumParam("after", "After last frame", outsideItems(), 0)),
                fixed(graph::enumParam("missing", "Missing frames",
                                       {{.id = "error", .label = "Error"},
                                        {.id = "hold", .label = "Hold previous frame"},
                                        {.id = "black", .label = "Black"},
                                        {.id = "checkerboard", .label = "Checkerboard"}},
                                       3)),
            },
        .op = std::make_shared<const ReadOp>(std::move(formats)),
    });
}

} // namespace pf::nodes
