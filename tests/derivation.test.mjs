/**
 * Derivation, commitment and verification.
 *
 * Frozen wire-format fixtures plus hostile-input handling. If a port of the
 * TypeScript module changes a single byte of the canonical encoding, the
 * fixture comparison fails here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { canonicalJson, encodeFields, sha256Hex } from '../tools/lib/canonical.mjs';
import { BET_FAMILIES, fullOrderParams, fullOrderParamsByRank } from '../tools/lib/bets.mjs';
import {
  allPermutations,
  factorial,
  orderKey,
  permutationRank,
  unrankPermutation,
} from '../tools/lib/permutations.mjs';
import {
  AetherOrderError,
  adapterFingerprint,
  catalogueDigest,
  claimSignature,
  digestCatalogue,
  derivePermutation,
  makeTranscript,
  normalizeServerSeed,
  openTicket,
  seedCommitment,
  settleTicket,
  ticketDigest,
  uniformBelow,
  verifyTranscript,
  ZERO_COMMITMENT,
} from '../tools/lib/derive.mjs';
import { ADAPTER_VERSION, LIMITS, VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'transcripts.json'), 'utf8'));

const SEED_A = 'a'.repeat(64);
const SEED_B = `${'0'.repeat(63)}1`;
const ctx = (over = {}) => ({ variantId: 'classic', roundId: 'r-1', clientSeed: 'axiom', nonce: 0, ...over });

/** Frozen: SHA-256 of encodeFields(['aether-order', 1n, 2]). */
const GOLDEN_FIELD_DIGEST = '20cde8918719d4e71c26b8d84c8aea5a0ae17c125ffa83bb81818ba4472a4754';

/* ------------------------------------------------------------------ *
 * The unranking FULL ORDER's parameterisation now depends on.          *
 *                                                                      *
 * `full` emits n! instances and each needs its order string. Building   *
 * the whole permutation table per call would put a 5,040-array          *
 * allocation on a path the resolution track walks at COMMIT, so the     *
 * family unranks instead — which is only safe if the unranking really   *
 * is the inverse of the ranking every other part of this repository     *
 * uses. Checked exhaustively, not spot-checked.                         *
 * ------------------------------------------------------------------ */

describe('unrankPermutation inverts permutationRank', () => {
  it.each(VARIANT_IDS)('%s: over the entire outcome space', (variantId) => {
    const { n } = getVariant(variantId);
    const all = allPermutations(n);
    for (let rank = 0; rank < all.length; rank += 1) {
      const unranked = unrankPermutation(n, rank);
      expect(unranked, `rank ${rank}`).toEqual(all[rank]);
      expect(permutationRank(unranked), `rank ${rank}`).toBe(rank);
    }
  });

  it('refuses a rank outside the space rather than wrapping', () => {
    expect(() => unrankPermutation(5, 120)).toThrow(RangeError);
    expect(() => unrankPermutation(5, -1)).toThrow(RangeError);
    expect(() => unrankPermutation(5, 1.5)).toThrow(RangeError);
  });

  it('orderKey stays decodable above nine elements', () => {
    // A bare digit string would stop being decodable at n > 9, and
    // PERMUTATION_LIMITS.maxElements is 12.
    expect(orderKey([11, 0, 10])).toBe('11-0-10');
    expect(orderKey([1, 10])).not.toBe(orderKey([11, 0]));
  });
});

/* ------------------------------------------------------------------ *
 * A FULL ORDER receipt has to be readable by the player who holds it.  *
 * ------------------------------------------------------------------ */

