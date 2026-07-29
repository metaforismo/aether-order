/**
 * Settlement: exact payouts, published limits, hostile tickets.
 */

import { describe, expect, it } from 'vitest';

import { AetherOrderError, exactChips, makeTranscript, settleTicket } from '../tools/lib/derive.mjs';
import { LIMITS, STAKE_LADDER, STAKE_QUANTUM, VARIANTS, getVariant } from '../tools/lib/model.mjs';
import { rational } from '../tools/lib/rational.mjs';

const SEED = 'c'.repeat(64);
const identity = (n) => Array.from({ length: n }, (_, i) => i);
/** A transcript-shaped object with a chosen permutation, for deterministic assertions. */
const at = (variantId, permutation) => ({ variantId, permutation });

describe('exact payouts', () => {
  it('pays stake x multiplier with no rounding, for every ladder rung', () => {
    for (const [code, multiplier] of Object.entries(VARIANTS.classic.multipliers)) {
      for (const stake of STAKE_LADDER) {
        const chips = exactChips(stake, multiplier);
        expect(typeof chips).toBe('bigint');
        expect(rational(chips).d).toBe(1n);
        expect(chips * multiplier.d).toBe(stake * multiplier.n);
      }
    }
  });

  it('throws rather than rounding when the quantum is violated', () => {
    // 1 chip x 48/25 is not an integer; settlement must refuse, never truncate.
    expect(() => exactChips(1n, VARIANTS.classic.multipliers.before)).toThrow(AetherOrderError);
  });

  it('credits a winning FULL ORDER line at exactly 115.20x in CLASSIC', () => {
    const settlement = settleTicket(at('classic', identity(5)), {
      lines: [{ code: 'full', params: { rank: 0 }, stakeChips: 100n }],
    });
    expect(settlement.lines[0].won).toBe(true);
    expect(settlement.grossChips).toBe(11520n); // 100 chips x 115.20
    expect(settlement.creditedChips).toBe(11520n);
    expect(settlement.capped).toBe(false);
    expect(settlement.netChips).toBe(11420n);
  });

  it('credits a winning FULL ORDER line at exactly 4838.40x in SEVEN', () => {
    const settlement = settleTicket(at('seven', identity(7)), {
      lines: [{ code: 'full', params: { rank: 0 }, stakeChips: 100n }],
    });
    expect(settlement.grossChips).toBe(483840n);
  });

  it('resolves each bet type correctly against a known permutation', () => {
    // CLASSIC identity: amber(0) first ... ivory(4) last.
    const t = at('classic', identity(5));
    const won = (code, params) => settleTicket(t, { lines: [{ code, params, stakeChips: 25n }] }).lines[0].won;

    expect(won('before', { a: 0, b: 4 })).toBe(true);
    expect(won('before', { a: 4, b: 0 })).toBe(false);
    expect(won('early', { c: 1 })).toBe(true);
    expect(won('early', { c: 2 })).toBe(false);
    expect(won('late', { c: 4 })).toBe(true);
    expect(won('late', { c: 0 })).toBe(false);
    expect(won('link-any', { a: 2, b: 3 })).toBe(true);
    expect(won('link-any', { a: 0, b: 3 })).toBe(false);
    expect(won('first', { c: 0 })).toBe(true);
    expect(won('first', { c: 1 })).toBe(false);
    expect(won('last', { c: 4 })).toBe(true);
    expect(won('slot', { c: 2, k: 2 })).toBe(true);
    expect(won('slot', { c: 2, k: 3 })).toBe(false);
    expect(won('link', { a: 1, b: 2 })).toBe(true);
    expect(won('link', { a: 2, b: 1 })).toBe(false);
    expect(won('opening', { a: 0, b: 1 })).toBe(true);
    expect(won('opening', { a: 1, b: 0 })).toBe(false);
    expect(won('full', { rank: 0 })).toBe(true);
    expect(won('full', { rank: 1 })).toBe(false);
  });

  it('sums correlated winning lines without interference', () => {
    const settlement = settleTicket(at('classic', identity(5)), {
      lines: [
        { code: 'first', params: { c: 0 }, stakeChips: 100n }, // 4.80x -> 480
        { code: 'early', params: { c: 0 }, stakeChips: 100n }, // 2.40x -> 240
        { code: 'opening', params: { a: 0, b: 1 }, stakeChips: 100n }, // 19.20x -> 1920
      ],
    });
    expect(settlement.lines.every((line) => line.won)).toBe(true);
    expect(settlement.grossChips).toBe(2640n);
    expect(settlement.totalStakeChips).toBe(300n);
  });
});

