#include "io/Formats.h"

#include "io/exr/ExrReader.h"

namespace pf::io {

void addBuiltinFormats(FormatRegistry& registry) {
    registry.add(exrFormat());
}

} // namespace pf::io
