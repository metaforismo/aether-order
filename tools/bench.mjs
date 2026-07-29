#!/usr/bin/env node
/**
 * Reproducible timings for the costs docs/ENGINE.md quotes.
 *
 * A timing with no hardware named is unfalsifiable, so ENGINE.md quotes this
 * script's output and names the machine it came from. Run it on yours and
 * compare; the conclusion the numbers support — the catalogue digest is paid
 * once at startup and never inside a round — survives a wide spread.
 *
 * Usage: node tools/bench.mjs
 */

import { cpus, totalmem } from 'node:os';

import { digestCatalogue, makeTranscript, settleTicket, verifyTranscript } from './lib/derive.mjs';
import { VARIANT_IDS, getVariant } from './lib/model.mjs';
import { createHash } from 'node:crypto';

const seedFrom = (label) => createHash('sha256').update(`aether-order/bench/${label}`).digest('hex');

function time(label, iterations, run) {
  // One untimed warm-up so the first call does not pay JIT for the sample.
  run(0);
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) run(i);
  const elapsedNs = Number(process.hrtime.bigint() - started);
  const perOp = elapsedNs / iterations / 1e6;
  return { label, iterations, perOpMs: perOp, totalMs: elapsedNs / 1e6 };
}

const rows = [];

// Cold catalogue digest: the uncached path, which is what a process pays once
// at construction. `digestCatalogue` is deliberately the uncached export.
for (const variantId of VARIANT_IDS) {
  const { n } = getVariant(variantId);
  const iterations = n >= 7 ? 3 : 20;
  rows.push(time(`catalogue digest, cold (n = ${n})`, iterations, () => digestCatalogue(variantId)));
}

// Per-round costs, once the digest is warm.
for (const variantId of VARIANT_IDS) {
  const { n } = getVariant(variantId);
  const seed = seedFrom(variantId);
  const context = { variantId, roundId: 'bench', clientSeed: 'axiom', nonce: 0 };
  rows.push(
    time(`transcript build (n = ${n}), warm`, 2000, (i) =>
      makeTranscript(seed, { ...context, nonce: i }),
    ),
  );
  const transcript = makeTranscript(seed, context);
  rows.push(time(`transcript verify (n = ${n}), warm`, 2000, () => verifyTranscript(seed, transcript)));
  const ticket = {
    lines: [
      { code: 'first', params: { c: transcript.permutation[0] }, stakeChips: 100n },
      { code: 'before', params: { a: 0, b: 1 }, stakeChips: 50n },
      { code: 'podium', params: { a: transcript.permutation[0], b: transcript.permutation[1], c: transcript.permutation[2] }, stakeChips: 25n },
    ],
  };
  rows.push(time(`ticket settle (n = ${n}, 3 lines), warm`, 2000, () => settleTicket(transcript, ticket)));
}

const cpu = cpus()[0];
const lines = [
  'AETHER ORDER — reference implementation timings',
  '='.repeat(64),
  `node        ${process.version} on ${process.platform}/${process.arch}`,
  `cpu         ${cpu ? cpu.model : 'unknown'} x ${cpus().length}`,
  `memory      ${Math.round(totalmem() / 1024 ** 3)} GB`,
  '',
  `  ${'measurement'.padEnd(38)}${'iterations'.padEnd(12)}per op`,
  `  ${'-'.repeat(37)} ${'-'.repeat(11)} ${'-'.repeat(12)}`,
];
for (const row of rows) {
  const perOp = row.perOpMs >= 1 ? `${row.perOpMs.toFixed(1)} ms` : `${(row.perOpMs * 1000).toFixed(1)} us`;
  lines.push(`  ${row.label.padEnd(38)}${String(row.iterations).padEnd(12)}${perOp}`);
}
lines.push('');
lines.push('The catalogue digest is paid once per process, at adapter construction.');
lines.push('No per-round path touches it: transcripts and settlements are microseconds.');

process.stdout.write(`${lines.join('\n')}\n`);
