# EXR reading — behaviour spec (PLAN Part C item 9)

How the app opens OpenEXR files: what it shows of a file before reading any pixels, how channels from multi-part,
multi-layer and multi-view files are named, what is read when a node asks for pixels, and what happens with damaged
files. Written in our own words; the OpenEXR documentation and the Blender, Redshift and Octane manuals were used only
as behavioural references. Exact rules (conversions, naming, metadata text) are in `docs/FORMAT_NOTES.md` §22,
decisions in `docs/DECISIONS.md` D-077.

## 1. Pieces and where they live

| Piece | Folder | What it is |
|---|---|---|
| EXR reader | `io/exr` | opens a file (header only), describes it, reads any channels over any region |
| Metadata | `io/Metadata.h` | header attributes as typed values with display text, one group per part |
| Format list | `io/Formats.h` | the formats the app reads (OpenEXR now, OpenImageIO's formats later), registered at startup |
| Read node | `nodes/read` | uses the reader; spreads decoding over the evaluation's threads |

The reader uses OpenEXR's low-level library (OpenEXRCore). One open file can be decoded by many threads at once, and
it decodes exactly the pieces of the file we ask for, which is what lazy reading needs.

## 2. Opening a file

- Opening reads **only the header**: no pixels. A 13-part, 21 MB Cycles frame opens in well under a millisecond of
  decoding work, so scrubbing through a sequence and listing its passes is cheap.
- The description of the file holds:
  - the **display window** (the frame) and the **data window** (where pixels exist; for files with several parts, the
    area covered by all of them);
  - every **channel**, under the names of §3;
  - for each channel, where it comes from: the name in the file, how it is stored (16-bit half, 32-bit float or 32-bit
    integer), its part and its view;
  - the **pixel aspect ratio**;
  - the **views** of a stereo (multi-view) file, the default view first;
  - the **metadata**: every header attribute of every part — renderer, camera, render time, colour information,
    Cryptomatte manifests, custom attributes — as typed values with readable text (§7);
  - **notes** about anything the reader left out or renamed (deep parts, reduced-resolution channels, clashing
    names), so the UI can tell the user.
- Files that are not OpenEXR, or whose header is damaged, do not open: the message names the file and the reason.

## 3. Channel names

The engine names channels as OpenEXR does: everything before the last dot is the layer (the render pass), the rest
the channel (`ViewLayer.Diffuse Direct.R` → pass `ViewLayer.Diffuse Direct`, channel `R`).

- **One part (single-part, multi-layer files)** — Redshift, Octane, older Blender versions, most compositors: the
  channels keep their names exactly (`R`, `G`, `B`, `A`, `DiffuseLighting.R`, `Z`).
- **Several parts** — Blender 4 and later write one part per pass (`ViewLayer.Combined`, `ViewLayer.Depth`, …) and put
  the full name in each channel (`ViewLayer.Combined.R`), as OpenEXR recommends. Those names are used as they are. If
  two parts hold a channel of the same name (a file whose parts all contain plain `R`, `G`, `B`), the first part keeps
  it and later ones are prefixed with their part's name (`specular.R`); a note says so.
- **Stereo and other multi-view files:** the **default view** (the first one listed) looks exactly like a normal
  image — its channels have no view name (`R`, `diffuse.R`). Every other view's channels carry the view name just
  before the channel (`right.R`, `diffuse.right.R`), which is how OpenEXR names views inside one part. This holds for
  both ways of storing views (all views in one part, or one part per view), so a stereo file always looks the same.
  Channels that belong to no view keep their names.
- Lower-case channel letters are kept (Cycles writes Cryptomatte as `CryptoObject00.r/g/b/a`); in lists they appear
  in the order r, g, b, a, right after R, G, B, A.

## 4. Reading pixels

- A node asks for some channels over a region. The reader then
  - touches only the **parts** that hold one of those channels (asking for the depth pass of a 13-part Cycles frame
    reads the depth part and nothing else);
  - reads only the **blocks of the file** (groups of scanlines, or tiles) that overlap the region;
  - unpacks only the **requested channels** from each block (within one part, a block must be decompressed whole, but
    the other channels are not converted or stored);
  - decodes the blocks **in parallel** on the evaluation's threads (never on the UI thread).
- Samples become 32-bit float: half and float values exactly (including values far above 1, negatives, infinity and
  NaN, and Cryptomatte IDs, whose bit patterns are kept), 32-bit integers by value (exact up to 16,777,216; larger
  ones round to the nearest float — FORMAT_NOTES §22).
- **Nothing else changes:** no clipping, no colour conversion (colour spaces are OpenColorIO's job, item 11), and no
  alpha change — EXR colour is already premultiplied, which is the engine's convention.
- Where the region lies outside a part's data window (parts with different windows), its channels read as 0.

## 5. What files are supported

- **Scanline and tiled** parts; any line order. Tiled files with **mipmap or ripmap levels** are read at full
  resolution.
- **Every compression** OpenEXR offers: none, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA, DWAB, HTJ2K (256 and 32
  lines), lossy HTJ2K and Zstandard.
- **Half, float and 32-bit integer** channels, mixed freely.
- **Data windows** of any position and size: bigger than the frame (overscan), smaller (region renders), negative
  origins. Windows beyond ±2²⁹ pixels are refused (the engine's coordinate limit).
- **Deep parts** (deep scanline and deep tiled, from renderers' deep output) are **detected and listed in the notes**
  but not read yet: turning deep samples into a flat image is part of Phase 1. A file with only deep data opens (its
  metadata can be shown) but a Read node of it reports that it holds only deep data.
- **Reduced-resolution channels** (subsampled, used by luminance/chroma files): left out with a note for now;
  reading them, and turning luminance/chroma files into RGB, comes with the full format work (Phase 9).

## 6. Damaged and incomplete files

- A damaged or incomplete file — cut short while a renderer was still writing it, or corrupted — never crashes the
  app. Opening fails if the header is damaged; reading fails if a block the request needs is missing or broken.
- The message is meant for the user: it names the file, the part and the rows (or tile) that could not be read, and
  OpenEXR's own reason: "cannot read render0007.exr: rows 512–543 of part "ViewLayer.Combined" are damaged or
  missing (the file may be incomplete): …".
- Nothing of a failed read is cached (the evaluator's rule), and a re-rendered file is opened afresh because its size
  or time changed (item 7), so fixing the file on disk fixes the comp.

## 7. Metadata

- One group per part, named after the part, holding every attribute of its header in file order: name, the file's
  type name (`string`, `v2f`, `chromaticities`, …), a typed value and display text.
- Typed values: whole numbers, decimal numbers, text, lists of text, lists of numbers (vectors, boxes, matrices,
  chromaticities, rationals). Types the app cannot interpret (embedded previews, raw bytes, custom types) keep their
  type name and size in the display text.
- The text is locale-independent and shows numbers as stored (`0.64`, not `0.639999986`); windows show as
  `(0, 0) – (1919, 1079)` (the file's inclusive corners).
- The Metadata panel (item 13) shows these groups; OpenColorIO input detection (item 11) reads the colour attributes
  (`colorInteropID`, `chromaticities`); the Cryptomatte picker (Phase 1) reads the manifests.

## 8. Statistics

Each open file counts the blocks it decoded and the bytes of compressed data it read, for tests (lazy reading is
checked by counting) and, later, the status bar's I/O readout.
