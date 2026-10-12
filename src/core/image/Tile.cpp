#include "core/image/Tile.h"

#include <stdexcept>
#include <utility>

namespace pf::image {

Rect tilesCovering(const Rect& pixels) {
    if (pixels.isEmpty()) {
        return {};
    }
    const TileCoord first = tileContaining(pixels.x0, pixels.y0);
    const TileCoord last = tileContaining(pixels.x1 - 1, pixels.y1 - 1);
    return {.x0 = first.x, .y0 = first.y, .x1 = last.x + 1, .y1 = last.y + 1};
}

namespace {

// nullptr: the default resource. Set once at startup in practice; atomic so a late change is still well-defined.
std::atomic<std::pmr::memory_resource*>& installedTileMemory() {
    static std::atomic<std::pmr::memory_resource*> resource{nullptr};
    return resource;
}

std::pmr::memory_resource* orDefault(std::pmr::memory_resource* resource) {
    return resource != nullptr ? resource : std::pmr::new_delete_resource();
}

} // namespace

void setTileMemoryResource(std::pmr::memory_resource* resource) noexcept {
    installedTileMemory().store(resource, std::memory_order_release);
}

std::pmr::memory_resource* tileMemoryResource() noexcept {
    return orDefault(installedTileMemory().load(std::memory_order_acquire));
}

TileBuffer::TileBuffer(const Rect& rect) : m_rect(rect) {
    const TileCoord tile = tileContaining(rect.x0, rect.y0);
    if (rect.isEmpty() || !tileCell(tile).contains(rect)) {
        throw std::invalid_argument("tile buffer " + toString(rect) + " is empty or crosses a tile boundary");
    }
    m_memory = tileMemoryResource();
    m_samples = static_cast<float*>(m_memory->allocate(byteSize(), tileSampleAlignment));
}

TileBuffer::~TileBuffer() {
    m_memory->deallocate(m_samples, byteSize(), tileSampleAlignment);
}

std::size_t TileBuffer::byteSize() const {
    return static_cast<std::size_t>(m_rect.area()) * sizeof(float);
}

TileRef TileRef::allocate(const Rect& rect) {
    auto* buffer = new TileBuffer(rect); // owned by the reference count
    buffer->m_refs.store(1, std::memory_order_relaxed);
    return TileRef(buffer);
}

TileRef::TileRef(const TileRef& other) noexcept : m_buffer(other.m_buffer) {
    if (m_buffer != nullptr) {
        // A new reference needs no ordering: the caller already holds one, so the buffer cannot go away.
        m_buffer->m_refs.fetch_add(1, std::memory_order_relaxed);
    }
}

TileRef::TileRef(TileRef&& other) noexcept : m_buffer(std::exchange(other.m_buffer, nullptr)) {}

TileRef& TileRef::operator=(const TileRef& other) noexcept {
    if (this != &other) {
        TileRef copy(other);
        std::swap(m_buffer, copy.m_buffer);
    }
    return *this;
}

TileRef& TileRef::operator=(TileRef&& other) noexcept {
    if (this != &other) {
        reset();
        m_buffer = std::exchange(other.m_buffer, nullptr);
    }
    return *this;
}

TileRef::~TileRef() {
    reset();
}

bool TileRef::isUnique() const {
    // Acquire pairs with the release half of the decrement in reset(): everything another holder did with the buffer
    // before dropping its reference happens before our writes.
    return m_buffer != nullptr && m_buffer->m_refs.load(std::memory_order_acquire) == 1;
}

void TileRef::reset() {
    TileBuffer* buffer = std::exchange(m_buffer, nullptr);
    if (buffer != nullptr && buffer->m_refs.fetch_sub(1, std::memory_order_acq_rel) == 1) {
        delete buffer; // the last reference frees the buffer
    }
}

} // namespace pf::image
