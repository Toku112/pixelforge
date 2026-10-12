# nodes/ — node types

One folder per node type: parameters, CPU reference implementation, optional GPU implementation (through `gpu::`,
never Qt directly) and tests. UI-agnostic: panels in `ui/` are generated from the parameter definitions.
