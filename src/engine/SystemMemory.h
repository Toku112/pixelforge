#pragma once

// Facts about the machine's memory, for the memory budget's default (MemoryBudget.h).

#include <cstddef>

namespace pf::engine {

// Installed physical memory in bytes; 0 when the system does not say.
[[nodiscard]] std::size_t physicalMemoryBytes() noexcept;

} // namespace pf::engine
