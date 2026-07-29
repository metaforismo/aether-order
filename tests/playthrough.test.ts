/**
 * The API-level playthrough.
 *
 * A full round is driven through the real HTTP service — the same routes the
 * client calls — and every credit is asserted against the published paytable:
 * FIRST at `4.80x`, BEFORE at `1.92x`, FULL ORDER at `115.20x`, on stakes that
 * are multiples of the 25-chip quantum, with the balance checked at each step.
 *
 * The one thing the test controls that a player cannot is the server seed. It is
 * forced through a store seam so the settled order is known in advance, which is
 * what makes "exact credits" a real assertion rather than a tautology. Nothing
 * else is stubbed: the engine derives, settles, signs and verifies exactly as it
 * does in `npm run dev`.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  derivePermutation,
  seedCommitment,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { createApp, type App } from '../src/server/app.js';
import { GAMES } from '../src/server/engine.js';
import { OPENING_BALANCE_CHIPS } from '../src/server/session.js';

const SEED = 'a1'.repeat(32);

let app: App;
let server: Server;
let base: string;
let now = 1_800_000_000_000;

async function call<T = Record<string, any>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

beforeAll(async () => {
  app = createApp({ now: () => now, lobby: false });
  server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function newSession(): Promise<string> {
  const created = await call('POST', '/api/session');
  expect(created.status).toBe(201);
  return created.json.session.id as string;
}

describe('a full round, through the API', () => {
  it('publishes the commitment before a ticket exists, then pays the published multipliers', async () => {
    const sessionId = await newSession();

    const before = await call('GET', `/api/session/${sessionId}`);
    expect(before.json.session.balanceChips).toBe(OPENING_BALANCE_CHIPS.toString());
    expect(before.json.session.balanceCredits).toBe('500.00');

    // 1. COMMITTED: seed drawn, context fixed, commitment published — no ticket.
    app.store.forceNextSeed(SEED);
    const opened = await call('POST', `/api/session/${sessionId}/round/open`);
    expect(opened.status).toBe(200);
    const round = opened.json.round;
    expect(round.phase).toBe('COMMITTED');
    expect(round.ticket).toBeNull();
    expect(round.transcript).toBeNull();
    expect(round.serverSeed).toBeNull();
    expect(round.previousCommitment).toBe('0'.repeat(64));
    expect(round.seedCommitment).toMatch(/^[0-9a-f]{64}$/u);
    // The published hash binds the seed AND the whole seed context (§7.2).
    expect(round.seedCommitment).toBe(
      seedCommitment(SEED, {
        variantId: 'classic',
        roundId: round.roundId,
        nonce: round.nonce,
      }),
    );

    // The settled order, known to the test only because it forced the seed.
    const clientSeed = 'playthrough';
    const permutation = derivePermutation(SEED, GAMES.classic, {
      gameId: 'aether-order',
      variantId: 'classic',
      roundId: round.roundId,
      clientSeed,
      nonce: round.nonce,
    });
    const winner = permutation[0] as number;
    const second = permutation[1] as number;
    const loser = permutation[4] as number;
    const order = permutation.join('-');

    const lines = [
      { code: 'first', params: { c: winner }, stake: '100' }, // 1.00 -> 4.80
      { code: 'first', params: { c: loser }, stake: '100' }, // 1.00 -> 0
      { code: 'before', params: { a: winner, b: second }, stake: '100' }, // 1.00 -> 1.92
      { code: 'full', params: { order }, stake: '25' }, // 0.25 -> 28.80
    ];

    // 2. The figure the player sees before committing: a maximum over the 120
    //    settled orders, NOT the sum of every line's return-if-hit (§8.1).
    const quoted = await call('POST', `/api/session/${sessionId}/ticket/quote`, { lines });
    expect(quoted.status).toBe(200);
    const quote = quoted.json.quote;
    expect(quote.lineCount).toBe(4);
    expect(quote.totalStakeChips).toBe('325');
    expect(quote.bestOutcomeChips).toBe('3552'); // 4.80 + 1.92 + 28.80
    expect(quote.bestOutcomeOrder).toBe(order);
    // The two FIRST lines are mutually exclusive, so the naive sum (40.32) is an
    // amount the game cannot pay, and the published figure says so.
    expect(quote.everyLineCanHitTogether).toBe(false);
    expect(quote.display.best).toBe('35.52');

    // 3. COMMIT: debit, derive, settle, credit.
    const committed = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: round.roundId,
      clientSeed,
      lines,
    });
    expect(committed.status).toBe(200);
    const settled = committed.json.round;
    expect(settled.phase).toBe('SETTLED');
    expect(settled.transcript.permutation).toEqual([...permutation]);

    expect(settled.settlement.totalStakeChips).toBe('325');
    expect(settled.settlement.grossChips).toBe('3552');
    expect(settled.settlement.creditedChips).toBe('3552');
    expect(settled.settlement.netChips).toBe('3227');
    expect(settled.settlement.capped).toBe(false);

    // Line by line, in canonical order (before, first, first, full).
    const byLabel = new Map<string, any>(
      settled.lines.map((line: any) => [`${line.code}:${line.label}`, line]),
    );
    expect(byLabel.get(`first:f${winner}`).won).toBe(true);
    expect(byLabel.get(`first:f${winner}`).grossChips).toBe('480');
    expect(byLabel.get(`first:f${winner}`).multiplierDecimal).toBe('4.80×');
    expect(byLabel.get(`first:f${loser}`).won).toBe(false);
    expect(byLabel.get(`first:f${loser}`).grossChips).toBe('0');
    expect(byLabel.get(`before:${winner}<${second}`).won).toBe(true);
    expect(byLabel.get(`before:${winner}<${second}`).grossChips).toBe('192');
    expect(byLabel.get(`full:full:${order}`).won).toBe(true);
    expect(byLabel.get(`full:full:${order}`).grossChips).toBe('2880');

    // 4. The wallet: 500.00 - 3.25 + 35.52.
    const expectedBalance = OPENING_BALANCE_CHIPS - 325n + 3552n;
    expect(committed.json.session.balanceChips).toBe(expectedBalance.toString());
    expect(settled.balanceAfterChips).toBe(expectedBalance.toString());

    // 5. The celebration gate — one comparison, and this round is above it.
    expect(settled.presentation.celebrate).toBe(true);
    expect(settled.presentation.headline).toBe('Won 32.27');
    expect(settled.presentation.balanceCountsUp).toBe(true);

    // 6. The resolution track: no line is undecided past lock n-1, ever.
    expect(settled.resolution.settlementKnownAtLock).toBe(4);
    expect(settled.resolution.closeCarriesInformation).toBe(false);
    for (const line of settled.resolution.lines) {
      expect(line.lock).toBeGreaterThanOrEqual(1);
      expect(line.lock).toBeLessThanOrEqual(4);
    }
    // FIRST is decided the moment the bottom sphere seats.
    for (const line of settled.resolution.lines)
      if (line.code === 'first') expect(line.lock).toBe(1);

    // 7. Idempotency: the same ticket replays without debiting twice.
    const replay = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: round.roundId,
      clientSeed,
      lines: [...lines].reverse(),
    });
    expect(replay.status).toBe(200);
    expect(replay.json.replayed).toBe(true);
    expect(replay.json.session.balanceChips).toBe(expectedBalance.toString());
    expect(replay.json.round.ticket.ticketDigest).toBe(settled.ticket.ticketDigest);

    // 8. REVEAL: the seed is published and the round verifies by re-derivation.
    const revealed = await call('POST', `/api/session/${sessionId}/round/${round.roundId}/reveal`);
    expect(revealed.status).toBe(200);
    expect(revealed.json.serverSeed).toBe(SEED);
    expect(revealed.json.verification.ok).toBe(true);
    expect(revealed.json.verification.commitment).toBe(settled.transcript.commitment);
    expect(revealed.json.receiptVerification.ok).toBe(true);
    expect(revealed.json.receiptVerification.signatureChecked).toBe(true);

    // The receipt binds the round to the bet, in money terms.
    expect(revealed.json.round.receipt.totalStake).toBe('325');
    expect(revealed.json.round.receipt.credited).toBe('3552');
    expect(revealed.json.round.receipt.seedCommitment).toBe(round.seedCommitment);
    expect(revealed.json.round.receipt.signature).toMatch(/^[0-9a-f]{128}$/u);

    // The snapshot round-trips with money as integer strings.
    const snapshot = JSON.parse(revealed.json.snapshot as string);
    expect(snapshot.phase).toBe('SETTLED');
    expect(snapshot.settlement.credited).toBe('3552');
    expect(snapshot.playPolicyDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('reports a round that returned less than it cost as the loss it is', async () => {
    const sessionId = await newSession();
    app.store.forceNextSeed(SEED);
    const opened = await call('POST', `/api/session/${sessionId}/round/open`);
    const round = opened.json.round;
    const permutation = derivePermutation(SEED, GAMES.classic, {
      gameId: 'aether-order',
      variantId: 'classic',
      roundId: round.roundId,
      clientSeed: '',
      nonce: round.nonce,
    });

    // Twelve credits staked, one small BEFORE line home: 1.92 of 12.00.
    const lines = [
      { code: 'before', params: { a: permutation[0], b: permutation[1] }, stake: '100' },
      { code: 'first', params: { c: permutation[4] }, stake: '500' },
      { code: 'last', params: { c: permutation[0] }, stake: '500' },
      { code: 'podium', params: { a: permutation[4], b: permutation[3], c: permutation[2] }, stake: '100' },
    ];
    const committed = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: round.roundId,
      clientSeed: '',
      lines,
    });
    const settled = committed.json.round;
    expect(settled.settlement.totalStakeChips).toBe('1200');
    expect(settled.settlement.creditedChips).toBe('192');
    expect(settled.presentation.celebrate).toBe(false);
    expect(settled.presentation.headline).toBe('Returned 1.92 of 12.00');
    expect(settled.presentation.audio).toBe('none');
    expect(settled.presentation.multiplierStamp).toBe(false);
    expect(settled.presentation.balanceCountsUp).toBe(false);
    // Which line won is information the player is owed, and is never suppressed.
    expect(settled.presentation.lineLighting).toBe(true);
    expect(settled.lines.filter((line: any) => line.won).length).toBe(1);
  });
});

describe('pacing and the wallet', () => {
  it('refuses a COMMIT that arrives before the round-cycle floor', async () => {
    const sessionId = await newSession();
    const first = await call('POST', `/api/session/${sessionId}/round/open`);
    await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: first.json.round.roundId,
      clientSeed: '',
      lines: [{ code: 'first', params: { c: 0 }, stake: '25' }],
    });

    const second = await call('POST', `/api/session/${sessionId}/round/open`);
    const early = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: second.json.round.roundId,
      clientSeed: '',
      lines: [{ code: 'first', params: { c: 1 }, stake: '25' }],
    });
    expect(early.status).toBe(429);
    expect(early.json.error.code).toBe('CYCLE_FLOOR');
    // A refused commit is a hard no bet: the stake is unspent.
    const state = await call('GET', `/api/session/${sessionId}`);
    expect(state.json.session.commitAvailableInMs).toBeGreaterThan(0);

    now += 2_500;
    const allowed = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: second.json.round.roundId,
      clientSeed: '',
      lines: [{ code: 'first', params: { c: 1 }, stake: '25' }],
    });
    expect(allowed.status).toBe(200);
    expect(allowed.json.round.phase).toBe('SETTLED');
  });

  it('declines a ticket the balance does not cover, and stakes nothing', async () => {
    const sessionId = await newSession();
    const session = app.store.get(sessionId);
    session.balanceChips = 100n;
    const opened = await call('POST', `/api/session/${sessionId}/round/open`);
    const declined = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: opened.json.round.roundId,
      clientSeed: '',
      lines: [{ code: 'first', params: { c: 0 }, stake: '500' }],
    });
    expect(declined.status).toBe(402);
    expect(declined.json.error.code).toBe('WALLET_DECLINED');
    expect(app.store.get(sessionId).balanceChips).toBe(100n);
  });

  it('stops betting at a loss limit the player set', async () => {
    const sessionId = await newSession();
    await call('POST', `/api/session/${sessionId}/settings`, { lossChips: '100' });
    const opened = await call('POST', `/api/session/${sessionId}/round/open`);
    const refused = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: opened.json.round.roundId,
      clientSeed: '',
      lines: [{ code: 'first', params: { c: 0 }, stake: '500' }],
    });
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe('LIMIT_REACHED');
  });

  it('only lets a reality-check interval tighten, and only to a published option', async () => {
    const sessionId = await newSession();
    const ok = await call('POST', `/api/session/${sessionId}/settings`, {
      playerRealityCheckMinutes: 15,
    });
    expect(ok.json.session.playerRealityCheckMinutes).toBe(15);
    const loosened = await call('POST', `/api/session/${sessionId}/settings`, {
      playerRealityCheckMinutes: 120,
    });
    expect(loosened.status).toBe(400);
  });
});

describe('hostile tickets', () => {
  const cases: [string, unknown, string][] = [
    [
      'a repeated claim spelled two ways',
      [
        { code: 'first', params: { c: 0 }, stake: '25' },
        { code: 'slot', params: { c: 0, k: 0 }, stake: '25' },
      ],
      'DUPLICATE_LINE',
    ],
    ['an unknown bet code', [{ code: 'jackpot', params: { c: 0 }, stake: '25' }], 'UNKNOWN_BET'],
    [
      'parameters that are not a legal instance',
      [{ code: 'slot', params: { c: 0, k: 9 }, stake: '25' }],
      'UNKNOWN_INSTANCE',
    ],
    [
      'a stake off the quantum',
      [{ code: 'first', params: { c: 0 }, stake: '30' }],
      'INVALID_TICKET',
    ],
    [
      'a stake above the per-line ceiling',
      [{ code: 'first', params: { c: 0 }, stake: '5025' }],
      'INVALID_TICKET',
    ],
    ['a float on a money path', [{ code: 'first', params: { c: 0 }, stake: 1.5 }], 'INVALID_TICKET'],
    ['no lines at all', [], 'INVALID_TICKET'],
  ];

  for (const [name, lines, code] of cases)
    it(`rejects ${name} with ${code}`, async () => {
      const sessionId = await newSession();
      const quoted = await call('POST', `/api/session/${sessionId}/ticket/quote`, { lines });
      expect(quoted.status).toBeGreaterThanOrEqual(400);
      expect(quoted.json.error.code).toBe(code);
    });

  it('rejects a thirteenth distinct claim', async () => {
    const sessionId = await newSession();
    const lines = Array.from({ length: 13 }, (_unused, index) => ({
      code: 'slot',
      params: { c: index % 5, k: Math.floor(index / 5) },
      stake: '25',
    }));
    const quoted = await call('POST', `/api/session/${sessionId}/ticket/quote`, { lines });
    expect(quoted.status).toBe(400);
    expect(quoted.json.error.code).toBe('INVALID_TICKET');
  });
});

describe('SEVEN', () => {
  it('re-prices every multiplier except BEFORE and pays them', async () => {
    const sessionId = await newSession();
    await call('POST', `/api/session/${sessionId}/settings`, { variantId: 'seven' });
    app.store.forceNextSeed(SEED);
    const opened = await call('POST', `/api/session/${sessionId}/round/open`);
    const round = opened.json.round;
    expect(round.variantId).toBe('seven');
    const permutation = derivePermutation(SEED, GAMES.seven, {
      gameId: 'aether-order',
      variantId: 'seven',
      roundId: round.roundId,
      clientSeed: '',
      nonce: round.nonce,
    });
    const lines = [
      { code: 'first', params: { c: permutation[0] }, stake: '100' }, // 6.72x
      { code: 'before', params: { a: permutation[0], b: permutation[1] }, stake: '100' }, // 1.92x
    ];
    const committed = await call('POST', `/api/session/${sessionId}/round/commit`, {
      roundId: round.roundId,
      clientSeed: '',
      lines,
    });
    expect(committed.json.round.settlement.grossChips).toBe('864'); // 6.72 + 1.92
    expect(committed.json.round.resolution.settlementKnownAtLock).toBe(6);
  });
});
