#include "engine/Engine.h"

#include "core/image/Tile.h"

namespace pf::engine {

Engine::Engine(const EngineOptions& options)
    : m_tilePool(TilePool::process()),
      m_memory(options.memoryLimit, [pool = &m_tilePool] { return pool->bytesInUse(); }) {
    m_tilePool.setRetainLimit(options.memoryLimit / retainDivisor);
    image::setTileMemoryResource(&m_tilePool);
}

// The tile pool stays installed: tiles allocated from it may outlive the engine, and the pool outlives everything.
Engine::~Engine() = default;

void Engine::setMemoryLimit(std::size_t bytes) {
    const bool lowered = bytes < m_memory.limit();
    m_tilePool.setRetainLimit(bytes / retainDivisor);
    m_memory.setLimit(bytes);
    if (lowered) {
        m_tilePool.releaseFree();
    }
}

void Engine::releaseUnusedMemory() {
    m_tilePool.releaseFree();
}

EngineStats Engine::stats() const {
    return {.memory = m_memory.stats(), .tiles = m_tilePool.stats(), .jobs = m_scheduler.stats()};
}

} // namespace pf::engine
