import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  makePermutationTranscript,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { createApp, parseLines } from '../src/server/app.js';
import { GAMES } from '../src/server/engine.js';
import { SharedChamber } from '../src/server/lobby.js';
import {
  SERVER_LIMITS,
  SessionStore,
  type SessionStoreTestFaults,
} from '../src/server/session.js';

const LINE = Object.freeze({ code: 'first', params: Object.freeze({ c: 0 }), stake: 25n });

function bytes(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return `${item}n`;
    if (item instanceof Map) return { $map: [...item.entries()] };
    return item;
  });
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function medianGetMs(store: SessionStore, sessionId: string, samples: number): number {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    store.get(sessionId);
    durations.push(performance.now() - startedAt);
  }
  return median(durations);
}

describe('AO-01 wallet patches are exception-atomic', () => {
  it('restores the complete staged-debit state when posting throws', () => {
    const faults: SessionStoreTestFaults = {
      afterStagePatch: () => {
        throw new Error('injected stage crash');
      },
    };
    const store = new SessionStore({ now: () => 1_800_000_000_000, testFaults: faults });
    const session = store.create();
    const round = store.openRound(session);
    const before = bytes(store.get(session.id));

    expect(() => store.stageTicket(session, round, [LINE])).toThrow('injected stage crash');
    expect(bytes(store.get(session.id))).toBe(before);
  });

  it('restores wallet, round and history byte-for-byte when finish posting throws', () => {
    let crash = false;
    const faults: SessionStoreTestFaults = {
      afterFinishPatch: () => {
        if (crash) throw new Error('injected finish crash');
      },
    };
    const store = new SessionStore({ now: () => 1_800_000_000_000, testFaults: faults });
    const session = store.create();
    const round = store.openRound(session);
    store.stageTicket(session, round, [LINE]);
    const transcript = makePermutationTranscript(
      round.serverSeed,
      GAMES.classic,
      {
        gameId: GAMES.classic.id,
        variantId: round.variantId,
        roundId: round.roundId,
        clientSeed: '',
        nonce: round.nonce,
      },
      round.previousCommitment,
    );
    const before = bytes(store.get(session.id));
    crash = true;

    expect(() => store.finishRound(session, round, transcript)).toThrow('injected finish crash');
    expect(bytes(store.get(session.id))).toBe(before);
  });
});

describe('AO-02 shared-chamber idempotency', () => {
  it('returns the settled original round when an exact retry arrives after the draw closed', () => {
    vi.useFakeTimers();
    let now = 1_800_000_000_000;
    const store = new SessionStore({ now: () => now });
    const chamber = new SharedChamber(store, 4_000);
    try {
      const session = store.create();
      chamber.start();
      const opened = chamber.draw;
      expect(opened).not.toBeNull();
      const first = chamber.commit(session, { roundId: opened!.roundId, lines: [LINE] });
      const balanceAfterCommit = store.get(session.id).balanceChips;

      now += 4_000;
      vi.advanceTimersByTime(4_000);
      expect(store.getRound(session, first.round.roundId).phase).toBe('SETTLED');
      expect(chamber.draw?.roundId).not.toBe(opened!.roundId);

      const retry = chamber.commit(session, { roundId: opened!.roundId, lines: [LINE] });
      expect(retry.replayed).toBe(true);
      expect(retry.round.roundId).toBe(first.round.roundId);
      expect(retry.round.receipt).toEqual(store.getRound(session, first.round.roundId).receipt);
      expect(store.get(session.id).balanceChips).toBeGreaterThanOrEqual(balanceAfterCommit);
    } finally {
      chamber.stop();
      vi.useRealTimers();
    }
  });
});

