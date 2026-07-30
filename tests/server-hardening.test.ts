import { describe, expect, it } from 'vitest';
import {
  makePermutationTranscript,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { GAMES } from '../src/server/engine.js';
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
