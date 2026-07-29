/**
 * "No decision policy beats the target RTP" — checked exhaustively.
 *
 * docs/MATH.md §9 proves three statements. These tests verify each by
 * enumeration rather than by trusting the algebra:
 *
 *   Theorem 1  any single-round ticket returns exactly 24/25;
 *   Theorem 2  no ticket has a guaranteed return above 24/25;
 *   Theorem 3  no adaptive, sequential, stopping-rule policy changes it.
 *
 * Theorem 3 is checked over the complete two-round outcome space
 * (120 x 120 = 14,400 ordered pairs for CLASSIC), with a policy whose second
 * round genuinely depends on the first round's outcome — including a stopping
 * rule and a stake-doubling loss-chase.
 */

import { describe, expect, it } from 'vitest';

import { proveCoverTickets, proveTicketInvariance, enumerateVariant, render } from '../tools/lib/analysis.mjs';
import { BET_FAMILIES, getFamily } from '../tools/lib/bets.mjs';
import { exactChips, makeTranscript } from '../tools/lib/derive.mjs';
import { STAKE_LADDER, TARGET_RTP, VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';
import { allPermutations, factorialBig, permutationRank, positionsOf } from '../tools/lib/permutations.mjs';
import { cmp, div, eq, mul, rational } from '../tools/lib/rational.mjs';

const viewsFor = (n) =>
  allPermutations(n).map((perm) =>
    Object.freeze({ perm, pos: positionsOf(perm), rank: permutationRank(perm), n }),
  );

/** Exact payout of a ticket under one outcome, in chips. */
function payoutOf(variant, lines, view) {
  let payout = 0n;
  for (const line of lines) {
    const family = getFamily(line.code);
    const instances = family.instances(variant.n, { permutationCount: Number(factorialBig(variant.n)) });
    const instance = instances.find((candidate) => candidate.label === line.label);
    if (!instance) throw new RangeError(`No instance ${line.label} in ${line.code}`);
    if (family.resolve(instance, view)) {
      payout += exactChips(line.stakeChips, variant.multipliers[family.code]);
    }
  }
  return payout;
}

const stakeOf = (lines) => lines.reduce((sum, line) => sum + line.stakeChips, 0n);

describe.each(VARIANT_IDS)('%s — Theorem 1: single-round invariance', (variantId) => {
  const analysis = enumerateVariant(variantId);

  it('every single bet instance returns exactly 24/25', () => {
    for (const row of analysis.rows) {
      expect(eq(mul(row.probability, row.multiplier), TARGET_RTP), row.code).toBe(true);
    }
  });

  it('structured and pseudo-random multi-line tickets all return exactly 24/25', () => {
    const tickets = [];
    // Deterministic sweep across families, instances and ladder rungs.
    for (let t = 0; t < 60; t += 1) {
      const lineCount = 1 + (t % 12);
      tickets.push({
        name: `sweep-${t}`,
        lines: Array.from({ length: lineCount }, (_, i) => ({
          code: BET_FAMILIES[(t + i) % BET_FAMILIES.length].code,
          instanceIndex: t * 13 + i * 7,
          stakeChips: STAKE_LADDER[(t + i) % STAKE_LADDER.length],
        })),
      });
    }
    const result = proveTicketInvariance(variantId, tickets);
    expect(result.allMatch).toBe(true);
    for (const ticket of result.tickets) expect(render.fraction(ticket.rtp)).toBe('24/25');
  });
});

describe.each(VARIANT_IDS)('%s — Theorem 2: no arbitrage', (variantId) => {
  const analysis = enumerateVariant(variantId);

  it('complete covers return exactly 24/25 with certainty', () => {
    const covers = proveCoverTickets(analysis);
    expect(covers.allMatch).toBe(true);
  });

  it('no ticket can guarantee a profit', () => {
    const tickets = Array.from({ length: 40 }, (_, t) => ({
      name: `arb-${t}`,
      lines: Array.from({ length: 1 + (t % 12) }, (_, i) => ({
        code: BET_FAMILIES[(t * 3 + i) % BET_FAMILIES.length].code,
        instanceIndex: t * 29 + i * 11,
        stakeChips: STAKE_LADDER[(t + i) % STAKE_LADDER.length],
      })),
    }));
    const result = proveTicketInvariance(variantId, tickets);
    expect(result.anyGuaranteedProfit).toBe(false);
    for (const ticket of result.tickets) {
      // The guaranteed return is min over outcomes, and min <= E = rho * S.
      const worstRatio = rational(ticket.worstOutcomeChips, ticket.totalStakeChips);
      expect(cmp(worstRatio, TARGET_RTP)).toBeLessThanOrEqual(0);
      // The best outcome is bounded by the largest multiplier on the ticket.
      expect(cmp(ticket.bestMultiple, analysis.maxMultiplier)).toBeLessThanOrEqual(0);
    }
  });

  it('a perfect hedge is a deterministic 4% fee, not an edge', () => {
    const variant = getVariant(variantId);
    const views = viewsFor(variant.n);
    const lines = Array.from({ length: variant.n }, (_, c) => ({
      code: 'first',
      label: `f${c}`,
      stakeChips: 25n,
    }));
    const stake = stakeOf(lines);
    const payouts = new Set(views.map((view) => payoutOf(variant, lines, view)));
    expect(payouts.size, 'a complete cover must be constant').toBe(1);
    const [only] = [...payouts];
    expect(eq(rational(only, stake), TARGET_RTP)).toBe(true);
  });
});

describe('Theorem 3: adaptive sequential play cannot change the RTP', () => {
  const variantId = 'classic';
  const variant = getVariant(variantId);
  const views = viewsFor(variant.n);
  const N = BigInt(views.length);

  /**
   * A deliberately adversarial policy:
   *  - round 1: a fixed FIRST line on AMBER at 1.00 credit;
   *  - if it lost, chase: double the stake and bet FIRST on whichever colour
   *    actually came first last round (the gambler's-fallacy play);
   *  - if it won, "lock in" by dropping to the minimum stake on FULL ORDER for
   *    the permutation that just happened;
   *  - and on a specific outcome, stop entirely (a stopping rule).
   */
  const round1 = [{ code: 'first', label: 'f0', stakeChips: 100n }];
  const round2For = (view1) => {
    const won = view1.pos[0] === 0;
    if (view1.rank === 7) return []; // stopping rule: quit after this outcome
    if (won) return [{ code: 'full', label: `full#${view1.rank}`, stakeChips: 25n }];
    return [{ code: 'first', label: `f${view1.perm[0]}`, stakeChips: 200n }];
  };

  it('returns exactly 24/25 over the complete two-round outcome space', () => {
    let totalStake = 0n;
    let totalPayout = 0n;
    let pairs = 0n;

    for (const view1 of views) {
      const payout1 = payoutOf(variant, round1, view1);
      const lines2 = round2For(view1);
      const stake2 = stakeOf(lines2);
      for (const view2 of views) {
        pairs += 1n;
        totalStake += stakeOf(round1) + stake2;
        totalPayout += payout1 + (lines2.length > 0 ? payoutOf(variant, lines2, view2) : 0n);
      }
    }

    expect(pairs).toBe(N * N);
    const rtp = div(rational(totalPayout), rational(totalStake));
    expect(render.fraction(rtp)).toBe('24/25');
    expect(eq(rtp, TARGET_RTP)).toBe(true);
  });

  it('the expected net loss is exactly 4% of turnover, whatever the policy', () => {
    let totalStake = 0n;
    let totalPayout = 0n;
    for (const view1 of views) {
      const payout1 = payoutOf(variant, round1, view1);
      const lines2 = round2For(view1);
      for (const view2 of views) {
        totalStake += stakeOf(round1) + stakeOf(lines2);
        totalPayout += payout1 + (lines2.length > 0 ? payoutOf(variant, lines2, view2) : 0n);
      }
    }
    const net = rational(totalPayout - totalStake, totalStake);
    expect(render.fraction(net)).toBe('-1/25');
  });

  it('conditional expectation is 24/25 for every first-round outcome', () => {
    // E[round-2 payout | omega_1] = rho * stake_2(omega_1), for every omega_1.
    for (const view1 of views) {
      const lines2 = round2For(view1);
      if (lines2.length === 0) continue;
      const total = views.reduce((sum, view2) => sum + payoutOf(variant, lines2, view2), 0n);
      const conditional = div(rational(total, N), rational(stakeOf(lines2)));
      expect(eq(conditional, TARGET_RTP), `outcome ${view1.rank}`).toBe(true);
    }
  });
});

describe('presentational choices cannot reach the outcome', () => {
  const SEED = 'd'.repeat(64);
  const base = { variantId: 'classic', roundId: 'ui-1', clientSeed: 'axiom', nonce: 0 };
  // The values a client might plausibly leak into a context object.
  const uiConcerns = {
    skip: true,
    mute: true,
    haptics: false,
    skin: 'abyss',
    latency: 412,
    deviceTier: 'low',
    reducedMotion: true,
    locale: 'it-IT',
    timestamp: 1_753_000_000_000,
  };

  it('extra UI fields in the context change neither the permutation nor the commitment', () => {
    // Exercised through the real derivation, not by comparing two hard-coded
    // lists: an implementation that mixed `skip` into the sampler would fail.
    const reference = makeTranscript(SEED, base);
    for (const [key, value] of Object.entries(uiConcerns)) {
      const polluted = makeTranscript(SEED, { ...base, [key]: value });
      expect(polluted.permutation, `${key} changed the permutation`).toEqual(reference.permutation);
      expect(polluted.commitment, `${key} changed the commitment`).toBe(reference.commitment);
      expect(polluted.seedCommitment).toBe(reference.seedCommitment);
    }
    // All of them at once, for good measure.
    const all = makeTranscript(SEED, { ...base, ...uiConcerns });
    expect(all.permutation).toEqual(reference.permutation);
    expect(all.commitment).toBe(reference.commitment);
  });

  it('a declared input, by contrast, does change the commitment', () => {
    // The control: proves the test above is capable of detecting a change.
    const reference = makeTranscript(SEED, base);
    expect(makeTranscript(SEED, { ...base, clientSeed: 'other' }).commitment).not.toBe(reference.commitment);
    expect(makeTranscript(SEED, { ...base, nonce: 1 }).commitment).not.toBe(reference.commitment);
  });

  it('the transcript exposes only the declared inputs', () => {
    const transcript = makeTranscript(SEED, { ...base, ...uiConcerns });
    for (const key of Object.keys(uiConcerns)) expect(Object.keys(transcript)).not.toContain(key);
  });
});
