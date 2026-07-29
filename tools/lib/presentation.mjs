/**
 * The two presentation rules that are money-facing, expressed as code.
 *
 * docs/DESIGN.md states both of these as release-blocking constraints. Stating
 * a player-protection rule in prose and implementing it by hand in a client is
 * exactly how it stops being true, so the rules live here, next to the exact
 * arithmetic, and the test suite asserts the document quotes them.
 *
 *   1. `roundPresentation` — the celebration gate. A round may only be
 *      celebrated when it returned MORE than it cost. Anything less is reported
 *      neutrally, including the very common case of a multi-line ticket where
 *      one small line hits and the round still lost money.
 *
 *   2. `ticketStripFigures` — the headline figure on the build screen. The
 *      number a player sees before committing is the best outcome that actually
 *      EXISTS, maximised over the n! permutations, not the arithmetic sum of
 *      every line's return-if-hit. Those differ whenever any two lines are
 *      mutually exclusive, which the fairness narrative actively encourages.
 */

import { allPermutations, outcomeViewOf } from './permutations.mjs';
import { CHIPS_PER_CREDIT, getVariant } from './model.mjs';
import { exactChips, normalizeTicket } from './derive.mjs';
import { exactDecimal, rational } from './rational.mjs';

/** Exact display rendering of an integer chip amount, e.g. 192n -> "1.92". */
export const credits = (chips) => exactDecimal(rational(chips, CHIPS_PER_CREDIT), 2);

/**
 * The celebration gate.
 *
 * A "loss disguised as a win" is a round that returns less than it cost while
 * being presented as a win: the win chord, the gold light-up, the multiplier
 * stamp, the balance counting upward. It is the canonical mechanism for
 * sustaining play through net-losing sessions and it is the exact mirror image
 * of the manufactured near-miss that docs/DESIGN.md §10 already bans.
 *
 * The rule is a single comparison and it has no exceptions:
 *
 *     celebrate  <=>  creditedChips > totalStakeChips
 *
 * Below that threshold the round is reported with a neutral statement of fact
 * ("returned 1.92 of 12.00") and the balance is written to its new value
 * without an upward count-up, because a balance animating upward *is* a
 * celebration whatever the copy says.
 *
 * `lineLighting` is deliberately NOT gated. Which lines won is information the
 * player is entitled to and can read off the tube anyway; what is gated is
 * every beat whose only function is to feel good. Won and lost lines change
 * state with the identical weight — same duration, same easing, no audio of
 * their own — so the difference between them is colour, not drama.
 *
 * @param {{totalStakeChips: bigint, creditedChips: bigint, netChips: bigint}} settlement
 */
export function roundPresentation(settlement) {
  if (
    typeof settlement !== 'object' ||
    settlement === null ||
    typeof settlement.totalStakeChips !== 'bigint' ||
    typeof settlement.creditedChips !== 'bigint'
  ) {
    throw new TypeError('roundPresentation requires a settlement with BigInt chip fields');
  }
  const staked = settlement.totalStakeChips;
  const credited = settlement.creditedChips;
  const net = credited - staked;
  const celebrate = credited > staked;

  let outcome;
  if (celebrate) outcome = 'win';
  else if (credited > 0n) outcome = 'partial-return';
  else outcome = 'no-return';

  const headline =
    outcome === 'win'
      ? `Won ${credits(net)}`
      : outcome === 'partial-return'
        ? `Returned ${credits(credited)} of ${credits(staked)}`
        : `Returned 0.00 of ${credits(staked)}`;

  return Object.freeze({
    outcome,
    celebrate,
    stakedChips: staked,
    creditedChips: credited,
    netChips: net,
    headline,
    /** Every beat below is gated on the same comparison. No exceptions. */
    audio: celebrate ? 'win-chord' : 'none',
    haptic: celebrate ? 'medium' : 'none',
    multiplierStamp: celebrate,
    balanceCountsUp: celebrate,
    goldBloom: celebrate,
    /** Line state is information, not celebration, so it is never suppressed. */
    lineLighting: true,
  });
}

/**
 * The figures on the ticket strip, all exact.
 *
 * `bestOutcomeChips` is a maximum over the outcome space, computed by settling
 * the ticket against all n! permutations. `sumIfEveryLineHitChips` is what a
 * naive implementation would print — the sum of every line's return-if-hit —
 * and is returned ONLY so a test can prove the two differ and the client can
 * never accidentally show it. For a ticket of four FULL ORDER lines the naive
 * figure overstates by 4x; for three FIRST lines on different colours, by 3x.
 *
 * n! <= 5040, so this is at most 5,040 x 12 predicate evaluations: cheap enough
 * to run on every ticket edit, on the device, in the client.
 */
export function ticketStripFigures(variantId, ticket) {
  const variant = getVariant(variantId);
  const normalized = normalizeTicket(variant.id, ticket);
  const views = allPermutations(variant.n).map((perm) => outcomeViewOf(perm, variant.n));

  let best = 0n;
  let bestRank = -1;
  let bestWinningLines = 0;
  let sumIfEveryLineHit = 0n;
  for (const line of normalized.lines) {
    sumIfEveryLineHit += exactChips(line.stakeChips, line.multiplier, '$.bestOutcome');
  }

  for (const view of views) {
    let payout = 0n;
    let winning = 0;
    for (const line of normalized.lines) {
      if (line.family.resolve(line.instance, view) === true) {
        winning += 1;
        payout += exactChips(line.stakeChips, line.multiplier, '$.bestOutcome');
      }
    }
    if (payout > best) {
      best = payout;
      bestRank = view.rank;
      bestWinningLines = winning;
    }
  }

  return Object.freeze({
    variantId: variant.id,
    lines: normalized.lines.length,
    totalStakeChips: normalized.totalStakeChips,
    /** THE published figure. Label it "best possible outcome", never "max". */
    bestOutcomeChips: best,
    /** The permutation rank that achieves it, so the figure is falsifiable. */
    bestOutcomeRank: bestRank,
    bestOutcomeWinningLines: bestWinningLines,
    /** Diagnostic only. Never rendered. */
    sumIfEveryLineHitChips: sumIfEveryLineHit,
    everyLineCanHitTogether: sumIfEveryLineHit === best,
    display: Object.freeze({
      lines: `${normalized.lines.length} lines`,
      stake: credits(normalized.totalStakeChips),
      best: `best possible outcome ${credits(best)}`,
    }),
  });
}