describe('FULL ORDER is spelled with the order, not with an opaque rank', () => {
  it.each(VARIANT_IDS)('%s: the digested parameters are the settled order', (variantId) => {
    const { n } = getVariant(variantId);
    const transcript = makeTranscript(SEED_A, ctx({ variantId, roundId: 'r-full' }));
    // The line that wins this round is spelled exactly as the transcript reads.
    const params = fullOrderParams(transcript.permutation);
    expect(params.order).toBe(transcript.permutation.join('-'));

    const seedContext = { variantId, roundId: transcript.roundId, nonce: transcript.nonce };
    const opened = openTicket(seedContext, {
      lines: [{ code: 'full', params, stakeChips: 25n }],
    });
    // What a player reads off their own ticket is the order, not an index.
    expect(opened.lines[0].params).toEqual({ order: transcript.permutation.join('-') });

    const settlement = settleTicket(transcript, { lines: [{ code: 'full', params, stakeChips: 25n }] });
    expect(settlement.lines[0].won).toBe(true);

    // And it is genuinely what the digest binds: a different order digests
    // differently, and the same order digests identically however it was built.
    const other = fullOrderParamsByRank(n, permutationRank(transcript.permutation) === 0 ? 1 : 0);
    expect(other.order).not.toBe(params.order);
    const otherDigest = ticketDigest(seedContext, { lines: [{ code: 'full', params: other, stakeChips: 25n }] });
    expect(otherDigest).not.toBe(opened.ticketDigest);
  });

  it('no instance in the catalogue still carries a rank parameter', () => {
    for (const variantId of VARIANT_IDS) {
      const { n } = getVariant(variantId);
      const family = BET_FAMILIES.find((candidate) => candidate.code === 'full');
      for (const instance of family.instances(n, { permutationCount: factorial(n) })) {
        expect(Object.keys(instance.params)).toEqual(['order']);
        expect(instance.label).toBe(`full:${instance.params.order}`);
      }
    }
  });

  it('the adapter version was bumped, because the change is replay-visible', () => {
    // canonicalParams is bound into the catalogue digest and thence into every
    // commitment, so docs/ENGINE.md §2 requires a new adapterVersion.
    expect(ADAPTER_VERSION).not.toBe('1.1.0');
    const published = JSON.parse(readFileSync(join(ROOT, 'docs', 'paytable.json'), 'utf8'));
    expect(published.adapterVersion).toBe(ADAPTER_VERSION);
  });

  it('docs/paytable.json publishes the element table those indices refer to', () => {
    const published = JSON.parse(readFileSync(join(ROOT, 'docs', 'paytable.json'), 'utf8'));
    for (const variantId of VARIANT_IDS) {
      const variant = getVariant(variantId);
      const elements = published.variants[variantId].elements;
      expect(elements).toHaveLength(variant.n);
      elements.forEach((element, index) => {
        expect(element.index).toBe(index);
        expect(element.id).toBe(variant.elements[index].id);
        expect(element.hex).toBe(variant.elements[index].hex);
      });
    }
  });
});

