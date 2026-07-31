/**
 * The pinned ticket strip must not print the result before the round shows it.
 *
 * docs/DESIGN.md §2.1 is the repository's anti-near-miss mechanism: a line
 * changes state at the first lock after which its verdict is identical for every
 * completion of the tube, and the server builds `resolutionTrack` and two parity
 * tests to guarantee that lock is the right one. All of that is decorative if
 * the client prints the verdict before lock 1 — which is exactly what the round-1
 * build did. The settlement arrives in full at COMMIT, so the strip had the
 * winning line's credit in hand from the first frame and rendered it: measured
 * at 270 ms after COMMIT, tube empty, every row still `pending`, and one row
 * already reading `FIRST coral returned 4.80`. Summing the visible figures gave
 * the exact round credit about 1.2 s before the first sphere locked.
 *
 * These tests drive a real settled round through the real service and then run
 * the client's own row builder over the result, in both phases. They fail if any
 * figure that is not already on the ticket appears while the round is live.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { derivePermutation } from '@axiom-games/reveal-engine/modules/permutation/aether';
import { createApp, type App } from '../src/server/app.js';
import { GAMES } from '../src/server/engine.js';
import { roundRows } from '../src/client/rows.js';
import type { Catalogue, RoundView, VariantInfo } from '../src/client/types.js';

const SEED = 'c3'.repeat(32);

let app: App;
let server: Server;
let base: string;
let classic: VariantInfo;

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}

beforeAll(async () => {
  app = createApp({ now: () => 1_800_000_000_000, lobby: false });
  server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  classic = ((await call('GET', '/api/catalogue')) as Catalogue).variants.classic;
}, 300_000);

afterAll(async () => {
  app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A five-line CLASSIC ticket, one FIRST on every colour. Exactly one line wins,
 * every other loses, and all five are decided at lock 1 — the earliest and
 * therefore harshest case for a leak, because a strip that renders the verdict
 * at COMMIT is a full round ahead of a strip that renders it at lock 1.
 */
async function settledRound(): Promise<RoundView> {
  const created = await call('POST', '/api/session');
  const sessionId = created.session.id as string;
  app.store.forceNextSeed(SEED);
  const opened = await call('POST', `/api/session/${sessionId}/round/open`);
  const round = opened.round;
  const permutation = derivePermutation(SEED, GAMES.classic, {
    gameId: 'aether-order',
    variantId: 'classic',
    roundId: round.roundId,
    clientSeed: '',
    nonce: round.nonce,
  });
  const committed = await call('POST', `/api/session/${sessionId}/round/commit`, {
    roundId: round.roundId,
    clientSeed: '',
    lines: [0, 1, 2, 3, 4].map((c) => ({ code: 'first', params: { c }, stake: '100' })),
  });
  // Sanity: the round really did settle, and really does contain a winner.
  expect(committed.round.settlement.grossChips).toBe('480');
  expect(committed.round.lines.filter((line: { won: boolean }) => line.won)).toHaveLength(1);
  expect(permutation).toHaveLength(5);
  return committed.round as RoundView;
}

describe('the pinned strip during a round (docs/DESIGN.md §2.1, §5 S4)', () => {
  it('carries no verdict and no credit while the round is live', async () => {
    const round = await settledRound();
    const rows = roundRows(classic, round, null, 'live');

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.state).toBe('pending');
      expect(row.right).not.toMatch(/returned/iu);
      // 4.80 is the winning line's credit on a 1.00 stake. It is also the
      // multiplier printed on the chip, so the assertion is on the *credit*
      // being absent, not on the digits.
      expect(row.right).toBe('1.00 CR × 4.80×');
    }
    // The whole strip, concatenated, must be identical for a winning ticket and
    // a losing one — five identical FIRST lines at the same stake are exactly
    // that pair of tickets, and only one of them wins.
    expect(new Set(rows.map((row) => row.right)).size).toBe(1);
  });

  it('reports the credit once the round is over, and only then', async () => {
    const round = await settledRound();
    const rows = roundRows(classic, round, null, 'final');
    const won = rows.filter((row) => row.state === 'won');
    const lost = rows.filter((row) => row.state === 'lost');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    expect(won[0]?.right).toBe('returned 4.80 CR');
    // Losing lines are never swept away and never hidden (§5 S5, §10).
    for (const row of lost) expect(row.right).toBe('1.00 CR × 4.80×');
  });

  it('renders the ticket in the order the player built it', async () => {
    const round = await settledRound();
    const reversed = [4, 3, 2, 1, 0];
    const rows = roundRows(classic, round, reversed, 'final');
    // `index` still addresses the canonical line, because that is what the
    // resolution track's per-line indices refer to.
    expect(rows.map((row) => row.index)).toEqual(reversed);
    expect(rows.map((row) => row.summary)).toEqual(
      reversed.map((index) => roundRows(classic, round, null, 'final')[index]?.summary),
    );
  });
});