describe('AO-04 bounded and encapsulated public service state', () => {
  it('materializes session views in near-constant time across the retained-round ceiling', () => {
    let now = 1_800_000_000_000;
    const smallStore = new SessionStore({ now: () => now });
    const smallSession = smallStore.create();
    const fullStore = new SessionStore({ now: () => now });
    const fullSession = fullStore.create();

    for (let index = 0; index < SERVER_LIMITS.maxRetainedRoundsPerSession; index += 1) {
      const round = fullStore.openRound(fullSession);
      fullStore.commit(fullSession, {
        roundId: round.roundId,
        clientSeed: `retained-${index}`,
        lines: [LINE],
      });
      now += GAMES.classic.play.minRoundCycleMs;
    }

    // Warm both paths before comparing medians. Pre-fix, the full-history path
    // eagerly clones each round three times and exceeds this ratio by orders of
    // magnitude; the lazy view pays only for the collection shells.
    smallStore.get(smallSession.id);
    fullStore.get(fullSession.id);
    const smallMs = medianGetMs(smallStore, smallSession.id, 11);
    const fullMs = medianGetMs(fullStore, fullSession.id, 11);
    expect(fullMs, `small=${smallMs.toFixed(4)}ms full=${fullMs.toFixed(4)}ms`).toBeLessThan(
      Math.max(0.25, smallMs * 8),
    );
  });

  it('lazily returns every retained round byte-for-byte and deeply frozen', () => {
    let now = 1_800_000_000_000;
    const store = new SessionStore({ now: () => now });
    const session = store.create();
    for (let index = 0; index < 8; index += 1) {
      const round = store.openRound(session);
      store.commit(session, {
        roundId: round.roundId,
        clientSeed: `correctness-${index}`,
        lines: [{ ...LINE, params: { c: index % 5 } }],
      });
      now += GAMES.classic.play.minRoundCycleMs;
    }

    const exposed = store.get(session.id);
    const expectedById = new Map(
      [...exposed.roundsById.keys()].map((roundId) => [
        roundId,
        bytes(store.getRound(session, roundId)),
      ]),
    );
    expect(Object.isFrozen(exposed.rounds)).toBe(true);
    expect(Object.isFrozen(exposed.roundsById)).toBe(true);
    expect(Object.isFrozen(exposed.commitsByIdempotencyKey)).toBe(true);

    for (const round of exposed.rounds) {
      expect(bytes(round)).toBe(expectedById.get(round.roundId));
      expectDeepFrozen(round);
    }
    for (const [roundId, round] of exposed.roundsById) {
      expect(bytes(round)).toBe(expectedById.get(roundId));
      expectDeepFrozen(round);
    }
    for (const round of exposed.commitsByIdempotencyKey.values()) {
      expect(bytes(round)).toBe(expectedById.get(round.roundId));
      expectDeepFrozen(round);
    }

    const fromArray = exposed.rounds[0]!;
    const fromId = exposed.roundsById.get(fromArray.roundId)!;
    const fromReplay = [...exposed.commitsByIdempotencyKey.values()][0]!;
    for (const round of [fromArray, fromId, fromReplay])
      expect(() => {
        round.balanceAfterChips = 0n;
      }).toThrow();
    exposed.roundsById.clear();
    exposed.commitsByIdempotencyKey.delete(fromReplay.ticketBinding!.idempotencyKey);
    expect(store.get(session.id).roundsById.size).toBe(8);
    expect(store.get(session.id).commitsByIdempotencyKey.size).toBe(8);
  });

  it('rejects session creation with a typed error at the explicit ceiling', () => {
    const maxConcurrentSessions = 4;
    const store = new SessionStore({ testLimits: { maxConcurrentSessions } });
    for (let index = 0; index < maxConcurrentSessions; index += 1) store.create();
    let failure: unknown;
    try {
      store.create();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'ServiceError',
      code: 'SERVER_CAPACITY',
      status: 503,
    });
  });

  it('evicts the oldest settled rounds and idempotency keys while retained rounds still reveal', () => {
    let now = 1_800_000_000_000;
    const maxRetainedRoundsPerSession = 4;
    const maxIdempotencyKeysPerSession = 4;
    const store = new SessionStore({
      now: () => now,
      testLimits: {
        maxRetainedRoundsPerSession,
        maxIdempotencyKeysPerSession,
      },
    });
    const session = store.create();
    let oldestRoundId = '';
    let newestRoundId = '';
    let oldestLine: { code: string; params: object; stake: bigint } = LINE;
    let newestLine: { code: string; params: object; stake: bigint } = LINE;
    for (let index = 0; index <= maxRetainedRoundsPerSession; index += 1) {
      const round = store.openRound(session);
      const line = { code: 'first', params: { c: index % 5 }, stake: 25n };
      if (index === 0) oldestRoundId = round.roundId;
      if (index === 0) oldestLine = line;
      newestRoundId = round.roundId;
      newestLine = line;
      store.commit(session, {
        roundId: round.roundId,
        clientSeed: '',
        lines: [line],
      });
      now += 2_500;
    }

    const retained = store.get(session.id);
    expect(retained.rounds).toHaveLength(maxRetainedRoundsPerSession);
    expect(retained.roundsById.size).toBe(maxRetainedRoundsPerSession);
    expect(retained.roundsById.has(oldestRoundId)).toBe(false);
    expect(retained.commitsByIdempotencyKey.size).toBe(maxIdempotencyKeysPerSession);
    expect(store.replayedTicket(session, oldestRoundId, [oldestLine])).toBeNull();
    expect(store.replayedTicket(session, newestRoundId, [newestLine])?.roundId).toBe(
      newestRoundId,
    );
    const newest = store.getRound(retained, newestRoundId);
    expect(store.reveal(newest).transcript.ok).toBe(true);

    now += 3_600_001;
    const afterWindow = store.openRound(session);
    store.commit(session, {
      roundId: afterWindow.roundId,
      clientSeed: '',
      lines: [LINE],
    });
    expect(store.get(session.id).commitTimestamps).toHaveLength(1);
  });

  it('bounds rolling-hour timestamps and rejects the first commit beyond the policy ceiling', () => {
    let now = 1_800_000_000_000;
    const maxCommitTimestampsPerSession = 4;
    const store = new SessionStore({
      now: () => now,
      testLimits: { maxCommitTimestampsPerSession },
    });
    const session = store.create();
    const policy = GAMES.classic.play;
    expect(SERVER_LIMITS.maxCommitTimestampsPerSession).toBe(
      policy.maxRoundsPerRollingHour,
    );
    for (let index = 0; index < maxCommitTimestampsPerSession; index += 1) {
      const round = store.openRound(session);
      store.commit(session, {
        roundId: round.roundId,
        clientSeed: '',
        lines: [LINE],
      });
      now += policy.minRoundCycleMs;
    }

    const blocked = store.openRound(session);
    let failure: unknown;
    try {
      store.commit(session, {
        roundId: blocked.roundId,
        clientSeed: '',
        lines: [LINE],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'ServiceError',
      code: 'CYCLE_FLOOR',
      status: 429,
    });
    expect(store.get(session.id).commitTimestamps).toHaveLength(
      maxCommitTimestampsPerSession,
    );

    now += 3_600_001;
    store.commit(session, {
      roundId: blocked.roundId,
      clientSeed: '',
      lines: [LINE],
    });
    expect(store.get(session.id).commitTimestamps).toHaveLength(1);
  });

  it('drops rejected shared-draw shells instead of retaining one per draw', () => {
    vi.useFakeTimers();
    let now = 1_800_000_000_000;
    const maxRetainedRoundsPerSession = 4;
    const store = new SessionStore({
      now: () => now,
      testLimits: { maxRetainedRoundsPerSession },
    });
    const session = store.create();
    store.setBalanceForTest(session, 0n);
    const chamber = new SharedChamber(store, 4_000);
    try {
      chamber.start();
      for (let index = 0; index <= maxRetainedRoundsPerSession; index += 1) {
        expect(() =>
          chamber.commit(session, {
            roundId: chamber.draw!.roundId,
            lines: [LINE],
          }),
        ).toThrow(expect.objectContaining({ code: 'WALLET_DECLINED' }));
        expect(store.get(session.id).roundsById.size).toBe(0);
        now += 4_000;
        vi.advanceTimersByTime(4_000);
      }
    } finally {
      chamber.stop();
      vi.useRealTimers();
    }
  });

  it('caps listeners and repeated unsubscribe leaves no retained listener', () => {
    const maxLobbyListeners = 4;
    const chamber = new SharedChamber(
      new SessionStore({ testLimits: { maxLobbyListeners } }),
      4_000,
    );
    const unsubscribers = Array.from(
      { length: maxLobbyListeners },
      () => chamber.subscribe(() => undefined),
    );
    expect(chamber.listenerCount).toBe(maxLobbyListeners);
    let failure: unknown;
    try {
      chamber.subscribe(() => undefined);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'ServiceError',
      code: 'SERVER_CAPACITY',
    });
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
      unsubscribe();
    }
    expect(chamber.listenerCount).toBe(0);
  });

  it('removes a throwing listener without interrupting other lobby listeners', () => {
    const chamber = new SharedChamber(new SessionStore(), 4_000);
    let observed = 0;
    chamber.subscribe(() => {
      throw new Error('broken stream');
    });
    const unsubscribe = chamber.subscribe(() => {
      observed += 1;
    });
    chamber.start();
    try {
      expect(observed).toBe(1);
      expect(chamber.listenerCount).toBe(1);
    } finally {
      unsubscribe();
      chamber.stop();
    }
  });

  it('unsubscribes the HTTP lobby stream on connection close', async () => {
    const app = createApp({ lobby: true, lobbyCadenceMs: 4_000 });
    const request = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/api/lobby/stream',
    }) as unknown as IncomingMessage;
    let headersSent = false;
    let ended = false;
    const response = Object.assign(new EventEmitter(), {
      get headersSent(): boolean {
        return headersSent;
      },
      get writableEnded(): boolean {
        return ended;
      },
      writeHead(): ServerResponse {
        headersSent = true;
        return response;
      },
      write(): boolean {
        return true;
      },
      end(): ServerResponse {
        ended = true;
        return response;
      },
    }) as unknown as ServerResponse;
    try {
      app.handler(request, response);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(app.chamber?.listenerCount).toBe(1);
      request.emit('close');
      for (let attempt = 0; attempt < 20 && app.chamber?.listenerCount !== 0; attempt += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(app.chamber?.listenerCount).toBe(0);
      expect(ended).toBe(true);
    } finally {
      app.close();
    }
  });

  it('mutating accessor results cannot alter wallet, receipts, history or replay records', () => {
    const store = new SessionStore({ now: () => 1_800_000_000_000 });
    const session = store.create();
    const opened = store.openRound(session);
    const committed = store.commit(session, {
      roundId: opened.roundId,
      clientSeed: '',
      lines: [LINE],
    });
    const exposed = store.get(session.id);
    const balance = exposed.balanceChips;
    const receipt = committed.round.receipt;

    exposed.roundsById.delete(opened.roundId);
    exposed.commitsByIdempotencyKey.clear();
    expect(() => exposed.rounds.splice(0)).toThrow();
    expect(() => {
      exposed.balanceChips = 0n;
    }).toThrow();
    expect(() => {
      (committed.round.receipt as { credited: bigint }).credited = 999_999n;
    }).toThrow();

    const current = store.get(session.id);
    expect(current.balanceChips).toBe(balance);
    expect(current.roundsById.has(opened.roundId)).toBe(true);
    expect(current.commitsByIdempotencyKey.size).toBe(1);
    expect(store.getRound(current, opened.roundId).receipt).toEqual(receipt);
  });

  it('mutating a lobby draw view cannot remove a staged settlement', () => {
    const store = new SessionStore({ now: () => 1_800_000_000_000 });
    const chamber = new SharedChamber(store, 4_000);
    const session = store.create();
    chamber.start();
    try {
      const draw = chamber.draw!;
      chamber.commit(session, { roundId: draw.roundId, lines: [LINE] });
      const exposed = chamber.draw!;
      expect(exposed.entries.size).toBe(1);
      exposed.entries.clear();
      expect(() => {
        exposed.settled = true;
      }).toThrow();
      expect(chamber.draw?.entries.size).toBe(1);
      expect(chamber.presence(chamber.draw!).tickets).toBe(1);
    } finally {
      chamber.stop();
    }
  });

  it('removes an unstaged lobby shell after a rejected ticket', () => {
    const store = new SessionStore({ now: () => 1_800_000_000_000 });
    const chamber = new SharedChamber(store, 4_000);
    const session = store.create();
    chamber.start();
    try {
      const roundId = chamber.draw!.roundId;
      expect(() =>
        chamber.commit(session, {
          roundId,
          lines: [{ code: 'jackpot', params: {}, stake: 25n }],
        }),
      ).toThrow();
      expect(store.get(session.id).roundsById.has(roundId)).toBe(false);
    } finally {
      chamber.stop();
    }
  });

  it('snapshots hostile ticket getters exactly once before validation and execution', () => {
    const store = new SessionStore({ now: () => 1_800_000_000_000 });
    const session = store.create();
    const round = store.openRound(session);
    const reads = { code: 0, params: 0, stake: 0 };
    const hostile = {
      get code(): string {
        reads.code += 1;
        return reads.code === 1 ? 'first' : 'jackpot';
      },
      get params(): object {
        reads.params += 1;
        return reads.params === 1 ? { c: 0 } : { c: 99 };
      },
      get stake(): bigint {
        reads.stake += 1;
        return reads.stake === 1 ? 25n : 30n;
      },
    };

    const result = store.commit(session, {
      roundId: round.roundId,
      clientSeed: '',
      lines: [hostile],
    });
    expect(result.round.ticket?.lines[0]).toMatchObject({
      code: 'first',
      params: { c: 0 },
      stake: 25n,
    });
    expect(reads).toEqual({ code: 1, params: 1, stake: 1 });
  });

  it('snapshots hostile HTTP line getters once instead of validating one value and using another', () => {
    const reads = { code: 0, params: 0, stake: 0 };
    const hostile = {
      get code(): string {
        reads.code += 1;
        return reads.code === 1 ? 'first' : 'jackpot';
      },
      get params(): object {
        reads.params += 1;
        return reads.params === 1 ? { c: 0 } : { c: 99 };
      },
      get stake(): string {
        reads.stake += 1;
        return reads.stake === 1 ? '25' : '30';
      },
    };

    expect(parseLines([hostile])).toEqual([{ code: 'first', params: { c: 0 }, stake: 25n }]);
    expect(reads).toEqual({ code: 1, params: 1, stake: 1 });
  });
});

