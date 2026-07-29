/**
 * Reference derivation, commitment and settlement for AETHER ORDER.
 *
 * This is the normative description of docs/ENGINE.md's permutation lifecycle
 * module, written in plain ESM so that the enumerator, the tests and an
 * independent verifier can all execute it without a build step. The shipped
 * TypeScript module inside Reveal Engine must produce byte-identical
 * commitments; tests/fixtures/transcripts.json freezes the vectors that prove it.
 *
 * Fairness model: commit-reveal.
 *   1. The operator draws a 32-byte server seed and publishes
 *      seedCommitment = SHA-256(canonical(domain, serverSeed, roundId)) BEFORE
 *      the player commits a ticket.
 *   2. The player may supply a client seed. It is mixed into every sampler call.
 *   3. The permutation is derived by rejection-sampled Fisher-Yates.
 *   4. After settlement the server seed is revealed; anyone re-derives the
 *      permutation and both hashes from (serverSeed, clientSeed, nonce, roundId).
 *   5. Each transcript binds the previous round's commitment, so a chain of
 *      rounds cannot be reordered, dropped or back-dated.
 */

import { encodeFields, hmacSha256, sha256Hex, constantTimeHexEqual } from './canonical.mjs';
import { fisherYates, permutationRank, positionsOf } from './permutations.mjs';
import { rational, mul as rmul, cmp as rcmp } from './rational.mjs';
import {
  ADAPTER_VERSION,
  GAME_ID,
  LIMITS,
  MODULE_VERSION,
  SEED_COMMIT_DOMAIN,
  STAKE_QUANTUM,
  TARGET_RTP,
  TRANSCRIPT_SCHEMA,
  getVariant,
} from './model.mjs';
import { BET_FAMILIES, getFamily } from './bets.mjs';

const RANGE_BITS = 256n;
const RANGE = 1n << RANGE_BITS;
const ZERO_COMMITMENT = '0'.repeat(64);

export class AetherOrderError extends Error {
  constructor(code, message, path = '$') {
    super(message);
    this.name = 'AetherOrderError';
    this.code = code;
    this.path = path;
  }
}

const fail = (code, message, path) => {
  throw new AetherOrderError(code, message, path);
};

/* ------------------------------------------------------------------ *
 * Hostile-input validation. Every public entry point validates first. *
 * ------------------------------------------------------------------ */

export function normalizeServerSeed(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(seedHex)) {
    fail('INVALID_SEED', 'Server seed must be exactly 32 bytes of hexadecimal', '$.serverSeed');
  }
  return seedHex.toLowerCase();
}

export function assertClientSeed(clientSeed) {
  if (typeof clientSeed !== 'string') fail('INVALID_CONTEXT', 'Client seed must be a string', '$.clientSeed');
  if (Buffer.byteLength(clientSeed, 'utf8') > LIMITS.maxClientSeedBytes) {
    fail('INVALID_CONTEXT', 'Client seed exceeds the published byte limit', '$.clientSeed');
  }
  // Printable ASCII only: keeps the value renderable, copy-pasteable and free of
  // control characters or bidirectional overrides that could spoof a receipt.
  if (!/^[\x20-\x7E]*$/u.test(clientSeed)) {
    fail('INVALID_CONTEXT', 'Client seed must be printable ASCII', '$.clientSeed');
  }
  return clientSeed;
}

export function assertRoundContext(context) {
  if (typeof context !== 'object' || context === null) fail('INVALID_CONTEXT', 'Round context must be an object');
  const { variantId, roundId, clientSeed, nonce } = context;
  getVariant(variantId);
  if (typeof roundId !== 'string' || roundId.length === 0) fail('INVALID_CONTEXT', 'Round id is required', '$.roundId');
  if (Buffer.byteLength(roundId, 'utf8') > LIMITS.maxRoundIdBytes) {
    fail('INVALID_CONTEXT', 'Round id exceeds the published byte limit', '$.roundId');
  }
  if (!/^[\x20-\x7E]+$/u.test(roundId)) fail('INVALID_CONTEXT', 'Round id must be printable ASCII', '$.roundId');
  assertClientSeed(clientSeed);
  if (!Number.isSafeInteger(nonce) || nonce < 0) fail('INVALID_CONTEXT', 'Nonce must be a non-negative safe integer', '$.nonce');
  return Object.freeze({ variantId, roundId, clientSeed, nonce });
}

function assertCommitmentHex(value, path) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    fail('INVALID_TRANSCRIPT', 'Expected a 32-byte lowercase hex digest', path);
  }
  return value;
}

/* ---------------------------------------- *
 * Adapter fingerprint and seed commitment. *
 * ---------------------------------------- */

