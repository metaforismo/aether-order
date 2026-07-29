/**
 * View models. The client renders these and computes no money of its own.
 *
 * Chip amounts leave the process as base-10 strings; `jsonBody` converts every
 * `bigint` on the way out, so a float can never appear on a money path by
 * accident (docs/MATH.md §6).
 */

import { gameFor, familyFor, instanceFor } from './engine.js';
import { chipString, credits } from './money.js';
import { multiplierDecimal } from './ticket.js';
import type { RoundRecord, Session, SessionStore } from './session.js';
import { exactPayout } from '@axiom-games/reveal-engine/modules/permutation/aether';

export interface WireLine {
  readonly index: number;
  readonly code: string;
  readonly name: string;
  readonly tier: string;
  readonly label: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly stakeChips: string;
  readonly multiplierDecimal: string;
  readonly returnIfHitChips: string;
  readonly won: boolean | null;
  readonly grossChips: string | null;
  readonly lock: number | null;
}

/** One row per line, carrying everything every screen needs about it. */
export function describeLines(round: RoundRecord): readonly WireLine[] {
  const ticket = round.ticket;
  if (!ticket) return [];
  const game = gameFor(round.variantId);
  return ticket.lines.map((line, index): WireLine => {
    const family = familyFor(game, line.code);
    const instance = family ? instanceFor(game, family, line.params) : undefined;
    const multiplier = game.pricing.multipliers[line.code];
    const settled = round.settlement?.lines[index];
    const resolved = round.resolution?.lines[index];
    return {
      index,
      code: line.code,
      name: family?.name ?? line.code,
      tier: family?.tier ?? 'FORM',
      label: instance?.label ?? '',
      params: { ...(line.params as Record<string, unknown>) },
      stakeChips: chipString(line.stake),
      multiplierDecimal: multiplierDecimal(game, line.code),
      returnIfHitChips: multiplier ? chipString(exactPayout(line.stake, multiplier)) : '0',
      won: settled ? settled.won : null,
      grossChips: settled ? chipString(settled.gross) : null,
      lock: resolved ? resolved.lock : null,
    };
  });
}

export function describeRound(
  store: SessionStore,
  round: RoundRecord,
): Record<string, unknown> {
  return {
    roundId: round.roundId,
    nonce: round.nonce,
    variantId: round.variantId,
    phase: round.phase,
    source: round.source,
    seedCommitment: round.seedCommitment,
    previousCommitment: round.previousCommitment,
    openedAt: round.openedAt,
    committedAt: round.committedAt,
    clientSeed: round.clientSeed,
    seedRevealed: round.seedRevealed,
    serverSeed: round.seedRevealed ? round.serverSeed : null,
    transcript: round.transcript,
    transcriptJson: store.serializedTranscript(round),
    ticket: round.ticket
      ? {
          ticketDigest: round.ticket.ticketDigest,
          idempotencyKey: round.ticket.idempotencyKey,
          totalStakeChips: chipString(round.ticket.totalStake),
        }
      : null,
    settlement: round.settlement
      ? {
          totalStakeChips: chipString(round.settlement.totalStake),
          grossChips: chipString(round.settlement.gross),
          creditedChips: chipString(round.settlement.credited),
          netChips: chipString(round.settlement.net),
          capped: round.settlement.capped,
        }
      : null,
    settlementDigest: store.settlementDigestOf(round),
    receipt: round.receipt,
    resolution: round.resolution,
    presentation: round.presentation,
    lines: describeLines(round),
    balanceAfterChips: round.balanceAfterChips === null ? null : chipString(round.balanceAfterChips),
  };
}

export function describeSession(store: SessionStore, session: Session): Record<string, unknown> {
  const check = store.realityCheck(session);
  const now = store.now();
  const availableAt = store.commitAvailableAt(session);
  const game = gameFor(session.variantId);
  return {
    id: session.id,
    now,
    variantId: session.variantId,
    balanceChips: chipString(session.balanceChips),
    balanceCredits: credits(session.balanceChips),
    openingBalanceChips: chipString(session.openingBalanceChips),
    stakedChips: chipString(session.stakedChips),
    creditedChips: chipString(session.creditedChips),
    netChips: chipString(store.netChips(session)),
    elapsedMs: store.elapsedMs(session),
    roundsPlayed: session.rounds.length,
    roundsInRollingHour: store.roundsInRollingHour(session),
    roundsRemainingInHour: Math.max(
      0,
      game.play.maxRoundsPerRollingHour - store.roundsInRollingHour(session),
    ),
    commitAvailableAt: availableAt,
    commitAvailableInMs: availableAt === null ? 0 : Math.max(0, availableAt - now),
    skip: session.skip,
    clientSeed: session.clientSeed,
    limits: {
      sessionMinutes: session.limits.sessionMinutes,
      lossChips: session.limits.lossChips === null ? null : chipString(session.limits.lossChips),
    },
    playerRealityCheckMinutes: session.playerRealityCheckMinutes,
    realityCheck: {
      due: check.due,
      minute: check.minute,
      nextMinute: check.nextMinute,
      elapsedMinutes: check.elapsedMinutes,
      stakedChips: chipString(check.stakedChips),
      creditedChips: chipString(check.creditedChips),
      netChips: chipString(check.netChips),
    },
    openRound: session.openRound
      ? {
          roundId: session.openRound.roundId,
          nonce: session.openRound.nonce,
          variantId: session.openRound.variantId,
          seedCommitment: session.openRound.seedCommitment,
          previousCommitment: session.openRound.previousCommitment,
          openedAt: session.openRound.openedAt,
        }
      : null,
  };
}

export function describeHistory(
  store: SessionStore,
  session: Session,
  limit = 40,
): readonly Record<string, unknown>[] {
  return session.rounds.slice(0, limit).map((round) => ({
    roundId: round.roundId,
    variantId: round.variantId,
    source: round.source,
    committedAt: round.committedAt,
    permutation: round.transcript?.permutation ?? null,
    stakeChips: round.settlement ? chipString(round.settlement.totalStake) : null,
    creditedChips: round.settlement ? chipString(round.settlement.credited) : null,
    netChips: round.settlement ? chipString(round.settlement.net) : null,
    celebrate: round.presentation?.celebrate ?? false,
    headline: round.presentation?.headline ?? '',
    lineCount: round.ticket?.lines.length ?? 0,
  }));
}
