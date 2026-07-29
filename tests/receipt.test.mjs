/**
 * The ticket half of the fairness model.
 *
 * Commit-reveal covers the draw. These tests cover the thing it does not: the
 * binding between a round and the bet that was placed on it. If a player can
 * prove the permutation was honest but cannot prove what they staked, the
 * fairness story has a hole in it, and docs/ENGINE.md §6.1 says so explicitly.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AetherOrderError,
  deserializeRoundSnapshot,
  deserializeTranscript,
  ed25519KeyPairFromSeed,
  idempotencyKeyFor,
  makeReceipt,
  makeRoundSnapshot,
  makeTranscript,
  openTicket,
  serializeRoundSnapshot,
  serializeTranscript,
  settleTicket,
  signReceipt,
  ticketDigest,
  verifyReceipt,
} from '../tools/lib/derive.mjs';
import { LIMITS, VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';
import { fullOrderParamsByRank } from '../tools/lib/bets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'transcripts.json'), 'utf8'));

const SEED = 'ab'.repeat(32);
const KEY = ed25519KeyPairFromSeed('11'.repeat(32));
const OTHER_KEY = ed25519KeyPairFromSeed('22'.repeat(32));

function round(variantId, overrides = {}) {
  const { n } = getVariant(variantId);
  const context = { variantId, roundId: 'r-receipt', clientSeed: 'axiom', nonce: 3, ...overrides };
  const transcript = makeTranscript(SEED, context);
  const ticket = {
    lines: [
      { code: 'first', params: { c: transcript.permutation[0] }, stakeChips: 100n },
      { code: 'before', params: { a: 0, b: 1 }, stakeChips: 50n },
      { code: 'slot', params: { c: transcript.permutation[n - 1], k: n - 1 }, stakeChips: 25n },
    ],
  };
  const settlement = settleTicket(transcript, ticket);
  const receipt = signReceipt(
    makeReceipt({ transcript, ticket, settlement, signerId: 'axiom-games/test' }),
    KEY.privateKey,
  );
  return { context, transcript, ticket, settlement, receipt, n };
}

describe.each(VARIANT_IDS)('openTicket — %s', (variantId) => {
  const { context, ticket, n } = round(variantId);
  const seedContext = { variantId, roundId: context.roundId, nonce: context.nonce };

  it('returns lines in canonical order with a derived idempotency key', () => {
    const opened = openTicket(seedContext, ticket);
    expect(opened.lines.map((line) => line.code)).toEqual(['before', 'first', 'slot']);
    expect(opened.totalStakeChips).toBe(175n);
    expect(opened.idempotencyKey).toBe(idempotencyKeyFor('open', opened.ticketDigest));
    expect(opened.ticketDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is stable under line reordering — a retry cannot double-debit', () => {
    const forward = openTicket(seedContext, ticket);
    const reversed = openTicket(seedContext, { lines: [...ticket.lines].reverse() });
    expect(reversed.ticketDigest).toBe(forward.ticketDigest);
    expect(reversed.idempotencyKey).toBe(forward.idempotencyKey);
  });

  it('separates the open and settle actions so one cannot replay as the other', () => {
    const opened = openTicket(seedContext, ticket);
    expect(idempotencyKeyFor('settle', opened.ticketDigest)).not.toBe(opened.idempotencyKey);
    expect(() => idempotencyKeyFor('void', opened.ticketDigest)).toThrow(AetherOrderError);
  });

  it('changes the digest when any money or round field changes', () => {
    const base = openTicket(seedContext, ticket).ticketDigest;
    const restaked = {
      lines: ticket.lines.map((line, index) => (index === 0 ? { ...line, stakeChips: 125n } : line)),
    };
    expect(openTicket(seedContext, restaked).ticketDigest).not.toBe(base);
    expect(openTicket({ ...seedContext, roundId: 'r-other' }, ticket).ticketDigest).not.toBe(base);
    expect(openTicket({ ...seedContext, nonce: 4 }, ticket).ticketDigest).not.toBe(base);
  });

  it('applies the full risk policy, not a relaxed one', () => {
    expect(() => openTicket(seedContext, { lines: [] })).toThrow(AetherOrderError);
    expect(() =>
      openTicket(seedContext, {
        lines: [
          { code: 'first', params: { c: 0 }, stakeChips: 100n },
          { code: 'slot', params: { c: 0, k: 0 }, stakeChips: 100n },
        ],
      }),
    ).toThrow(/same claim twice/u);
    expect(() =>
      openTicket(seedContext, { lines: [{ code: 'first', params: { c: 0 }, stakeChips: 30n }] }),
    ).toThrow(/stake quantum/u);
    expect(() =>
      openTicket(seedContext, {
        lines: Array.from({ length: LIMITS.maxLinesPerTicket + 1 }, (_, i) => ({
          code: 'full',
          params: fullOrderParamsByRank(n, i),
          stakeChips: 25n,
        })),
      }),
    ).toThrow(/line limit/u);
  });

  it('rejects a hostile ticket that answers `length` and `map` differently', () => {
    const lines = [{ code: 'first', params: { c: 0 }, stakeChips: 25n }];
    lines.map = () =>
      Array.from({ length: 40 }, (_, i) => ({ code: 'full', params: fullOrderParamsByRank(n, i), stakeChips: 5000n }));
    // slice() reads length and indices directly, so the smuggled `map` is never
    // consulted and the ticket settles as the single line it declared.
    expect(openTicket(seedContext, { lines }).lines).toHaveLength(1);
  });
});

describe.each(VARIANT_IDS)('receipts — %s', (variantId) => {
  const { transcript, ticket, settlement, receipt } = round(variantId);

  it('verifies against its own round, ticket and settlement', () => {
    const result = verifyReceipt(receipt, { transcript, ticket, settlement, publicKey: KEY.publicKey });
    expect(result.ok).toBe(true);
    expect(result.signatureChecked).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.digest).toBe(receipt.digest);
  });

  it('does NOT pass when no operator key is supplied, however intact the bindings', () => {
    // The round-4 defect. This path returned ok:true with signatureChecked:false
    // beside it, so a caller branching on `.ok` — which is what every other path
    // here answers with — accepted a receipt whose signature was never checked,
    // including one whose `signature` was null. The receipt is the only thing
    // binding the bet to the round; unsigned it proves nothing about the stake.
    const result = verifyReceipt(receipt, { transcript, ticket, settlement });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SIGNATURE_UNCHECKED');
    expect(result.signatureChecked).toBe(false);
    expect(result.signatureValid).toBeNull();
    // The bindings really were all checked, and that is a different field.
    expect(result.bindingsVerified).toBe(true);
    expect(result.digest).toBe(receipt.digest);
  });

  it('an unsigned receipt cannot reach even the bindings-verified state', () => {
    const unsigned = makeReceipt({ transcript, ticket, settlement, signerId: 'axiom-games/test' });
    const withKey = verifyReceipt(unsigned, { transcript, ticket, settlement, publicKey: KEY.publicKey });
    expect(withKey.ok).toBe(false);
    // And with no key at all it is the same answer as a signed one would get:
    // not ok. Nothing about `signature: null` may soften the verdict.
    const withoutKey = verifyReceipt(unsigned, { transcript, ticket, settlement });
    expect(withoutKey.ok).toBe(false);
    expect(withoutKey.code).toBe('SIGNATURE_UNCHECKED');
  });

  it('every failure path reports whether the bindings were checked', () => {
    const results = [
      verifyReceipt(receipt, { transcript, ticket, settlement }),
      verifyReceipt(receipt, { transcript, ticket, settlement, publicKey: OTHER_KEY.publicKey }),
      verifyReceipt({ ...receipt, gameId: 'other-game' }, { transcript, ticket, settlement }),
    ];
    for (const result of results) {
      expect(typeof result.bindingsVerified, JSON.stringify(result)).toBe('boolean');
      expect(result.ok).toBe(false);
    }
    // A wrong adapter is rejected before any binding is recomputed.
    expect(results[2].bindingsVerified).toBe(false);
    // A wrong key means the bindings held and the signature did not.
    expect(results[1].bindingsVerified).toBe(true);
  });

  it('binds the pre-round publication and the round commitment', () => {
    expect(receipt.seedCommitment).toBe(transcript.seedCommitment);
    expect(receipt.commitment).toBe(transcript.commitment);
    const swapped = { ...transcript, commitment: 'f'.repeat(64) };
    const result = verifyReceipt(receipt, { transcript: swapped, ticket, settlement });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMITMENT_MISMATCH');
  });

  it('rejects a ticket whose stake was edited after signing', () => {
    const restaked = {
      lines: ticket.lines.map((line, index) => (index === 0 ? { ...line, stakeChips: 5000n } : line)),
    };
    const result = verifyReceipt(receipt, { transcript, ticket: restaked, settlement, publicKey: KEY.publicKey });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('$.ticketDigest');
  });

  it('rejects a ticket with a line swapped for a different bet', () => {
    const swapped = {
      lines: [...ticket.lines.slice(1), { code: 'last', params: { c: 1 }, stakeChips: 100n }],
    };
    const result = verifyReceipt(receipt, { transcript, ticket: swapped, settlement, publicKey: KEY.publicKey });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('$.ticketDigest');
  });

  it('rejects an edited settlement', () => {
    const inflated = { ...settlement, creditedChips: settlement.creditedChips + 100n };
    const result = verifyReceipt(receipt, { transcript, ticket, settlement: inflated });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('$.settlementDigest');
  });

  it('rejects a flipped won flag even when the totals are left alone', () => {
    const flipped = {
      ...settlement,
      lines: settlement.lines.map((line, index) => (index === 0 ? { ...line, won: !line.won } : line)),
    };
    const result = verifyReceipt(receipt, { transcript, ticket, settlement: flipped });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('$.settlementDigest');
  });

  it('rejects a receipt whose own money fields were rewritten', () => {
    const lying = { ...receipt, creditedChips: receipt.creditedChips + 1000n };
    const result = verifyReceipt(lying, { transcript, ticket, settlement, publicKey: KEY.publicKey });
    expect(result.ok).toBe(false);
  });

  it('rejects a receipt whose digest does not cover its own fields', () => {
    const lying = { ...receipt, signerId: 'someone-else' };
    const result = verifyReceipt(lying, { transcript, ticket, settlement });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('$.digest');
  });

  it('rejects a valid receipt from a round it does not describe', () => {
    const other = makeTranscript(SEED, { variantId, roundId: 'r-elsewhere', clientSeed: 'axiom', nonce: 3 });
    const result = verifyReceipt(receipt, { transcript: other, ticket, settlement });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TRANSCRIPT_MISMATCH');
  });

  it('rejects a signature from the wrong operator key', () => {
    const result = verifyReceipt(receipt, { transcript, ticket, settlement, publicKey: OTHER_KEY.publicKey });
    expect(result.ok).toBe(false);
    expect(result.signatureChecked).toBe(true);
    expect(result.signatureValid).toBe(false);
  });

  it('rejects an unsigned receipt when a key is supplied', () => {
    const unsigned = makeReceipt({ transcript, ticket, settlement, signerId: 'axiom-games/test' });
    expect(unsigned.signature).toBeNull();
    const result = verifyReceipt(unsigned, { transcript, ticket, settlement, publicKey: KEY.publicKey });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('$.signature');
  });

  it.each([
    ['schema', { schema: 'something/else' }, 'UNSUPPORTED_VERSION'],
    ['moduleVersion', { moduleVersion: 'v0' }, 'UNSUPPORTED_VERSION'],
    ['gameId', { gameId: 'other-game' }, 'ADAPTER_MISMATCH'],
    ['adapterFingerprint', { adapterFingerprint: '0'.repeat(64) }, 'ADAPTER_MISMATCH'],
  ])('fails closed on a wrong %s', (_field, patch, code) => {
    const result = verifyReceipt({ ...receipt, ...patch }, { transcript, ticket, settlement });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
  });

  it('rejects hostile signer ids', () => {
    for (const signerId of ['', 'a'.repeat(200), 'tab\there', '‮evil']) {
      expect(() => makeReceipt({ transcript, ticket, settlement, signerId })).toThrow(AetherOrderError);
    }
  });

  it('is deterministic — the same round signs to the same bytes twice', () => {
    const again = signReceipt(
      makeReceipt({ transcript, ticket, settlement, signerId: 'axiom-games/test' }),
      KEY.privateKey,
    );
    expect(again.signature).toBe(receipt.signature);
    expect(again.digest).toBe(receipt.digest);
  });

  it('ticketDigest revalidates rather than trusting a pre-blessed object', () => {
    const seedContext = { variantId, roundId: transcript.roundId, nonce: transcript.nonce };
    const opened = openTicket(seedContext, ticket);
    expect(ticketDigest(seedContext, opened)).toBe(opened.ticketDigest);
    expect(() => ticketDigest(seedContext, { ...opened, lines: [] })).toThrow(AetherOrderError);
  });
});

describe('frozen wire-format fixtures', () => {
  it('every fixture receipt still verifies, byte for byte', () => {
    // The fixture key is DERIVED from a published label, never stored, so a
    // regenerated fixture cannot quietly move to a different signer.
    const operator = ed25519KeyPairFromSeed(fixtureSeed());
    expect(operator.publicKeyHex).toBe(FIXTURES.operatorPublicKey);

    for (const vector of FIXTURES.vectors) {
      const transcript = vector.transcript;
      const ticket = { lines: vector.ticket.lines.map((line) => ({ ...line, stakeChips: BigInt(line.stakeChips) })) };
      const settlement = settleTicket(transcript, ticket);
      const receipt = { ...vector.receipt, totalStakeChips: BigInt(vector.receipt.totalStakeChips), creditedChips: BigInt(vector.receipt.creditedChips) };

      expect(settlement.creditedChips).toBe(BigInt(vector.settlement.creditedChips));
      expect(settlement.totalStakeChips).toBe(BigInt(vector.settlement.totalStakeChips));

      const result = verifyReceipt(receipt, { transcript, ticket, settlement, publicKey: operator.publicKey });
      expect(result.ok, `${vector.context.roundId}: ${result.message ?? ''}`).toBe(true);
      expect(result.signatureValid).toBe(true);
    }
  });

  it('covers both variants and chains its commitments', () => {
    expect(FIXTURES.vectors).toHaveLength(8);
    expect(new Set(FIXTURES.vectors.map((v) => v.context.variantId))).toEqual(new Set(VARIANT_IDS));
  });
});

/** The fixture operator seed, recomputed the same way tools/enumerate.mjs does. */
function fixtureSeed() {
  return createHash('sha256').update('aether-order/fixture/operator-key').digest('hex');
}