describe('frozen wire-format fixtures', () => {
  it('carries vectors for every variant', () => {
    expect(FIXTURES.vectors.length).toBeGreaterThanOrEqual(VARIANT_IDS.length * 4);
    for (const variantId of VARIANT_IDS) {
      expect(FIXTURES.vectors.some((vector) => vector.context.variantId === variantId)).toBe(true);
    }
  });

  it.each(FIXTURES.vectors.map((vector, index) => [index, vector]))(
    'vector %i re-derives byte-for-byte',
    (_index, vector) => {
      const rebuilt = makeTranscript(vector.serverSeed, vector.context, vector.transcript.previousCommitment);
      expect(canonicalJson(rebuilt)).toBe(canonicalJson(vector.transcript));
      expect(rebuilt.commitment).toBe(vector.transcript.commitment);
      expect(rebuilt.seedCommitment).toBe(vector.transcript.seedCommitment);
      expect(rebuilt.permutation).toEqual(vector.transcript.permutation);
    },
  );

  it.each(FIXTURES.vectors.map((vector, index) => [index, vector]))('vector %i verifies', (_index, vector) => {
    expect(verifyTranscript(vector.serverSeed, vector.transcript)).toEqual({
      ok: true,
      commitment: vector.transcript.commitment,
    });
  });

  it('chains rounds: each transcript binds the previous commitment', () => {
    const byVariant = new Map();
    for (const vector of FIXTURES.vectors) {
      const chain = byVariant.get(vector.context.variantId) ?? [];
      chain.push(vector);
      byVariant.set(vector.context.variantId, chain);
    }
    expect(byVariant.size).toBe(VARIANT_IDS.length);
    for (const chain of byVariant.values()) {
      expect(chain.length).toBeGreaterThan(1);
      expect(chain[0].transcript.previousCommitment).toBe(ZERO_COMMITMENT);
      for (let i = 1; i < chain.length; i += 1) {
        expect(chain[i].transcript.previousCommitment).toBe(chain[i - 1].transcript.commitment);
      }
    }
  });

  it('a broken chain link fails verification', () => {
    const [, second] = FIXTURES.vectors;
    const forged = { ...second.transcript, previousCommitment: ZERO_COMMITMENT };
    const result = verifyTranscript(second.serverSeed, forged);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMITMENT_MISMATCH');
  });

  /**
   * The oracle has to cover the shapes it is the oracle FOR.
   *
   * docs/ENGINE.md §10 designates these vectors as the port-conformance test:
   * "If a single commitment digest differs, the port is wrong." Round 4 froze
   * eight vectors of one shape — three lines, always first/before/slot, always
   * 175 chips — so eight of eleven codes never appeared, the whole ORDER tier
   * was absent, and nothing froze the ticket, settlement or receipt encoding for
   * `full`, for `podium`, or for a ticket wide enough to exercise the canonical
   * line sort. These tests fail the build if that coverage narrows again.
   */
  describe('coverage of the port-conformance oracle', () => {
    const lineCodes = (vector) => vector.ticket.lines.map((line) => line.code);
    const codesIn = (vector) => new Set(lineCodes(vector));
    const allCodes = new Set(FIXTURES.vectors.flatMap(lineCodes));

    it('freezes every bet code the catalogue defines', () => {
      for (const family of BET_FAMILIES) {
        expect(allCodes.has(family.code), `no frozen vector carries a ${family.code} line`).toBe(true);
      }
    });

    it.each(VARIANT_IDS)('%s freezes every bet code on its own, not only across variants', (variantId) => {
      const forVariant = new Set(
        FIXTURES.vectors.filter((vector) => vector.context.variantId === variantId).flatMap(lineCodes),
      );
      for (const family of BET_FAMILIES) {
        expect(forVariant.has(family.code), `${variantId} has no ${family.code} vector`).toBe(true);
      }
    });

    it('freezes the highest-liability bet both winning and losing', () => {
      const fullVectors = FIXTURES.vectors.filter((vector) => codesIn(vector).has('full'));
      expect(fullVectors.length).toBeGreaterThanOrEqual(2 * VARIANT_IDS.length);
      const verdicts = new Set(
        fullVectors.flatMap((vector) =>
          vector.settlement.lines.filter((line) => line.code === 'full').map((line) => line.won),
        ),
      );
      expect(verdicts).toEqual(new Set([true, false]));
    });

    it("freezes the FULL ORDER parameter in its readable form, matching its round", () => {
      for (const vector of FIXTURES.vectors) {
        for (const line of vector.ticket.lines) {
          if (line.code !== 'full') continue;
          expect(Object.keys(line.params)).toEqual(['order']);
          const settled = vector.settlement.lines.find(
            (candidate) => candidate.code === 'full' && candidate.params.order === line.params.order,
          );
          // A won FULL ORDER line's parameter IS the transcript's permutation,
          // which is the whole point of spelling it this way.
          expect(settled.won).toBe(line.params.order === vector.transcript.permutation.join('-'));
        }
      }
    });

    it('freezes the three-parameter shape and a ticket at the line limit', () => {
      expect(FIXTURES.vectors.some((vector) => codesIn(vector).has('podium'))).toBe(true);
      const widest = Math.max(...FIXTURES.vectors.map((vector) => vector.ticket.lines.length));
      expect(widest).toBe(LIMITS.maxLinesPerTicket);
      // More than one width, or the sort is never exercised at scale.
      expect(new Set(FIXTURES.vectors.map((vector) => vector.ticket.lines.length)).size).toBeGreaterThanOrEqual(3);
    });

    it('every frozen ticket is in canonical order and re-digests to its frozen value', () => {
      for (const vector of FIXTURES.vectors) {
        const seedContext = {
          variantId: vector.context.variantId,
          roundId: vector.context.roundId,
          nonce: vector.context.nonce,
        };
        const lines = vector.ticket.lines.map((line) => ({ ...line, stakeChips: BigInt(line.stakeChips) }));
        const reopened = openTicket(seedContext, { lines });
        expect(reopened.ticketDigest, vector.context.roundId).toBe(vector.ticket.ticketDigest);
        expect(reopened.idempotencyKey).toBe(vector.ticket.idempotencyKey);
        // Frozen in canonical order already: reopening must not reorder them.
        expect(reopened.lines.map((line) => line.code)).toEqual(lines.map((line) => line.code));
      }
    });

    it('every frozen settlement re-settles to the same money and the same flags', () => {
      for (const vector of FIXTURES.vectors) {
        const lines = vector.ticket.lines.map((line) => ({ ...line, stakeChips: BigInt(line.stakeChips) }));
        const settlement = settleTicket(vector.transcript, { lines });
        expect(settlement.totalStakeChips).toBe(BigInt(vector.settlement.totalStakeChips));
        expect(settlement.grossChips).toBe(BigInt(vector.settlement.grossChips));
        expect(settlement.creditedChips).toBe(BigInt(vector.settlement.creditedChips));
        expect(settlement.lines.map((line) => line.won)).toEqual(vector.settlement.lines.map((line) => line.won));
      }
    });

    it('the frozen settlements include mixed win/lose flags, not only clean sweeps', () => {
      const mixed = FIXTURES.vectors.filter((vector) => {
        const flags = new Set(vector.settlement.lines.map((line) => line.won));
        return flags.size === 2;
      });
      expect(mixed.length).toBeGreaterThanOrEqual(VARIANT_IDS.length);
    });
  });
});

