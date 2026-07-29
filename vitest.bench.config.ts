import { defineConfig } from 'vitest/config';

/**
 * The benchmark pass, alone on the machine.
 *
 * `tests/bench.test.mjs` asserts the published bands in docs/ENGINE.md §4 by
 * measuring wall-clock time. Run inside the main suite it shares the box with
 * eighteen other test files, and on a loaded host it then fails on figures that
 * pass comfortably the moment it has the machine to itself — measured here at
 * 2.26 ms against a 2 ms band in parallel, and 0.23 ms standalone, from the same
 * commit and the same source. A timing assertion that is really an assertion
 * about scheduler pressure is a flaky test, and a flaky test is how an
 * unasserted benchmark gets rationalised back in.
 *
 * So `npm test` runs the suite, then runs this: one file, no parallelism, and
 * the bands mean what they say. CI additionally runs `npm run bench`, which is
 * the same measurement with the full table printed.
 */
export default defineConfig({
  test: {
    include: ['tests/bench.test.mjs'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
