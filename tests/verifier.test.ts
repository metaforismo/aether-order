/**
 * The client verifier is a second implementation, and this is the test that
 * makes that claim mean something.
 *
 * docs/ENGINE.md §10's porting checklist: "reproduce `encodeFields` byte for
 * byte, keep the domain tags and field order in §7 identical ... If a single
 * commitment digest differs, the port is wrong." The browser verifier shares no
 * code with the engine — it is WebCrypto plus about two hundred lines — so
 * agreement here is evidence rather than a tautology, and disagreement is a
 * build failure rather than a "verified locally" chip that lies.
 */

import { describe, expect, it } from 'vitest';
import {
  derivePermutation as engineDerive,
  ed25519KeyPairFromSeed,
  makePermutationTranscript,
  makeReceipt,
  openTicket,
  seedCommitment as engineSeedCommitment,
  settleTicket,
  settlementDigest,
  signReceipt,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { GAMES } from '../src/server/engine.js';
import {
  bytesToHex,
  derivePermutation,
  encodeFields,
  seedCommitment,
  settlementDigestOf,
  ticketDigestOf,
  transcriptCommitment,
  verifyReceiptLocally,
  verifyTranscriptLocally,
  type ReceiptLike,
  type TranscriptLike,
} from '../src/client/verify.js';

const wire = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString(10) : item,
    ),
  ) as T;

const CONTEXTS = [
  { variantId: 'classic' as const, roundId: 'r-0', clientSeed: '', nonce: 0 },
  { variantId: 'classic' as const, roundId: 'a-very-long-round-id-000000001', clientSeed: 'hello', nonce: 42 },
  // Printable ASCII is the whole of the legal client-seed alphabet
  // (docs/ENGINE.md §6), so the awkward case is punctuation, not Unicode.
  { variantId: 'classic' as const, roundId: 'r-2', clientSeed: ' ~!@#$%^&*() {}[]|\\"\'', nonce: 7 },
  { variantId: 'seven' as const, roundId: 'r-3', clientSeed: 'seven', nonce: 5040 },
];

const SEEDS = ['00'.repeat(32), 'a1'.repeat(32), 'ff'.repeat(32), '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0'];

describe('canonical encoding', () => {
  it('frames fields so no two vectors can collide', () => {
    const left = bytesToHex(encodeFields(['ab', 'c']));
    const right = bytesToHex(encodeFields(['a', 'bc']));
    expect(left).not.toBe(right);
    // uint32 field count, then uint32 length + bytes per field.
    expect(bytesToHex(encodeFields(['a']))).toBe('0000000100000001' + '61');
  });

  it('encodes numbers and bigints as base-10 ASCII, like the engine', () => {
    expect(bytesToHex(encodeFields([7]))).toBe(bytesToHex(encodeFields([7n])));
    expect(bytesToHex(encodeFields([7]))).toBe(bytesToHex(encodeFields(['7'])));
  });
});

describe('derivation, against the engine', () => {
  for (const seed of SEEDS)
    for (const context of CONTEXTS)
      it(`agrees for ${context.variantId} ${context.roundId} under ${seed.slice(0, 8)}`, async () => {
        const game = GAMES[context.variantId];
        const expected = engineDerive(seed, game, { gameId: game.id, ...context });
        const actual = await derivePermutation(seed, game.n, {
          gameId: game.id,
          ...context,
        });
        expect(actual).toEqual([...expected]);

        expect(await seedCommitment(seed, context)).toBe(engineSeedCommitment(seed, context));

        const transcript = makePermutationTranscript(seed, game, { gameId: game.id, ...context });
        expect(await transcriptCommitment(seed, wire(transcript) as TranscriptLike)).toBe(
          transcript.commitment,
        );
      });
});

