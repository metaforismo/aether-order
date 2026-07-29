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
import { BET_FAMILIES } from '../tools/lib/bets.mjs';
import {
  AetherOrderError,
  adapterFingerprint,
  catalogueDigest,
  claimSignature,
  digestCatalogue,
  derivePermutation,
  makeTranscript,
  normalizeServerSeed,
  seedCommitment,
  uniformBelow,
  verifyTranscript,
  ZERO_COMMITMENT,
} from '../tools/lib/derive.mjs';
import { VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'transcripts.json'), 'utf8'));

const SEED_A = 'a'.repeat(64);
const SEED_B = `${'0'.repeat(63)}1`;
const ctx = (over = {}) => ({ variantId: 'classic', roundId: 'r-1', clientSeed: 'axiom', nonce: 0, ...over });

/** Frozen: SHA-256 of encodeFields(['aether-order', 1n, 2]). */
const GOLDEN_FIELD_DIGEST = '20cde8918719d4e71c26b8d84c8aea5a0ae17c125ffa83bb81818ba4472a4754';

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

    // Behavioural aliases across families share a signature; near-misses do not.
    expect(claimSignature('classic', slot, { code: 'slot', params: { c: 0, k: 0 }, label: '0@0' })).toBe(honest);
    expect(claimSignature('classic', slot, { code: 'slot', params: { c: 0, k: 1 }, label: '0@1' })).not.toBe(honest);
  });
});