describe('canonical encoding', () => {
  it('recovers field boundaries — no separator can be smuggled inside a field', () => {
    const a = encodeFields(['ab', 'c']);
    const b = encodeFields(['a', 'bc']);
    const c = encodeFields(['abc']);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(c)).toBe(false);
    expect(b.equals(c)).toBe(false);
  });

  it('is not type-tagged, which is why every field position has a fixed type', () => {
    // Documented limitation, asserted so it cannot change silently: numbers,
    // BigInts and their decimal strings share an encoding. Safe only because no
    // commitment payload ever varies the type at a given field position.
    expect(encodeFields([7]).equals(encodeFields(['7']))).toBe(true);
    expect(encodeFields([7n]).equals(encodeFields(['7']))).toBe(true);
    // Field boundaries still hold, which is the property commitments rely on.
    expect(encodeFields([7, 'x']).equals(encodeFields(['7x']))).toBe(false);
  });

  it('rejects unsafe integers', () => {
    expect(() => encodeFields([Number.MAX_SAFE_INTEGER + 1])).toThrow(TypeError);
  });

  it('produces a frozen golden digest for a fixed field vector', () => {
    // A golden constant, not a self-comparison: a constant-returning or
    // reordered encoder fails here. Regenerate only for an intentional
    // protocol change, which is also a commitment-format change.
    expect(sha256Hex(encodeFields(['aether-order', 1n, 2]))).toBe(GOLDEN_FIELD_DIGEST);
    expect(sha256Hex(encodeFields(['aether-order', 2, 1n]))).not.toBe(GOLDEN_FIELD_DIGEST);
    expect(sha256Hex(encodeFields(['aether-order', 1n]))).not.toBe(GOLDEN_FIELD_DIGEST);
  });
});

