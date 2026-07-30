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
 * share. This is the server-side protocol guarantee only: the current fairness
 * explainer is not mode-scoped and may still show solo-oriented seed wording.
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
import {
  type RawLine,
  type RoundRecord,
  type Session,
  type SessionStore,
  snapshotRawLines,
} from './session.js';

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
  readonly #drawStates = new WeakMap<LobbyDraw, LobbyDraw>();
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
    return this.#draw ? this.#drawView(this.#draw) : null;
  }

  get listenerCount(): number {
    return this.#listeners.size;
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
    if (this.#listeners.size >= this.#store.limits.maxLobbyListeners)
      throw new ServiceError(
        'SERVER_CAPACITY',
        'The shared-chamber stream limit has been reached',
        '$.lobby.stream',
        { limit: this.#store.limits.maxLobbyListeners },
      );
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  #emit(event: LobbyEvent): void {
    // One materialisation shared across every stream — so it must be frozen,
    // or a handler that assigns to `event.draw` rewrites what every other
    // player's stream receives. `#drawView` freezes the draw; this freezes the
    // wrapper around it.
    const emitted = Object.freeze({
      type: event.type,
      draw: this.#drawView(event.draw),
    }) as LobbyEvent;
    for (const listener of this.#listeners) {
      try {
        listener(emitted);
      } catch {
        // A broken stream cannot strand settlement or the next draw.
        this.#listeners.delete(listener);
      }
    }
  }

  #drawState(draw: LobbyDraw): LobbyDraw {
    const state = this.#drawStates.get(draw);
    if (!state) throw new ServiceError('ROUND_NOT_FOUND', 'No such lobby draw', '$.roundId');
    return state;
  }

  #drawView(draw: LobbyDraw): LobbyDraw {
    // Belt and braces with `#settle`'s entry removal: an entry whose round no
    // longer resolves is dropped from the view rather than thrown over. A
    // presence view is not worth wedging the chamber for, and the throw used to
    // escape all the way past `#open()`.
    const resolved: [string, { session: Session; round: RoundRecord; label: string }][] = [];
    for (const [sessionId, entry] of draw.entries) {
      let round;
      try {
        round = this.#store.getRound(entry.session, entry.round.roundId);
      } catch {
        continue;
      }
      resolved.push([
        sessionId,
        Object.freeze({
          session: this.#store.get(entry.session.id),
          round,
          label: entry.label,
        }),
      ]);
    }
    const entries = new FrozenMap(resolved);
    const transcript = draw.transcript ? deepFreeze(structuredClone(draw.transcript)) : null;
    const view = Object.freeze({ ...draw, entries, transcript }) as LobbyDraw;
    this.#drawStates.set(view, draw);
    return view;
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
    // The seed and commitment are fixed properties of this draw object. They
    // cannot be rewritten through the public `draw`/event references while the
    // settlement fields below remain intentionally mutable.
    Object.defineProperties(draw, {
      serverSeed: { value: serverSeed, enumerable: true, writable: false, configurable: false },
      seedCommitment: {
        value: draw.seedCommitment,
        enumerable: true,
        writable: false,
        configurable: false,
      },
    });
    this.#drawStates.set(draw, draw);
    // There is no in-process discard-and-redraw path: `start()` is a no-op
    // whenever `#draw` is non-null, failures leave that same draw referenced,
    // and the only other call to `#open` is the final step of `#settle`, after
    // this draw's transcript and reveal have been fixed and published.
    this.#draw = draw;
    this.#emit({ type: 'round.open', draw });
    this.#timer = setTimeout(() => this.#settle(draw), this.cadenceMs);
    this.#timer.unref?.();
  }

  #settle(draw: LobbyDraw): void {
    const game = gameFor(draw.variantId);
    let transcript: PermutationTranscript;
    try {
      transcript = makePermutationTranscript(
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
    } catch (error) {
      // A draw-wide derivation failure happens before any player can be
      // credited, so every staged debit belongs to the same failed unit.
      for (const entry of draw.entries.values()) {
        this.#store.rollbackStagedTicket(entry.session, entry.round);
        this.#store.discardUnstagedRound(entry.session, entry.round);
      }
      throw error;
    }
    draw.transcript = transcript;
    draw.settled = true;
    this.#previousCommitment = transcript.commitment;
    for (const entry of draw.entries.values()) {
      try {
        // Settle and credit BEFORE the seed becomes readable on that round.
        // Reversing the two would publish the seed for a ticket that is still
        // debited and unsettled, which is the one ordering §5 forbids.
        this.#store.finishRound(entry.session, entry.round, transcript);
        this.#store.markLobbySeedRevealed(entry.round);
      } catch {
        // `finishRound` restores its credit-side patch; this restores the
        // earlier staged debit and replay identity too. The now-unbet shell is
        // discarded, while every other entry and the next draw continue.
        this.#store.rollbackStagedTicket(entry.session, entry.round);
        this.#store.discardUnstagedRound(entry.session, entry.round);
        // And the entry leaves the draw with its round. `discardUnstagedRound`
        // removes the round from the session, so an entry left behind here
        // points at a round `#drawView` can no longer resolve — which threw out
        // of `#emit`, out of `#settle`, and past the `#open()` below, wedging
        // the chamber shut for every player rather than for this one entry.
        draw.entries.delete(entry.session.id);
      }
    }
    this.#emit({ type: 'round.reveal', draw });
    // Ordering is the anti-grinding guarantee for this single process: the next
    // seed is not drawn until this draw is settled and its reveal event emitted.
    this.#open();
  }

  /** The window as the server sees it. The client's countdown is display only. */
  windowFor(draw: LobbyDraw): {
    closesAt: number;
    lastAcceptedAt: number;
    clientClosesAt: number;
    settleAtEpochMs: number;
  } {
    draw = this.#drawState(draw);
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
  ): { round: RoundRecord; replayed: boolean } {
    // Snapshot caller-owned request fields once. In particular, the same
    // `lines` object must determine both replay identity and a new staged bet.
    const roundId = input.roundId;
    const lines = snapshotRawLines(input.lines);
    const replayed = this.#store.replayedTicket(session, roundId, lines);
    if (replayed) return { round: replayed, replayed: true };

    const draw = this.#draw;
    if (!draw || draw.roundId !== roundId || draw.settled)
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
    if (this.#store.get(session.id).variantId !== draw.variantId)
      throw new ServiceError(
        'ADAPTER_MISMATCH',
        'The shared chamber runs CLASSIC; switch variant to join it.',
        '$.variantId',
      );

    const round = this.#store.attachRound(session, draw);
    let staged: ReturnType<SessionStore['stageTicket']>;
    try {
      staged = this.#store.stageTicket(session, round, lines);
    } catch (error) {
      this.#store.discardUnstagedRound(session, round);
      throw error;
    }
    if (staged.replayed) return { round: staged.replayed, replayed: true };
    // `attachRound` returned a pre-stage frozen view. Refresh it after the
    // ticket patch so both the caller and the presence row see the bet that was
    // actually debited.
    const stagedRound = this.#store.getRound(session, round.roundId);
    const first = staged.ticket.lines[0];
    draw.entries.set(session.id, {
      session,
      round: stagedRound,
      label: first ? `${first.code} x${staged.ticket.lines.length}` : 'ticket',
    });
    this.#emit({ type: 'presence', draw });
    return { round: stagedRound, replayed: false };
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
    draw = this.#drawState(draw);
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * A genuinely read-only map surface.
 *
 * The previous version subclassed `Map` and overrode `set`/`delete`/`clear`.
 * That is not isolation: `Object.freeze` does not protect a Map's internal
 * `[[MapData]]`, and the overrides are own-properties that
 * `Map.prototype.set.call(view, ...)` walks straight past — one stream handler
 * could inject an entry every other handler then saw. This closes over a
 * private Map instead, so there is no inherited mutator to reach, and the
 * mutators throw the way everything else in this service does rather than
 * silently doing nothing.
 */
class FrozenMap<K, V> {
  readonly #data: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#data = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#data.size;
  }

  get(key: K): V | undefined {
    return this.#data.get(key);
  }

  has(key: K): boolean {
    return this.#data.has(key);
  }

  keys(): MapIterator<K> {
    return this.#data.keys();
  }

  values(): MapIterator<V> {
    return this.#data.values();
  }

  entries(): MapIterator<[K, V]> {
    return this.#data.entries();
  }

  forEach(fn: (value: V, key: K, map: FrozenMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#data) fn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#data[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  set(_key: K, _value: V): never {
    throw new ServiceError('INVALID_TICKET', 'The lobby entry view is read-only', '$.entries');
  }

  delete(_key: K): never {
    throw new ServiceError('INVALID_TICKET', 'The lobby entry view is read-only', '$.entries');
  }

  clear(): never {
    throw new ServiceError('INVALID_TICKET', 'The lobby entry view is read-only', '$.entries');
  }
}
