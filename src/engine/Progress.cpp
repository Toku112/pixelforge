#include "engine/Progress.h"

#include <algorithm>
#include <utility>

namespace pf::engine {

std::optional<double> Progress::fraction() const noexcept {
    const std::uint64_t total = this->total();
    if (total == 0) {
        return std::nullopt;
    }
    return std::min(1.0, static_cast<double>(done()) / static_cast<double>(total));
}

void Progress::setStatus(std::string status) {
    const std::scoped_lock lock(m_statusMutex);
    m_status = std::move(status);
}

std::string Progress::status() const {
    const std::scoped_lock lock(m_statusMutex);
    return m_status;
}

} // namespace pf::engine
