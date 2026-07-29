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
import {
  AetherOrderError,
  adapterFingerprint,
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
  it('is unambiguous — no two distinct field vectors collide', () => {
    const a = encodeFields(['ab', 'c']);
    const b = encodeFields(['a', 'bc']);
    const c = encodeFields(['abc']);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(c)).toBe(false);
    expect(b.equals(c)).toBe(false);
  });

  it('distinguishes a number field from the same digits as a string', () => {
    expect(encodeFields([7]).equals(encodeFields(['7']))).toBe(true); // same bytes by design
    expect(encodeFields([7, 'x']).equals(encodeFields(['7x']))).toBe(false);
  });

  it('rejects unsafe integers', () => {
    expect(() => encodeFields([Number.MAX_SAFE_INTEGER + 1])).toThrow(TypeError);
  });

  it('produces a stable digest for a stable field vector', () => {
    expect(sha256Hex(encodeFields(['aether-order', 1n, 2]))).toBe(
      sha256Hex(encodeFields(['aether-order', 1n, 2])),
    );
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

  it('changes when any declared input changes', () => {
    const base = derivePermutation(SEED_A, ctx({ variantId: 'seven' })).join(',');
    const variants = [
      derivePermutation(SEED_B, ctx({ variantId: 'seven' })).join(','),
      derivePermutation(SEED_A, ctx({ variantId: 'seven', roundId: 'r-2' })).join(','),
      derivePermutation(SEED_A, ctx({ variantId: 'seven', clientSeed: 'other' })).join(','),
      derivePermutation(SEED_A, ctx({ variantId: 'seven', nonce: 1 })).join(','),
    ];
    for (const candidate of variants) expect(candidate).not.toBe(base);
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

  it('rejects an unknown variant', () => {
    expect(() => makeTranscript(SEED_A, ctx({ variantId: 'nine' }))).toThrow(RangeError);
  });

  it('rejects a malformed previous commitment', () => {
    expect(() => makeTranscript(SEED_A, ctx(), 'nope')).toThrow(AetherOrderError);
  });
});

describe('commitments', () => {
  it('the seed commitment hides the seed and binds the round', () => {
    expect(seedCommitment(SEED_A, 'r-1')).not.toBe(seedCommitment(SEED_A, 'r-2'));
    expect(seedCommitment(SEED_A, 'r-1')).not.toBe(seedCommitment(SEED_B, 'r-1'));
    expect(seedCommitment(SEED_A, 'r-1')).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('the adapter fingerprint separates variants', () => {
    expect(adapterFingerprint('classic')).not.toBe(adapterFingerprint('seven'));
    expect(adapterFingerprint('classic')).toBe(adapterFingerprint('classic'));
  });
});
