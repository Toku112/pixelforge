#include "engine/SystemMemory.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#elif defined(__APPLE__)
#include <sys/sysctl.h>
#include <sys/types.h>
#else
#include <unistd.h>
#endif

#include <cstdint>

namespace pf::engine {

std::size_t physicalMemoryBytes() noexcept {
#ifdef _WIN32
    MEMORYSTATUSEX status{};
    status.dwLength = sizeof(status);
    if (GlobalMemoryStatusEx(&status) == 0) {
        return 0;
    }
    return static_cast<std::size_t>(status.ullTotalPhys);
#elif defined(__APPLE__)
    std::uint64_t bytes = 0;
    std::size_t size = sizeof(bytes);
    if (sysctlbyname("hw.memsize", &bytes, &size, nullptr, 0) != 0) {
        return 0;
    }
    return static_cast<std::size_t>(bytes);
#else
    const long pages = sysconf(_SC_PHYS_PAGES);
    const long pageSize = sysconf(_SC_PAGE_SIZE);
    if (pages <= 0 || pageSize <= 0) {
        return 0;
    }
    return static_cast<std::size_t>(pages) * static_cast<std::size_t>(pageSize);
#endif
}

} // namespace pf::engine
