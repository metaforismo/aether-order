/**
 * The rows of the pinned ticket strip, as data.
 *
 * This is a pure function of (variant, round, display order, phase) with no DOM
 * in it, and it lives in its own module for one reason: **the round-1 build
 * leaked the result.** The strip printed `returned 4.80` on winning lines from
 * the first frame of the round — 270 ms after COMMIT, with the tube still empty
 * — because the whole settlement arrives at COMMIT and the row template read it
 * unconditionally. The exact credit was therefore readable about 1.2 seconds
 * before the first sphere locked, which makes docs/DESIGN.md §2.1 decorative:
 * the rule that a line changes state at the lock that decided it is worth
 * nothing if the verdict was on screen before lock 1.
 *
 * Extracted so `tests/pinned-lines.test.ts` can assert the property directly on
 * a fully settled round, rather than leaving it to a comment.
 *
 * The two phases:
 *
 * - `live` (S4) — every row is `pending` and carries the stake and the
 *   multiplier the player already knew when they committed. The only thing the
 *   choreography changes is `state`, which drives colour and opacity, so the
 *   strip also never reflows during SETTLE (§5 S4, §6.4).
 * - `final` (S5) — the record. States are known, and a won line carries what it
 *   returned.
 */

import { claimSummary, type Params } from './claims.js';
import { UNIT, credits } from './money.js';
import type { RoundView, VariantInfo } from './types.js';

export interface TicketRow {
  /** Index into the round's canonical line list — what the track addresses. */
  index: number;
  name: string;
  summary: string;
  /** The right-hand cell: stake and multiplier, or what the line returned. */
  right: string;
  state: 'pending' | 'won' | 'lost';
}

export interface PendingLine {
  code: string;
  params: Params;
  stakeChips: bigint;
}

/** Rows for a committed round. `order` is the player's build order, if known. */
export function roundRows(
  variant: VariantInfo,
  round: RoundView,
  order: readonly number[] | null,
  phase: 'live' | 'final',
): TicketRow[] {
  const indices =
    order && order.length === round.lines.length
      ? [...order]
      : round.lines.map((_line, index) => index);
  return indices.map((index) => {
    const line = round.lines[index] as (typeof round.lines)[number];
    const won = phase === 'final' && line.won === true;
    return {
      index,
      name: line.name,
      summary: claimSummary(variant, line.code, line.params),
      right:
        won && line.grossChips
          // The unit travels with the figure, without exception. §5 of the
          // rubric: "currency unit is always attached to the number", and a
          // bare `returned 4.80` beside a plate that says `4.80 CR` is two
          // different-looking numbers for one fact.
          ? `returned ${credits(BigInt(line.grossChips))} ${UNIT}`
          : `${credits(BigInt(line.stakeChips))} ${UNIT} × ${line.multiplierDecimal}`,
      state: phase === 'live' ? 'pending' : line.won === true ? 'won' : 'lost',
    };
  });
}

/** Rows for a ticket that has not been committed yet. */
export function draftRows(variant: VariantInfo, lines: readonly PendingLine[]): TicketRow[] {
  return lines.map((line, index) => {
    const bet = variant.bets.find((candidate) => candidate.code === line.code);
    return {
      index,
      name: bet?.name ?? line.code,
      summary: claimSummary(variant, line.code, line.params),
      right: `${credits(line.stakeChips)} × ${bet?.multiplierDecimal ?? ''}`,
      state: 'pending' as const,
    };
  });
}
