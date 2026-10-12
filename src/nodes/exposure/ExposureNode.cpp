#include "nodes/exposure/ExposureNode.h"

#include "core/graph/NodeOp.h"
#include "core/image/Alpha.h"

#include <algorithm>
#include <cmath>
#include <optional>
#include <string>

namespace pf::nodes {
namespace {

using graph::NodeContext;
using graph::OutputInfo;
using image::Image;
using image::TileCoord;

// Settings turned into the numbers the per-sample loop needs.
class Adjustment {
public:
    explicit Adjustment(const ExposureSettings& settings)
        : m_gain(static_cast<float>(std::exp2(settings.exposure))),
          m_offset(static_cast<float>(settings.offset)),
          m_power(static_cast<float>(1.0 / settings.gamma)),
          m_hasPower(settings.gamma != 1.0) {}

    // Exposure alone is a multiplication, which gives the same result on premultiplied values.
    [[nodiscard]] bool isScaleOnly() const { return m_offset == 0.0F && !m_hasPower; }

    [[nodiscard]] float straight(float value) const {
        float v = (value * m_gain) + m_offset;
        if (m_hasPower) {
            v = v >= 0.0F ? std::pow(v, m_power) : -std::pow(-v, m_power); // mirrored below 0 (NaN stays NaN)
        }
        return v;
    }

    [[nodiscard]] float premultiplied(float value, float alpha) const {
        if (isScaleOnly()) {
            return value * m_gain;
        }
        return alpha != 0.0F ? image::premultiplied(straight(image::unpremultiplied(value, alpha)), alpha)
                             : straight(value);
    }

private:
    float m_gain;
    float m_offset;
    float m_power;
    bool m_hasPower;
};

ExposureSettings settingsOf(const graph::ParamValues& params) {
    return {.exposure = params.getFloat("exposure"),
            .offset = params.getFloat("offset"),
            .gamma = params.getFloat("gamma")};
}

std::string alphaOf(const std::string& layer) {
    return layer.empty() ? "A" : layer + ".A";
}

bool isColourChannel(std::string_view channel, std::string_view layer) {
    if (image::layerOf(channel) != layer) {
        return false;
    }
    const std::string_view suffix = image::suffixOf(channel);
    return suffix == "R" || suffix == "G" || suffix == "B" || suffix == "Y";
}

class ExposureOp final : public graph::NodeOp {
public:
    [[nodiscard]] std::optional<std::size_t> passThroughInput(const NodeContext& node) const override {
        if (settingsOf(node.params()).isNeutral()) {
            return 0;
        }
        return std::nullopt;
    }

    [[nodiscard]] OutputInfo info(const NodeContext& /*node*/, int /*proxyScale*/,
                                  std::span<const OutputInfo> inputs) const override {
        return inputs[0];
    }

    [[nodiscard]] graph::InputRequest inputRequest(const graph::RegionContext& context,
                                                   std::size_t /*index*/) const override {
        graph::InputRequest request{
            .frame = context.frame(), .region = context.region(), .channels = context.channels()};
        const std::string& layer = context.params().getString("layer");
        const std::string alpha = alphaOf(layer);
        const bool colourWanted = std::ranges::any_of(
            context.channels(), [&](const std::string& channel) { return isColourChannel(channel, layer); });
        if (colourWanted && !Adjustment(settingsOf(context.params())).isScaleOnly() &&
            context.inputInfo(0).channels.contains(alpha)) {
            request.channels.insert(alpha);
        }
        return request;
    }

    void render(const graph::RenderContext& context) const override {
        const Adjustment adjustment(settingsOf(context.params()));
        const std::string& layer = context.params().getString("layer");
        const Image& input = context.input(0);
        Image& output = context.output();
        const std::string alphaName = alphaOf(layer);
        const std::optional<std::size_t> alpha =
            adjustment.isScaleOnly() ? std::nullopt : input.channels().indexOf(alphaName);

        context.forEachTile([&](TileCoord tile) {
            for (const std::string& channel : context.channels()) {
                const std::size_t to = output.channelIndex(channel);
                const std::size_t from = input.channelIndex(channel);
                if (!isColourChannel(channel, layer)) {
                    output.copyTile(to, tile, input, from);
                    continue;
                }
                const image::ConstTile colour = input.tile(from, tile);
                const image::ConstTile coverage =
                    alpha ? input.tile(*alpha, tile) : image::ConstTile{.rect = colour.rect, .constant = 1.0F};
                if (colour.isConstant() && coverage.isConstant()) {
                    output.setTileConstant(to, tile, adjustment.premultiplied(colour.constant, coverage.constant));
                    continue;
                }
                const image::MutableTile result = output.overwriteTile(to, tile);
                for (int y = result.rect.y0; y < result.rect.y1; ++y) {
                    for (int x = result.rect.x0; x < result.rect.x1; ++x) {
                        result.at(x, y) = adjustment.premultiplied(colour.at(x, y), coverage.at(x, y));
                    }
                }
            }
        });
    }
};

} // namespace

float applyExposure(float value, const ExposureSettings& settings) {
    return Adjustment(settings).straight(value);
}

float applyExposurePremultiplied(float value, float alpha, const ExposureSettings& settings) {
    return Adjustment(settings).premultiplied(value, alpha);
}

std::shared_ptr<const graph::NodeDef> makeExposureNodeDef() {
    return std::make_shared<const graph::NodeDef>(graph::NodeDef{
        .typeId = std::string(exposureTypeId),
        .version = 1,
        .label = "Exposure",
        .category = "Color",
        .inputs = {{.id = "source", .label = "Source"}},
        .hasOutput = true,
        .params = {graph::floatParam("exposure", "Exposure", 0.0, -20.0, 20.0, -20.0, 20.0),
                   graph::floatParam("offset", "Offset", 0.0, -0.5, 0.5, -0.5, 0.5),
                   graph::floatParam("gamma", "Gamma Correction", 1.0, 0.01, 9.99, 0.01, 9.99),
                   graph::stringParam("layer", "Layer")},
        .op = std::make_shared<const ExposureOp>(),
    });
}

} // namespace pf::nodes
