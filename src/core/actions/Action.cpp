#include "core/actions/Action.h"

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

namespace pf::actions {
namespace {

constexpr std::string_view formatName = "pixelforge-action";
constexpr std::int64_t formatVersion = 1;

[[noreturn]] void notAnAction(const std::string& why) {
    throw ActionError("not an action file: " + why, 0);
}

} // namespace

json::Value toJson(const Action& action) {
    json::Array steps;
    steps.reserve(action.steps.size());
    for (const commands::Descriptor& step : action.steps) {
        steps.push_back(commands::toJson(step));
    }
    return json::Object{
        {"format", formatName}, {"version", formatVersion}, {"name", action.name}, {"steps", std::move(steps)}};
}

Action actionFromJson(const json::Value& value) {
    if (!value.isObject()) {
        notAnAction("it is not a JSON object");
    }
    const json::Object& object = value.asObject();
    const json::Value* format = object.find("format");
    if (format == nullptr || !format->isString() || format->asString() != formatName) {
        notAnAction(R"("format" is not ")" + std::string(formatName) + "\"");
    }
    const json::Value* version = object.find("version");
    if (version == nullptr || !version->isInt() || version->asInt() < 1) {
        notAnAction("\"version\" is missing");
    }
    if (version->asInt() > formatVersion) {
        throw ActionError("this action was saved by a newer version (format " + std::to_string(version->asInt()) +
                              ") and cannot be read",
                          0);
    }
    Action action;
    if (const json::Value* name = object.find("name"); name != nullptr && name->isString()) {
        action.name = name->asString();
    }
    const json::Value* steps = object.find("steps");
    if (steps == nullptr || !steps->isArray()) {
        notAnAction("\"steps\" is missing");
    }
    for (std::size_t i = 0; i < steps->asArray().size(); ++i) {
        try {
            action.steps.push_back(commands::descriptorFromJson(steps->asArray()[i]));
        } catch (const commands::CommandError& error) {
            throw ActionError("step " + std::to_string(i + 1) + ": " + error.what(), i);
        }
    }
    return action;
}

Recorder::Recorder(history::History& history) : m_history(&history) {
    m_observer = history.addObserver([this](const history::Change& change) {
        if (change.descriptor == nullptr) {
            return;
        }
        if (change.kind == history::ChangeKind::Merged && !m_steps.empty()) {
            m_steps.back() = *change.descriptor;
        } else if (change.kind == history::ChangeKind::Executed || change.kind == history::ChangeKind::Merged) {
            m_steps.push_back(*change.descriptor);
        }
    });
}

Recorder::~Recorder() {
    stop();
}

void Recorder::stop() {
    if (m_history != nullptr) {
        m_history->removeObserver(m_observer);
        m_history = nullptr;
    }
}

std::size_t play(const Action& action, history::History& history) {
    commands::NameMap renames;
    std::size_t recorded = 0;
    for (std::size_t i = 0; i < action.steps.size(); ++i) {
        try {
            if (history.execute(action.steps[i], history::Merge::No, &renames)) {
                ++recorded;
            }
        } catch (const commands::CommandError& error) {
            throw ActionError("step " + std::to_string(i + 1) + " (" + action.steps[i].command + "): " + error.what(),
                              i);
        }
    }
    return recorded;
}

} // namespace pf::actions
