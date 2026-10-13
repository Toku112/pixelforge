# Image sequences — behaviour spec (PLAN Part C item 10)

How the app finds the frames of a rendered sequence, how a Read node turns the comp's current frame into a file, and
what it shows before the first frame, after the last one and where a frame is missing. Written in our own words;
established compositors, image viewers and the Blender, Redshift and Octane manuals (how they name frames) were used
only as behavioural references. Exact rules: `docs/FORMAT_NOTES.md` §23; decisions: `docs/DECISIONS.md` D-078.

## 1. Pieces and where they live

| Piece | Folder | What it is |
|---|---|---|
| Frame ranges | `core/anim/FrameRange.h` | whole frames, ranges, what happens outside a range, lists of frames as text ("7, 12–14") |
| Frame patterns | `io/sequence/FramePattern.h` | a path with a frame placeholder (`render####.exr`); frame numbers in file names |
| Sequences | `io/sequence/Sequence.h` | the files of a pattern on disk, gaps, sequences in a folder, snapshots for live linking |
| Sequence cache | `io/sequence/SequenceIndex.h` | the frames of each pattern, listed once and listed again when the folder changes |
| Read node | `nodes/read` | the frame range settings; picks the file for each frame |

Everything that touches the disk runs on background threads, never on the UI thread.

## 2. Frame numbers in file names

- A rendered frame's file name holds its frame number: `name.1001.exr`, `name_1001.exr`, `name1001.exr` (Blender's
  default), `shot010_v002.1001.exr`. The frame number is the **last group of digits before the extension**; what comes
  before it is the name's prefix, what comes after (`.exr`) its suffix. Earlier digits (`shot010`, `v002`) are part of
  the prefix.
- A group of more than 9 digits is not a frame number (dates and times written as one long number).
- **Negative frames** are written with a minus sign: `name.-0005.exr` (Blender's style: the padding counts digits
  only) or `name.-005.exr` (the C-style `%04d`: the padding counts the sign). Both are read. In a single name, a minus
  sign counts as one only when it starts the name or follows `.`, `_` or a space, because names like `shot-0001.exr`
  are common. When a folder holds both `render0000.exr` and `render-0001.exr` (Blender without a separator), the minus
  sign is understood as a sign, and they form one sequence from −1.
- **Padding** — how many digits are written, with leading zeros: `0001` has 4. Numbers that grow beyond it simply get
  longer (`9999`, `10000`). Unpadded sequences (`frame.1.exr` … `frame.120.exr`) work too. **Mixed padding** in one
  folder (`f.01.exr` next to `f.002.exr`) is found as well; the frame number counts, not how it is written.

## 3. Frame patterns

A sequence is stored as a path with a **placeholder** where the frame number goes:

| Placeholder | Meaning |
|---|---|
| `####` | one `#` per digit: `render####.exr` → `render0001.exr` (also the form the app writes) |
| `@@@@` | the same with `@` |
| `%04d` | C-style: 4 digits with leading zeros; `%d` for no padding |

- Only the file name may hold the placeholder, and only the last one counts (a `#` earlier in a name is just a
  character). Padding is 1 to 9 digits.
- Files of a pattern are found by their frame number with any padding, so a pattern always finds every frame the
  folder has, however it was written.
- **Picking a file of a sequence** (Open, drag and drop — item 13) finds its sequence: every file in the same folder
  whose name differs only in the frame number. At least two such files make a sequence; one is a still image. The
  pattern gets the padding the files use (`render0001.exr` → `render####.exr`). Whether picking one file opens the
  whole sequence or just that file is the Open dialog's choice (item 13).
- **A folder** (dropped on the app, item 13) is listed as its sequences and single files; hidden files are skipped.

## 4. The Read node and time

The Read node's `file` is either a plain path (a **still**, the same image at every frame) or a pattern (a
**sequence**). For a sequence:

| Setting | Values | Default | What it does |
|---|---|---|---|
| Frame range from files | on / off | on | on: the range is the first to the last frame on disk, and it follows the disk (new frames of a render in progress extend it); off: First and Last below |
| First frame, Last frame | whole numbers | 1, 1 | the range when it does not come from the files |
| Frame offset | whole number | 0 | moves the sequence in time: with offset 100, file frame 1 shows at comp frame 101 |
| Before first frame | Hold, Loop, Bounce, Black | Hold | comp frames before the range |
| After last frame | Hold, Loop, Bounce, Black | Hold | comp frames after the range |
| Missing frames | Error, Hold previous frame, Black, Checkerboard | Checkerboard | frames inside the range without a file |

- **Which file at which frame:** the comp frame is rounded to the nearest whole frame (halves round up), the offset is
  subtracted, then frames outside the range follow Before/After:
  - **Hold** shows the first (or last) frame of the range;
  - **Loop** repeats the range: 1 2 3 1 2 3 …;
  - **Bounce** plays it forwards and backwards without repeating the end frames: 1 2 3 2 1 2 3 …;
  - **Black** shows a black, empty frame of the sequence's size and channels.
- **Missing frames** — gaps in a render, frames still being rendered:
  - **Checkerboard** (default): a grey checkerboard (squares of 64 pixels) in the colour channels, alpha 1, every
    other channel 0 — impossible to mistake for a real frame, and the comp keeps working;
  - **Hold previous frame**: the nearest earlier frame of the range that exists (the nearest later one when there is
    none earlier);
  - **Black**: as above;
  - **Error**: the frame fails with a message that names the missing file.
- Black and checkerboard frames take their size and channels from the nearest frame that exists, so the frame
  around them, the passes and everything downstream stay the same through a gap.
- A sequence with no files at all is an error ("no files match render####.exr in …"), whatever the settings.
- Frames that show the same file share their results: holding frame 20 for 50 frames costs one frame of memory.
- **Listing missing frames:** the node's panel (item 13) lists the gaps inside the range as text, e.g.
  `Missing: 7, 12–14`.

## 5. When files change

- Every evaluation checks the file it shows (size and modification time) and the folder (its modification time,
  which changes when files are added, removed or renamed). A re-rendered frame is read again; a new frame fills its
  gap or, with "Frame range from files", extends the range; a deleted frame becomes missing. Unchanged frames keep
  their cached results.
- The answer to "which file shows at this frame" is worked out **once per frame and evaluation**, before hashing, and
  the same answer is used for the cache key, the description and the pixels. A frame appearing in the middle of an
  evaluation therefore cannot put its pixels under the key of the frame that stood in for it.
- **Groundwork for live linking** (PLAN B0.2, Phase 1): a **snapshot** of a sequence records every frame's file with
  its size and modification time; comparing two snapshots lists the frames added, removed and changed. Phase 1 adds
  the watching itself (when to look, waiting until a frame has finished writing, refreshing the viewer and the frame
  cache).
- File systems that do not update a folder's modification time promptly (some network shares) still pick up
  re-rendered and newly written frames of the range at once (the file itself is checked); frames beyond the known
  range may only appear after the folder's time changes or the user reloads (item 13).
- A frame that is still being written when it is read gives the reader's "damaged file" error for that evaluation;
  the next evaluation after the renderer finishes reads it normally.

## 6. Not in this item

- Movies (FFmpeg/VideoToolbox) — Phase 1 with ProRes export; they will use the same frame range settings.
- Writing sequences (Write node, render queue) — Phase 1.
- Waiting for frames to finish writing, folder watching, viewer refresh — live linking, Phase 1.
- The Read node's panel and the Open dialog — item 13; the timeline's cached-frame and missing-frame display — item
  14.
