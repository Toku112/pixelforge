# nodes/ — node types

One folder per node type: parameters, CPU reference implementation, optional GPU implementation (through `gpu::`,
never Qt directly) and tests. UI-agnostic: panels in `ui/` are generated from the parameter definitions.

| Folder | Node | Notes |
|---|---|---|
| `read/` | Read | stills and image sequences through `io::FormatRegistry`; frame range, offset, hold/loop/bounce/black, missing frames; proxy box filter; follows files changing on disk |
| `viewer/` | Viewer | 10 inputs, shows the active one; display settings never touch pixels |
| `shuffle/` | Shuffle | routes one layer (render pass) into another; shares tiles |
| `exposure/` | Exposure | the image editor's Exposure adjustment on scene-linear float |

`Builtins.h` registers them all at startup. Behaviour: `docs/specs/node-graph.md` §6 and `docs/specs/sequences.md`;
maths: FORMAT_NOTES §20 and §23.
A new node type is a `NodeDef` (type id, version, inputs, parameters) plus a `NodeOp` (`core/graph/NodeOp.h` lists
the rules: a pixel never depends on the requested region, every listed tile gets filled, errors are thrown with a
plain message).