describe('verifyTranscriptLocally', () => {
  const game = GAMES.classic;
  const seed = SEEDS[1] as string;
  const context = { gameId: game.id, variantId: 'classic', roundId: 'verify-1', clientSeed: 'x', nonce: 3 };
  const transcript = makePermutationTranscript(seed, game, context);

  it('passes on the honest round', async () => {
    const result = await verifyTranscriptLocally(seed, wire(transcript) as TranscriptLike);
    expect(result.ok).toBe(true);
    expect(result.commitment).toBe(transcript.commitment);
  });

  it('rejects a tampered permutation', async () => {
    const tampered = wire(transcript) as TranscriptLike;
    tampered.permutation = [...transcript.permutation].reverse();
    const result = await verifyTranscriptLocally(seed, tampered);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TRANSCRIPT_MISMATCH');
  });

  it('rejects a wrong revealed seed', async () => {
    const result = await verifyTranscriptLocally(SEEDS[2] as string, wire(transcript) as TranscriptLike);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TRANSCRIPT_MISMATCH');
  });

  it('rejects a mutated client seed, nonce or previous commitment', async () => {
    for (const mutate of [
      (value: TranscriptLike) => (value.clientSeed = 'y'),
      (value: TranscriptLike) => (value.nonce = 4),
      (value: TranscriptLike) => (value.previousCommitment = 'f'.repeat(64)),
    ]) {
      const mutated = wire(transcript) as TranscriptLike;
      mutate(mutated);
      const result = await verifyTranscriptLocally(seed, mutated);
      expect(result.ok).toBe(false);
    }
  });

  it('fails closed on a missing seed commitment rather than skipping the check', async () => {
    const stripped = wire(transcript) as TranscriptLike;
    (stripped as unknown as Record<string, unknown>).seedCommitment = undefined;
    const result = await verifyTranscriptLocally(seed, stripped);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSCRIPT');
  });

  it('fails closed on an unknown schema', async () => {
    const future = wire(transcript) as TranscriptLike;
    future.schema = 'reveal-engine/permutation-transcript-v2';
    const result = await verifyTranscriptLocally(seed, future);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNSUPPORTED_VERSION');
  });
});

describe('the verifier rejects what the engine rejects', () => {
  const game = GAMES.classic;
  const seed = SEEDS[1] as string;
  const context = {
    gameId: game.id,
    variantId: 'classic',
    roundId: 'adapter-1',
    clientSeed: '',
    nonce: 1,
  };
  const transcript = makePermutationTranscript(seed, game, context);
  const adapter = {
    gameId: game.id,
    adapterVersion: game.adapterVersion,
    adapterFingerprint: transcript.adapterFingerprint,
    n: game.n,
  };

  it('accepts the honest round under the adapter it holds', async () => {
    const result = await verifyTranscriptLocally(seed, wire(transcript) as TranscriptLike, adapter);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['gameId', (value: TranscriptLike) => (value.gameId = 'other-game')],
    ['adapterVersion', (value: TranscriptLike) => (value.adapterVersion = '9.9.9')],
    ['adapterFingerprint', (value: TranscriptLike) => (value.adapterFingerprint = 'f'.repeat(64))],
  ])('rejects a transcript from another adapter (%s)', async (_name, mutate) => {
    const mutated = wire(transcript) as TranscriptLike;
    mutate(mutated);
    const result = await verifyTranscriptLocally(seed, mutated, adapter);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ADAPTER_MISMATCH');
  });

  it('rejects a permutation that is not one — even with a matching commitment', async () => {
    // The attack the check exists for: an internally consistent transcript that
    // is not a legal round. Both hashes are recomputed from the forgery, so the
    // only thing standing between it and a gold "verified locally" chip is
    // §7.10's structural validation.
    for (const permutation of [[], [0, 0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3, 5]]) {
      const forged = wire(transcript) as TranscriptLike;
      forged.permutation = permutation as number[];
      const result = await verifyTranscriptLocally(seed, forged, adapter);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_TRANSCRIPT');
    }
  });

  it('rejects a transcript with an impossible element count', async () => {
    const forged = wire(transcript) as TranscriptLike;
    forged.n = 0;
    forged.permutation = [];
    const result = await verifyTranscriptLocally(seed, forged);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSCRIPT');
  });
});