describe('uniform sampler', () => {
  it('is deterministic for identical inputs', () => {
    const first = uniformBelow(SEED_A, ctx(), 'shuffle', 0, 5n);
    const second = uniformBelow(SEED_A, ctx(), 'shuffle', 0, 5n);
    expect(first).toBe(second);
  });

  it('stays inside the modulus', () => {
    for (let counter = 0; counter < 64; counter += 1) {
      const value = uniformBelow(SEED_A, ctx(), 'shuffle', counter, 5n);
      expect(value >= 0n && value < 5n).toBe(true);
    }
  });

  it('domain-separates label, counter, client seed and nonce', () => {
    const base = uniformBelow(SEED_A, ctx(), 'shuffle', 0, 1_000_000_007n);
    expect(uniformBelow(SEED_A, ctx(), 'other', 0, 1_000_000_007n)).not.toBe(base);
    expect(uniformBelow(SEED_A, ctx(), 'shuffle', 1, 1_000_000_007n)).not.toBe(base);
    expect(uniformBelow(SEED_A, ctx({ clientSeed: 'x' }), 'shuffle', 0, 1_000_000_007n)).not.toBe(base);
    expect(uniformBelow(SEED_A, ctx({ nonce: 1 }), 'shuffle', 0, 1_000_000_007n)).not.toBe(base);
    expect(uniformBelow(SEED_A, ctx({ roundId: 'r-2' }), 'shuffle', 0, 1_000_000_007n)).not.toBe(base);
    expect(uniformBelow(SEED_B, ctx(), 'shuffle', 0, 1_000_000_007n)).not.toBe(base);
  });

  it('rejects an out-of-range modulus', () => {
    expect(() => uniformBelow(SEED_A, ctx(), 'shuffle', 0, 0n)).toThrow(AetherOrderError);
    expect(() => uniformBelow(SEED_A, ctx(), 'shuffle', 0, -1n)).toThrow(AetherOrderError);
    expect(() => uniformBelow(SEED_A, ctx(), 'shuffle', 0, 1n << 256n)).toThrow(AetherOrderError);
  });
});