describe('AO-05 adapter-bound ticket replay identity', () => {
  it('rejects a ticket opened under one fingerprint when replayed under another', () => {
    const fingerprintA = 'a'.repeat(64);
    const fingerprintB = 'b'.repeat(64);
    let activeFingerprint = fingerprintA;
    const faults: SessionStoreTestFaults = {
      ticketAdapterFingerprint: () => activeFingerprint,
    };
    const store = new SessionStore({
      now: () => 1_800_000_000_000,
      testFaults: faults,
    });
    const session = store.create();
    const round = store.openRound(session);
    const staged = store.stageTicket(session, round, [LINE]);
    const opened = store.getRound(session, round.roundId);
    const binding = opened.ticketBinding;
    expect(binding).toMatchObject({ adapterFingerprint: fingerprintA });
    expect(binding?.idempotencyKey).not.toBe(staged.ticket.idempotencyKey);
    expect(store.get(session.id).commitsByIdempotencyKey.has(binding!.idempotencyKey)).toBe(
      true,
    );
    const balanceAfterFirstStage = store.get(session.id).balanceChips;

    activeFingerprint = fingerprintB;
    let failure: unknown;
    try {
      store.stageTicket(session, round, [LINE]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'ServiceError',
      code: 'ADAPTER_MISMATCH',
      path: '$.adapterFingerprint',
    });
    expect(store.get(session.id).balanceChips).toBe(balanceAfterFirstStage);
    expect(store.get(session.id).commitsByIdempotencyKey).toHaveLength(1);
  });
});