/**
 * Binds every replay-visible declarative field. Any change to elements,
 * multipliers, the target RTP, the cap or the stake quantum changes this
 * digest, which in turn changes every commitment — an integration cannot
 * silently re-price an open liability.
 */
export function adapterFingerprint(variantId) {
  const variant = getVariant(variantId);
  const fields = [
    'adapter',
    MODULE_VERSION,
    GAME_ID,
    ADAPTER_VERSION,
    variant.id,
    variant.n,
    variant.elements.length,
  ];
  variant.elements.forEach((element, index) => fields.push(index, element.id));
  fields.push(BET_FAMILIES.length);
  for (const family of BET_FAMILIES) {
    const multiplier = variant.multipliers[family.code];
    if (!multiplier) fail('INVALID_ADAPTER', `Variant ${variant.id} does not price bet ${family.code}`);
    fields.push(family.code, multiplier.n, multiplier.d);
  }
  fields.push(
    TARGET_RTP.n,
    TARGET_RTP.d,
    'floor',
    STAKE_QUANTUM,
    LIMITS.maxWinMultiple,
    LIMITS.maxLinesPerTicket,
    LIMITS.minLineStakeChips,
    LIMITS.maxLineStakeChips,
    LIMITS.maxTicketStakeChips,
  );
  return sha256Hex(encodeFields(fields));
}

/** Published before the player commits a ticket. Hides the seed, binds the round. */
export function seedCommitment(serverSeedHex, roundId) {
  const seed = normalizeServerSeed(serverSeedHex);
  if (typeof roundId !== 'string' || roundId.length === 0) fail('INVALID_CONTEXT', 'Round id is required', '$.roundId');
  return sha256Hex(encodeFields([SEED_COMMIT_DOMAIN, Buffer.from(seed, 'hex'), roundId]));
}

/* --------------------------------- *
 * Uniform sampling and the shuffle. *
 * --------------------------------- */

/**
 * Exact uniform sample in [0, modulus) by rejection.
 *
 * The accept region has size RANGE - (RANGE mod modulus), which is divisible by
 * modulus, so every residue is produced by exactly the same number of accepted
 * 256-bit values. No modulo bias, for any modulus, with no floating point.
 */
export function uniformBelow(serverSeedHex, context, label, counter, modulus) {
  const seed = normalizeServerSeed(serverSeedHex);
  const ctx = assertRoundContext(context);
  if (typeof label !== 'string' || label.length === 0) fail('INVALID_CONTEXT', 'Sampler label is required', '$.label');
  if (!Number.isSafeInteger(counter) || counter < 0) fail('INVALID_CONTEXT', 'Sampler counter is invalid', '$.counter');
  if (typeof modulus !== 'bigint' || modulus <= 0n || modulus >= RANGE) {
    fail('INVALID_CONTEXT', 'Sampler modulus must be in [1, 2^256)', '$.modulus');
  }
  const key = Buffer.from(seed, 'hex');
  const limit = RANGE - (RANGE % modulus);
  for (let rejection = 0n; ; rejection += 1n) {
    const payload = encodeFields([
      'sampler',
      MODULE_VERSION,
      GAME_ID,
      ctx.variantId,
      ctx.roundId,
      ctx.clientSeed,
      ctx.nonce,
      label,
      counter,
      rejection,
      modulus,
    ]);
    const value = BigInt(`0x${hmacSha256(key, payload).toString('hex')}`);
    if (value < limit) return value % modulus;
  }
}

/**
 * Derive the settling order. `perm[k]` is the element index that settles into
 * slot k. Draw t addresses index n-1-t and ranges over [0, n-t).
 */
export function derivePermutation(serverSeedHex, context) {
  const ctx = assertRoundContext(context);
  const { n } = getVariant(ctx.variantId);
  const draws = [];
  for (let t = 0; t < n - 1; t += 1) {
    draws.push(Number(uniformBelow(serverSeedHex, ctx, 'shuffle', t, BigInt(n - t))));
  }
  return Object.freeze(fisherYates(n, draws));
}

/* ------------------------- *
 * Transcript and verifying. *
 * ------------------------- */

function canonicalTranscriptBytes(variantId, context, permutation, previousCommitment) {
  const variant = getVariant(variantId);
  const fields = [
    'AETHER ORDER permutation transcript',
    TRANSCRIPT_SCHEMA,
    MODULE_VERSION,
    GAME_ID,
    ADAPTER_VERSION,
    adapterFingerprint(variantId),
    variant.id,
    context.roundId,
    context.clientSeed,
    context.nonce,
    variant.n,
    permutation.length,
  ];
  permutation.forEach((element, slot) => fields.push(slot, element));
  fields.push(previousCommitment);
  return encodeFields(fields);
}

