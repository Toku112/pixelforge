# io/ — files

Format registry, OpenEXR (lazy per-channel decode), OpenImageIO bridge, image sequences, renderer AOV presets, PSD,
video (FFmpeg / VideoToolbox). File I/O never runs on the UI thread.

| File | What it does |
|---|---|
| `ImageReader.h` | `ImageReader` (an open image file: describe it, read any channels over any region), `FormatRegistry` (formats by file extension), UTF-8 path conversion |
| `FileStamp.h` | a file's size and modification time, to notice rewritten files |

The first format, OpenEXR, arrives with PLAN Part C item 9.
