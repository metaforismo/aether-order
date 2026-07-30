import { describe, expect, it, vi } from 'vitest';
import {
  makePermutationTranscript,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { GAMES } from '../src/server/engine.js';
import { SharedChamber } from '../src/server/lobby.js';
import { SessionStore, type SessionStoreTestFaults } from '../src/server/session.js';

const LINE = Object.freeze({ code: 'first', params: Object.freeze({ c: 0 }), stake: 25n });

function bytes(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return `${item}n`;
    if (item instanceof Map) return { $map: [...item.entries()] };
    return item;
  });
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
    const before = bytes(session);

    expect(() => store.stageTicket(session, round, [LINE])).toThrow('injected stage crash');
    expect(bytes(session)).toBe(before);
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
    const before = bytes(session);
    crash = true;

    expect(() => store.finishRound(session, round, transcript)).toThrow('injected finish crash');
    expect(bytes(session)).toBe(before);
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
      const balanceAfterCommit = session.balanceChips;

      now += 4_000;
      vi.advanceTimersByTime(4_000);
      expect(first.round.phase).toBe('SETTLED');
      expect(chamber.draw?.roundId).not.toBe(opened!.roundId);

      const retry = chamber.commit(session, { roundId: opened!.roundId, lines: [LINE] });
      expect(retry.replayed).toBe(true);
      expect(retry.round).toBe(first.round);
      expect(retry.round.receipt).toBe(first.round.receipt);
      expect(session.balanceChips).toBeGreaterThanOrEqual(balanceAfterCommit);
    } finally {
      chamber.stop();
      vi.useRealTimers();
    }
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
      expect(chamber.draw).toBe(opened);
      expect(() => {
        (opened as { serverSeed: string }).serverSeed = '00'.repeat(32);
      }).toThrow();

      now += 4_000;
      vi.advanceTimersByTime(4_000);
      expect(opened.settled).toBe(true);
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