describe('wire serialisation', () => {
  const { transcript, ticket, settlement, receipt, context } = round('classic');

  it('round-trips a transcript through canonical JSON', () => {
    const json = serializeTranscript(transcript);
    const back = deserializeTranscript(json);
    expect(back).toEqual(transcript);
    expect(serializeTranscript(back)).toBe(json);
  });

  it('drops unknown fields rather than carrying them past a verifier', () => {
    const back = deserializeTranscript({ ...transcript, extra: 'smuggled', permutation: [...transcript.permutation] });
    expect(back.extra).toBeUndefined();
  });

  it.each([
    ['a bad schema', { schema: 'x' }],
    ['a bad module version', { moduleVersion: 'x' }],
    ['a short permutation', { permutation: [0, 1] }],
    ['a repeated element', { permutation: [0, 0, 1, 2, 3] }],
    ['a non-hex commitment', { commitment: 'zz' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => deserializeTranscript({ ...transcript, permutation: [...transcript.permutation], ...patch })).toThrow(
      AetherOrderError,
    );
  });

  it('round-trips a settled snapshot and revives every money field as BigInt', () => {
    const opened = openTicket({ variantId: 'classic', roundId: context.roundId, nonce: context.nonce }, ticket);
    const snapshot = makeRoundSnapshot({
      phase: 'SETTLED',
      seedContext: { variantId: 'classic', roundId: context.roundId, nonce: context.nonce },
      seedCommitment: transcript.seedCommitment,
      transcript,
      ticket: opened,
      settlement,
      receipt,
    });
    const back = deserializeRoundSnapshot(serializeRoundSnapshot(snapshot));
    expect(back.phase).toBe('SETTLED');
    expect(back.ticket.totalStakeChips).toBe(opened.totalStakeChips);
    expect(typeof back.settlement.creditedChips).toBe('bigint');
    expect(back.settlement.creditedChips).toBe(settlement.creditedChips);
    for (const line of back.settlement.lines) expect(typeof line.stakeChips).toBe('bigint');
  });

  it('refuses a half-written snapshot', () => {
    const seedContext = { variantId: 'classic', roundId: context.roundId, nonce: context.nonce };
    expect(() =>
      makeRoundSnapshot({ phase: 'SETTLED', seedContext, seedCommitment: transcript.seedCommitment, ticket }),
    ).toThrow(AetherOrderError);
    expect(() =>
      makeRoundSnapshot({ phase: 'TICKETED', seedContext, seedCommitment: transcript.seedCommitment }),
    ).toThrow(AetherOrderError);
    expect(() =>
      makeRoundSnapshot({ phase: 'WHATEVER', seedContext, seedCommitment: transcript.seedCommitment }),
    ).toThrow(AetherOrderError);
  });

  it('rejects a snapshot whose money field is a float', () => {
    const snapshot = makeRoundSnapshot({
      phase: 'COMMITTED',
      seedContext: { variantId: 'classic', roundId: context.roundId, nonce: context.nonce },
      seedCommitment: transcript.seedCommitment,
    });
    const wire = JSON.parse(serializeRoundSnapshot(snapshot));
    wire.settlement = { creditedChips: '1.5' };
    expect(() => deserializeRoundSnapshot(wire)).toThrow(AetherOrderError);
  });
});
