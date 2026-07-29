import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * **`testTimeout` is the whole point of this file.** Several suites here are
 * exhaustive rather than sampled — SEVEN's `n = 7` sweeps in
 * `tests/strategy.test.mjs` legitimately take two to six seconds each on an idle
 * M3 — and vitest's default is 5,000 ms. That default turned a slow but correct
 * test into a red build on a loaded machine, and a 2-vCPU CI runner is slower
 * than a loaded laptop. `tests/adapter-conformance.test.ts` had already set its
 * own 60 s timeout inline, which is the same problem recognised in one file and
 * left in eight.
 *
 * The README's "run the proof yourself" and the claim that a disagreement
 * between a published table and the code turns CI red both rest on this suite
 * being reliably green, so the timeout is generous on purpose. It is not a
 * performance budget: `tools/bench.mjs` is, it asserts the published bands in
 * docs/ENGINE.md §4, and it runs as its own CI step.
 */
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    /*
     * `tests/bench.test.mjs` measures wall-clock time and asserts the bands
     * docs/ENGINE.md §4 publishes, so it must not run while eighteen other test
     * files are saturating the machine — that is measuring contention, not the
     * code, and it fails for reasons no commit caused. `npm test` runs it as a
     * second, serial pass (see package.json); this excludes it from the first.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/bench.test.mjs'],
  },
});
