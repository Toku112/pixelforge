# Commands, History and Actions — behaviour spec (PLAN Part C item 8)

How every change to a project becomes an undoable step, what the History panel shows, how a slider drag becomes one
step, and how Actions record and replay edits. Written in our own words; the image editor's user guide (History panel,
Undo/Redo, Actions) was used only as a behavioural reference. File forms are in `docs/FORMAT_NOTES.md` §21, decisions
in `docs/DECISIONS.md` D-076.

## 1. Pieces and where they live

| Piece | Folder | What it is |
|---|---|---|
| JSON | `core/json` | values, strict reading and stable writing, for descriptors, action files and (Phase 1) project files |
| Commands | `core/commands` | descriptors, the command registry, the graph commands and `group` |
| Graph deltas | `core/graph` | the nodes that differ between two states of a graph: what a step keeps to undo and redo |
| History | `core/history` | undo, redo, the History panel's list, the step limit, continuous edits |
| Actions | `core/actions` | recording descriptors, playing them back, the action file |

All of it is pure C++ in `core/`; the menus, shortcuts and the History panel itself come with the UI (item 13).

## 2. Commands and descriptors

- **Every change to a project is a command.** Nothing in the UI edits the graph directly; it builds a command and
  hands it to the History (CLAUDE.md §3.6).
- A command is written down as a **descriptor**: its name and its parameters as JSON, for example
  `graph.setValue {"node": "Exposure1", "param": "exposure", "value": 1.5}`. The descriptor is the whole command:
  performing it makes the edit, and the same descriptor replays the edit later — in an Action, a script, a batch run
  or the crash journal. Because live edits and replays run through the same code, a replay does exactly what the
  original did.
- **Nodes are named, not numbered**, in descriptors, so Actions and scripts can refer to them ("Exposure1"). Numbers
  (node ids) are internal.
- Performing a command can **complete its descriptor**: a node added without a name gets one ("Exposure2"), and the
  descriptor kept in the History says so; values are written in their canonical form (an enum by its item id). The
  kept descriptor therefore always replays to the same result.
- Each command gives a **History label** in the image editor's style: "Add Exposure", "Set Exposure", "Connect",
  "Delete Nodes".
- A command that **cannot run** — an unknown node, a missing parameter, a connection that would make a loop — changes
  nothing and reports a message meant for the user ("there is no node named 'Blur1'"). A command that **changes
  nothing** (setting a value it already has) leaves no History step.

## 3. The graph commands

| Command | Parameters | Label |
|---|---|---|
| `graph.addNode` | `type`, optional `name` (a free one when left out), optional `position` [x, y] | Add *Type* |
| `graph.removeNodes` | `nodes`: names; their connections go too | Delete Node / Delete Nodes |
| `graph.connect` | `source`, `target`, `input` (0 = first input) | Connect |
| `graph.disconnect` | `target`, `input` | Disconnect |
| `graph.renameNode` | `node`, `name` | Rename Node |
| `graph.setBypassed` | `node`, `bypassed` | Bypass Node / Enable Node |
| `graph.moveNodes` | `nodes`: [{`node`, `position`}] | Move Node / Move Nodes |
| `graph.setValue` | `node`, `param`, `value`, optional `frame` | Set *Parameter* |
| `graph.setKey` | `node`, `param`, `component`, `key` {frame, value, interpolation…} | Set Keyframe: *Parameter* |
| `graph.removeKey` | `node`, `param`, `component`, `frame` | Delete Keyframe: *Parameter* |
| `graph.removeAnimation` | `node`, `param`, `frame` (the value kept) | Delete Animation: *Parameter* |
| `graph.setExtrapolation` | `node`, `param`, `before`, `after` | Set Extrapolation: *Parameter* |
| `group` | `label`, `steps`: descriptors | its label |

- `graph.setValue` **with a frame** does what a panel does (node-graph spec §3): on an animated parameter it sets a
  key there on every component; otherwise it sets the static value. Without a frame it always sets the static value.
- `group` runs several commands as **one History step**, in order — creating a node and wiring it in, for example. If
  any of its steps fails, none of them stays.