export function transcriptCommitment(serverSeedHex, variantId, context, permutation, previousCommitment) {
  const seed = normalizeServerSeed(serverSeedHex);
  return sha256Hex(
    encodeFields([
      'commitment',
      MODULE_VERSION,
      Buffer.from(seed, 'hex'),
      canonicalTranscriptBytes(variantId, context, permutation, previousCommitment),
    ]),
  );
}

/**
 * @param {string} serverSeedHex
 * @param {{variantId: string, roundId: string, clientSeed: string, nonce: number}} context
 * @param {string} [previousCommitment] previous round's commitment, or 64 zeros to open a chain
 */
export function makeTranscript(serverSeedHex, context, previousCommitment = ZERO_COMMITMENT) {
  const seed = normalizeServerSeed(serverSeedHex);
  const ctx = assertRoundContext(context);
  assertCommitmentHex(previousCommitment, '$.previousCommitment');
  const variant = getVariant(ctx.variantId);
  const permutation = derivePermutation(seed, ctx);
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    moduleVersion: MODULE_VERSION,
    gameId: GAME_ID,
    adapterVersion: ADAPTER_VERSION,
    adapterFingerprint: adapterFingerprint(variant.id),
    variantId: variant.id,
    roundId: ctx.roundId,
    clientSeed: ctx.clientSeed,
    nonce: ctx.nonce,
    n: variant.n,
    permutation: Object.freeze([...permutation]),
    previousCommitment,
    seedCommitment: seedCommitment(seed, ctx.roundId),
    commitment: transcriptCommitment(seed, variant.id, ctx, permutation, previousCommitment),
  });
}

/**
 * Independent re-derivation. Returns a typed result rather than throwing, so a
 * verifier UI can render the precise reason a transcript failed.
 */
