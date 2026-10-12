#include "support/golden/Compare.h"

#include "support/golden/DeltaE.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <format>
#include <limits>
#include <string_view>

namespace pf::golden {
namespace {

constexpr std::array<std::string_view, 4> deltaEChannels = {"R", "G", "B", "A"};
constexpr std::string_view deltaEChannelName = "golden.deltaE";
constexpr std::string_view failedChannelName = "golden.failed";
constexpr float infinity = std::numeric_limits<float>::infinity();
constexpr double infiniteRatio = std::numeric_limits<double>::infinity();

bool usesDeltaE(const CompareOptions& options, std::string_view channel) {
    return options.mode == CompareMode::DeltaE && std::ranges::find(deltaEChannels, channel) != deltaEChannels.end();
}

const FloatTolerance& toleranceFor(const CompareOptions& options, std::string_view channel) {
    const auto found = options.channelTolerances.find(channel);
    return found == options.channelTolerances.end() ? options.tolerance : found->second;
}

std::string number(double value) {
    return std::format("{:.6g}", value);
}

std::vector<std::string> findStructuralProblems(const Image& actual, const Image& expected,
                                                const CompareOptions& options) {
    std::vector<std::string> problems;
    if (actual.displayWindow != expected.displayWindow) {
        problems.push_back("display window differs: actual " + toString(actual.displayWindow) + ", expected " +
                           toString(expected.displayWindow));
    }
    if (actual.dataWindow != expected.dataWindow) {
        problems.push_back("data window differs: actual " + toString(actual.dataWindow) + ", expected " +
                           toString(expected.dataWindow));
    }
    for (const Channel& channel : expected.channels) {
        if (actual.find(channel.name) == nullptr) {
            problems.push_back("channel '" + channel.name + "' is missing from the actual image");
        }
    }
    for (const Channel& channel : actual.channels) {
        if (expected.find(channel.name) == nullptr) {
            problems.push_back("the actual image has an unexpected channel '" + channel.name + "'");
        }
    }
    for (const Image* image : {&actual, &expected}) {
        for (const Channel& channel : image->channels) {
            if (channel.samples.size() != image->pixelCount()) {
                problems.push_back(std::string(image == &actual ? "actual" : "expected") + " channel '" + channel.name +
                                   "' has " + std::to_string(channel.samples.size()) + " samples for " +
                                   std::to_string(image->pixelCount()) + " pixels");
            }
        }
    }
    for (const auto& [name, tolerance] : options.channelTolerances) {
        if (expected.find(name) == nullptr) {
            problems.push_back("a tolerance is given for channel '" + name + "', which the expected image lacks");
        }
    }
    if (options.mode == CompareMode::DeltaE) {
        for (const std::string_view name : {"R", "G", "B"}) {
            if (expected.find(name) == nullptr) {
                problems.push_back("ΔE mode needs channels R, G and B; the expected image has no '" +
                                   std::string(name) + "'");
            }
        }
    }
    return problems;
}

bool nonFiniteMatches(double actual, double expected, NonFinite policy) {
    if (policy != NonFinite::MustMatch) {
        return false;
    }
    return (std::isnan(actual) && std::isnan(expected)) || (std::isinf(actual) && actual == expected);
}

ChannelReport compareChannel(const Channel& actual, const Channel& expected, const Box& dataWindow,
                             const FloatTolerance& tolerance, Channel& difference, Channel& failed) {
    ChannelReport report;
    report.name = expected.name;
    report.sampleCount = expected.samples.size();
    const auto width = static_cast<std::size_t>(dataWindow.width());
    double errorSum = 0.0;
    std::size_t finiteCount = 0;
    double worstRatio = -1.0;

    for (std::size_t i = 0; i < report.sampleCount; ++i) {
        const auto a = static_cast<double>(actual.samples[i]);
        const auto e = static_cast<double>(expected.samples[i]);
        const bool actualFinite = std::isfinite(a);
        const bool expectedFinite = std::isfinite(e);
        if (!actualFinite) {
            ++report.nonFiniteActual;
        }
        if (!expectedFinite) {
            ++report.nonFiniteExpected;
        }
        if (!actualFinite || !expectedFinite) {
            if (nonFiniteMatches(a, e, tolerance.nonFinite)) {
                difference.samples[i] = 0.0F;
            } else {
                ++report.nonFiniteMismatches;
                difference.samples[i] = infinity;
                failed.samples[i] = 1.0F;
            }
            continue;
        }

        const double error = std::abs(a - e);
        const double allowed = std::max(tolerance.absolute, tolerance.relative * std::abs(e));
        difference.samples[i] = static_cast<float>(error);
        errorSum += error;
        ++finiteCount;
        report.maxError = std::max(report.maxError, error);
        if (error > allowed) {
            ++report.samplesOverTolerance;
            failed.samples[i] = 1.0F;
        }
        double ratio = error > 0.0 ? infiniteRatio : 0.0; // a zero allowance tolerates only exact matches
        if (allowed > 0.0) {
            ratio = error / allowed;
        }
        if (ratio > worstRatio) {
            worstRatio = ratio;
            report.worstX = dataWindow.minX + static_cast<int>(i % width);
            report.worstY = dataWindow.minY + static_cast<int>(i / width);
            report.worstActual = a;
            report.worstExpected = e;
            report.worstError = error;
            report.worstAllowed = allowed;
        }
    }

    report.meanError = finiteCount == 0 ? 0.0 : errorSum / static_cast<double>(finiteCount);
    report.passed = report.samplesOverTolerance == 0 && report.nonFiniteMismatches == 0;
    return report;
}

// The R, G, B and A channels of an image (A may be absent: opaque).
struct RgbaChannels {
    std::array<const Channel*, 4> channels{};