describe('verifyReceiptLocally — a tri-state, and only one of the three is a pass', () => {
  const game = GAMES.classic;
  const seed = SEEDS[3] as string;
  const context = {
    gameId: game.id,
    variantId: 'classic',
    roundId: 'receipt-1',
    clientSeed: 'r',
    nonce: 11,
  };
  const transcript = makePermutationTranscript(seed, game, context);
  const ticket = openTicket(
    game,
    { variantId: 'classic', roundId: context.roundId, nonce: context.nonce },
    { lines: [{ code: 'first', params: { c: transcript.permutation[0] as number }, stake: 100n }] },
  );
  const settlement = settleTicket(game, transcript, ticket);
  const keyPair = ed25519KeyPairFromSeed('bb'.repeat(32));
  const receipt = signReceipt(
    makeReceipt({ transcript, ticket, settlement, signerId: 'test-operator' }),
    keyPair.privateKey,
  );

  it('verifies a signed receipt against the operator key', async () => {
    const result = await verifyReceiptLocally(
      wire(receipt) as unknown as ReceiptLike,
      wire(transcript) as TranscriptLike,
      keyPair.publicKeyHex,
    );
    expect(result.ok).toBe(true);
    expect(result.state).toBe('verified');
    expect(result.digest).toBe(receipt.digest);
  });

  it('returns ok:false with bindingsVerified:true when no key is available', async () => {
    const result = await verifyReceiptLocally(
      wire(receipt) as unknown as ReceiptLike,
      wire(transcript) as TranscriptLike,
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SIGNATURE_UNCHECKED');
    expect(result.bindingsVerified).toBe(true);
    expect(result.signatureChecked).toBe(false);
    expect(result.state).toBe('unchecked');
  });

  it('rejects a receipt whose money was edited after signing', async () => {
    const edited = wire(receipt) as unknown as ReceiptLike;
    edited.totalStake = '25';
    const result = await verifyReceiptLocally(
      edited,
      wire(transcript) as TranscriptLike,
      keyPair.publicKeyHex,
    );
    expect(result.ok).toBe(false);
    expect(result.state).toBe('mismatch');
  });

  it('rejects a receipt bound to another round', async () => {
    const other = makePermutationTranscript(seed, game, { ...context, roundId: 'receipt-2' });
    const result = await verifyReceiptLocally(
      wire(receipt) as unknown as ReceiptLike,
      wire(other) as TranscriptLike,
      keyPair.publicKeyHex,
    );
    expect(result.ok).toBe(false);
    expect(result.state).toBe('mismatch');
  });

  /*
   * The receipt exists to bind the round to THE BET. A verifier that only
   * recomputes the receipt's own digest proves the receipt is self-consistent
   * and says nothing about the settlement on screen beside it — so a valid
   * signed receipt could sit under a payout figure it does not cover.
   */
  describe('bound to the ticket and settlement on screen', () => {
    const displayedLines = settlement.lines.map((line) => ({
      code: line.code,
      params: line.params as Record<string, unknown>,
      stakeChips: line.stake.toString(10),
      won: line.won,
      grossChips: line.gross.toString(10),
    }));
    const displayedSettlement = {
      totalStakeChips: settlement.totalStake.toString(10),
      grossChips: settlement.gross.toString(10),
      creditedChips: settlement.credited.toString(10),
      netChips: settlement.net.toString(10),
      capped: settlement.capped,
    };

    it('recomputes both digests and passes on the real ticket', async () => {
      const result = await verifyReceiptLocally(
        wire(receipt) as unknown as ReceiptLike,
        wire(transcript) as TranscriptLike,
        keyPair.publicKeyHex,
        { lines: displayedLines, settlement: displayedSettlement },
      );
      expect(result.ok).toBe(true);
      expect(result.state).toBe('verified');
    });

    it('rejects an inflated payout under a genuine signature', async () => {
      const result = await verifyReceiptLocally(
        wire(receipt) as unknown as ReceiptLike,
        wire(transcript) as TranscriptLike,
        keyPair.publicKeyHex,
        {
          lines: displayedLines,
          settlement: { ...displayedSettlement, creditedChips: '99999' },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.state).toBe('mismatch');
      expect(result.path).toBe('$.settlementDigest');
    });

    it('rejects a ticket line that was edited after settlement', async () => {
      const edited = displayedLines.map((line) => ({ ...line, stakeChips: '5000' }));
      const result = await verifyReceiptLocally(
        wire(receipt) as unknown as ReceiptLike,
        wire(transcript) as TranscriptLike,
        keyPair.publicKeyHex,
        { lines: edited, settlement: displayedSettlement },
      );
      expect(result.ok).toBe(false);
      expect(result.path).toBe('$.ticketDigest');
    });

    it('agrees with the engine on both digests', async () => {
      const identity = {
        gameId: game.id,
        variantId: game.variantId,
        roundId: context.roundId,
        nonce: context.nonce,
      };
      expect(await ticketDigestOf(identity, displayedLines)).toBe(ticket.ticketDigest);
      expect(await settlementDigestOf(identity, displayedSettlement, displayedLines)).toBe(
        settlementDigest(game, settlement),
      );
    });
  });
});
