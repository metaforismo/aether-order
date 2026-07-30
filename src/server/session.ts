/**
 * Server-authoritative session and round state.
 *
 * This is the RGS half of docs/ENGINE.md: the engine owns derivation,
 * commitment, settlement, receipts and their byte layouts; this file owns the
 * things §3 says are *not* the engine's — the wallet, session state, pacing, and
 * the responsible-play controls — and it owns the ordering §5 calls
 * load-bearing:
 *
 *   1. draw the server seed, fix the seed context, publish `seedCommitment`
 *   2. accept the client seed and ticket, debit the wallet
 *   3. derive, settle, credit
 *   4. reveal the seed; the transcript becomes independently verifiable
 *   5. chain: the next transcript binds this round's commitment
 *
 * Everything money-shaped is `bigint` chips. The wallet is in-memory and
 * free-play only; nothing here is persistence, custody or an audit trail.
 */

import { randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import {
  ZERO_COMMITMENT,
  assertClientSeed,
  ed25519KeyPairFromSeed,
  makePermutationTranscript,
  makeReceipt,
  makeRoundSnapshot,
  openTicket,
  permutationPlayPolicyDigest,
  seedCommitment as computeSeedCommitment,
  serializeRoundSnapshot,
  serializeTranscript,
  settleTicket,
  settlementDigest,
  signReceipt,
  verifyPermutationTranscript,
  verifyReceipt,
  type PermutationReceipt,
  type PermutationTranscript,
  type ReceiptVerificationResult,
  type RoundSnapshot,
  type Settlement,
  type Ticket,
  type VerificationResult,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { GAMES, gameFor, type VariantId } from './engine.js';
import { ServiceError } from './errors.js';
import { resolutionTrack, type ResolutionTrack } from './resolution.js';
import { openForQuote, presentSettlement, quoteTicket, type TicketQuote, type WirePresentation } from './ticket.js';

export type Clock = () => number;

export interface RawLine {
  readonly code: string;
  readonly params: object;
  readonly stake: bigint;
}

export interface RoundRecord {
  readonly roundId: string;
  readonly nonce: number;
  readonly variantId: VariantId;
  readonly seedCommitment: string;
  readonly openedAt: number;
  phase: 'COMMITTED' | 'SETTLED';
  serverSeed: string;
  seedRevealed: boolean;
  clientSeed: string;
  previousCommitment: string;
  transcript: PermutationTranscript | null;
  ticket: Ticket | null;
  settlement: Settlement | null;
  receipt: PermutationReceipt | null;
  resolution: ResolutionTrack | null;
  presentation: WirePresentation | null;
  committedAt: number | null;
  balanceAfterChips: bigint | null;
  source: 'solo' | 'lobby';
}

export interface SessionLimits {
  sessionMinutes: number | null;
  lossChips: bigint | null;
}

export interface Session {
  readonly id: string;
  readonly startedAt: number;
  variantId: VariantId;
  balanceChips: bigint;
  readonly openingBalanceChips: bigint;
  stakedChips: bigint;
  creditedChips: bigint;
  roundSequence: number;
  openRound: RoundRecord | null;
  rounds: RoundRecord[];
  roundsById: Map<string, RoundRecord>;
  commitsByIdempotencyKey: Map<string, RoundRecord>;
  lastCommitAt: number | null;
  commitTimestamps: number[];
  previousCommitment: string;
  skip: boolean;
  clientSeed: string;
  limits: SessionLimits;
  playerRealityCheckMinutes: number | null;
  acknowledgedRealityCheckMinute: number;
  /** Dev-only: shifts *session elapsed time* so S9's schedule can be seen. */
  elapsedSkewMs: number;
}

/** Free-play opening balance. Not a spec figure: a free-play wallet float. */
export const OPENING_BALANCE_CHIPS = 50_000n;

export const SIGNER_ID = 'aether-order/free-play-operator';

export interface OperatorKey {
  readonly signerId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicKeyHex: string;
}

/**
 * Fault injection used by the server regression suite.
 *
 * `createApp` never supplies this object, and no HTTP route can reach it. The
 * hooks run after the in-memory patch has been applied so the tests can prove
 * that the rollback path restores every touched field.
 */
export interface SessionStoreTestFaults {
  readonly afterStagePatch?: () => void;
  readonly afterFinishPatch?: () => void;
}

/**
 * The operator key is generated at process start.
 *
 * docs/ENGINE.md §11 is explicit that key custody, publication and rotation are
 * the operator's and that this repository neither has nor simulates them. A
 * per-process ephemeral key makes that plain: receipts verify for as long as the
 * process that signed them is alive, and never longer.
 */
export function makeOperatorKey(): OperatorKey {
  const pair = ed25519KeyPairFromSeed(randomBytes(32).toString('hex'));
  return Object.freeze({
    signerId: SIGNER_ID,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyHex: pair.publicKeyHex,
  });
}

export interface CommitResult {
  readonly round: RoundRecord;
  readonly replayed: boolean;
}

export interface RealityCheck {
  readonly due: boolean;
  readonly minute: number;
  readonly elapsedMinutes: number;
  readonly stakedChips: bigint;
  readonly creditedChips: bigint;
  readonly netChips: bigint;
  readonly nextMinute: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #now: Clock;
  readonly #operatorKey: OperatorKey;
  readonly #testFaults: SessionStoreTestFaults | undefined;
  /** Test seam only: forces the next server seed. Never used in production. */
  #forcedSeed: string | null = null;

  constructor(
    options: {
      now?: Clock;
      operatorKey?: OperatorKey;
      /** Test-only fault injection; deliberately not threaded through `createApp`. */
      testFaults?: SessionStoreTestFaults;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#operatorKey = options.operatorKey ?? makeOperatorKey();
    this.#testFaults = options.testFaults;
  }

  get operatorKey(): OperatorKey {
    return this.#operatorKey;
  }

  now(): number {
    return this.#now();
  }

  create(): Session {
    const id = randomUUID();
    const session: Session = {
      id,
      startedAt: this.#now(),
      variantId: 'classic',
      balanceChips: OPENING_BALANCE_CHIPS,
      openingBalanceChips: OPENING_BALANCE_CHIPS,
      stakedChips: 0n,
      creditedChips: 0n,
      roundSequence: 0,
      openRound: null,
      rounds: [],
      roundsById: new Map(),
      commitsByIdempotencyKey: new Map(),
      lastCommitAt: null,
      commitTimestamps: [],
      previousCommitment: ZERO_COMMITMENT,
      skip: false,
      clientSeed: '',
      limits: { sessionMinutes: null, lossChips: null },
      playerRealityCheckMinutes: null,
      acknowledgedRealityCheckMinute: 0,
      elapsedSkewMs: 0,
    };
    this.#sessions.set(id, session);
    return session;
  }

  get(id: unknown): Session {
    if (typeof id !== 'string' || !this.#sessions.has(id))
      throw new ServiceError('SESSION_NOT_FOUND', 'No such session', '$.sessionId');
    return this.#sessions.get(id) as Session;
  }

  setVariant(session: Session, variantId: VariantId): void {
    this.#discardOpenRound(session);
    session.variantId = variantId;
  }

  /**
   * Abandon an open, unbet round.
   *
   * The round is *forgotten*, not merely unlinked: a discarded round left
   * reachable by id is a round a client can still commit to, and committing it
   * after a later round has settled would bind a stale `previousCommitment` and
   * fork the chain (docs/ENGINE.md §5). Nothing was staked on it, so nothing is
   * lost by dropping it.
   */
  #discardOpenRound(session: Session): void {
    const open = session.openRound;
    if (!open) return;
    if (open.phase === 'COMMITTED' && open.ticket === null) session.roundsById.delete(open.roundId);
    session.openRound = null;
  }

  /* ---------------------------------------------------------------- pacing */

  roundsInRollingHour(session: Session): number {
    const cutoff = this.#now() - 3_600_000;
    return session.commitTimestamps.filter((stamp) => stamp > cutoff).length;
  }

  /** `null` when a commit may proceed now, otherwise the epoch ms it may. */
  commitAvailableAt(session: Session): number | null {
    const policy = GAMES[session.variantId].play;
    const now = this.#now();
    if (session.lastCommitAt !== null) {
      const floorAt = session.lastCommitAt + policy.minRoundCycleMs;
      if (floorAt > now) return floorAt;
    }
    const cutoff = now - 3_600_000;
    const recent = session.commitTimestamps.filter((stamp) => stamp > cutoff);
    if (recent.length >= policy.maxRoundsPerRollingHour) {
      const oldest = recent[0] as number;
      return oldest + 3_600_000;
    }
    return null;
  }

  #assertPacing(session: Session): void {
    const availableAt = this.commitAvailableAt(session);
    if (availableAt === null) return;
    const policy = GAMES[session.variantId].play;
    const rolling = this.roundsInRollingHour(session);
    const atCeiling = rolling >= policy.maxRoundsPerRollingHour;
    throw new ServiceError(
      'CYCLE_FLOOR',
      atCeiling
        ? `You have played ${rolling} rounds this hour.`
        : 'A commit arrived before the round-cycle floor elapsed.',
      '$.commit',
      { availableAt, atCeiling, roundsInRollingHour: rolling },
    );
  }

  /* ------------------------------------------------------ player-set limits */

  elapsedMs(session: Session): number {
    return this.#now() - session.startedAt + session.elapsedSkewMs;
  }

  netChips(session: Session): bigint {
    return session.balanceChips - session.openingBalanceChips;
  }

  #assertLimits(session: Session, stake: bigint): void {
    const { sessionMinutes, lossChips } = session.limits;
    if (sessionMinutes !== null && this.elapsedMs(session) >= sessionMinutes * 60_000)
      throw new ServiceError(
        'LIMIT_REACHED',
        `You set a ${sessionMinutes}-minute session limit and it has been reached.`,
        '$.limits.sessionMinutes',
      );
    if (lossChips !== null) {
      const net = this.netChips(session);
      if (-net >= lossChips)
        throw new ServiceError(
          'LIMIT_REACHED',
          'You set a loss limit for this session and it has been reached.',
          '$.limits.lossChips',
        );
      if (-(net - stake) > lossChips)
        throw new ServiceError(
          'LIMIT_REACHED',
          'That bet would take this session past the loss limit you set.',
          '$.limits.lossChips',
        );
    }
  }

  /* --------------------------------------------------------- reality checks */

  realityCheck(session: Session): RealityCheck {
    const policy = GAMES[session.variantId].play;
    const elapsedMinutes = Math.floor(this.elapsedMs(session) / 60_000);
    const marks = new Set<number>();
    // The operator floor: fixed early checks, then the recurrence, forever.
    for (const minute of policy.realityCheckMinutes) marks.add(minute);
    const recurrence = policy.realityCheckRecurrenceMinutes;
    const lastFixed = Math.max(...policy.realityCheckMinutes);
    for (let minute = lastFixed + recurrence; minute <= elapsedMinutes + recurrence; minute += recurrence)
      marks.add(minute);
    // The player's own selection only ever ADDS instants (tighten-only).
    const player = session.playerRealityCheckMinutes;
    if (player !== null)
      for (let minute = player; minute <= elapsedMinutes + player; minute += player)
        marks.add(minute);
    const sorted = [...marks].sort((left, right) => left - right);
    const passed = sorted.filter((minute) => minute <= elapsedMinutes);
    const due = passed.filter((minute) => minute > session.acknowledgedRealityCheckMinute);
    const next = sorted.find((minute) => minute > elapsedMinutes) ?? lastFixed;
    const highestDue = due.length > 0 ? (due[due.length - 1] as number) : 0;
    return Object.freeze({
      due: due.length > 0,
      minute: highestDue,
      elapsedMinutes,
      stakedChips: session.stakedChips,
      creditedChips: session.creditedChips,
      netChips: this.netChips(session),
      nextMinute: next,
    });
  }

  acknowledgeRealityCheck(session: Session): void {
    const check = this.realityCheck(session);
    if (check.due) session.acknowledgedRealityCheckMinute = check.minute;
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Test seam: force the server seed of the next round this store opens. */
  forceNextSeed(hex: string | null): void {
    this.#forcedSeed = hex;
  }

  /**
   * Step 1. Draw the seed, fix the context, publish the commitment — all before
   * a ticket exists. Idempotent: an already-open, uncommitted round is returned
   * unchanged rather than replaced, because replacing it would republish a
   * commitment for a round the player may already have on screen.
   */
  openRound(session: Session, source: 'solo' | 'lobby' = 'solo'): RoundRecord {
    const existing = session.openRound;
    if (existing && existing.phase === 'COMMITTED' && existing.variantId === session.variantId)
      return existing;
    this.#discardOpenRound(session);
    const variantId = session.variantId;
    const nonce = session.roundSequence;
    session.roundSequence += 1;
    const roundId = `${session.id.slice(0, 8)}-r${nonce}`;
    const serverSeed = this.#forcedSeed ?? randomBytes(32).toString('hex');
    this.#forcedSeed = null;
    const seedCommitment = computeSeedCommitment(serverSeed, { variantId, roundId, nonce });
    const round: RoundRecord = {
      roundId,
      nonce,
      variantId,
      seedCommitment,
      openedAt: this.#now(),
      phase: 'COMMITTED',
      serverSeed,
      seedRevealed: false,
      clientSeed: '',
      previousCommitment: session.previousCommitment,
      transcript: null,
      ticket: null,
      settlement: null,
      receipt: null,
      resolution: null,
      presentation: null,
      committedAt: null,
      balanceAfterChips: null,
      source,
    };
    session.openRound = round;
    session.roundsById.set(roundId, round);
    return round;
  }

  quote(session: Session, lines: readonly RawLine[]): TicketQuote {
    const game = gameFor(session.variantId);
    return quoteTicket(game, openForQuote(game, lines));
  }

  /**
   * A per-session record for a round whose seed and commitment were published
   * elsewhere — the shared chamber, where one draw serves many tickets.
   */
  attachRound(
    session: Session,
    draw: {
      roundId: string;
      nonce: number;
      variantId: VariantId;
      serverSeed: string;
      seedCommitment: string;
      previousCommitment: string;
      openedAt: number;
    },
  ): RoundRecord {
    const existing = session.roundsById.get(draw.roundId);
    if (existing) return existing;
    const round: RoundRecord = {
      roundId: draw.roundId,
      nonce: draw.nonce,
      variantId: draw.variantId,
      seedCommitment: draw.seedCommitment,
      openedAt: draw.openedAt,
      phase: 'COMMITTED',
      serverSeed: draw.serverSeed,
      seedRevealed: false,
      clientSeed: '',
      previousCommitment: draw.previousCommitment,
      transcript: null,
      ticket: null,
      settlement: null,
      receipt: null,
      resolution: null,
      presentation: null,
      committedAt: null,
      balanceAfterChips: null,
      source: 'lobby',
    };
    session.roundsById.set(round.roundId, round);
    return round;
  }

  /**
   * Validate, fence and debit — the half of a commit that happens before the
   * draw resolves. In solo play the two halves are one call; in the shared
   * chamber the ticket waits for the lobby's clock.
   *
   * The idempotency key is derived from the ticket digest by the engine, never
   * chosen by the caller, so a retry on a flaky connection presents the same key
   * with the same payload and returns the same round instead of debiting twice.
   * The replay check runs *before* pacing: a retransmitted commit is not a
   * second bet and must not be refused as one.
   */
  stageTicket(
    session: Session,
    round: RoundRecord,
    lines: readonly RawLine[],
  ): { ticket: Ticket; replayed: RoundRecord | null } {
    const game = gameFor(round.variantId);
    const ticket = openTicket(
      game,
      { variantId: round.variantId, roundId: round.roundId, nonce: round.nonce },
      { lines },
    );

    const replayed = session.commitsByIdempotencyKey.get(ticket.idempotencyKey);
    if (replayed) return { ticket, replayed };

    if (round.phase !== 'COMMITTED' || round.ticket !== null)
      throw new ServiceError(
        'ROUND_ALREADY_SETTLED',
        'That round is settled; open a new one',
        '$.roundId',
      );

    this.#assertPacing(session);
    this.#assertLimits(session, ticket.totalStake);

    if (session.balanceChips < ticket.totalStake)
      throw new ServiceError(
        'WALLET_DECLINED',
        'That bet was not placed — your balance did not cover it.',
        '$.totalStake',
      );

    const now = this.#now();
    const before = {
      balanceChips: session.balanceChips,
      stakedChips: session.stakedChips,
      ticket: round.ticket,
      lastCommitAt: session.lastCommitAt,
      commitTimestampLength: session.commitTimestamps.length,
      priorCommit: session.commitsByIdempotencyKey.get(ticket.idempotencyKey),
    };
    try {
      // Debit and record the matching staged bet as one exception-safe patch.
      // The permutation was fixed by the published commitment; the debit is
      // what makes the ticket a bet.
      session.balanceChips = before.balanceChips - ticket.totalStake;
      session.stakedChips = before.stakedChips + ticket.totalStake;
      round.ticket = ticket;
      session.commitsByIdempotencyKey.set(ticket.idempotencyKey, round);
      session.lastCommitAt = now;
      session.commitTimestamps.push(now);
      this.#testFaults?.afterStagePatch?.();
    } catch (error) {
      session.balanceChips = before.balanceChips;
      session.stakedChips = before.stakedChips;
      round.ticket = before.ticket;
      session.lastCommitAt = before.lastCommitAt;
      session.commitTimestamps.length = before.commitTimestampLength;
      if (before.priorCommit)
        session.commitsByIdempotencyKey.set(ticket.idempotencyKey, before.priorCommit);
      else session.commitsByIdempotencyKey.delete(ticket.idempotencyKey);
      throw error;
    }
    return { ticket, replayed: null };
  }

  /**
   * Look up an already-recorded commit without applying pacing or round-state
   * gates. Shared-chamber retries consult this before checking whether the draw
   * is still live: a lost success response must remain recoverable after close.
   */
  replayedTicket(
    session: Session,
    roundId: string,
    lines: readonly RawLine[],
  ): RoundRecord | null {
    const round = session.roundsById.get(roundId);
    if (!round) return null;
    const game = gameFor(round.variantId);
    const ticket = openTicket(
      game,
      { variantId: round.variantId, roundId: round.roundId, nonce: round.nonce },
      { lines },
    );
    return session.commitsByIdempotencyKey.get(ticket.idempotencyKey) ?? null;
  }

  /**
   * Settle a staged ticket against the round's transcript, and credit.
   *
   * The phase guard is the second half of the idempotency rule: `stageTicket`
   * stops a ticket being debited twice, and this stops a round being credited
   * twice. Both halves are needed — a settle path that credits whatever it is
   * handed is one retry away from paying a round out again.
   */
  finishRound(session: Session, round: RoundRecord, transcript: PermutationTranscript): RoundRecord {
    if (round.phase === 'SETTLED')
      throw new ServiceError(
        'ROUND_ALREADY_SETTLED',
        'That round has already been settled and credited',
        '$.roundId',
      );
    const game = gameFor(round.variantId);
    const ticket = round.ticket;
    if (!ticket) throw new ServiceError('ROUND_NOT_FOUND', 'Round has no staged ticket', '$.ticket');
    const settlement = settleTicket(game, transcript, ticket);
    const receipt = signReceipt(
      makeReceipt({ transcript, ticket, settlement, signerId: this.#operatorKey.signerId }),
      this.#operatorKey.privateKey,
    );
    // Finish every downstream operation that can reject or throw before the
    // wallet or round changes. Only fully computed values enter the patch.
    const resolution = resolutionTrack(game, ticket.lines, transcript.permutation);
    const presentation = presentSettlement(settlement);
    const committedAt = session.lastCommitAt ?? this.#now();
    const balanceAfterChips = session.balanceChips + settlement.credited;
    const before = {
      balanceChips: session.balanceChips,
      creditedChips: session.creditedChips,
      phase: round.phase,
      clientSeed: round.clientSeed,
      transcript: round.transcript,
      settlement: round.settlement,
      receipt: round.receipt,
      resolution: round.resolution,
      presentation: round.presentation,
      committedAt: round.committedAt,
      balanceAfterChips: round.balanceAfterChips,
      roundsLength: session.rounds.length,
      openRound: session.openRound,
    };
    try {
      session.balanceChips = balanceAfterChips;
      session.creditedChips = before.creditedChips + settlement.credited;
      round.phase = 'SETTLED';
      round.clientSeed = transcript.clientSeed;
      round.transcript = transcript;
      round.settlement = settlement;
      round.receipt = receipt;
      round.resolution = resolution;
      round.presentation = presentation;
      round.committedAt = committedAt;
      round.balanceAfterChips = balanceAfterChips;
      session.rounds.unshift(round);
      if (session.openRound === round) session.openRound = null;
      this.#testFaults?.afterFinishPatch?.();
    } catch (error) {
      session.balanceChips = before.balanceChips;
      session.creditedChips = before.creditedChips;
      round.phase = before.phase;
      round.clientSeed = before.clientSeed;
      round.transcript = before.transcript;
      round.settlement = before.settlement;
      round.receipt = before.receipt;
      round.resolution = before.resolution;
      round.presentation = before.presentation;
      round.committedAt = before.committedAt;
      round.balanceAfterChips = before.balanceAfterChips;
      session.rounds.length = before.roundsLength;
      session.openRound = before.openRound;
      throw error;
    }
    return round;
  }

  /** Steps 2-4 of the solo lifecycle, atomically from the caller's view. */
  commit(
    session: Session,
    input: { roundId: string; clientSeed: string; lines: readonly RawLine[] },
  ): CommitResult {
    const round = session.roundsById.get(input.roundId);
    if (!round) throw new ServiceError('ROUND_NOT_FOUND', 'No such round', '$.roundId');
    const game = gameFor(round.variantId);
    // Validate the one field the player supplies AFTER the commitment, before
    // any money moves. `makePermutationTranscript` would reject a malformed
    // client seed too — but it runs after the debit, and a validation that
    // happens after the wallet has been touched is a refund path, not a check.
    const clientSeed = assertClientSeed(typeof input.clientSeed === 'string' ? input.clientSeed : '');

    const staged = this.stageTicket(session, round, input.lines);
    if (staged.replayed) return { round: staged.replayed, replayed: true };

    // The chain binds the previous SETTLED round's commitment as of now, not as
    // of whenever this round happened to be opened: rounds can be opened and
    // abandoned, and a stale link would fork the chain the format promises.
    const previousCommitment = session.previousCommitment;
    round.previousCommitment = previousCommitment;
    const transcript = makePermutationTranscript(
      round.serverSeed,
      game,
      {
        gameId: game.id,
        variantId: round.variantId,
        roundId: round.roundId,
        clientSeed,
        nonce: round.nonce,
      },
      previousCommitment,
    );
    this.finishRound(session, round, transcript);
    session.previousCommitment = transcript.commitment;
    session.clientSeed = clientSeed;
    return { round, replayed: false };
  }

  /**
   * Step 4. Reveal the seed, and verify before revealing it.
   *
   * The server re-derives its own transcript and re-checks its own receipt on
   * the way out. That is not the player's verification — the client does its own
   * re-derivation, which is the whole point — but a server that will not verify
   * its own round has no business publishing the seed for one.
   */
  reveal(round: RoundRecord): {
    serverSeed: string;
    transcript: VerificationResult;
    receipt: ReceiptVerificationResult;
  } {
    if (round.phase !== 'SETTLED' || !round.transcript || !round.ticket || !round.settlement)
      throw new ServiceError('ROUND_NOT_FOUND', 'That round has not settled', '$.roundId');
    const game = gameFor(round.variantId);
    const transcript = verifyPermutationTranscript(round.serverSeed, game, round.transcript);
    const receipt = verifyReceipt(round.receipt, {
      transcript: round.transcript,
      ticket: round.ticket,
      settlement: round.settlement,
      publicKey: this.#operatorKey.publicKey,
    });
    round.seedRevealed = true;
    return { serverSeed: round.serverSeed, transcript, receipt };
  }

  snapshotOf(round: RoundRecord): RoundSnapshot {
    const game = gameFor(round.variantId);
    return makeRoundSnapshot({
      game,
      phase: round.phase,
      seedContext: { variantId: round.variantId, roundId: round.roundId, nonce: round.nonce },
      seedCommitment: round.seedCommitment,
      playPolicyDigest: permutationPlayPolicyDigest(game.play),
      ...(round.transcript ? { transcript: round.transcript } : {}),
      ...(round.ticket ? { ticket: round.ticket } : {}),
      ...(round.settlement ? { settlement: round.settlement } : {}),
      ...(round.receipt ? { receipt: round.receipt } : {}),
    });
  }

  serializedSnapshot(round: RoundRecord): string {
    return serializeRoundSnapshot(this.snapshotOf(round));
  }

  serializedTranscript(round: RoundRecord): string | null {
    return round.transcript ? serializeTranscript(round.transcript) : null;
  }

  settlementDigestOf(round: RoundRecord): string | null {
    if (!round.settlement) return null;
    return settlementDigest(gameFor(round.variantId), round.settlement);
  }
}
