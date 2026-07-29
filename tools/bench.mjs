#!/usr/bin/env node
/**
 * Reproducible timings for the costs docs/ENGINE.md quotes.
 *
 * A timing with no hardware named is unfalsifiable, so ENGINE.md quotes this
 * script's output and names the machine it came from. Run it on yours and
 * compare.
 *
 * Round 2 published a table that did not reproduce on its own declared
 * hardware: ticket settle was quoted at 85 µs and measures around 11 µs on the
 * very Apple M3 the document names — a factor of ten. It survived because CI
 * ran the benchmark and asserted nothing, so the one number in the repository
 * explicitly offered as falsifiable was the one number with no test behind it.
 * Two things changed:
 *
 *   1. `--json` makes the output machine-readable and `tests/bench.test.mjs`
 *      asserts every measurement against a published band. The bands are
 *      deliberately generous: they have to hold on a shared CI runner an order
 *      of magnitude slower than a laptop, so they guard against a regression of
 *      *kind* — a per-round path that started touching the catalogue digest —
 *      rather than against hardware variance.
 *   2. `--repeat` reports the median of several samples, because a single run
 *      of the cold `n = 7` digest varies by tens of percent and quoting one
 *      sample as though it were a constant is how the first table drifted.
 *
 * Usage:
 *   node tools/bench.mjs                 human-readable, 3 samples
 *   node tools/bench.mjs --repeat=5      more samples, tighter median
 *   node tools/bench.mjs --json          machine-readable
 *   node tools/bench.mjs --quick         fewer iterations; used by the tests
 */

import { cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';

import { digestCatalogue, makeTranscript, settleTicket, verifyTranscript } from './lib/derive.mjs';
import { VARIANT_IDS, getVariant } from './lib/model.mjs';

const seedFrom = (label) => createHash('sha256').update(`aether-order/bench/${label}`).digest('hex');

/**
 * The bands CI asserts. Chosen so a runner ten times slower than the reference
 * machine still passes, and so a per-round path that started doing catalogue
 * work would fail immediately.
 */
export const BANDS = Object.freeze({
  /** No warm per-round operation may take a millisecond. Reference: 11–79 µs. */
  perRoundMaxMs: 2,
  /** Cold catalogue digest, n = 5. Reference: ~1.5 ms. */
  coldDigestClassicMaxMs: 200,
  /** Cold catalogue digest, n = 7 (27.6M predicate evaluations). Reference: ~300 ms. */
  coldDigestSevenMaxMs: 20_000,
  /**
   * The structural claim the table exists to support: the digest is a startup
   * cost and nothing on a round path touches it. Reference ratio: ~27,000.
   */
  minDigestToSettleRatio: 100,
});

function time(key, label, iterations, run) {
  // One untimed warm-up so the first call does not pay JIT for the sample.
  run(0);
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) run(i);
  const elapsedNs = Number(process.hrtime.bigint() - started);
  return { key, label, iterations, perOpMs: elapsedNs / iterations / 1e6 };
}

