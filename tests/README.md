# tests/

Run with `ctest --preset <preset>`; select a kind with `-L unit`, `-L golden` or `-L integration` (CLAUDE.md §4).

- `unit/` — GoogleTest tests of maths and models.
- `golden/<feature>/` — image in, expected EXR out, compared in float per channel.
- `integration/` — user workflows driving the app headless.
- `fixtures/` — input files we generate ourselves (and owner-provided renders).

`layering` (label `unit`) checks the include rules of `src/README.md`.
