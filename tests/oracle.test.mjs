/**
 * Closed-form oracle.
 *
 * The enumerator establishes the paytable by brute force: every instance
 * against every permutation. This suite establishes the same numbers by a
 * completely independent route — closed-form combinatorics derived by hand in
 * docs/MATH.md §3.1 — and requires the two to agree.
 *
 * The value of an oracle is that the two paths share no code. A bug in a
 * resolve predicate would move the enumeration and leave the oracle still
 * quoting the textbook count; a bug in the algebra of docs/MATH.md would move
 * the oracle and leave the enumeration alone. Only a coincidence that broke
 * both identically could slip through.
 */

import { describe, expect, it } from 'vitest';

import { enumerateVariant, render } from '../tools/lib/analysis.mjs';
import { TARGET_RTP, VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';
import { factorialBig } from '../tools/lib/permutations.mjs';
import { eq, mul, rational, sub } from '../tools/lib/rational.mjs';

const f = factorialBig;
const big = (value) => BigInt(value);

/** Winning permutations per instance, from first principles. */
const ORACLE_WINS = Object.freeze({
  // Exactly one of "A before B" and "B before A" holds, and the two cases are
  // in bijection via transposing A and B, so each owns half the space.
  before: (n) => f(n) / 2n,
  // Choose which of the two lowest slots the colour takes (2 ways), then
  // arrange the rest freely.
  early: (n) => 2n * f(n - 1),
  late: (n) => 2n * f(n - 1),
  // Glue the pair into one block: (n-1)! block arrangements x 2 internal orders.
  'link-any': (n) => 2n * f(n - 1),
  // Fix one colour in one slot; arrange the remaining n-1 freely.
  first: (n) => f(n - 1),
  last: (n) => f(n - 1),
  slot: (n) => f(n - 1),
  // Same glued block, internal order fixed.
  link: (n) => f(n - 1),
  // Two slots pinned; arrange the remaining n-2.
  opening: (n) => f(n - 2),
  full: () => 1n,
});

/** Legal instances per family, from first principles. */
const ORACLE_INSTANCES = Object.freeze({
  before: (n) => big(n) * big(n - 1),
  early: (n) => big(n),
  late: (n) => big(n),
  'link-any': (n) => (big(n) * big(n - 1)) / 2n,
  first: (n) => big(n),
  last: (n) => big(n),
  slot: (n) => big(n) * big(n),
  link: (n) => big(n) * big(n - 1),
  opening: (n) => big(n) * big(n - 1),
  full: (n) => f(n),
});

describe.each(VARIANT_IDS)('%s — closed-form oracle vs brute-force enumeration', (variantId) => {
  const { n } = getVariant(variantId);
  const analysis = enumerateVariant(variantId);

  it('covers every implemented family', () => {
    expect(Object.keys(ORACLE_WINS).sort()).toEqual(analysis.rows.map((row) => row.code).sort());
    expect(Object.keys(ORACLE_INSTANCES).sort()).toEqual(analysis.rows.map((row) => row.code).sort());
  });

  it.each(analysis.rows.map((row) => [row.code, row]))('%s: win count matches the textbook formula', (code, row) => {
    expect(big(row.winsPerInstance)).toBe(ORACLE_WINS[code](n));
  });

  it.each(analysis.rows.map((row) => [row.code, row]))('%s: instance count matches the textbook formula', (code, row) => {
    expect(big(row.instances)).toBe(ORACLE_INSTANCES[code](n));
  });

  it.each(analysis.rows.map((row) => [row.code, row]))('%s: probability is wins / n!', (code, row) => {
    expect(eq(row.probability, rational(ORACLE_WINS[code](n), f(n)))).toBe(true);
  });

  it.each(analysis.rows.map((row) => [row.code, row]))('%s: multiplier x probability is exactly 24/25', (code, row) => {
    const oracleProbability = rational(ORACLE_WINS[code](n), f(n));
    expect(eq(mul(oracleProbability, row.multiplier), TARGET_RTP)).toBe(true);
  });

  it.each(analysis.rows.map((row) => [row.code, row]))('%s: variance is rho^2 (1/p - 1)', (code, row) => {
    const p = rational(ORACLE_WINS[code](n), f(n));
    const oracleVariance = mul(mul(TARGET_RTP, TARGET_RTP), rational(p.d - p.n, p.n));
    expect(render.fraction(row.variance)).toBe(render.fraction(oracleVariance));
  });

  it.each(analysis.rows.map((row) => [row.code, row]))('%s: the published decimal is exact', (code, row) => {
    const decimal = render.multiplierDecimal(row.multiplier);
    // decimal x 100 must reproduce the fraction with no remainder.
    expect(BigInt(decimal.replace('.', '')) * row.multiplier.d).toBe(row.multiplier.n * 100n);
  });

  it('the whole outcome space is accounted for by the FULL ORDER family', () => {
    const full = analysis.rows.find((row) => row.code === 'full');
    // Its instances partition S_n: one instance per outcome, one win each.
    expect(big(full.instances) * big(full.winsPerInstance)).toBe(f(n));
    expect(sub(rational(1n), mul(rational(big(full.instances)), full.probability)).n).toBe(0n);
  });
});