/** One sample of every measurement. */
export function benchSample({ quick = false } = {}) {
  const rows = [];

  // Cold catalogue digest: the uncached path, which is what a process pays once
  // at construction. `digestCatalogue` is deliberately the uncached export.
  for (const variantId of VARIANT_IDS) {
    const { n } = getVariant(variantId);
    const iterations = n >= 7 ? (quick ? 1 : 3) : quick ? 3 : 20;
    rows.push(
      time(`digest-cold-n${n}`, `catalogue digest, cold (n = ${n})`, iterations, () => digestCatalogue(variantId)),
    );
  }

  // Per-round costs, once the digest is warm.
  for (const variantId of VARIANT_IDS) {
    const { n } = getVariant(variantId);
    const seed = seedFrom(variantId);
    const context = { variantId, roundId: 'bench', clientSeed: 'axiom', nonce: 0 };
    const iterations = quick ? 200 : 2000;
    rows.push(
      time(`transcript-build-n${n}`, `transcript build (n = ${n}), warm`, iterations, (i) =>
        makeTranscript(seed, { ...context, nonce: i }),
      ),
    );
    const transcript = makeTranscript(seed, context);
    rows.push(
      time(`transcript-verify-n${n}`, `transcript verify (n = ${n}), warm`, iterations, () =>
        verifyTranscript(seed, transcript),
      ),
    );
    const ticket = {
      lines: [
        { code: 'first', params: { c: transcript.permutation[0] }, stakeChips: 100n },
        { code: 'before', params: { a: 0, b: 1 }, stakeChips: 50n },
        {
          code: 'podium',
          params: {
            a: transcript.permutation[0],
            b: transcript.permutation[1],
            c: transcript.permutation[2],
          },
          stakeChips: 25n,
        },
      ],
    };
    rows.push(
      time(`ticket-settle-n${n}`, `ticket settle (n = ${n}, 3 lines), warm`, iterations, () =>
        settleTicket(transcript, ticket),
      ),
    );
  }

  return rows;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Several samples, reduced to min / median / max per measurement. */
export function runBench({ repeat = 3, quick = false } = {}) {
  const samples = Array.from({ length: repeat }, () => benchSample({ quick }));
  const measurements = samples[0].map((first, index) => {
    const values = samples.map((sample) => sample[index].perOpMs);
    return Object.freeze({
      key: first.key,
      label: first.label,
      iterations: first.iterations,
      samples: repeat,
      minMs: Math.min(...values),
      medianMs: median(values),
      maxMs: Math.max(...values),
    });
  });
  const cpu = cpus()[0];
  return Object.freeze({
    machine: Object.freeze({
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: cpu ? `${cpu.model} x ${cpus().length}` : 'unknown',
      memoryGb: Math.round(totalmem() / 1024 ** 3),
    }),
    measurements: Object.freeze(measurements),
  });
}

/** Every band, evaluated. Shared by the CLI and by `tests/bench.test.mjs`. */
export function evaluateBands(result) {
  const by = (key) => result.measurements.find((row) => row.key === key);
  const perRound = result.measurements.filter((row) => !row.key.startsWith('digest-cold'));
  const settleSeven = by('ticket-settle-n7');
  const digestSeven = by('digest-cold-n7');
  const ratio = settleSeven.medianMs > 0 ? digestSeven.medianMs / settleSeven.medianMs : Infinity;

  return [
    {
      name: 'every warm per-round operation is under the per-round band',
      ok: perRound.every((row) => row.medianMs < BANDS.perRoundMaxMs),
      detail: `worst ${Math.max(...perRound.map((row) => row.medianMs)).toFixed(4)} ms < ${BANDS.perRoundMaxMs} ms`,
    },
    {
      name: 'cold catalogue digest (n = 5) is under its band',
      ok: by('digest-cold-n5').medianMs < BANDS.coldDigestClassicMaxMs,
      detail: `${by('digest-cold-n5').medianMs.toFixed(2)} ms < ${BANDS.coldDigestClassicMaxMs} ms`,
    },
    {
      name: 'cold catalogue digest (n = 7) is under its band',
      ok: digestSeven.medianMs < BANDS.coldDigestSevenMaxMs,
      detail: `${digestSeven.medianMs.toFixed(0)} ms < ${BANDS.coldDigestSevenMaxMs} ms`,
    },
    {
      name: 'the digest is a startup cost, not a round cost',
      ok: ratio > BANDS.minDigestToSettleRatio,
      detail: `digest / settle = ${Math.round(ratio).toLocaleString('en-US')}x > ${BANDS.minDigestToSettleRatio}x`,
    },
  ];
}

const render = (ms) => (ms >= 1 ? `${ms.toFixed(1)} ms` : `${(ms * 1000).toFixed(1)} us`);

/* --------------------------------------------------------------- */
/* CLI                                                              */
/* --------------------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const option = (name, fallback) => {
    const hit = argv.find((entry) => entry.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };

  const result = runBench({ repeat: Number(option('repeat', '3')), quick: flag('quick') });
  const bands = evaluateBands(result);

  if (flag('json')) {
    process.stdout.write(`${JSON.stringify({ ...result, bands }, null, 2)}\n`);
  } else {
    const lines = [
      'AETHER ORDER — reference implementation timings',
      '='.repeat(72),
      `node        ${result.machine.node} on ${result.machine.platform}`,
      `cpu         ${result.machine.cpu}`,
      `memory      ${result.machine.memoryGb} GB`,
      `samples     ${result.measurements[0].samples} per measurement; the median is quoted`,
      '',
      `  ${'measurement'.padEnd(38)}${'iters'.padEnd(8)}${'median'.padEnd(12)}range`,
      `  ${'-'.repeat(37)} ${'-'.repeat(7)} ${'-'.repeat(11)} ${'-'.repeat(20)}`,
    ];
    for (const row of result.measurements) {
      lines.push(
        `  ${row.label.padEnd(38)}${String(row.iterations).padEnd(8)}${render(row.medianMs).padEnd(12)}` +
          `${render(row.minMs)} – ${render(row.maxMs)}`,
      );
    }
    lines.push('');
    lines.push('Bands (asserted by tests/bench.test.mjs on whatever hardware runs it):');
    for (const band of bands) lines.push(`  ${band.ok ? 'PASS' : 'FAIL'}  ${band.name}  ${band.detail}`);
    lines.push('');
    lines.push('The catalogue digest is paid once per process, at adapter construction.');
    lines.push('No per-round path touches it: transcripts and settlements are microseconds.');
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (bands.some((band) => !band.ok)) process.exitCode = 1;
}
