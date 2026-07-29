/**
 * AETHER ORDER game model.
 *
 * This module is the single source of truth for the shipped configuration:
 * variants, elements, published multipliers, limits and the cap. The enumerator
 * and the test suite both import it, and both prove that the published
 * multipliers reproduce the target RTP exactly. Nothing here is derived from a
 * simulation.
 */

import { rational } from './rational.mjs';

export const GAME_ID = 'aether-order';
export const ADAPTER_VERSION = '1.0.0';
export const MODULE_VERSION = 'reveal-engine/permutation-v1';
export const TRANSCRIPT_SCHEMA = 'reveal-engine/permutation-transcript-v1';
export const SEED_COMMIT_DOMAIN = 'aether-order/seed-commit-v1';

/** Target theoretical return to player, exact: 24/25 = 96.000%. */
export const TARGET_RTP = rational(24n, 25n);

/**
 * Accounting unit. One chip is 1/100 of a display credit. Stakes are integer
 * chips and must be a multiple of STAKE_QUANTUM, which makes every published
 * multiplier land on an exact integer chip payout (proved by the enumerator).
 */
export const CHIPS_PER_CREDIT = 100n;
export const STAKE_QUANTUM = 25n;

/** Published stake ladder, in chips: 0.25 .. 50.00 credits. */
export const STAKE_LADDER = Object.freeze([25n, 50n, 100n, 250n, 500n, 1000n, 2500n, 5000n]);

export const LIMITS = Object.freeze({
  maxLinesPerTicket: 12,
  minLineStakeChips: 25n,
  maxLineStakeChips: 5000n,
  maxTicketStakeChips: 20000n,
  /** Round credit ceiling as a multiple of the ticket's total stake. */
  maxWinMultiple: 5000n,
  maxClientSeedBytes: 64,
  maxRoundIdBytes: 128,
});

/** Element identity is shared across variants; SEVEN appends two elements. */
export const ELEMENTS = Object.freeze([
  Object.freeze({ id: 'amber', name: 'AMBER', hex: '#FFB020', glyph: 'disc' }),
  Object.freeze({ id: 'coral', name: 'CORAL', hex: '#FF5A5F', glyph: 'ring' }),
  Object.freeze({ id: 'violet', name: 'VIOLET', hex: '#A06BFF', glyph: 'triangle' }),
  Object.freeze({ id: 'aqua', name: 'AQUA', hex: '#2FE0C8', glyph: 'square' }),
  Object.freeze({ id: 'ivory', name: 'IVORY', hex: '#F2F4F8', glyph: 'diamond' }),
  Object.freeze({ id: 'indigo', name: 'INDIGO', hex: '#4C6BFF', glyph: 'chevron' }),
  Object.freeze({ id: 'rose', name: 'ROSE', hex: '#FF7FD1', glyph: 'hexagon' }),
]);

/**
 * Published multipliers per variant, keyed by bet code.
 *
 * These are the numbers printed on the chips in the client and in
 * docs/MATH.md. They are declared, not computed, so that the enumerator can
 * independently verify multiplier x probability === TARGET_RTP for every bet.
 */
const CLASSIC_MULTIPLIERS = Object.freeze({
  before: rational(48n, 25n), //   1.92x
  early: rational(12n, 5n), //     2.40x
  late: rational(12n, 5n), //      2.40x
  'link-any': rational(12n, 5n), //2.40x
  first: rational(24n, 5n), //     4.80x
  last: rational(24n, 5n), //      4.80x
  slot: rational(24n, 5n), //      4.80x
  link: rational(24n, 5n), //      4.80x
  opening: rational(96n, 5n), //  19.20x
  full: rational(576n, 5n), //   115.20x
});

const SEVEN_MULTIPLIERS = Object.freeze({
  before: rational(48n, 25n), //     1.92x
  early: rational(84n, 25n), //      3.36x
  late: rational(84n, 25n), //       3.36x
  'link-any': rational(84n, 25n), // 3.36x
  first: rational(168n, 25n), //     6.72x
  last: rational(168n, 25n), //      6.72x
  slot: rational(168n, 25n), //      6.72x
  link: rational(168n, 25n), //      6.72x
  opening: rational(1008n, 25n), // 40.32x
  full: rational(24192n, 5n), //  4838.40x
});

/**
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   n: number,
 *   elements: readonly object[],
 *   multipliers: Readonly<Record<string, {n: bigint, d: bigint}>>,
 * }} Variant
 */

/** @type {Readonly<Record<string, Variant>>} */
export const VARIANTS = Object.freeze({
  classic: Object.freeze({
    id: 'classic',
    displayName: 'AETHER ORDER',
    n: 5,
    elements: Object.freeze(ELEMENTS.slice(0, 5)),
    multipliers: CLASSIC_MULTIPLIERS,
  }),
  seven: Object.freeze({
    id: 'seven',
    displayName: 'AETHER ORDER · SEVEN',
    n: 7,
    elements: Object.freeze(ELEMENTS.slice(0, 7)),
    multipliers: SEVEN_MULTIPLIERS,
  }),
});

export const VARIANT_IDS = Object.freeze(['classic', 'seven']);

export function getVariant(id) {
  const variant = VARIANTS[id];
  if (!variant) throw new RangeError(`Unknown variant: ${id}`);
  return variant;
}
