// Timing of image-sequence handling (PLAN Part C item 10, docs/specs/sequences.md). Throw-away measurement, never
// linked into the app.
//
// Makes folders of 100, 1,000 and 10,000 empty frame files (plus 200 other files) and times listing a pattern's
// frames, detecting the sequence of a picked file, listing the folder, a snapshot with stamps, and the Read node's
// per-frame work: hashing a Read node at every frame of the sequence (which file shows, its stamp) with the folder
// listing cached, for present and for missing frames. With a folder of a real sequence as argument it also detects
// that sequence and hashes every frame of it.

#include "core/graph/Graph.h"
#include "core/graph/NodeDef.h"
#include "engine/Evaluator.h"
#include "engine/MemoryBudget.h"
#include "io/Formats.h"
#include "io/ImageReader.h"
#include "io/sequence/FramePattern.h"
#include "io/sequence/Sequence.h"
#include "io/sequence/SequenceIndex.h"
#include "nodes/Builtins.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <random>
#include <string>
#include <vector>

namespace {

using namespace pf;
using Clock = std::chrono::steady_clock;

// Best of `runs`, in milliseconds.
double bestOf(int runs, const std::function<void()>& work) {
    double best = 1e300;
    for (int i = 0; i < runs; ++i) {
        const auto start = Clock::now();
        work();
        best = std::min(best, std::chrono::duration<double, std::milli>(Clock::now() - start).count());
    }
    return best;
}

struct ReadBench {
    std::shared_ptr<io::FormatRegistry> formats = std::make_shared<io::FormatRegistry>();
    graph::NodeRegistry types;
    engine::MemoryBudget budget{std::size_t{1} << 32};
    engine::Evaluator evaluator{budget};
    graph::Graph graph;
    graph::NodeId read;

    explicit ReadBench(const std::string& pattern) {
        io::addBuiltinFormats(*formats);
        nodes::registerBuiltinNodes(types, formats);
        read = graph.addNode(types.find("Read"));
        graph.setValue(read, "file", pattern);
    }

    // Milliseconds per frame to hash frames first … last (a fresh evaluation per frame, as playback asks).
    double hashPerFrame(std::int64_t first, std::int64_t last) {
        std::uint64_t sink = 0;
        const double total = bestOf(5, [&] {
            for (std::int64_t frame = first; frame <= last; ++frame) {
                sink += evaluator.hash(graph, read, static_cast<double>(frame));
            }
        });
        if (sink == 42) {
            std::printf(" ");
        }
        return total / static_cast<double>(last - first + 1);
    }
};

void measureFolder(const std::filesystem::path& root, int frames) {
    const std::filesystem::path folder = root / ("frames" + std::to_string(frames));
    std::filesystem::create_directories(folder);
    const io::FramePattern pattern(folder, "shot010_v002.", 4, ".exr");
    for (int frame = 1; frame <= frames; ++frame) {
        if (frame % 50 != 25) { // a gap every 50 frames
            std::ofstream(folder / pattern.fileName(frame)) << "x";
        }
    }
    for (int i = 0; i < 200; ++i) {
        std::ofstream(folder / ("other_" + std::to_string(i) + ".txt")) << "x";
    }
    std::printf("\n%d frames (every 50th missing) + 200 other files\n", frames);

    std::size_t found = 0;
    std::size_t sequences = 0;
    std::printf("  scan the pattern            %8.3f ms\n",
                bestOf(5, [&] { found = io::scanSequence(pattern).files().size(); }));
    std::printf("  scan with stamps (snapshot) %8.3f ms\n",
                bestOf(5, [&] { found = io::scanSequence(pattern, {.stamps = true}).files().size(); }));
    std::printf("  detect from one file        %8.3f ms\n",
                bestOf(5, [&] { found = io::detectSequence(folder / pattern.fileName(1)).value().files().size(); }));
    std::printf("  list the folder             %8.3f ms\n",
                bestOf(5, [&] { sequences = io::scanFolder(folder).sequences.size(); }));
    const io::SequenceIndex index;
    (void)index.get(pattern);
    std::printf("  index, unchanged folder     %8.4f ms\n", bestOf(50, [&] { (void)index.get(pattern); }));
    std::printf("  (%zu frames found; %zu sequences in the folder: the frames and other_###.txt)\n", found, sequences);

    ReadBench bench(io::pathToUtf8(folder / "shot010_v002.####.exr"));
    std::printf("  Read hash per frame         %8.4f ms (all frames)\n", bench.hashPerFrame(1, frames));
    bench.graph.setValue(bench.read, "missing", std::int64_t{3}); // checkerboard
    double missing = 0.0;
    for (int frame = 25; frame <= std::min(frames, 1000); frame += 50) {
        missing = std::max(missing, bench.hashPerFrame(frame, frame));
    }
    std::printf("  Read hash, missing frame    %8.4f ms (slowest)\n", missing);
}

void measureRealSequence(const std::filesystem::path& folder) {
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(folder)) {
        if (entry.is_regular_file() && !entry.path().filename().string().starts_with('.')) {
            files.push_back(entry.path());
        }
    }
    std::sort(files.begin(), files.end());
    if (files.empty()) {
        return;
    }
    std::optional<io::Sequence> sequence;
    const double detect = bestOf(5, [&] { sequence = io::detectSequence(files.front()); });
    if (!sequence) {
        std::printf("\n%s: no sequence\n", io::pathToUtf8(folder).c_str());
        return;
    }
    const anim::FrameRange range = *sequence->range();
    std::printf("\nreal sequence %s: %s, frames %lld-%lld (%zu files)\n", io::pathToUtf8(folder).c_str(),
                sequence->pattern().fileNameText().c_str(), static_cast<long long>(range.first),
                static_cast<long long>(range.last), sequence->files().size());
    std::printf("  detect from one file        %8.3f ms\n", detect);
    ReadBench bench(sequence->pattern().text());
    std::printf("  Read hash per frame         %8.4f ms\n", bench.hashPerFrame(range.first, range.last));
}

} // namespace

int main(int argc, char** argv) {
    std::random_device random;
    const std::filesystem::path root =
        std::filesystem::temp_directory_path() / ("pf-sequence-bench-" + std::to_string(random()));
    std::filesystem::create_directories(root);
    for (const int frames : {100, 1000, 10000}) {
        measureFolder(root, frames);
    }
    std::filesystem::remove_all(root);
    for (int i = 1; i < argc; ++i) {
        measureRealSequence(argv[i]);
    }
    return 0;
}
