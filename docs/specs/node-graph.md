# Node graph core — behaviour spec (PLAN Part C item 7)

How the compositor's node graph is stored, animated, hashed, evaluated and cached, and what the first four nodes do.
Written in our own words; compositor and image-editor manuals were used only as behavioural references. Maths that
must match exactly (curves, exposure, proxy filtering, hashing) is in `docs/FORMAT_NOTES.md` §20.

## 1. Pieces and where they live

| Piece | Folder | What it is |
|---|---|---|
| Keyframes and curves | `core/anim` | one animated number: keys, interpolation, extrapolation |
| Parameters | `core/graph` | typed values (float, int, bool, enum, colour, 2D/3D vector, string, file) with limits and animation |
| Node types | `core/graph` | a `NodeDef`: type name, version, inputs, parameters and the `NodeOp` that does the pixel work |
| Graph | `core/graph` | node instances, their parameter values and connections; cheap to copy |
| Evaluator | `engine/` | answers requests by pulling pixels through the graph, with the node result cache |
| First nodes | `nodes/read`, `nodes/viewer`, `nodes/shuffle`, `nodes/exposure` | real node types |
| Image files | `io/` | the format registry the Read node opens files through (EXR plugs in with item 9) |

`core/` stays pure C++: the pixel interface (`NodeOp`) is defined there, and the engine hands it a small task runner
for parallel loops and cancellation, so nodes never depend on threads or Qt.

## 2. Keyframes (core/anim)

- An animated number is a **curve**: keys sorted by frame. Frames are real numbers (sub-frames are allowed for motion
  blur later); two keys closer than 10⁻⁶ frames are the same key, so setting a key there replaces it.
- Each key has a **type**, chosen per key as in a compositor's curve editor:
  - **Constant** (hold): the value stays until the next key, then jumps.
  - **Linear**: straight lines to the neighbouring keys.
  - **Smooth**: the curve passes through the key smoothly, with a slope worked out from the neighbours. It never
    overshoots: at a peak or valley, and at the first and last key, the curve is flat; between keys that rise (or
    fall) steadily, it keeps rising (or falling).
  - **Bézier**: the user's own handles — a slope and a handle length on each side.
- New keys are **Linear**, the image editor's default for timeline keys (the curve editor in Phase 4 changes types).
- Before the first key and after the last, the curve holds the end value (**constant extrapolation**) or continues
  in a straight line (**linear extrapolation**), set per side of the curve.
- Every value is finite: keys with NaN or infinity are refused.

## 3. Parameters

