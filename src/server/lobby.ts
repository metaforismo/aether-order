/**
 * SHARED CHAMBER — docs/DESIGN.md §5 S10 and §13.2.
 *
 * One transcript, many tickets. The only structural difference from solo play is
 * that the round's clock belongs to the server, and that clock is the part with
 * rules:
 *
 *   settleAt - commitLeadMs - clientSafetyMs   the CLIENT disables COMMIT
 *   settleAt - commitLeadMs                    the window closes
 *   + commitGraceMs                            last arrival the server accepts
 *   settleAt                                   the draw settles
 *
 * A commit that arrives after the grace is `BETTING_CLOSED`: the stake is
 * unspent, the wallet untouched, and the ticket is never queued into the next
 * draw, because a queued bet is a latency-sensitive money decision by another
 * name. `roundId` is bound into `ticketDigest`, so that is structural as well as
 * enforced.
 *
 * There is one client seed per draw and it is empty, because there is one draw
 * for everyone: a per-player seed cannot enter a transcript that many players
 * share. The client says so on the screen rather than implying otherwise.
 */

import { randomBytes } from 'node:crypto';
import {
  ZERO_COMMITMENT,
  makePermutationTranscript,
  seedCommitment as computeSeedCommitment,
  type PermutationTranscript,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { PAYTABLE, gameFor, type VariantId } from './engine.js';
import { ServiceError } from './errors.js';
import type { RawLine, RoundRecord, Session, SessionStore } from './session.js';

export interface LobbyDraw {
  readonly seq: number;
  readonly roundId: string;
  readonly nonce: number;
  readonly variantId: VariantId;
  readonly serverSeed: string;
  readonly seedCommitment: string;
  readonly previousCommitment: string;
  readonly openedAt: number;
  readonly settleAtEpochMs: number;
  readonly entries: Map<string, { session: Session; round: RoundRecord; label: string }>;
  transcript: PermutationTranscript | null;
  settled: boolean;
}

export type LobbyEvent =
  | { readonly type: 'round.open'; readonly draw: LobbyDraw }
  | { readonly type: 'presence'; readonly draw: LobbyDraw }
  | { readonly type: 'round.reveal'; readonly draw: LobbyDraw };

type Listener = (event: LobbyEvent) => void;

const SHARED = PAYTABLE.sharedChamber as {
  commitLeadMs: number;
  commitGraceMs: number;
  clientSafetyMs: number;
  minCadenceMs: number;
};

export class SharedChamber {
  readonly #store: SessionStore;
  readonly #listeners = new Set<Listener>();
  readonly cadenceMs: number;
  readonly variantId: VariantId = 'classic';
  #draw: LobbyDraw | null = null;
  #seq = 0;
  #previousCommitment = ZERO_COMMITMENT;
  #timer: NodeJS.Timeout | null = null;
  #presenceTimer: NodeJS.Timeout | null = null;

  constructor(store: SessionStore, cadenceMs = 6_000) {
    if (cadenceMs < SHARED.minCadenceMs)
      throw new RangeError(
        `Cadence must be at least ${SHARED.minCadenceMs} ms: below it the rolling ceiling starts binding`,
      );
    this.#store = store;
    this.cadenceMs = cadenceMs;
  }

  get draw(): LobbyDraw | null {
    return this.#draw;
  }

  start(): void {
    if (this.#draw) return;
    this.#open();
    this.#presenceTimer = setInterval(() => {
      if (this.#draw) this.#emit({ type: 'presence', draw: this.#draw });
    }, 500);
    this.#presenceTimer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#presenceTimer) clearInterval(this.#presenceTimer);
    this.#timer = null;
    this.#presenceTimer = null;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: LobbyEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #open(): void {
    const now = this.#store.now();
    const nonce = this.#seq;
    this.#seq += 1;
    const roundId = `shared-r${nonce}`;
    const serverSeed = randomBytes(32).toString('hex');
    const draw: LobbyDraw = {
      seq: nonce,
      roundId,
      nonce,
      variantId: this.variantId,
      serverSeed,
      seedCommitment: computeSeedCommitment(serverSeed, {
        variantId: this.variantId,
        roundId,
        nonce,
      }),
      previousCommitment: this.#previousCommitment,
      openedAt: now,
      settleAtEpochMs: now + this.cadenceMs,
      entries: new Map(),
      transcript: null,
      settled: false,
    };
    this.#draw = draw;
    this.#emit({ type: 'round.open', draw });
    this.#timer = setTimeout(() => this.#settle(draw), this.cadenceMs);
    this.#timer.unref?.();
  }

  #settle(draw: LobbyDraw): void {
    const game = gameFor(draw.variantId);
    const transcript = makePermutationTranscript(
      draw.serverSeed,
      game,
      {
        gameId: game.id,
        variantId: draw.variantId,
        roundId: draw.roundId,
        clientSeed: '',
        nonce: draw.nonce,
      },
      draw.previousCommitment,
    );
    draw.transcript = transcript;
    draw.settled = true;
    this.#previousCommitment = transcript.commitment;
    for (const entry of draw.entries.values()) {
      entry.round.seedRevealed = true;
      this.#store.finishRound(entry.session, entry.round, transcript);
    }
    this.#emit({ type: 'round.reveal', draw });
    this.#open();
  }

  /** The window as the server sees it. The client's countdown is display only. */
  windowFor(draw: LobbyDraw): {
    closesAt: number;
    lastAcceptedAt: number;
    clientClosesAt: number;
    settleAtEpochMs: number;
  } {
    const closesAt = draw.settleAtEpochMs - SHARED.commitLeadMs;
    return {
      closesAt,
      lastAcceptedAt: closesAt + SHARED.commitGraceMs,
      clientClosesAt: closesAt - SHARED.clientSafetyMs,
      settleAtEpochMs: draw.settleAtEpochMs,
    };
  }

  commit(
    session: Session,
    input: { roundId: string; lines: readonly RawLine[] },
  ): { round: RoundRecord; draw: LobbyDraw; replayed: boolean } {
    const draw = this.#draw;
    if (!draw || draw.roundId !== input.roundId || draw.settled)
      throw new ServiceError(
        'BETTING_CLOSED',
        'That draw closed — your ticket is still here.',
        '$.roundId',
      );
    const now = this.#store.now();
    if (now > this.windowFor(draw).lastAcceptedAt)
      throw new ServiceError(
        'BETTING_CLOSED',
        'That draw closed — your ticket is still here.',
        '$.roundId',
      );
    if (session.variantId !== draw.variantId)
      throw new ServiceError(
        'ADAPTER_MISMATCH',
        'The shared chamber runs CLASSIC; switch variant to join it.',
        '$.variantId',
      );

    const round = this.#store.attachRound(session, draw);
    const staged = this.#store.stageTicket(session, round, input.lines);
    if (staged.replayed) return { round: staged.replayed, draw, replayed: true };
    const first = staged.ticket.lines[0];
    draw.entries.set(session.id, {
      session,
      round,
      label: first ? `${first.code} x${staged.ticket.lines.length}` : 'ticket',
    });
    this.#emit({ type: 'presence', draw });
    return { round, draw, replayed: false };
  }

  /**
   * The presence row: a count of tickets and what people bet. Never balances,
   * never stakes, never wins, never names — a leaderboard is a wagering
   * incentive in a social costume.
   */
  presence(draw: LobbyDraw): {
    tickets: number;
    claims: readonly { code: string; params: Record<string, unknown> }[];
  } {
    const claims: { code: string; params: Record<string, unknown> }[] = [];
    for (const entry of draw.entries.values()) {
      if (claims.length >= 8) break;
      const lines = entry.round.ticket?.lines ?? [];
      for (const line of lines) {
        if (claims.length >= 8) break;
        claims.push({ code: line.code, params: { ...(line.params as Record<string, unknown>) } });
      }
    }
    return { tickets: draw.entries.size, claims };
  }
}
