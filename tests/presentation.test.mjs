/**
 * Two player-protection rules that are only real if they are code.
 *
 *   1. No round that returns less than it cost may be celebrated.
 *   2. The headline figure on the build screen must be an outcome the game can
 *      actually produce.
 *
 * Both were prose in docs/DESIGN.md and both are the kind of rule that a client
 * quietly reimplements slightly differently. They now live in
 * tools/lib/presentation.mjs, and these tests are what stops them drifting.
 */

import { describe, expect, it } from 'vitest';

import { credits, roundPresentation, ticketStripFigures } from '../tools/lib/presentation.mjs';
import { makeTranscript, settleTicket } from '../tools/lib/derive.mjs';
import { allPermutations, outcomeViewOf } from '../tools/lib/permutations.mjs';
import { BET_FAMILIES, fullOrderParamsByRank } from '../tools/lib/bets.mjs';
import { LIMITS, STAKE_QUANTUM, VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';

const settlement = (totalStakeChips, creditedChips) =>
  Object.freeze({ totalStakeChips, creditedChips, netChips: creditedChips - totalStakeChips });

describe('the celebration gate', () => {
  it('celebrates exactly when the round returned more than it cost', () => {
    // Walk the boundary chip by chip. There is no tolerance, no "close enough",
    // and break-even is on the losing side of the line.
    for (const staked of [25n, 100n, 1200n, 20000n]) {
      for (const delta of [-staked, -25n, 0n, 25n, staked]) {
        const credited = staked + delta;
        if (credited < 0n) continue;
        const presentation = roundPresentation(settlement(staked, credited));
        expect(presentation.celebrate).toBe(credited > staked);
      }
    }
  });

  it('is the canonical loss-disguised-as-a-win case, and reports it as a loss', () => {
    // A 12-line, 12.00-credit ticket whose single BEFORE line returns 1.92.
    const presentation = roundPresentation(settlement(1200n, 192n));
    expect(presentation.celebrate).toBe(false);
    expect(presentation.outcome).toBe('partial-return');
    expect(presentation.headline).toBe('Returned 1.92 of 12.00');
    expect(presentation.netChips).toBe(-1008n);
  });

  it('suppresses every celebratory channel below the gate, not just the sound', () => {
    for (const credited of [0n, 25n, 192n, 1199n, 1200n]) {
      const presentation = roundPresentation(settlement(1200n, credited));
      expect(presentation.celebrate).toBe(false);
      expect(presentation.audio).toBe('none');
      expect(presentation.haptic).toBe('none');
      expect(presentation.multiplierStamp).toBe(false);
      expect(presentation.goldBloom).toBe(false);
      // A balance animating upward is a celebration whatever the copy says.
      expect(presentation.balanceCountsUp).toBe(false);
    }
  });

  it('treats break-even as not a win', () => {
    const presentation = roundPresentation(settlement(500n, 500n));
    expect(presentation.celebrate).toBe(false);
    expect(presentation.headline).toBe('Returned 5.00 of 5.00');
  });

  it('celebrates a genuine win, including a one-chip one', () => {
    const presentation = roundPresentation(settlement(500n, 525n));
    expect(presentation.celebrate).toBe(true);
    expect(presentation.outcome).toBe('win');
    expect(presentation.headline).toBe('Won 0.25');
    expect(presentation.audio).toBe('win-chord');
    expect(presentation.balanceCountsUp).toBe(true);
  });

  it('never suppresses line lighting — which lines won is information, not drama', () => {
    for (const credited of [0n, 192n, 1200n, 5000n]) {
      expect(roundPresentation(settlement(1200n, credited)).lineLighting).toBe(true);
    }
  });

  it('says nothing about a win when nothing was returned', () => {
    const presentation = roundPresentation(settlement(500n, 0n));
    expect(presentation.outcome).toBe('no-return');
    expect(presentation.headline).toBe('Returned 0.00 of 5.00');
  });

  it('refuses a settlement that is not exact integer chips', () => {
    expect(() => roundPresentation({ totalStakeChips: 100, creditedChips: 50 })).toThrow(TypeError);
    expect(() => roundPresentation({ totalStakeChips: 100n, creditedChips: 1.5 })).toThrow(TypeError);
    expect(() => roundPresentation(null)).toThrow(TypeError);
  });
});

describe.each(VARIANT_IDS)('the celebration gate through real settlements — %s', (variantId) => {
  const { n } = getVariant(variantId);

  it('agrees with the settlement path on every outcome of a real ticket', () => {
    const transcript = makeTranscript('cd'.repeat(32), {
      variantId,
      roundId: 'gate',
      clientSeed: '',
      nonce: 1,
    });
    // A ticket where exactly one cheap line usually hits: the classic shape of
    // a round that returns something and still loses money.
    const ticket = {
      lines: [
        { code: 'before', params: { a: 0, b: 1 }, stakeChips: 100n },
        { code: 'full', params: fullOrderParamsByRank(n, 0), stakeChips: 100n },
        { code: 'opening', params: { a: 2, b: 3 }, stakeChips: 100n },
      ],
    };
    let celebrated = 0;
    let returnedButLost = 0;
    for (const perm of allPermutations(n)) {
      const result = settleTicket({ variantId, permutation: perm }, ticket);
      const presentation = roundPresentation(result);
      expect(presentation.celebrate).toBe(result.creditedChips > result.totalStakeChips);
      if (presentation.celebrate) celebrated += 1;
      else if (result.creditedChips > 0n) returnedButLost += 1;
    }
    // The case the rule exists for must actually occur, or the test proves
    // nothing: a BEFORE-only hit returns 192 against a 300 stake.
    expect(returnedButLost).toBeGreaterThan(0);
    expect(celebrated).toBeGreaterThan(0);
  });
});

describe.each(VARIANT_IDS)('the ticket strip headline is a real maximum — %s', (variantId) => {
  const { n } = getVariant(variantId);
  const permutationCount = allPermutations(n).length;

  it('four FULL ORDER lines cannot all hit, and the figure says so', () => {
    const figures = ticketStripFigures(variantId, {
      lines: [0, 1, 2, 3].map((rank) => ({
        code: 'full',
        params: fullOrderParamsByRank(n, rank),
        stakeChips: LIMITS.maxLineStakeChips,
      })),
    });
    // Exactly one of four mutually exclusive lines can ever hit.
    expect(figures.bestOutcomeChips * 4n).toBe(figures.sumIfEveryLineHitChips);
    expect(figures.everyLineCanHitTogether).toBe(false);
    expect(figures.bestOutcomeWinningLines).toBe(1);
  });

  it('three FIRST lines on different colours cannot all hit', () => {
    const figures = ticketStripFigures(variantId, {
      lines: [0, 1, 2].map((c) => ({ code: 'first', params: { c }, stakeChips: 100n })),
    });
    expect(figures.bestOutcomeChips * 3n).toBe(figures.sumIfEveryLineHitChips);
    expect(figures.everyLineCanHitTogether).toBe(false);
  });

  it('agrees with the sum when every line genuinely can hit together', () => {
    const figures = ticketStripFigures(variantId, {
      lines: [
        { code: 'full', params: fullOrderParamsByRank(n, 0), stakeChips: 100n },
        { code: 'opening', params: { a: 0, b: 1 }, stakeChips: 100n },
        { code: 'slot', params: { c: 2, k: 2 }, stakeChips: 100n },
      ],
    });
    expect(figures.everyLineCanHitTogether).toBe(true);
    expect(figures.bestOutcomeChips).toBe(figures.sumIfEveryLineHitChips);
    expect(figures.bestOutcomeRank).toBe(0);
  });

  it('is never above the naive sum, and never below the best real outcome', () => {
    // Cross-check against an independent brute force over the whole space: for
    // a spread of tickets, recompute the maximum credit line by line.
    const tickets = [
      [{ code: 'before', params: { a: 0, b: 1 }, stakeChips: 100n }],
      [
        { code: 'before', params: { a: 0, b: 1 }, stakeChips: 100n },
        { code: 'before', params: { a: 1, b: 0 }, stakeChips: 100n },
      ],
      [
        { code: 'podium', params: { a: 0, b: 1, c: 2 }, stakeChips: 250n },
        { code: 'late', params: { c: 4 }, stakeChips: 250n },
        { code: 'link', params: { a: 0, b: 1 }, stakeChips: 250n },
      ],
      Array.from({ length: n }, (_, c) => ({ code: 'first', params: { c }, stakeChips: STAKE_QUANTUM })),
    ];
    for (const lines of tickets) {
      const figures = ticketStripFigures(variantId, { lines });
      let brute = 0n;
      for (const perm of allPermutations(n)) {
        const view = outcomeViewOf(perm, n);
        let payout = 0n;
        for (const line of lines) {
          const family = BET_FAMILIES.find((candidate) => candidate.code === line.code);
          const instance = family
            .instances(n, { permutationCount })
            .find((candidate) => Object.keys(candidate.params).every((key) => candidate.params[key] === line.params[key]));
          if (family.resolve(instance, view)) {
            payout += (line.stakeChips * getVariant(variantId).multipliers[line.code].n) /
              getVariant(variantId).multipliers[line.code].d;
          }
        }
        if (payout > brute) brute = payout;
      }
      expect(figures.bestOutcomeChips).toBe(brute);
      expect(figures.bestOutcomeChips).toBeLessThanOrEqual(figures.sumIfEveryLineHitChips);
    }
  });

  it('labels the figure as a best possible outcome, never as a maximum return', () => {
    const figures = ticketStripFigures(variantId, {
      lines: [{ code: 'first', params: { c: 0 }, stakeChips: 100n }],
    });
    expect(figures.display.best).toMatch(/^best possible outcome /u);
    expect(figures.display.best).not.toMatch(/max/iu);
  });

  it('renders credits exactly, never as a float', () => {
    expect(credits(192n)).toBe('1.92');
    expect(credits(0n)).toBe('0.00');
    expect(credits(2436000n)).toBe('24360.00');
  });
});
