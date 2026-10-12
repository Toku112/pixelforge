#pragma once

// Hashes for cache keys (docs/specs/node-graph.md §5, FORMAT_NOTES §20.5). Deterministic: the same values give the
// same hash on every platform, compiler and run, so keys can later name files in the disk cache. Values are fed in a
// fixed structure (the caller's order); each call mixes one or more 64-bit words into the state.

#include <cstdint>
#include <string_view>

namespace pf::graph {

using HashValue = std::uint64_t;

class Hasher {
public:
    Hasher& addUnsigned(std::uint64_t value);
    Hasher& addInteger(std::int64_t value);
    // −0 hashes like 0 and every NaN alike, so equal-behaving numbers give equal keys.
    Hasher& addNumber(double value);
    Hasher& addBool(bool value);
    // The length, then the bytes.
    Hasher& addText(std::string_view text);

    [[nodiscard]] HashValue finish() const;

private:
    void mix(std::uint64_t word);

    std::uint64_t m_state = 0x243F6A8885A308D3ULL; // the first digits of π, as a non-zero start
    std::uint64_t m_words = 0;
};

} // namespace pf::graph