- Each parameter has a stable **id** (`exposure`), a label, a type, a default, hard limits (values are clamped into
  them, also when an animation curve overshoots), a slider range for panels, and two flags:
  - **animatable** — numeric parameters are; strings and file paths are not (no node needs animated text yet; the
    Text tool brings it in Phase 10);
  - **affects pixels** — false for display settings (the viewer's exposure and gamma), which are left out of the
    cache key, so changing them never recomputes anything.
- Numeric types are made of components: float, int, bool and enum have one, a 2D vector two, a 3D vector three, a
  colour four (RGBA). **Each component animates on its own curve**, so a colour can animate only its red. A
  component without keys keeps the parameter's static value.
- Int parameters interpolate and round to the nearest integer; bool and enum parameters behave like Constant keys
  (they switch at the key).
- Setting a value "at a frame" (what a panel does) sets a key on every component when the parameter is animated, and
  the static value otherwise.

## 4. Nodes and the graph

- A **node type** (`NodeDef`) has a type name (stable, stored in project files), a version (raised when its output
  changes for the same parameters, which changes its cache keys), a label and category for menus, named inputs, an
  output (the Viewer has none) and its parameters.
- A **node** is an instance: a unique id, a unique name (`Exposure1`, letters, digits and `_`, not starting with a
  digit), its parameter values and animation, one optional connection per input, a **bypass** flag (the node passes
  its first input through) and a position for the node view.
- **Connections** go from a node's output to one input of another node. An input holds at most one connection;
  connecting again replaces it. A connection that would make a loop is refused, so the graph is always a DAG. An
  unconnected input delivers **nothing** (no channels, no pixels), not an error.
- The graph is a value: copying it shares the nodes, and every edit replaces only the node it changes. Background
  work evaluates its own copy, so the UI can keep editing without locks or waiting.

## 5. Evaluation

A **request** asks one node for (frame, region, channels, proxy scale). The answer is an image with the node's display
window, its data window clipped to the region (grown to whole 256 × 256 tiles), and the requested channels that the
node has.

1. **Pass-through first.** A bypassed node, or a node that hands one input on unchanged at this frame (the Viewer's
   active input, Exposure at its neutral settings), is skipped: the request goes to that input.
2. **Hash.** A node's hash at a frame combines its type and version, every pixel-affecting parameter's value at that
   frame, anything else the node depends on (the Read node adds the file's size and modification time) and the
   hashes of its inputs at the frames it reads them. Identical work gets identical hashes — two identical Exposure
   nodes share results, and a still image is computed once for every frame. Hashes ignore names, positions and
   display settings. The hash function is our own, deterministic on every platform (FORMAT_NOTES §20.5).
3. **Info.** The node describes its output (display window, data window, channels) from its parameters and its
   inputs' descriptions. Cached per (hash, proxy).
4. **Tiles from the cache.** The node result cache stores each output tile of each channel under (hash, proxy,
   channel, tile). Tiles found there are used as they are (shared, not copied).
5. **Missing tiles.** For the rest, the node says what each input must deliver — frame, region and channels — for the
   bounding box of the missing tiles (**region of interest propagation**: a blur asks for a larger region, a channel
   shuffle for other channels). The inputs are evaluated the same way, recursively, then the node renders the missing
   tiles, in parallel, and they go into the cache.
6. **Rules for node code:** a pixel's value depends only on the parameters and the input pixels, never on the
   requested region or on which other channels were requested — that is what makes tile caching correct.
7. **Errors** (a file that cannot be opened) stop the evaluation with a message naming the node; the viewer shows it
   (item 12). Nothing of a failed node is cached.
8. **Cancellation:** evaluations run inside jobs; when the job is cancelled, tile loops stop at the next tile.
9. **Threads:** evaluation may open files, so it never runs on the UI thread (checked). Several evaluations may run
   at once on the same graph copy or different ones; two of them may compute the same tile at the same moment, which
   costs time but never correctness.

**Proxy scale** 1, 2, 4, 8, 16 or 32 divides the resolution. Windows are scaled outward (left/top edges rounded down,
right/bottom rounded up). Each node handles proxy for its own parameters; the Read node averages each p × p block.

**Caches and memory:** tiles count against the memory budget (D-074); the least recently used tiles over all caches
are evicted first. Both node caches also have an entry limit, so results that use no memory (constant tiles,
descriptions) cannot pile up for ever.

## 6. The first nodes

### Read

- Opens an image file through the format registry (`io/`), by file extension. Item 7 has the registry and the node;
  the first real format, OpenEXR, plugs in with item 9, sequences (frame patterns, frame range, before/after,
  missing frames) with item 10 and the input colour space with item 11.
- **Parameters:** `file` (path, UTF-8).
- **Output:** the file's display and data window and all of its channels, scene-linear and premultiplied (the
  format reader converts at the boundary).
- An empty path gives nothing; a path that cannot be opened is an error naming the file and the reason.
- Only the requested channels and region are read. Open files are kept in a small cache and reopened when their
  size or modification time changes, which also changes the node's hash, so a re-rendered file shows up on the
  next evaluation.

### Viewer

- Up to 10 inputs (keys 1–9 and 0 in the viewer, item 12); no output.
- **Parameters:** `activeInput` (0–9) chooses which input the viewer shows; the display settings `exposure` (stops),
  `gamma`, `layer` (which layer/AOV to show; empty = the main RGBA layer), `channel` (RGB, red, green, blue, alpha or
  luminance), `display` and `view` (OpenColorIO names; empty = the config's defaults) are used by the viewer's display
  path (item 12) and never change pixel data or cache keys.
- Evaluating the Viewer evaluates its active input; an unconnected active input shows nothing.

### Shuffle

- Moves channels around: takes one layer (AOV) of its input and writes it into a layer of its output, by default the
  main RGBA layer — the usual way to pick a render pass for further work.
- **Parameters:** `inLayer` (empty = the main layer), `outLayer` (empty = the main layer), and `red`, `green`,
  `blue`, `alpha`: where each output channel comes from — empty for automatic, `0` or `1` for a constant, or the
  suffix of a channel of the input layer (`R`, `X`, `Z`…).
- **Automatic:** the input layer's colour channels (everything but `A`, in canonical order) go to red, green and
  blue; a single channel (a depth or matte pass) goes to all three, so it shows as grey; with two channels blue is
  0. Alpha comes from the input layer's `A`; when it has none, or when the layer has no channels at all, the output
  channel is left as it was.
- A named channel the input does not have reads as 0.
- Every other channel passes through unchanged. Shuffling copies no pixels: tiles are shared.

### Exposure

- The image editor's Exposure adjustment as a node, on scene-linear float.
- **Parameters:** `exposure` in stops (−20 to +20, default 0), `offset` (−0.5 to +0.5, default 0), `gamma`
  correction (0.01 to 9.99, default 1), and `layer` (empty = the main layer). It changes the colour channels of that
  layer (R, G, B, Y); alpha and data passes pass through.
- Per colour value v of the straight (un-premultiplied) colour: `v · 2^exposure + offset`, then the gamma power
  `1/gamma` — negative values are mirrored around 0 (they stay negative and change like their positive
  counterparts). Exposure alone is applied directly to the premultiplied values; offset and gamma work on straight
  colour, so the node divides by alpha first and multiplies back after (where alpha is 0 the colour is used as it
  is). Values above 1 are never clipped; NaN and infinity pass through the maths unchanged.
- At its neutral settings the node passes its input through (no work, no cache memory).