describe('published limits', () => {
  const t = at('classic', identity(5));
  const line = (over = {}) => ({ code: 'first', params: { c: 0 }, stakeChips: 100n, ...over });

  it('rejects an empty ticket', () => {
    expect(() => settleTicket(t, { lines: [] })).toThrow(AetherOrderError);
  });

  it('rejects more than the line limit', () => {
    const lines = Array.from({ length: LIMITS.maxLinesPerTicket + 1 }, () => line());
    expect(() => settleTicket(t, { lines })).toThrow(AetherOrderError);
  });

  it('rejects a stake below the minimum, above the maximum, or off the quantum', () => {
    expect(() => settleTicket(t, { lines: [line({ stakeChips: 0n })] })).toThrow(AetherOrderError);
    expect(() => settleTicket(t, { lines: [line({ stakeChips: LIMITS.maxLineStakeChips + STAKE_QUANTUM })] })).toThrow(
      AetherOrderError,
    );
    expect(() => settleTicket(t, { lines: [line({ stakeChips: 30n })] })).toThrow(AetherOrderError);
    expect(() => settleTicket(t, { lines: [line({ stakeChips: -25n })] })).toThrow(AetherOrderError);
  });

  it('rejects a non-BigInt stake', () => {
    expect(() => settleTicket(t, { lines: [line({ stakeChips: 100 })] })).toThrow(AetherOrderError);
  });

  it('rejects a ticket above the total stake limit', () => {
    const lines = Array.from({ length: LIMITS.maxLinesPerTicket }, () =>
      line({ stakeChips: LIMITS.maxLineStakeChips }),
    );
    expect(() => settleTicket(t, { lines })).toThrow(AetherOrderError);
  });

  it('rejects an unknown bet code and illegal parameters', () => {
    expect(() => settleTicket(t, { lines: [line({ code: 'jackpot' })] })).toThrow(RangeError);
    expect(() => settleTicket(t, { lines: [line({ params: { c: 99 } })] })).toThrow(AetherOrderError);
    expect(() => settleTicket(t, { lines: [line({ code: 'slot', params: { c: 0 } })] })).toThrow(AetherOrderError);
    expect(() => settleTicket(t, { lines: [line({ code: 'before', params: { a: 2, b: 2 } })] })).toThrow(
      AetherOrderError,
    );
  });

  it.each([null, undefined, 42, 'ticket', {}])('rejects hostile ticket %p', (ticket) => {
    expect(() => settleTicket(t, ticket)).toThrow(AetherOrderError);
  });

  it.each([
    [[0, 1, 2, 3]],
    [[0, 1, 2, 3, 4, 5]],
    [[0, 0, 1, 2, 3]],
    [[0, 1, 2, 3, 9]],
    [[0, 1, 2, 3, -1]],
    [[0, 1, 2, 3, 1.5]],
    ['01234'],
    [null],
  ])('rejects a malformed permutation %p even from a trusted caller', (permutation) => {
    expect(() => settleTicket(at('classic', permutation), { lines: [line()] })).toThrow(AetherOrderError);
  });
});

describe('the cap never binds on the shipped paytable', () => {
  it.each(Object.keys(VARIANTS))('%s: the maximum credit stays under the ceiling', (variantId) => {
    const { n } = getVariant(variantId);
    const transcript = at(variantId, identity(n));
    const settlement = settleTicket(transcript, {
      lines: [{ code: 'full', params: { rank: 0 }, stakeChips: LIMITS.maxLineStakeChips }],
    });
    expect(settlement.capped).toBe(false);
    expect(settlement.creditedChips).toBe(settlement.grossChips);
    expect(settlement.creditedChips).toBeLessThan(settlement.totalStakeChips * LIMITS.maxWinMultiple);
  });
});

describe('settlement runs against a real transcript', () => {
  it('settles the derived permutation, not a supplied one', () => {
    const transcript = makeTranscript(SEED, {
      variantId: 'classic',
      roundId: 'settle-1',
      clientSeed: '',
      nonce: 0,
    });
    const firstColour = transcript.permutation[0];
    const settlement = settleTicket(transcript, {
      lines: [
        { code: 'first', params: { c: firstColour }, stakeChips: 25n },
        { code: 'first', params: { c: (firstColour + 1) % 5 }, stakeChips: 25n },
      ],
    });
    expect(settlement.lines[0].won).toBe(true);
    expect(settlement.lines[1].won).toBe(false);
    expect(settlement.grossChips).toBe(120n); // 25 x 4.80
    expect(settlement.netChips).toBe(70n); // 120 credited - 50 staked
  });
});
