import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAMES } from '../src/server/engine.js';
import { SharedChamber, type LobbyEvent } from '../src/server/lobby.js';
import { SessionStore } from '../src/server/session.js';

const LINE = Object.freeze({ code: 'first', params: Object.freeze({ c: 0 }), stake: 25n });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('round-two session capacity reclamation', () => {
  it('keeps expired sessions with an open round or staged lobby ticket at the ceiling', () => {
    let now = 1_800_000_000_000;
    const sessionIdleEvictMs = 1_000;
    const store = new SessionStore({
      now: () => now,
      testLimits: { maxConcurrentSessions: 2, sessionIdleEvictMs },
    });
    const openSession = store.create();
    const stagedSession = store.create();
    const openRound = store.openRound(openSession);
    const chamber = new SharedChamber(store, 4_000);
    try {
      chamber.start();
      const stagedRound = chamber.commit(stagedSession, {
        roundId: chamber.draw!.roundId,
        lines: [LINE],
      }).round;
      now += sessionIdleEvictMs + 1;

      expect(() => store.create()).toThrowError(
        expect.objectContaining({ code: 'SERVER_CAPACITY', status: 503 }),
      );
      expect(store.getRound(store.get(openSession.id), openRound.roundId).phase).toBe(
        'COMMITTED',
      );
      expect(store.getRound(store.get(stagedSession.id), stagedRound.roundId).ticket).not.toBeNull();
    } finally {
      chamber.stop();
    }
  });

  it('evicts a settled idle session after its TTL and reclaims capacity', () => {
    let now = 1_800_000_000_000;
    const sessionIdleEvictMs = 1_000;
    const store = new SessionStore({
      now: () => now,
      testLimits: { maxConcurrentSessions: 2, sessionIdleEvictMs },
    });
    const protectedSession = store.create();
    store.openRound(protectedSession);
    const idleSession = store.create();
    const settledRound = store.openRound(idleSession);
    store.commit(idleSession, {
      roundId: settledRound.roundId,
      clientSeed: '',
      lines: [LINE],
    });
    now += sessionIdleEvictMs + 1;

    const replacement = store.create();

    expect(replacement.id).not.toBe(idleSession.id);
    expect(store.get(protectedSession.id).openRound).not.toBeNull();
    expect(() => store.get(idleSession.id)).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
    );
  });
});

describe('round-two shared-chamber event materialisation', () => {
  it('builds one shared immutable presence view regardless of listener count', () => {
    vi.useFakeTimers();
    const store = new SessionStore({ now: () => 1_800_000_000_000 });
    const chamber = new SharedChamber(store, 4_000);
    const session = store.create();
    const events: LobbyEvent[] = [];
    const unsubscribers: (() => void)[] = [];
    try {
      chamber.start();
      chamber.commit(session, { roundId: chamber.draw!.roundId, lines: [LINE] });
      for (let index = 0; index < 4; index += 1)
        unsubscribers.push(chamber.subscribe((event) => events.push(event)));
      const get = vi.spyOn(store, 'get');
      const getRound = vi.spyOn(store, 'getRound');

      vi.advanceTimersByTime(500);

      expect(get).toHaveBeenCalledTimes(1);
      expect(getRound).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(4);
      expect(events.every((event) => event.draw === events[0]!.draw)).toBe(true);
      expect(events[0]!.draw.entries.delete(session.id)).toBe(false);
      expect(events.every((event) => event.draw.entries.size === 1)).toBe(true);
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
      chamber.stop();
    }
  });
});

describe('round-two second-ticket wire semantics', () => {
  it('reports a different ticket for the same lobby round as betting closed', () => {
    const store = new SessionStore({ now: () => 1_800_000_000_000 });
    const chamber = new SharedChamber(store, 4_000);
    const session = store.create();
    try {
      chamber.start();
      const roundId = chamber.draw!.roundId;
      chamber.commit(session, { roundId, lines: [LINE] });
      const balanceAfterFirstBet = store.get(session.id).balanceChips;

      expect(() =>
        chamber.commit(session, {
          roundId,
          lines: [{ ...LINE, params: { c: 1 } }],
        }),
      ).toThrowError(expect.objectContaining({ code: 'BETTING_CLOSED' }));
      expect(store.get(session.id).balanceChips).toBe(balanceAfterFirstBet);
    } finally {
      chamber.stop();
    }
  });

  it('reports a different ticket for the same solo round as already settled', () => {
    let now = 1_800_000_000_000;
    const store = new SessionStore({ now: () => now });
    const session = store.create();
    const round = store.openRound(session);
    store.commit(session, {
      roundId: round.roundId,
      clientSeed: '',
      lines: [LINE],
    });
    const balanceAfterFirstBet = store.get(session.id).balanceChips;
    now += GAMES.classic.play.minRoundCycleMs;

    expect(() =>
      store.commit(session, {
        roundId: round.roundId,
        clientSeed: '',
        lines: [{ ...LINE, params: { c: 1 } }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ROUND_ALREADY_SETTLED' }));
    expect(store.get(session.id).balanceChips).toBe(balanceAfterFirstBet);
  });
});
