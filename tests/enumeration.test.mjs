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
  optimalityWitness,
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
    // Every instance against every outcome, evaluated twice, with deeply frozen
    // arguments so a predicate that mutated its inputs would throw in strict
    // mode rather than pass. This is the claim docs/ENGINE.md section 8 makes.
    const views = allPermutations(variant.n).map((perm) =>
      Object.freeze({
        perm: Object.freeze(perm),
        pos: Object.freeze(positionsOf(perm)),
        rank: permutationRank(perm),
        n: variant.n,
      }),
    );
    for (const family of BET_FAMILIES) {
      for (const instance of family.instances(variant.n, { permutationCount: analysis.permutationCount })) {
        expect(Object.isFrozen(instance.params)).toBe(true);
        for (const view of views) {
          const first = family.resolve(instance, view);
          if (typeof first !== 'boolean') throw new TypeError(`${family.code} returned a non-boolean`);
          if (family.resolve(instance, view) !== first) {
            throw new Error(`${family.code} is non-deterministic on ${instance.label}`);
          }
        }
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
    for (const cover of covers.covers) {
      // Resolved against every outcome: constant payout, exactly one winner.
      expect(cover.zeroVariance).toBe(true);
      expect(cover.winningLinesPerOutcome).toEqual([1]);
      expect(render.fraction(cover.ratio)).toBe('24/25');
    }
  });

  it('settles the best possible round below the cap, and it is a true maximum', () => {
    const best = proveMaxRoundCredit(variantId);
    expect(best.capped).toBe(false);
    expect(best.allLinesWon).toBe(true);
    expect(best.optimal).toBe(true);
    expect(best.witness.noBetterUnchosen).toBe(true);
    expect(best.witness.matchesIndependentSelection).toBe(true);
    expect(best.witness.budgetExhausted).toBe(true);
    expect(best.totalStakeChips).toBe(LIMITS.maxTicketStakeChips);
    expect(cmp(best.roundMultiple, rational(LIMITS.maxWinMultiple))).toBe(-1);
  });

  it('the optimality witness rejects a deliberately bad selection', () => {
    // Guard against a tautological witness: feed it the WORST four winning
    // claims instead of the best and require it to say no. If the witness were
    // reading back the same ordering the selection came from, this would pass
    // and the maximum-credit figure would be unproved.
    const winners = [
      { code: 'full', params: { rank: 0 }, multiplier: variant.multipliers.full },
      { code: 'opening', params: { a: 0, b: 1 }, multiplier: variant.multipliers.opening },
      { code: 'first', params: { c: 0 }, multiplier: variant.multipliers.first },
      { code: 'before', params: { a: 0, b: 1 }, multiplier: variant.multipliers.before },
      { code: 'early', params: { c: 0 }, multiplier: variant.multipliers.early },
    ];
    const worstFirst = [...winners].sort((a, b) => cmp(a.multiplier, b.multiplier)).slice(0, 4);
    const badLines = worstFirst.map((winner) => ({
      code: winner.code,
      params: winner.params,
      stakeChips: LIMITS.maxLineStakeChips,
    }));
    const bad = optimalityWitness(variant, winners, badLines, LIMITS.maxTicketStakeChips);
    expect(bad.optimal).toBe(false);
    expect(bad.noBetterUnchosen).toBe(false);
    expect(bad.matchesIndependentSelection).toBe(false);

    // And it accepts the genuinely best four.
    const bestFirst = [...winners].sort((a, b) => cmp(b.multiplier, a.multiplier)).slice(0, 4);
    const goodLines = bestFirst.map((winner) => ({
      code: winner.code,
      params: winner.params,
      stakeChips: LIMITS.maxLineStakeChips,
    }));
    expect(optimalityWitness(variant, winners, goodLines, LIMITS.maxTicketStakeChips).optimal).toBe(true);
  });

  it('the optimality witness rejects a full line count at minimum stakes', () => {
    // Reaching the 12-line limit is not "nothing left to buy" if the lines sit
    // at the minimum stake — 19,700 chips of budget would still be unspent.
    // The witness must require the budget spent, or the line limit reached with
    // every line already at the per-line ceiling.
    const winners = Array.from({ length: LIMITS.maxLinesPerTicket }, (_, i) => ({
      code: 'slot',
      params: { c: i % variant.n, k: i % variant.n },
      multiplier: variant.multipliers.slot,
    }));
    const cheap = winners.map((w) => ({ code: w.code, params: w.params, stakeChips: LIMITS.minLineStakeChips }));
    const cheapWitness = optimalityWitness(variant, winners, cheap, LIMITS.minLineStakeChips * 12n);
    expect(cheapWitness.optimal).toBe(false);
    expect(cheapWitness.budgetExhausted).toBe(false);
    expect(cheapWitness.everyLineAtCeiling).toBe(false);
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
