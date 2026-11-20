/**
 * Compile-time entry module (design.md §21, implementation.md §8 M5).
 *
 * `bun build --compile src/index.ts` is what §21 documents, but `src/index.ts` is
 * also the package's public surface: importing it from a test must not start a
 * proxy. Bun sets `import.meta.main` only in the module it was pointed at, so the
 * guard inside `index.ts` is unreachable in the compiled binary and the binary
 * built from it would exit 0 without ever listening.
 *
 * This file exists to remove that ambiguity rather than to re-document it:
 *
 *   - `src/index.ts` stays a pure library surface (no process side effects);
 *   - `src/cli.ts` is a one-line process boundary that ALWAYS runs;
 *   - `src/main.ts` keeps `main()`/`runCli()` so both entries share one policy.
 *
 * The build points here (packages/kiseki/package.json `build`), and
 * `test/binary.test.ts` runs the compiled artefact so a regression cannot pass
 * silently: a binary that exits 0 is exactly the failure this module prevents.
 */

import { runCli } from "./main"

runCli()
