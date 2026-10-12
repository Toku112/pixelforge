#include "core/graph/Hash.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <limits>

namespace pf::graph {
namespace {

// A bijective 64-bit scrambler (the SplitMix64 finaliser): every input bit changes about half the output bits.
std::uint64_t scramble(std::uint64_t z) {
    z = (z ^ (z >> 30U)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27U)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31U);
}

} // namespace

void Hasher::mix(std::uint64_t word) {
    // Every step is invertible for a fixed word, so two different words from the same state never meet; the
    // rotation and multiplication make the result depend on the order of the words.
    m_state ^= scramble(word);
    m_state = (std::rotl(m_state, 27) * 0x9E3779B97F4A7C15ULL) + 0x632BE59BD9B4E019ULL;
    ++m_words;
}

Hasher& Hasher::addUnsigned(std::uint64_t value) {
    mix(value);
    return *this;
}

Hasher& Hasher::addInteger(std::int64_t value) {
    mix(static_cast<std::uint64_t>(value));
    return *this;
}

Hasher& Hasher::addNumber(double value) {
    if (value == 0.0) {
        value = 0.0; // −0 → +0
    } else if (std::isnan(value)) {
        value = std::numeric_limits<double>::quiet_NaN();
    }
    mix(std::bit_cast<std::uint64_t>(value));
    return *this;
}

Hasher& Hasher::addBool(bool value) {
    mix(value ? 1U : 0U);
    return *this;
}

Hasher& Hasher::addText(std::string_view text) {
    mix(text.size());
    // Eight bytes per word, the first byte lowest, so the result does not depend on the machine's byte order.
    std::uint64_t word = 0;
    unsigned shift = 0;
    for (const char c : text) {
        word |= std::uint64_t{static_cast<unsigned char>(c)} << shift;
        shift += 8;
        if (shift == 64) {
            mix(word);
            word = 0;
            shift = 0;
        }
    }
    if (shift != 0) {
        mix(word);
    }
    return *this;
}

HashValue Hasher::finish() const {
    return scramble(m_state ^ (m_words * 0xD6E8FEB86659FD93ULL));
}

} // namespace pf::graph