describe('permutation derivation', () => {
  it.each(VARIANT_IDS)('produces a genuine permutation for %s', (variantId) => {
    const { n } = getVariant(variantId);
    for (let round = 0; round < 200; round += 1) {
      const perm = derivePermutation(SEED_A, ctx({ variantId, roundId: `r-${round}`, nonce: round }));
      expect(perm).toHaveLength(n);
      expect([...new Set(perm)].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('is a pure function of its declared inputs', () => {
    const a = derivePermutation(SEED_A, ctx());
    const b = derivePermutation(SEED_A, ctx());
    expect(a).toEqual(b);
  });

  it('re-randomises on every declared input change', () => {
    // Two different inputs CAN legitimately land on the same permutation — the
    // input space is astronomically larger than 120 or 5040 outcomes, so
    // collisions are expected, not a defect. The invariant that must hold is
    // that the *commitment* changes, which is collision resistance of SHA-256,
    // and that the permutation is genuinely re-derived rather than carried over.
    const base = makeTranscript(SEED_A, ctx({ variantId: 'seven' }));
    const changed = [
      makeTranscript(SEED_B, ctx({ variantId: 'seven' })),
      makeTranscript(SEED_A, ctx({ variantId: 'seven', roundId: 'r-2' })),
      makeTranscript(SEED_A, ctx({ variantId: 'seven', clientSeed: 'other' })),
      makeTranscript(SEED_A, ctx({ variantId: 'seven', nonce: 1 })),
      makeTranscript(SEED_A, ctx({ variantId: 'classic' })),
    ];
    for (const candidate of changed) expect(candidate.commitment).not.toBe(base.commitment);
    // On these specific inputs the permutations also differ; asserted as a
    // regression guard on the sampler's domain separation, not as a theorem.
    for (const candidate of changed.slice(0, 4)) {
      expect(candidate.permutation.join(',')).not.toBe(base.permutation.join(','));
    }
  });
});

describe('transcript verification', () => {
  const transcript = makeTranscript(SEED_A, ctx());

  it('accepts the honest transcript', () => {
    expect(verifyTranscript(SEED_A, transcript).ok).toBe(true);
  });

  it.each([
    ['permutation', { permutation: [4, 3, 2, 1, 0] }, 'TRANSCRIPT_MISMATCH'],
    ['clientSeed', { clientSeed: 'tampered' }, 'TRANSCRIPT_MISMATCH'],
    ['nonce', { nonce: 99 }, 'TRANSCRIPT_MISMATCH'],
    ['roundId', { roundId: 'r-999' }, 'TRANSCRIPT_MISMATCH'],
    ['previousCommitment', { previousCommitment: 'f'.repeat(64) }, 'COMMITMENT_MISMATCH'],
    ['commitment', { commitment: '0'.repeat(64) }, 'COMMITMENT_MISMATCH'],
    ['seedCommitment', { seedCommitment: '1'.repeat(64) }, 'COMMITMENT_MISMATCH'],
    ['variantId', { variantId: 'nonexistent' }, 'ADAPTER_MISMATCH'],
    ['adapterFingerprint', { adapterFingerprint: 'b'.repeat(64) }, 'ADAPTER_MISMATCH'],
    ['adapterVersion', { adapterVersion: '9.9.9' }, 'ADAPTER_MISMATCH'],
    ['schema', { schema: 'reveal-engine/transcript-v2' }, 'UNSUPPORTED_VERSION'],
    ['moduleVersion', { moduleVersion: 'reveal-engine/permutation-v2' }, 'UNSUPPORTED_VERSION'],
    ['n', { n: 7 }, 'INVALID_TRANSCRIPT'],
  ])('rejects a tampered %s', (_field, patch, code) => {
    const result = verifyTranscript(SEED_A, { ...transcript, ...patch });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
  });

  it('rejects a wrong revealed seed', () => {
    expect(verifyTranscript(SEED_B, transcript).ok).toBe(false);
  });

  it('rejects a permutation with a repeated element', () => {
    const result = verifyTranscript(SEED_A, { ...transcript, permutation: [0, 0, 1, 2, 3] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSCRIPT');
  });

  it.each([null, undefined, 42, 'transcript', [], {}])('rejects hostile input %p', (input) => {
    expect(verifyTranscript(SEED_A, input).ok).toBe(false);
  });
});

describe('hostile input handling', () => {
  it.each([
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    ' '.repeat(64),
    `${'a'.repeat(62)}\n\n`,
  ])('rejects malformed server seed %p', (seed) => {
    expect(() => normalizeServerSeed(seed)).toThrow(AetherOrderError);
  });

  it('accepts and lowercases a valid uppercase seed', () => {
    expect(normalizeServerSeed('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects an oversized client seed', () => {
    expect(() => makeTranscript(SEED_A, ctx({ clientSeed: 'x'.repeat(65) }))).toThrow(AetherOrderError);
  });

  it('rejects a non-printable client seed', () => {
    expect(() => makeTranscript(SEED_A, ctx({ clientSeed: 'a b' }))).toThrow(AetherOrderError);
    expect(() => makeTranscript(SEED_A, ctx({ clientSeed: 'a‮b' }))).toThrow(AetherOrderError);
  });

  it('accepts an empty client seed', () => {
    expect(makeTranscript(SEED_A, ctx({ clientSeed: '' })).clientSeed).toBe('');
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '0'])('rejects nonce %p', (nonce) => {
    expect(() => makeTranscript(SEED_A, ctx({ nonce }))).toThrow(AetherOrderError);
  });

  it('rejects an oversized or non-printable round id', () => {
    expect(() => makeTranscript(SEED_A, ctx({ roundId: 'r'.repeat(129) }))).toThrow(AetherOrderError);
    expect(() => makeTranscript(SEED_A, ctx({ roundId: 'r' }))).toThrow(AetherOrderError);
    expect(() => makeTranscript(SEED_A, ctx({ roundId: '' }))).toThrow(AetherOrderError);
  });

  it('rejects an unknown variant with a coded error, not a bare RangeError', () => {
    expect(() => makeTranscript(SEED_A, ctx({ variantId: 'nine' }))).toThrow(AetherOrderError);
    try {
      makeTranscript(SEED_A, ctx({ variantId: 'nine' }));
    } catch (error) {
      expect(error.code).toBe('ADAPTER_MISMATCH');
      expect(error.path).toBe('$.variantId');
    }
  });

  it('rejects a malformed previous commitment', () => {
    expect(() => makeTranscript(SEED_A, ctx(), 'nope')).toThrow(AetherOrderError);
  });
});

describe('commitments', () => {
  const seedCtx = (over = {}) => ({ variantId: 'classic', roundId: 'r-1', nonce: 0, ...over });

  it('the seed commitment hides the seed and binds the whole pre-bet context', () => {
    const base = seedCommitment(SEED_A, seedCtx());
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(seedCommitment(SEED_B, seedCtx())).not.toBe(base);
    expect(seedCommitment(SEED_A, seedCtx({ roundId: 'r-2' }))).not.toBe(base);
    // The nonce and variant MUST be bound. If they were not, an operator that
    // had already seen the ticket could search them for a favourable outcome
    // while still opening the published hash honestly.
    expect(seedCommitment(SEED_A, seedCtx({ nonce: 1 }))).not.toBe(base);
    expect(seedCommitment(SEED_A, seedCtx({ variantId: 'seven' }))).not.toBe(base);
  });

  it('the seed commitment validates its context', () => {
    expect(() => seedCommitment(SEED_A, seedCtx({ roundId: 'r'.repeat(129) }))).toThrow(AetherOrderError);
    expect(() => seedCommitment(SEED_A, seedCtx({ roundId: 'bad\u0000id' }))).toThrow(AetherOrderError);
    expect(() => seedCommitment(SEED_A, seedCtx({ nonce: -1 }))).toThrow(AetherOrderError);
    expect(() => seedCommitment(SEED_A, seedCtx({ variantId: 'nope' }))).toThrow(AetherOrderError);
  });

  it('a transcript with no pre-round commitment fails closed', () => {
    const transcript = makeTranscript(SEED_A, ctx());
    for (const broken of [undefined, null, 42, '', 'not-hex', 'A'.repeat(64)]) {
      const patched = { ...transcript, seedCommitment: broken };
      if (broken === undefined) delete patched.seedCommitment;
      const result = verifyTranscript(SEED_A, patched);
      expect(result.ok, `seedCommitment ${String(broken)} must not verify`).toBe(false);
      expect(result.code).toBe('INVALID_TRANSCRIPT');
    }
  });

  it('the adapter fingerprint separates variants and is stable', () => {
    expect(adapterFingerprint('classic')).not.toBe(adapterFingerprint('seven'));
    expect(adapterFingerprint('classic')).toBe(adapterFingerprint('classic'));
  });

  it('the adapter fingerprint binds catalogue BEHAVIOUR, not just its declaration', () => {
    // Tampered catalogues are digested through the PRODUCTION code path
    // (digestCatalogue), not a local reimplementation — a reimplementation
    // would pass even if catalogueDigest ignored behaviour entirely.
    const honest = catalogueDigest('classic');
    expect(honest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digestCatalogue('classic')).toBe(honest);
    expect(digestCatalogue('classic', [...BET_FAMILIES])).toBe(honest);

    // Same code, same instances, same multiplier — only the predicate flips
    // from "first" to "last". The digest must move.
    const flipped = BET_FAMILIES.map((family) =>
      family.code === 'first'
        ? { ...family, resolve: (instance, view) => view.pos[instance.params.c] === view.n - 1 }
        : family,
    );
    expect(digestCatalogue('classic', flipped)).not.toBe(honest);

    // Same behaviour, same labels — only a parameter key is renamed. Ticket
    // matching would break, so the digest must move too.
    const renamed = BET_FAMILIES.map((family) =>
      family.code === 'first'
        ? {
            ...family,
            instances: (n) =>
              Array.from({ length: n }, (_, colour) =>
                Object.freeze({ code: 'first', params: Object.freeze({ colour }), label: `f${colour}` }),
              ),
            resolve: (instance, view) => view.pos[instance.params.colour] === 0,
          }
        : family,
    );
    expect(digestCatalogue('classic', renamed)).not.toBe(honest);

    // Dropping a family entirely must move it as well.
    expect(digestCatalogue('classic', BET_FAMILIES.filter((f) => f.code !== 'link'))).not.toBe(honest);
  });

  it('claim signatures are keyed on parameters, not on adapter-authored labels', () => {
    const first = BET_FAMILIES.find((family) => family.code === 'first');
    const slot = BET_FAMILIES.find((family) => family.code === 'slot');
    const honest = claimSignature('classic', first, { code: 'first', params: { c: 0 }, label: 'f0' });

    // A hand-built instance whose label lies about its params must not be able
    // to poison the cache entry for the real instance.
    claimSignature('classic', first, { code: 'first', params: { c: 1 }, label: 'f0' });
    expect(claimSignature('classic', first, { code: 'first', params: { c: 0 }, label: 'f0' })).toBe(honest);

    // A caller-supplied family object with a matching code but a different
    // predicate must not be able to write a signature for a claim it does not
    // define. The adapter's own family is always looked up by code.
    claimSignature('classic', { code: 'first', resolve: () => false }, { params: { c: 0 }, label: 'f0' });
    expect(claimSignature('classic', first, { code: 'first', params: { c: 0 }, label: 'f0' })).toBe(honest);

    // A stateful `params` getter that answers one way for the cache key and
    // another for the predicate must not desync them. Both now read the
    // adapter's own frozen instance.
    let reads = 0;
    const shifty = claimSignature('classic', 'first', {
      code: 'first',
      label: 'f0',
      get params() {
        reads += 1;
        return reads === 1 ? { c: 0 } : { c: 1 };
      },
    });
    // Exactly one read, so the getter cannot answer the key and the predicate
    // differently, and the result is the claim the first read named.
    expect(reads).toBe(1);
    expect(shifty).toBe(honest);
    expect(claimSignature('classic', first, { code: 'first', params: { c: 0 }, label: 'f0' })).toBe(honest);
    expect(claimSignature('classic', first, { code: 'first', params: { c: 1 }, label: 'f1' })).not.toBe(honest);

    // Parameters that name no legal instance are rejected, not silently hashed.
    expect(() => claimSignature('classic', first, { code: 'first', params: { c: 99 } })).toThrow(AetherOrderError);
    expect(() => claimSignature('classic', first, { code: 'first' })).toThrow(AetherOrderError);

    // Behavioural aliases across families share a signature; near-misses do not.
    expect(claimSignature('classic', slot, { code: 'slot', params: { c: 0, k: 0 }, label: '0@0' })).toBe(honest);
    expect(claimSignature('classic', slot, { code: 'slot', params: { c: 0, k: 1 }, label: '0@1' })).not.toBe(honest);
  });
});