export function verifyTranscript(serverSeedHex, input) {
  const reject = (code, message, path) => Object.freeze({ ok: false, code, message, path });
  try {
    const seed = normalizeServerSeed(serverSeedHex);
    if (typeof input !== 'object' || input === null) return reject('INVALID_TRANSCRIPT', 'Transcript must be an object', '$');
    if (input.schema !== TRANSCRIPT_SCHEMA) return reject('UNSUPPORTED_VERSION', 'Unknown transcript schema', '$.schema');
    if (input.moduleVersion !== MODULE_VERSION) return reject('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
    if (input.gameId !== GAME_ID || input.adapterVersion !== ADAPTER_VERSION) {
      return reject('ADAPTER_MISMATCH', 'Transcript belongs to another adapter', '$.adapterVersion');
    }
    const variant = getVariant(input.variantId);
    if (input.adapterFingerprint !== adapterFingerprint(variant.id)) {
      return reject('ADAPTER_MISMATCH', 'Adapter fingerprint does not match this build', '$.adapterFingerprint');
    }
    assertCommitmentHex(input.previousCommitment, '$.previousCommitment');
    const ctx = assertRoundContext({
      variantId: input.variantId,
      roundId: input.roundId,
      clientSeed: input.clientSeed,
      nonce: input.nonce,
    });
    if (input.n !== variant.n) return reject('INVALID_TRANSCRIPT', 'Sphere count does not match the variant', '$.n');
    if (!Array.isArray(input.permutation) || input.permutation.length !== variant.n) {
      return reject('INVALID_TRANSCRIPT', 'Permutation has the wrong length', '$.permutation');
    }
    const seen = new Set();
    for (const element of input.permutation) {
      if (!Number.isInteger(element) || element < 0 || element >= variant.n || seen.has(element)) {
        return reject('INVALID_TRANSCRIPT', 'Permutation is not a permutation of the elements', '$.permutation');
      }
      seen.add(element);
    }
    const expected = derivePermutation(seed, ctx);
    if (expected.some((element, slot) => element !== input.permutation[slot])) {
      return reject('TRANSCRIPT_MISMATCH', 'Permutation does not match the deterministic derivation', '$.permutation');
    }
    if (
      typeof input.seedCommitment === 'string' &&
      !constantTimeHexEqual(input.seedCommitment, seedCommitment(seed, ctx.roundId))
    ) {
      return reject('COMMITMENT_MISMATCH', 'Pre-round seed commitment does not open to this seed', '$.seedCommitment');
    }
    const expectedCommitment = transcriptCommitment(seed, variant.id, ctx, expected, input.previousCommitment);
    if (!constantTimeHexEqual(expectedCommitment, String(input.commitment))) {
      return reject('COMMITMENT_MISMATCH', 'Commitment does not match the revealed seed', '$.commitment');
    }
    return Object.freeze({ ok: true, commitment: expectedCommitment });
  } catch (error) {
    if (error instanceof AetherOrderError) return reject(error.code, error.message, error.path);
    return reject('INVALID_TRANSCRIPT', 'Transcript verification failed', '$');
  }
}

/* ------------ *
 * Settlement.  *
 * ------------ */

/**
 * Settle a ticket against a transcript.
 *
 * Payouts are exact: `stakeChips * multiplier` is asserted to be an integer,
 * which the published stake quantum guarantees. The floor is therefore a no-op
 * and the realised RTP equals the theoretical RTP with zero rounding drift.
 *
 * @param {{permutation: readonly number[], variantId: string}} transcript
 * @param {{lines: ReadonlyArray<{code: string, params: object, stakeChips: bigint}>}} ticket
 */
export function settleTicket(transcript, ticket) {
  const variant = getVariant(transcript.variantId);
  if (typeof ticket !== 'object' || ticket === null || !Array.isArray(ticket.lines)) {
    fail('INVALID_TICKET', 'Ticket must carry a lines array', '$.lines');
  }
  if (ticket.lines.length === 0) fail('INVALID_TICKET', 'Ticket must carry at least one line', '$.lines');
  if (ticket.lines.length > LIMITS.maxLinesPerTicket) {
    fail('INVALID_TICKET', 'Ticket exceeds the published line limit', '$.lines');
  }
  const perm = transcript.permutation;
  // Defence in depth: settlement never trusts a caller-supplied permutation,
  // even though the production path only ever passes a verified transcript.
  if (!Array.isArray(perm) || perm.length !== variant.n) {
    fail('INVALID_TRANSCRIPT', 'Permutation has the wrong length', '$.transcript.permutation');
  }
  const seen = new Set();
  for (const element of perm) {
    if (!Number.isInteger(element) || element < 0 || element >= variant.n || seen.has(element)) {
      fail('INVALID_TRANSCRIPT', 'Permutation is not a permutation of the elements', '$.transcript.permutation');
    }
    seen.add(element);
  }
  const ctx = Object.freeze({
    perm,
    pos: positionsOf(perm),
    rank: permutationRank(perm),
    n: variant.n,
  });

  let totalStake = 0n;
  let payout = 0n;
  const lines = ticket.lines.map((line, index) => {
    const path = `$.lines[${index}]`;
    const family = getFamily(line.code);
    const stake = line.stakeChips;
    if (typeof stake !== 'bigint') fail('INVALID_TICKET', 'Stake must be a BigInt chip amount', `${path}.stakeChips`);
    if (stake < LIMITS.minLineStakeChips || stake > LIMITS.maxLineStakeChips) {
      fail('INVALID_TICKET', 'Line stake is outside the published limits', `${path}.stakeChips`);
    }
    if (stake % STAKE_QUANTUM !== 0n) {
      fail('INVALID_TICKET', 'Line stake is not a multiple of the stake quantum', `${path}.stakeChips`);
    }
    const legal = family.instances(variant.n, { permutationCount: factorialNumber(variant.n) });
    const instance = legal.find((candidate) => sameParams(candidate.params, line.params));
    if (!instance) fail('UNKNOWN_INSTANCE', 'Bet parameters are not a legal instance', `${path}.params`);
    const multiplier = variant.multipliers[family.code];
    const won = family.resolve(instance, ctx) === true;
    const gross = won ? exactChips(stake, multiplier, `${path}.payout`) : 0n;
    totalStake += stake;
    payout += gross;
    return Object.freeze({ code: family.code, params: instance.params, stakeChips: stake, won, grossChips: gross });
  });

  if (totalStake > LIMITS.maxTicketStakeChips) {
    fail('INVALID_TICKET', 'Ticket exceeds the published total stake limit', '$.lines');
  }
  const ceiling = totalStake * LIMITS.maxWinMultiple;
  const credited = payout > ceiling ? ceiling : payout;
  return Object.freeze({
    lines: Object.freeze(lines),
    totalStakeChips: totalStake,
    grossChips: payout,
    creditedChips: credited,
    capped: payout > ceiling,
    netChips: credited - totalStake,
  });
}

/** `stake * multiplier`, asserted exact. Throws rather than silently rounding. */
export function exactChips(stakeChips, multiplier, path = '$') {
  const product = rmul(rational(stakeChips), multiplier);
  if (product.d !== 1n) {
    fail('INEXACT_PAYOUT', 'Payout is not an integer chip amount; stake quantum violated', path);
  }
  return product.n;
}

function sameParams(a, b) {
  if (typeof b !== 'object' || b === null) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function factorialNumber(n) {
  let out = 1;
  for (let i = 2; i <= n; i += 1) out *= i;
  return out;
}

/** Convenience for callers comparing a rational against the target RTP. */
export const isTargetRtp = (value) => rcmp(value, TARGET_RTP) === 0;

export { ZERO_COMMITMENT };
