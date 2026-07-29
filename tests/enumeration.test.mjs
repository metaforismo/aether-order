/**
 * The exhaustive proofs, run as tests.
 *
 * Everything here enumerates the complete outcome space. Nothing samples.
 */

import { describe, expect, it } from 'vitest';

import {
  enumerateVariant,
  proveCapHeadroom,
  proveCoverTickets,
  proveMaxRoundCredit,
  proveRejectionUniformity,
  proveShuffleBijection,
  proveStakeQuantum,
  render,
} from '../tools/lib/analysis.mjs';
import { BET_CODES, BET_FAMILIES } from '../tools/lib/bets.mjs';
import { LIMITS, STAKE_QUANTUM, TARGET_RTP, VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';
import { allPermutations, factorialBig, permutationRank, positionsOf } from '../tools/lib/permutations.mjs';
import { cmp, eq, mul, rational } from '../tools/lib/rational.mjs';

describe.each(VARIANT_IDS)('variant %s', (variantId) => {
  const variant = getVariant(variantId);
  const analysis = enumerateVariant(variantId);

  it('enumerates the whole symmetric group', () => {
    expect(analysis.permutationCount).toBe(Number(factorialBig(variant.n)));
    expect(analysis.permutationCountBig).toBe(factorialBig(variant.n));
  });

  it('prices every bet type at exactly 24/25', () => {
    expect(analysis.exact).toBe(true);
    expect(analysis.offenders).toHaveLength(0);
    for (const row of analysis.rows) {
      expect(eq(row.expectedValue, TARGET_RTP)).toBe(true);
      expect(eq(row.multiplier, row.fairMultiplier)).toBe(true);
    }
  });

  it('implements exactly the documented bet catalogue', () => {
    expect(analysis.rows.map((row) => row.code)).toEqual([...BET_CODES]);
  });

  it('keeps every family homogeneous — one win count per family', () => {
    const permutations = allPermutations(variant.n);
    const contexts = permutations.map((perm) => ({
      perm,
      pos: positionsOf(perm),
      rank: permutationRank(perm),
      n: variant.n,
    }));
    for (const family of BET_FAMILIES) {
      const counts = family
        .instances(variant.n, { permutationCount: permutations.length })
        .map((instance) => contexts.reduce((wins, ctx) => wins + (family.resolve(instance, ctx) ? 1 : 0), 0));
      expect(new Set(counts).size, `family ${family.code} is heterogeneous`).toBe(1);
    }
  });

  it('resolves every bet as a pure function of (instance, permutation)', () => {
    const perm = Array.from({ length: variant.n }, (_, i) => i);
    const ctx = Object.freeze({ perm, pos: positionsOf(perm), rank: permutationRank(perm), n: variant.n });
    for (const family of BET_FAMILIES) {
      for (const instance of family.instances(variant.n, { permutationCount: analysis.permutationCount })) {
        const first = family.resolve(instance, ctx);
        const second = family.resolve(instance, ctx);
        expect(typeof first).toBe('boolean');
        expect(second).toBe(first);
      }
      // enumerateInstances must be deterministic
      const a = family.instances(variant.n, { permutationCount: analysis.permutationCount }).map((i) => i.label);
      const b = family.instances(variant.n, { permutationCount: analysis.permutationCount }).map((i) => i.label);
      expect(b).toEqual(a);
      expect(new Set(a).size, `family ${family.code} has duplicate labels`).toBe(a.length);
    }
  });

  it('has no degenerate bet type', () => {
    for (const row of analysis.rows) {
      expect(row.winsPerInstance).toBeGreaterThan(0);
      expect(row.winsPerInstance).toBeLessThan(analysis.permutationCount);
    }
  });

  it('orders tier labels monotonically in variance', () => {
    expect(analysis.tiersMonotone).toBe(true);
  });

  it('derives an unbiased permutation: the shuffle is a bijection', () => {
    const proof = proveShuffleBijection(variant.n);
    expect(proof.bijective).toBe(true);
    expect(proof.drawVectors).toBe(proof.permutationCount);
    expect(proof.distinctImages).toBe(proof.permutationCount);
  });

  it('keeps the round cap strictly non-binding', () => {
    const cap = proveCapHeadroom(analysis);
    expect(cap.capCanBind).toBe(false);
    expect(cmp(cap.headroom, rational(0n))).toBe(1);
  });

  it('removes rounding entirely via the stake quantum', () => {
    const quantum = proveStakeQuantum(analysis);
    expect(quantum.denominatorsDivideQuantum).toBe(true);
    expect(quantum.everyLegalStakeExact).toBe(true);
    expect(quantum.roundingIsNoOp).toBe(true);
    for (const row of analysis.rows) expect(STAKE_QUANTUM % row.multiplier.d).toBe(0n);
  });

  it('returns exactly 24/25 on complete covers, with zero variance', () => {
    const covers = proveCoverTickets(analysis);
    expect(covers.allMatch).toBe(true);
    for (const cover of covers.covers) expect(render.fraction(cover.ratio)).toBe('24/25');
  });

  it('settles the best possible round below the cap', () => {
    const best = proveMaxRoundCredit(variantId);
    expect(best.capped).toBe(false);
    expect(best.allLinesWon).toBe(true);
    expect(best.totalStakeChips).toBeLessThanOrEqual(LIMITS.maxTicketStakeChips);
    expect(cmp(best.roundMultiple, rational(LIMITS.maxWinMultiple))).toBe(-1);
  });

  it('keeps variance consistent with the closed form rho^2 * (1/p - 1)', () => {
    const rhoSquared = mul(TARGET_RTP, TARGET_RTP);
    for (const row of analysis.rows) {
      const closedForm = mul(rhoSquared, rational(row.probability.d - row.probability.n, row.probability.n));
      expect(eq(row.variance, closedForm)).toBe(true);
    }
  });
});

describe('rejection sampler', () => {
  it.each([2n, 3n, 4n, 5n, 6n, 7n])('is exactly uniform for modulus %s', (modulus) => {
    const proof = proveRejectionUniformity(10, modulus);
    expect(proof.uniform).toBe(true);
    expect(proof.acceptRegion % modulus).toBe(0n);
    expect(BigInt(proof.perResidue) * modulus).toBe(proof.acceptRegion);
  });

  it('shows the bias that naive truncation would have introduced', () => {
    // 2^10 = 1024 is not divisible by 7, so truncation favours the low residues.
    const proof = proveRejectionUniformity(10, 7n);
    expect(proof.naiveBiased).toBe(true);
    expect(render.fraction(proof.naiveBias)).toBe('1/146');
  });

  it('has nothing to correct when the modulus divides the domain', () => {
    const proof = proveRejectionUniformity(10, 4n);
    expect(proof.rejected).toBe(0n);
    expect(proof.naiveBiased).toBe(false);
  });
});
