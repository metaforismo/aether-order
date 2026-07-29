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
export const ADAPTER_VERSION = '1.1.0';
export const API_VERSION = 'reveal-engine/api-v1';
export const MODULE_VERSION = 'reveal-engine/permutation-v1';
export const TRANSCRIPT_SCHEMA = 'reveal-engine/permutation-transcript-v1';
export const TICKET_SCHEMA = 'reveal-engine/permutation-ticket-v1';
export const RECEIPT_SCHEMA = 'reveal-engine/permutation-receipt-v1';
export const ROUND_SNAPSHOT_SCHEMA = 'reveal-engine/permutation-round-snapshot-v1';

export const SEED_COMMIT_DOMAIN = 'aether-order/seed-commit-v1';
export const TICKET_DIGEST_DOMAIN = 'aether-order/ticket-digest-v1';
export const SETTLEMENT_DIGEST_DOMAIN = 'aether-order/settlement-digest-v1';
export const RECEIPT_DOMAIN = 'aether-order/receipt-v1';
export const IDEMPOTENCY_DOMAIN = 'aether-order/idempotency-v1';
export const PLAY_POLICY_DOMAIN = 'aether-order/play-policy-v1';

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
  /** Definition ceiling, and the ceiling on exhaustive conformance. */
  maxElements: 12,
  maxExhaustiveElements: 8,
  maxLinesPerTicket: 12,
  minLineStakeChips: 25n,
  maxLineStakeChips: 5000n,
  maxTicketStakeChips: 20000n,
  /** Round credit ceiling as a multiple of the ticket's total stake. */
  maxWinMultiple: 5000n,
  /**
   * A ticket is a set of distinct claims. Without this, repeating a line would
   * defeat the per-line stake ceiling; the client merges repeats by raising the
   * stake. It is also what makes the maximum-credit figure in docs/MATH.md §8 a
   * true maximum rather than a lower bound.
   */
  requireDistinctLines: true,
  maxClientSeedBytes: 64,
  maxRoundIdBytes: 128,
  maxLabelBytes: 128,
  maxTranscriptBytes: 64 * 1024,
  maxSnapshotBytes: 256 * 1024,
});

/**
 * Speed-of-play and session policy. NOT part of the adapter fingerprint: pacing
 * is a client/RGS obligation and *tightening* it must not invalidate an open
 * liability. It is published here so docs/DESIGN.md §10 can be machine-checked
 * against the shipped numbers instead of asserting them in prose, and it is
 * digested into every round snapshot (`playPolicyDigest`) so that *loosening*
 * it — the direction that matters for player protection — leaves a per-round
 * trace. See docs/ENGINE.md §4 for why those two directions are treated
 * differently.
 *
 * `minRoundCycleMs` is measured COMMIT to COMMIT and enforced server-side. SKIP
 * compresses the presentation only; it can never shorten the cycle. The rolling
 * ceiling is a hard stop, not a nudge: at the ceiling COMMIT is disabled until
 * the trailing 60-minute window frees a slot.
 *
 * `realityCheckMinutes` are the fixed early checks; `realityCheckRecurrenceMinutes`
 * is the interval that repeats forever after the last of them. An array alone
 * cannot express "then hourly", and a client reading only the array would stop
 * checking after 60 minutes — which is precisely what the prose promised not to
 * do.
 *
 * `autoplay` is `'none'`, and it is a value rather than a sentence because a
 * sentence is what let round 2 ship a self-contradiction: a clause banning
 * autoplay that continues through losses, followed by a clause permitting a
 * count-bounded autoplay with no loss limit. See docs/DESIGN.md §10.
 */
export const PLAY_POLICY = Object.freeze({
  minRoundCycleMs: 2500,
  maxRoundsPerRollingHour: 900,
  realityCheckMinutes: Object.freeze([30, 60]),
  realityCheckRecurrenceMinutes: 60,
  skipShortensPresentationOnly: true,
  autoplay: 'none',
});

/** The only legal value of `PLAY_POLICY.autoplay` in this specification. */
export const AUTOPLAY_MODES = Object.freeze(['none']);

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
  podium: rational(288n, 5n), //  57.60x
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
  podium: rational(1008n, 5n), //  201.60x
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
