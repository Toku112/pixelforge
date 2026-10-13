# io/ — files

Format registry, OpenEXR (lazy per-channel decode), OpenImageIO bridge, image sequences, renderer AOV presets, PSD,
video (FFmpeg / VideoToolbox). File I/O never runs on the UI thread.

| File | What it does |
|---|---|
| `ImageReader.h` | `ImageReader` (an open image file: describe it, read any channels over any region, spread over threads with `ParallelFor`), the file description (`ImageFileInfo`: windows, channels and where they come from, views, metadata, notes), `FormatRegistry` (formats by file extension), UTF-8 path conversion |
| `Formats.h` | the built-in formats, registered at startup |
| `Metadata.h` | header attributes as typed values with display text, one group per part |
| `FileStamp.h` | a file's size and modification time, to notice rewritten files |
| `exr/ExrReader.h` | OpenEXR files on OpenEXR's low-level library: every compression, scanline and tiled, multi-part, multi-view, lazy and parallel decoding (docs/specs/exr-reading.md, FORMAT_NOTES §22) |
| `exr/ExrNaming.h` | how EXR channel names become engine names (views, clashes) |
| `exr/ExrMetadata.h` | EXR attributes as metadata entries |