describe('AO-03 shared-draw seed custody', () => {
  it('cannot replace a live draw and cannot rewrite its seed fields across settlement', () => {
    vi.useFakeTimers();
    let now = 1_800_000_000_000;
    const store = new SessionStore({ now: () => now });
    const chamber = new SharedChamber(store, 4_000);
    try {
      chamber.start();
      const opened = chamber.draw!;
      const identity = {
        roundId: opened.roundId,
        serverSeed: opened.serverSeed,
        seedCommitment: opened.seedCommitment,
      };
      expect(Object.getOwnPropertyDescriptor(opened, 'serverSeed')?.writable).toBe(false);
      expect(Object.getOwnPropertyDescriptor(opened, 'seedCommitment')?.writable).toBe(false);

      chamber.start();
      expect(chamber.draw?.roundId).toBe(opened.roundId);
      expect(() => {
        (opened as { serverSeed: string }).serverSeed = '00'.repeat(32);
      }).toThrow();

      now += 4_000;
      vi.advanceTimersByTime(4_000);
      expect({
        roundId: opened.roundId,
        serverSeed: opened.serverSeed,
        seedCommitment: opened.seedCommitment,
      }).toEqual(identity);
      expect(chamber.draw?.roundId).not.toBe(opened.roundId);
    } finally {
      chamber.stop();
      vi.useRealTimers();
    }
  });
});

describe('development-only seams', () => {
  it('keeps the HTTP clock-skew hook disabled in production even when dev is requested', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp({ lobby: false, dev: true });
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/api/dev/skew',
    }) as unknown as IncomingMessage;
    let status = 0;
    let body = '';
    let headersSent = false;
    const response = Object.assign(new EventEmitter(), {
      get headersSent(): boolean {
        return headersSent;
      },
      writableEnded: false,
      writeHead(nextStatus: number): ServerResponse {
        status = nextStatus;
        headersSent = true;
        return response;
      },
      end(value?: string): ServerResponse {
        body = value ?? '';
        return response;
      },
    }) as unknown as ServerResponse;
    try {
      app.handler(request, response);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(status).toBe(400);
      expect(JSON.parse(body)).toMatchObject({
        error: { code: 'BAD_REQUEST', message: 'Dev hooks are disabled' },
      });
    } finally {
      app.close();
      vi.unstubAllEnvs();
    }
  });
});