    explicit RgbaChannels(const Image& image) {
        for (std::size_t c = 0; c < deltaEChannels.size(); ++c) {
            channels.at(c) = image.find(deltaEChannels.at(c));
        }
    }
};

struct LinearRgba {
    std::array<double, 4> values{};
    bool finite = true;
};

LinearRgba readLinearRgba(const RgbaChannels& rgba, std::size_t index, RgbEncoding encoding) {
    LinearRgba pixel;
    for (std::size_t c = 0; c < rgba.channels.size(); ++c) {
        const Channel* channel = rgba.channels.at(c);
        const double value = channel == nullptr ? 1.0 : static_cast<double>(channel->samples[index]);
        pixel.finite = pixel.finite && std::isfinite(value);
        if (c < 3) {
            pixel.values.at(c) = encoding == RgbEncoding::Srgb ? srgbToLinear(value) : value;
        } else {
            pixel.values.at(c) = std::clamp(value, 0.0, 1.0);
        }
    }
    return pixel;
}

Lab compositeToLab(const LinearRgba& pixel, double background) {
    const double alpha = pixel.values[3];
    const double under = background * (1.0 - alpha);
    return linearSrgbToLab((pixel.values[0] * alpha) + under, (pixel.values[1] * alpha) + under,
                           (pixel.values[2] * alpha) + under);
}

DeltaEReport compareDeltaE(const Image& actual, const Image& expected, const DeltaETolerance& tolerance,
                           Channel& deltaE, Channel& failed) {
    DeltaEReport report;
    report.tolerance = tolerance;
    const auto width = static_cast<std::size_t>(expected.dataWindow.width());
    const RgbaChannels actualRgba(actual);
    const RgbaChannels expectedRgba(expected);
    double sum = 0.0;
    std::size_t finiteCount = 0;

    for (std::size_t i = 0; i < expected.pixelCount(); ++i) {
        const LinearRgba a = readLinearRgba(actualRgba, i, tolerance.encoding);
        const LinearRgba e = readLinearRgba(expectedRgba, i, tolerance.encoding);
        if (!a.finite || !e.finite) {
            ++report.nonFinitePixels;
            deltaE.samples[i] = infinity;
            failed.samples[i] = 1.0F;
            continue;
        }
        // Over black and over white: colour hidden under zero alpha is ignored, alpha differences are caught.
        const double difference = std::max(deltaE2000(compositeToLab(a, 0.0), compositeToLab(e, 0.0)),
                                           deltaE2000(compositeToLab(a, 1.0), compositeToLab(e, 1.0)));
        deltaE.samples[i] = static_cast<float>(difference);
        sum += difference;
        ++finiteCount;
        if (difference > report.maximum) {
            report.maximum = difference;
            report.maximumX = expected.dataWindow.minX + static_cast<int>(i % width);
            report.maximumY = expected.dataWindow.minY + static_cast<int>(i / width);
        }
        if (difference > tolerance.maximum) {
            ++report.pixelsOverMaximum;
            failed.samples[i] = 1.0F;
        }
    }

    report.average = finiteCount == 0 ? 0.0 : sum / static_cast<double>(finiteCount);
    report.passed =
        report.nonFinitePixels == 0 && report.average <= tolerance.average && report.maximum <= tolerance.maximum;
    return report;
}

} // namespace

CompareResult compare(const Image& actual, const Image& expected, const CompareOptions& options) {
    CompareResult result;
    result.structuralProblems = findStructuralProblems(actual, expected, options);
    if (!result.structuralProblems.empty()) {
        return result;
    }

    Image difference;
    difference.displayWindow = expected.displayWindow;
    difference.dataWindow = expected.dataWindow;
    for (const Channel& channel : expected.channels) {
        if (!usesDeltaE(options, channel.name)) {
            difference.addChannel(channel.name);
        }
    }
    if (options.mode == CompareMode::DeltaE) {
        difference.addChannel(deltaEChannelName);
    }
    difference.addChannel(failedChannelName);
    Channel& failed = difference.channel(failedChannelName);

    bool passed = true;
    for (const Channel& channel : expected.channels) {
        if (usesDeltaE(options, channel.name)) {
            continue;
        }
        ChannelReport report =
            compareChannel(actual.channel(channel.name), channel, expected.dataWindow,
                           toleranceFor(options, channel.name), difference.channel(channel.name), failed);
        passed = passed && report.passed;
        result.channels.push_back(std::move(report));
    }
    if (options.mode == CompareMode::DeltaE) {
        result.deltaE = compareDeltaE(actual, expected, options.deltaE, difference.channel(deltaEChannelName), failed);
        passed = passed && result.deltaE->passed;
    }

    result.passed = passed;
    result.difference = std::move(difference);
    return result;
}

std::string CompareResult::describe() const {
    if (passed) {
        return "match";
    }
    std::string text;
    const auto addLine = [&text](const std::string& line) {
        if (!text.empty()) {
            text += '\n';
        }
        text += line;
    };

    for (const std::string& problem : structuralProblems) {
        addLine(problem);
    }
    for (const ChannelReport& channel : channels) {
        if (channel.passed) {
            continue;
        }
        if (channel.samplesOverTolerance > 0) {
            addLine(std::format("{}: {} of {} samples over tolerance; worst at ({}, {}): actual {}, expected {}, "
                                "difference {} (allowed {}); largest difference {}, mean {}",
                                channel.name, channel.samplesOverTolerance, channel.sampleCount, channel.worstX,
                                channel.worstY, number(channel.worstActual), number(channel.worstExpected),
                                number(channel.worstError), number(channel.worstAllowed), number(channel.maxError),
                                number(channel.meanError)));
        }
        if (channel.nonFiniteMismatches > 0) {
            addLine(std::format("{}: {} samples fail on NaN or infinity (the actual image has {}, the expected {})",
                                channel.name, channel.nonFiniteMismatches, channel.nonFiniteActual,
                                channel.nonFiniteExpected));
        }
    }
    if (deltaE && !deltaE->passed) {
        addLine(std::format("ΔE2000: average {} (limit {}), maximum {} at ({}, {}) (limit {}), {} pixels over the "
                            "maximum",
                            number(deltaE->average), number(deltaE->tolerance.average), number(deltaE->maximum),
                            deltaE->maximumX, deltaE->maximumY, number(deltaE->tolerance.maximum),
                            deltaE->pixelsOverMaximum));
        if (deltaE->nonFinitePixels > 0) {
            addLine(std::format("ΔE2000: {} pixels have NaN or infinity in R, G, B or A", deltaE->nonFinitePixels));
        }
    }
    return text;
}

} // namespace pf::golden
