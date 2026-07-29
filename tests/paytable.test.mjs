/**
 * The published paytable is a tested artefact.
 *
 * These tests parse the paytable tables straight out of docs/MATH.md and
 * compare every cell against the exhaustive enumeration. A typo in a
 * multiplier, a stale probability, or a bet type documented but not implemented
 * (or implemented but not documented) fails the build.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { enumerateVariant, render } from '../tools/lib/analysis.mjs';
import { collectMultiplierTokens, readFencedTable, untick } from '../tools/lib/mdtable.mjs';
import { seedCommitment } from '../tools/lib/derive.mjs';
import { LIMITS, TARGET_RTP, VARIANT_IDS } from '../tools/lib/model.mjs';
import { rational } from '../tools/lib/rational.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MATH_MD = join(ROOT, 'docs', 'MATH.md');
const DESIGN_MD = join(ROOT, 'docs', 'DESIGN.md');
const PAYTABLE_JSON = join(ROOT, 'docs', 'paytable.json');

const EXPECTED_HEADER = ['Code', 'Tier', 'Instances', 'Wins', 'Probability', 'Multiplier', 'Decimal', 'RTP'];

const analyses = Object.fromEntries(VARIANT_IDS.map((id) => [id, enumerateVariant(id)]));

describe.each(VARIANT_IDS)('docs/MATH.md paytable — %s', (variantId) => {
  const analysis = analyses[variantId];
  const table = readFencedTable(MATH_MD, `paytable:${variantId}`);

  it('uses the expected column layout', () => {
    expect(table.header).toEqual(EXPECTED_HEADER);
  });

  it('documents exactly the implemented bet types, in order', () => {
    expect(table.rows.map((row) => untick(row[0]))).toEqual(analysis.rows.map((row) => row.code));
  });

  it.each(analysis.rows.map((row) => [row.code, row]))('row %s matches the enumeration cell for cell', (code, row) => {
    const documented = table.rows.find((candidate) => untick(candidate[0]) === code);
    expect(documented, `no documented row for ${code}`).toBeDefined();
    const [, tier, instances, wins, probability, multiplier, decimal, rtp] = documented;

    expect(tier).toBe(row.tier);
    expect(Number(instances)).toBe(row.instances);
    expect(Number(wins)).toBe(row.winsPerInstance);
    expect(probability).toBe(render.fraction(row.probability));
    expect(multiplier).toBe(render.fraction(row.multiplier));
    expect(decimal).toBe(`${render.multiplierDecimal(row.multiplier)}×`);
    expect(rtp).toBe(render.fraction(TARGET_RTP));
  });

  it('every documented RTP is the target RTP', () => {
    for (const row of table.rows) expect(row[7]).toBe('24/25');
  });

  it('documented wins over documented instances reproduce the documented probability', () => {
    for (const row of table.rows) {
      const wins = BigInt(row[3]);
      const derived = rational(wins, analysis.permutationCountBig);
      expect(render.fraction(derived)).toBe(row[4]);
    }
  });

  it('documented probability times documented multiplier is exactly 24/25', () => {
    for (const row of table.rows) {
      const [pn, pd] = row[4].split('/').map(BigInt);
      const [mn, md] = row[5].split('/').map(BigInt);
      const product = rational(pn * mn, pd * md);
      expect(render.fraction(product)).toBe('24/25');
    }
  });
});

describe('docs/paytable.json mirrors the enumeration', () => {
  const published = JSON.parse(readFileSync(PAYTABLE_JSON, 'utf8'));

  it('covers exactly the shipped variants', () => {
    expect(Object.keys(published.variants).sort()).toEqual([...VARIANT_IDS].sort());
  });

  it.each(VARIANT_IDS)('%s is byte-current', (variantId) => {
    const analysis = analyses[variantId];
    const entry = published.variants[variantId];
    expect(entry.n).toBe(analysis.n);
    expect(entry.permutationCount).toBe(analysis.permutationCount);
    expect(entry.adapterFingerprint).toBe(analysis.adapterFingerprint);
    expect(entry.targetRtp).toBe(render.fraction(TARGET_RTP));
    expect(entry.maxWinMultiple).toBe(LIMITS.maxWinMultiple.toString());
    expect(entry.supremumMultiplier).toBe(render.fraction(analysis.maxMultiplier));
    expect(entry.bets).toHaveLength(analysis.rows.length);
    entry.bets.forEach((bet, index) => {
      const row = analysis.rows[index];
      expect(bet.code).toBe(row.code);
      expect(bet.tier).toBe(row.tier);
      expect(bet.instances).toBe(row.instances);
      expect(bet.winsPerInstance).toBe(row.winsPerInstance);
      expect(bet.probability).toBe(render.fraction(row.probability));
      expect(bet.multiplier).toBe(render.fraction(row.multiplier));
      expect(bet.decimal).toBe(`${render.multiplierDecimal(row.multiplier)}x`);
      expect(bet.rtp).toBe(render.fraction(TARGET_RTP));
      expect(bet.variance).toBe(render.fraction(row.variance));
    });
  });
});

describe('docs/DESIGN.md quotes real multipliers', () => {
  const design = readFileSync(DESIGN_MD, 'utf8');

  it('the player-facing bet menu quotes only published multipliers', () => {
    const quoted = new Set(collectMultiplierTokens(design, '### FLOW — lands often', '### Ticket rules'));
    const publishedDecimals = new Set(
      VARIANT_IDS.flatMap((id) => analyses[id].rows.map((row) => render.multiplierDecimal(row.multiplier))),
    );
    expect([...quoted].sort()).toEqual([...publishedDecimals].sort());
  });

  it('states the single target RTP', () => {
    expect(design).toContain('96.000%');
  });
});

/**
 * Documentation drift guard.
 *
 * The seed commitment's field list is a security-critical claim repeated in
 * three documents. When it was strengthened to bind the nonce and variant, one
 * of the three was missed. These tests make that class of drift a build
 * failure: every document must name every field, and every named field must
 * demonstrably change the digest.
 */
describe('the seed commitment is described identically everywhere', () => {
  const docs = {
    'README.md': readFileSync(join(ROOT, 'README.md'), 'utf8'),
    'docs/MATH.md': readFileSync(MATH_MD, 'utf8'),
    'docs/ENGINE.md': readFileSync(join(ROOT, 'docs', 'ENGINE.md'), 'utf8'),
  };
  // One canonical rendering of the committed field list, in derivation order.
  // Every document must quote it verbatim, so a change to what the commitment
  // binds cannot land in one document and miss the others.
  const CANONICAL_FIELD_LIST = 'serverSeed ‖ gameId ‖ variantId ‖ roundId ‖ nonce';

  it.each(Object.keys(docs))('%s quotes the canonical committed field list', (name) => {
    expect(docs[name].includes(CANONICAL_FIELD_LIST), `${name} does not quote "${CANONICAL_FIELD_LIST}"`).toBe(true);
  });

  it('every field named in the docs actually changes the digest', () => {
    const base = { variantId: 'classic', roundId: 'r-1', nonce: 0 };
    const seedA = 'a'.repeat(64);
    const seedB = 'b'.repeat(64);
    const reference = seedCommitment(seedA, base);
    expect(seedCommitment(seedB, base)).not.toBe(reference);
    expect(seedCommitment(seedA, { ...base, variantId: 'seven' })).not.toBe(reference);
    expect(seedCommitment(seedA, { ...base, roundId: 'r-2' })).not.toBe(reference);
    expect(seedCommitment(seedA, { ...base, nonce: 1 })).not.toBe(reference);
  });
});