## 4. Undo and redo

- Each History step keeps its descriptor, its label and **the nodes it changed, before and after**. Nodes are shared
  and never modified in place (node-graph spec §4), so keeping them costs only a reference each, and undo and redo
  just put the right nodes back — nothing is recomputed, and redo gives back the very same nodes (so their cached
  pixels stay valid). This is the graph's version of keeping changed tiles only.
- Undo and redo move one step; **clicking an entry** in the History panel moves to it directly.
- **A new step while an earlier entry is current** drops the entries after it (the image editor's normal, linear
  history; its "non-linear history" option is PLAN B16).
- **Edit > Toggle Last State** goes back one entry, and the next toggle forward again; any other move starts over
  from the new current entry.
- The Edit menu shows **"Undo *label*" / "Redo *label*"** from the History.
- Node ids are never handed out twice, even after undoing the node that had one, so selections and caches that remember
  a node id can never point at a different node.

## 5. The History panel's model

- The first entry is the **opening state** — "New" for a new project, "Open" for an opened file — followed by one
  entry per step. Entries after the current one (undone) are shown dimmed.
- **Step limit:** Preferences, default 50, 1 to 1000 (the image editor's History States setting). Over the limit the
  oldest steps are dropped. The opening state stays reachable by clicking it, and every kept step can be reached
  again from it; undo stops at the oldest step left. A new step made from the opening state starts the list again
  from it.
- Lowering the limit drops the oldest steps but **never the current entry**: when the current entry is the oldest
  step, undone steps are dropped first (newest first).
- Memory: dropped steps release their nodes at once (tested), so many edits never grow memory beyond the limit's
  worth of steps. Counting undo memory against the memory budget comes with the first node that holds pixels of its
  own (Paint/Retouch, Phase 3).
- **Observers** (the History panel, the node view, the action recorder) hear every change: a new step, a step that
  took in a continuous edit, a move, steps dropped by a new limit.
- Named snapshots, the non-linear option and the History Brush source column are PLAN B16 (History panel complete).

## 6. Continuous edits

- **Dragging a slider makes one History step**, as in the image editor. The UI marks every change after the first of
  one drag as "continuing"; it joins the current step when that step was the last thing executed and the command says
  the new change continues it:
  - `graph.setValue`: the same node, parameter and frame (or both without a frame);
  - `graph.moveNodes`: the same nodes in the same order (dragging nodes in the node view);
  - `graph.setKey`: the same node, parameter, component and key frame (dragging a key's value).
- The step keeps the value before the drag (for undo) and the last value (for redo and replay). A drag event that
  changes nothing adds nothing. After an undo or redo, or for another parameter, a "continuing" change starts a new
  step.

## 7. Actions

- An **Action** is a named list of descriptors. The **recorder** follows the History: every new step is recorded, a
  continuous edit updates the recorded step (a slider drag records its final value), and undo and redo are not
  recorded — undone steps stay in the recording, as in the image editor.
- **Playing** an Action executes its steps in order, each as its own History step (each undoable). Steps that change
  nothing record nothing.
- **Names during playback:** a node the Action creates under a name that is already taken gets a free name
  ("Exposure2" instead of "Exposure1"), and the Action's later steps that name it follow it there. The same holds for a
  rename to a taken name. Nodes the Action did not create are found by their names as recorded.
- Playback **stops at the first step that fails**, with a message naming the step ("step 3 (graph.connect): there is
  no node named 'Read1'"); the steps before it stay done.
- Actions are saved as JSON files (FORMAT_NOTES §21.4). A file from a newer version of the program is refused with a
  clear message rather than half-read.
- The Actions panel itself (sets, button mode, dialogs per step, insert stop, playback options, ATN import) is
  PLAN B19.

## 8. Threads and speed

- The History lives on the UI thread. Background work (evaluation, rendering) works on its own copy of the graph, so
  edits never wait for it and it never sees a half-made edit.
- An edit copies the graph's node table and compares it with the result: measured 0.05 ms per edit at 1000 nodes and
  0.3 ms at 5000 (`spikes/history-cost`); undo, redo and jumps take microseconds whatever the size.
