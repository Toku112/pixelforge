#include "engine/TilePool.h"

#include <tbb/scalable_allocator.h>

#include <algorithm>
#include <new>

// AddressSanitizer builds (debug presets): GCC and MSVC define __SANITIZE_ADDRESS__, Clang reports the feature.
#ifdef __SANITIZE_ADDRESS__
#define PF_ASAN 1 // NOLINT(cppcoreguidelines-macro-usage): selects code and includes below
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define PF_ASAN 1 // NOLINT(cppcoreguidelines-macro-usage)
#endif
#endif

#ifdef PF_ASAN
#include <sanitizer/asan_interface.h>
#endif

namespace pf::engine {

namespace {

std::size_t effectiveAlignment(std::size_t alignment) {
    return std::max(alignment, image::tileSampleAlignment);
}

bool isPoolable(std::size_t bytes, std::size_t alignment) {
    return bytes == TilePool::blockBytes && alignment <= image::tileSampleAlignment;
}

// Kept blocks are poisoned, so a dangling tile pointer is caught in sanitizer builds.
void poison([[maybe_unused]] void* pointer, [[maybe_unused]] std::size_t bytes) {
#ifdef PF_ASAN
    ASAN_POISON_MEMORY_REGION(pointer, bytes);
#endif
}

void unpoison([[maybe_unused]] void* pointer, [[maybe_unused]] std::size_t bytes) {
#ifdef PF_ASAN
    ASAN_UNPOISON_MEMORY_REGION(pointer, bytes);
#endif
}

// oneTBB's scalable allocator; operator new under AddressSanitizer, which then sees every block.
void* allocateFromSystem(std::size_t bytes, std::size_t alignment) {
#ifdef PF_ASAN
    return ::operator new(bytes, std::align_val_t{effectiveAlignment(alignment)});
#else
    void* pointer = scalable_aligned_malloc(bytes, effectiveAlignment(alignment));
    if (pointer == nullptr) {
        throw std::bad_alloc();
    }
    return pointer;
#endif
}

void freeToSystem(void* pointer, [[maybe_unused]] std::size_t bytes, [[maybe_unused]] std::size_t alignment) noexcept {
#ifdef PF_ASAN
    ::operator delete(pointer, bytes, std::align_val_t{effectiveAlignment(alignment)});
#else
    scalable_aligned_free(pointer);
#endif
}

} // namespace

TilePool::~TilePool() {
    shrinkTo(0);
}

TilePool& TilePool::process() {
    // Never destroyed: images held by static objects may release tiles during static destruction.
    static auto* pool = new TilePool();
    return *pool;
}

void TilePool::setRetainLimit(std::size_t bytes) {
    m_retainLimit.store(bytes, std::memory_order_relaxed);
    shrinkTo(bytes);
}

void TilePool::releaseFree() {
    shrinkTo(0);
#ifndef PF_ASAN
    // oneTBB 2023.1 crashes when this runs before its allocator was ever used (D-074).
    if (m_systemAllocatorUsed.load(std::memory_order_acquire)) {
        scalable_allocation_command(TBBMALLOC_CLEAN_ALL_BUFFERS, nullptr);
    }
#endif
}

TilePoolStats TilePool::stats() const {
    std::size_t freeBlocks = 0;
    {
        const std::scoped_lock lock(m_mutex);
        freeBlocks = m_free.size();
    }
    return {.bytesInUse = bytesInUse(),
            .bytesFree = freeBlocks * blockBytes,
            .reused = m_reused.load(std::memory_order_relaxed),
            .allocated = m_allocated.load(std::memory_order_relaxed)};
}

void* TilePool::do_allocate(std::size_t bytes, std::size_t alignment) {
    void* pointer = nullptr;
    if (isPoolable(bytes, alignment)) {
        const std::scoped_lock lock(m_mutex);
        if (!m_free.empty()) {
            pointer = m_free.back();
            m_free.pop_back();
        }
    }
    if (pointer != nullptr) {
        unpoison(pointer, bytes);
        m_reused.fetch_add(1, std::memory_order_relaxed);
    } else {
        pointer = allocateFromSystem(bytes, alignment);
        m_systemAllocatorUsed.store(true, std::memory_order_release);
        m_allocated.fetch_add(1, std::memory_order_relaxed);
    }
    m_bytesInUse.fetch_add(bytes, std::memory_order_relaxed);
    return pointer;
}

void TilePool::do_deallocate(void* pointer, std::size_t bytes, std::size_t alignment) {
    m_bytesInUse.fetch_sub(bytes, std::memory_order_relaxed);
    if (isPoolable(bytes, alignment)) {
        const std::scoped_lock lock(m_mutex);
        if ((m_free.size() + 1) * blockBytes <= retainLimit()) {
            poison(pointer, bytes);
            m_free.push_back(pointer);
            return;
        }
    }
    freeToSystem(pointer, bytes, alignment);
}

void TilePool::shrinkTo(std::size_t keepBytes) {
    // Frees under the lock: nothing here may throw (the destructor uses it), and it runs rarely.
    const std::scoped_lock lock(m_mutex);
    const std::size_t keepBlocks = keepBytes / blockBytes;
    while (m_free.size() > keepBlocks) {
        void* pointer = m_free.back();
        m_free.pop_back();
        unpoison(pointer, blockBytes);
        freeToSystem(pointer, blockBytes, image::tileSampleAlignment);
    }
}

} // namespace pf::engine
