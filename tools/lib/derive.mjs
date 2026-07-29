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
 *   1. The operator draws a 32-byte server seed and publishes, BEFORE the
 *      player commits a ticket, both the seed context (variant, round id,
 *      nonce) and
 *        seedCommitment = SHA-256(canonical(domain, serverSeed, seed context)).
 *      Binding the whole context matters: a commitment over the seed alone
 *      would leave the nonce free for an operator that has already seen the
 *      ticket to search.
 *   2. The player may supply a client seed. It is mixed into every sampler call
 *      and is the only derivation input left free once the hash is published.
 *   3. The permutation is derived by rejection-sampled Fisher-Yates.
 *   4. After settlement the server seed is revealed; anyone re-derives the
 *      permutation and both hashes from the transcript plus the revealed seed.
 *   5. Each transcript binds the previous round's commitment, which makes
 *      retroactive edits to a round's ancestry detectable to anyone holding a
 *      later commitment. It is tamper-evidence, not a proof of completeness or
 *      chronology; see docs/ENGINE.md section 5.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

import { canonicalJson, encodeFields, hmacSha256, sha256Hex, constantTimeHexEqual } from './canonical.mjs';
import { allPermutations, fisherYates, permutationRank, positionsOf } from './permutations.mjs';
import { rational, mul as rmul, cmp as rcmp } from './rational.mjs';
import {
  ADAPTER_VERSION,
  GAME_ID,
  IDEMPOTENCY_DOMAIN,
  LIMITS,
  MODULE_VERSION,
  RECEIPT_DOMAIN,
  RECEIPT_SCHEMA,
  ROUND_SNAPSHOT_SCHEMA,
  SEED_COMMIT_DOMAIN,
  SETTLEMENT_DIGEST_DOMAIN,
  STAKE_QUANTUM,
  TARGET_RTP,
  TICKET_DIGEST_DOMAIN,
  TICKET_SCHEMA,
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

/** Every unknown identifier fails with a coded error, never a bare RangeError. */
export function assertVariant(variantId) {
  try {
    return getVariant(variantId);
  } catch {
    return fail('ADAPTER_MISMATCH', 'Unknown variant', '$.variantId');
  }
}

export function assertBetFamily(code) {
  try {
    return getFamily(code);
  } catch {
    return fail('UNKNOWN_BET', 'Unknown bet code', '$.code');
  }
}

export function assertRoundId(roundId) {
  if (typeof roundId !== 'string' || roundId.length === 0) fail('INVALID_CONTEXT', 'Round id is required', '$.roundId');
  if (Buffer.byteLength(roundId, 'utf8') > LIMITS.maxRoundIdBytes) {
    fail('INVALID_CONTEXT', 'Round id exceeds the published byte limit', '$.roundId');
  }
  if (!/^[\x20-\x7E]+$/u.test(roundId)) fail('INVALID_CONTEXT', 'Round id must be printable ASCII', '$.roundId');
  return roundId;
}

export function assertNonce(nonce) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    fail('INVALID_CONTEXT', 'Nonce must be a non-negative safe integer', '$.nonce');
  }
  return nonce;
}

/**
 * The part of the round context that must be frozen and published *before* the
 * player commits a ticket. It is exactly the derivation's input set minus the
 * client seed, which the player supplies afterwards.
 */
export function assertSeedContext(context) {
  if (typeof context !== 'object' || context === null) fail('INVALID_CONTEXT', 'Round context must be an object');
  const variant = assertVariant(context.variantId);
  return Object.freeze({
    variantId: variant.id,
    roundId: assertRoundId(context.roundId),
    nonce: assertNonce(context.nonce),
  });
}

export function assertRoundContext(context) {
  const seedContext = assertSeedContext(context);
  return Object.freeze({ ...seedContext, clientSeed: assertClientSeed(context.clientSeed) });
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

const catalogueDigestCache = new Map();
const fingerprintCache = new Map();
const claimSignatureCache = new Map();
const viewsCache = new Map();

/** Frozen outcome views for a variant, computed once. */
function viewsFor(variantId) {
  const variant = assertVariant(variantId);
  const cached = viewsCache.get(variant.id);
  if (cached) return cached;
  const views = allPermutations(variant.n).map((perm) =>
    Object.freeze({
      perm: Object.freeze(perm),
      pos: Object.freeze(positionsOf(perm)),
      rank: permutationRank(perm),
      n: variant.n,
    }),
  );
  viewsCache.set(variant.id, views);
  return views;
}

/** Canonical rendering of an instance's parameters: sorted key=value pairs. */
function canonicalParams(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join(',');
}

/* --------------------------------------------------------------------- *
 * Instance lookup, memoised.                                             *
 *                                                                        *
 * `full` enumerates n! instances, so rebuilding the array on every        *
 * settlement made a single SEVEN round allocate 5,040 objects and scan    *
 * them linearly. Both caches live HERE, in the consumer, and never inside *
 * the adapter: conformance check 3 must keep calling `family.instances`   *
 * twice for real, and a cached array would make that check tautological.  *
 * --------------------------------------------------------------------- */

const instancesCache = new Map();
const instanceIndexCache = new Map();

function instancesFor(family, n) {
  const key = `${family.code}|${n}`;
  let cached = instancesCache.get(key);
  if (!cached) {
    cached = family.instances(n, { permutationCount: factorialNumber(n) });
    instancesCache.set(key, cached);
  }
  return cached;
}

/**
 * Resolve caller-supplied parameters to the adapter's own frozen instance.
 *
 * The canonical rendering is only an index: the match is still confirmed with
 * `sameParams`, which compares with `===`, so `{c: '0'}` cannot pass as
 * `{c: 0}` merely because the two render alike.
 */
function findInstance(family, n, params) {
  if (typeof params !== 'object' || params === null) return undefined;
  // One read of the caller's object, into a plain snapshot. Everything below
  // inspects the snapshot, so a stateful getter cannot answer the index lookup
  // and the strict comparison differently.
  const snapshot = { ...params };
  const key = `${family.code}|${n}`;
  let index = instanceIndexCache.get(key);
  if (!index) {
    index = new Map();
    for (const instance of instancesFor(family, n)) index.set(canonicalParams(instance.params), instance);
    instanceIndexCache.set(key, index);
  }
  const candidate = index.get(canonicalParams(snapshot));
  return candidate && sameParams(candidate.params, snapshot) ? candidate : undefined;
}

/**
 * The behavioural identity of a single claim: a digest of which outcomes it
 * wins on. Two lines are the SAME claim exactly when their win sets are equal,
 * however differently they are spelled — `first {c:0}` and `slot {c:0,k:0}` are
 * one claim, and a ticket may not carry both. Comparing labels would miss that
 * and hand back the per-line stake ceiling it was meant to enforce.
 */
export function claimSignature(variantId, family, instance) {
  const variant = assertVariant(variantId);
  // Nothing the caller supplies reaches the bitmap. The family is looked up by
  // code and the instance is resolved to the adapter's own frozen instance, so
  // neither a substituted `resolve` nor a stateful `params` getter — one that
  // answers `{c:0}` for the cache key and `{c:1}` for the predicate — can write
  // a signature for a claim it does not name. The caller's `params` is read
  // exactly once, and only to find the real instance.
  const canonical = assertBetFamily(typeof family === 'string' ? family : family?.code);
  if (typeof instance !== 'object' || instance === null) {
    fail('UNKNOWN_INSTANCE', 'Bet instance must be an object', '$.instance');
  }
  // One read, into a local. Validating `instance.params` and then spreading it
  // would touch the property three times, which a stateful getter can answer
  // differently each time.
  const supplied = instance.params;
  if (typeof supplied !== 'object' || supplied === null) {
    fail('UNKNOWN_INSTANCE', 'Bet instance must carry a params object', '$.params');
  }
  const requested = { ...supplied };
  const canonicalInstance = findInstance(canonical, variant.n, requested);
  if (!canonicalInstance) fail('UNKNOWN_INSTANCE', 'Bet parameters are not a legal instance', '$.params');

  // Key on what determines the bitmap — the family code and the adapter's own
  // canonical parameters — never on the label, which is authored metadata.
  const key = `${variant.id}|${canonical.code}|${canonicalParams(canonicalInstance.params)}`;
  const cached = claimSignatureCache.get(key);
  if (cached) return cached;
  const views = viewsFor(variant.id);
  const bitmap = Buffer.alloc(Math.ceil(views.length / 8));
  for (let p = 0; p < views.length; p += 1) {
    if (canonical.resolve(canonicalInstance, views[p]) === true) bitmap[p >> 3] |= 1 << (p & 7);
  }
  const signature = sha256Hex(bitmap);
  claimSignatureCache.set(key, signature);
  return signature;
}

/**
 * Behavioural digest of the bet catalogue.
 *
 * Declaring the codes and multipliers is not enough: a change that *reverses a
 * predicate* would leave a declarative fingerprint untouched while changing how
 * an open liability settles. So this hashes the catalogue's actual behaviour —
 * for every family, in canonical order, every instance's complete win/lose
 * bitmap over all n! permutations. Flip one bit of one predicate and the digest
 * moves, and with it every commitment.
 *
 * Cost is one pass over the full outcome space per variant, memoised.
 */
export function catalogueDigest(variantId) {
  const variant = assertVariant(variantId);
  const cached = catalogueDigestCache.get(variant.id);
  if (cached) return cached;
  const digest = digestCatalogue(variant.id);
  catalogueDigestCache.set(variant.id, digest);
  return digest;
}

/**
 * The uncached digest, parameterised by the family list.
 *
 * Exported so the test suite can digest a *tampered* catalogue through the real
 * code path. A test that reimplements the digest locally proves nothing about
 * the production one — it would pass even if `catalogueDigest` ignored
 * behaviour entirely.
 */
export function digestCatalogue(variantId, families = BET_FAMILIES) {
  const variant = assertVariant(variantId);
  const { n } = variant;
  const views = viewsFor(variant.id);
  const hash = createHash('sha256');
  hash.update(encodeFields(['catalogue', MODULE_VERSION, GAME_ID, variant.id, n, views.length, families.length]));
  const bitmap = Buffer.alloc(Math.ceil(views.length / 8));
  for (const family of families) {
    const instances = family.instances(n, { permutationCount: views.length });
    hash.update(encodeFields(['family', family.code, family.tier, instances.length]));
    for (const instance of instances) {
      bitmap.fill(0);
      for (let p = 0; p < views.length; p += 1) {
        if (family.resolve(instance, views[p]) === true) bitmap[p >> 3] |= 1 << (p & 7);
      }
      // The parameter SCHEMA is bound as well as the behaviour: renaming a
      // parameter key leaves labels and win sets untouched but breaks how an
      // open ticket's params are matched, so it must move the digest.
      hash.update(encodeFields([instance.label, canonicalParams(instance.params), bitmap]));
    }
  }
  return hash.digest('hex');
}

/**
 * The exact field list the adapter fingerprint hashes.
 *
 * Exposed — and parameterised by `overrides` — so the test suite can ask the
 * *production* builder what a tampered configuration would fingerprint to. A
 * test that rebuilt the field list locally would prove nothing: it would pass
 * even if `adapterFingerprint` had stopped binding the catalogue's behaviour
 * altogether. Overriding a field here is the only supported way to answer
 * "would this change move the fingerprint?", and conformance check 11 uses the
 * same door to prove the bound catalogue digest is the recomputed one.
 *
 * @param {string} variantId
 * @param {{catalogueDigest?: string, multipliers?: object, targetRtp?: {n: bigint, d: bigint},
 *          stakeQuantum?: bigint, limits?: object}} [overrides]
 */
export function fingerprintFields(variantId, overrides = {}) {
  const variant = assertVariant(variantId);
  const multipliers = overrides.multipliers ?? variant.multipliers;
  const behaviour = overrides.catalogueDigest ?? catalogueDigest(variant.id);
  const targetRtp = overrides.targetRtp ?? TARGET_RTP;
  const quantum = overrides.stakeQuantum ?? STAKE_QUANTUM;
  const limits = overrides.limits ?? LIMITS;

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
    const multiplier = multipliers[family.code];
    if (!multiplier) fail('INVALID_ADAPTER', `Variant ${variant.id} does not price bet ${family.code}`);
    fields.push(family.code, multiplier.n, multiplier.d);
  }
  fields.push(
    'catalogue-behaviour',
    behaviour,
    targetRtp.n,
    targetRtp.d,
    'floor',
    quantum,
    limits.maxWinMultiple,
    limits.maxLinesPerTicket,
    limits.minLineStakeChips,
    limits.maxLineStakeChips,
    limits.maxTicketStakeChips,
    limits.maxClientSeedBytes,
    limits.maxRoundIdBytes,
    limits.maxLabelBytes,
    limits.requireDistinctLines ? 1 : 0,
  );
  return fields;
}

/**
 * Binds every replay-visible field: declarative configuration *and* the
 * catalogue's behaviour. Any change to elements, predicates, multipliers, the
 * target RTP, the cap, the quantum or the published limits changes this digest,
 * which in turn changes every commitment — an integration cannot silently
 * re-price or re-resolve an open liability.
 */
export function adapterFingerprint(variantId) {
  const variant = assertVariant(variantId);
  const cached = fingerprintCache.get(variant.id);
  if (cached) return cached;
  const digest = sha256Hex(encodeFields(fingerprintFields(variant.id)));
  fingerprintCache.set(variant.id, digest);
  return digest;
}

/**
 * The pre-round publication. Published *before* the player commits a ticket.
 *
 * It must bind the entire derivation input set except the client seed, which
 * the player supplies afterwards. Committing only to `(serverSeed, roundId)`
 * would leave `nonce` and `variantId` free, letting an operator that has seen
 * the ticket search those for a favourable permutation while still opening the
 * published hash honestly. Binding them here closes that door: once the hash is
 * out, the only remaining degree of freedom belongs to the player.
 */
export function seedCommitment(serverSeedHex, context) {
  const seed = normalizeServerSeed(serverSeedHex);
  const seedContext = assertSeedContext(context);
  return sha256Hex(
    encodeFields([
      SEED_COMMIT_DOMAIN,
      Buffer.from(seed, 'hex'),
      GAME_ID,
      seedContext.variantId,
      seedContext.roundId,
      seedContext.nonce,
    ]),
  );
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
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    Buffer.byteLength(label, 'utf8') > LIMITS.maxLabelBytes ||
    !/^[\x20-\x7E]+$/u.test(label)
  ) {
    fail('INVALID_CONTEXT', 'Sampler label must be 1-128 bytes of printable ASCII', '$.label');
  }
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
    seedCommitment: seedCommitment(seed, ctx),
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
    const variant = assertVariant(input.variantId);
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
    // The pre-round commitment is REQUIRED, not optional. Treating a missing or
    // wrongly-typed field as "nothing to check" would let a transcript that was
    // never committed to in advance verify as honest — a fail-open hole.
    if (typeof input.seedCommitment !== 'string' || !/^[0-9a-f]{64}$/u.test(input.seedCommitment)) {
      return reject('INVALID_TRANSCRIPT', 'Pre-round seed commitment is missing or malformed', '$.seedCommitment');
    }
    if (!constantTimeHexEqual(input.seedCommitment, seedCommitment(seed, ctx))) {
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
 * Validate a ticket against the published risk policy and resolve every line to
 * the adapter's own frozen instance.
 *
 * Shared by `openTicket` (which prices nothing and only accepts the bet) and
 * `settleTicket` (which resolves it against a permutation), so the two can never
 * disagree about what a legal ticket is. The validation order is load-bearing
 * and matches the published error table: shape, then per-line limits, then
 * instance legality, then claim distinctness, then the ticket total.
 *
 * @param {string} variantId
 * @param {{lines: ReadonlyArray<{code: string, params: object, stakeChips: bigint}>}} ticket
 */
export function normalizeTicket(variantId, ticket) {
  const variant = assertVariant(variantId);
  if (typeof ticket !== 'object' || ticket === null || !Array.isArray(ticket.lines)) {
    fail('INVALID_TICKET', 'Ticket must carry a lines array', '$.lines');
  }
  // Snapshot by index before validating. Checking `ticket.lines.length` and then
  // iterating with `ticket.lines.map` reads the input twice: an array carrying
  // an own `map` (or a hostile iterator) can report one line to the limit check
  // and hand thirteen to the loop. `Array.prototype.slice` reads length and
  // indices directly, and everything downstream uses only the snapshot.
  const ticketLines = Array.prototype.slice.call(ticket.lines);
  if (ticketLines.length === 0) fail('INVALID_TICKET', 'Ticket must carry at least one line', '$.lines');
  if (ticketLines.length > LIMITS.maxLinesPerTicket) {
    fail('INVALID_TICKET', 'Ticket exceeds the published line limit', '$.lines');
  }

  let totalStake = 0n;
  // A ticket is a set of DISTINCT claims, compared by what they actually win
  // on rather than by how they are spelled. Duplicating a claim would be an
  // end-run around the per-line stake ceiling, which exists to bound single-bet
  // exposure; the client merges repeats by raising the stake instead. Enforcing
  // it here is also what makes the maximum-credit optimisation in
  // docs/MATH.md section 8 a true maximum rather than a lower bound.
  const claims = new Set();
  const lines = ticketLines.map((line, index) => {
    const path = `$.lines[${index}]`;
    if (typeof line !== 'object' || line === null) fail('INVALID_TICKET', 'Ticket line must be an object', path);
    const family = assertBetFamily(line.code);
    const stake = line.stakeChips;
    if (typeof stake !== 'bigint') fail('INVALID_TICKET', 'Stake must be a BigInt chip amount', `${path}.stakeChips`);
    if (stake < LIMITS.minLineStakeChips || stake > LIMITS.maxLineStakeChips) {
      fail('INVALID_TICKET', 'Line stake is outside the published limits', `${path}.stakeChips`);
    }
    if (stake % STAKE_QUANTUM !== 0n) {
      fail('INVALID_TICKET', 'Line stake is not a multiple of the stake quantum', `${path}.stakeChips`);
    }
    const instance = findInstance(family, variant.n, line.params);
    if (!instance) fail('UNKNOWN_INSTANCE', 'Bet parameters are not a legal instance', `${path}.params`);
    // Identity is behavioural, not syntactic: `first {c:0}` and
    // `slot {c:0,k:0}` win on exactly the same outcomes and are one claim.
    const claim = claimSignature(variant.id, family, instance);
    if (LIMITS.requireDistinctLines && claims.has(claim)) {
      fail('DUPLICATE_LINE', 'A ticket cannot carry the same claim twice; raise the stake instead', path);
    }
    claims.add(claim);
    totalStake += stake;
    return Object.freeze({
      code: family.code,
      family,
      instance,
      params: instance.params,
      stakeChips: stake,
      claim,
      multiplier: variant.multipliers[family.code],
    });
  });

  if (totalStake > LIMITS.maxTicketStakeChips) {
    fail('INVALID_TICKET', 'Ticket exceeds the published total stake limit', '$.lines');
  }
  return Object.freeze({ variantId: variant.id, lines: Object.freeze(lines), totalStakeChips: totalStake });
}

/**
 * Canonical line order for every digest: sorted by `(code, canonical params)`.
 *
 * A retry that reorders the same lines must produce the same ticket digest, or
 * the derived idempotency key would change and the wallet could be debited
 * twice for one intent. The distinct-claim rule makes this order total: two
 * lines can never share both a code and a parameter rendering.
 */
function canonicalLineOrder(lines) {
  return [...lines].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const pa = canonicalParams(a.params);
    const pb = canonicalParams(b.params);
    return pa === pb ? 0 : pa < pb ? -1 : 1;
  });
}

/**
 * Digest of the bet the player actually placed.
 *
 * This is the missing half of a provably-fair round. Commit-reveal proves the
 * *draw* was honest; on its own it says nothing about what was staked, which is
 * the single most common misunderstanding of these systems. Binding this digest
 * into a signed receipt (see `makeReceipt`) is what makes the ticket
 * non-repudiable — and it needs an operator signature, so it is a trust
 * assumption of a different kind from the commitment. docs/ENGINE.md §11 and
 * the README state that boundary in those words.
 */
export function ticketDigest(context, ticket) {
  const seedContext = assertSeedContext(context);
  // Always re-validate. `normalizeTicket` is idempotent — a normalised ticket
  // carries exactly the fields it reads — so there is no fast path that could
  // let an already-blessed object skip the risk policy.
  const normalized = normalizeTicket(seedContext.variantId, ticket);
  const ordered = canonicalLineOrder(normalized.lines);
  const fields = [
    TICKET_DIGEST_DOMAIN,
    TICKET_SCHEMA,
    MODULE_VERSION,
    GAME_ID,
    seedContext.variantId,
    seedContext.roundId,
    seedContext.nonce,
    ordered.length,
  ];
  for (const line of ordered) fields.push(line.code, canonicalParams(line.params), line.stakeChips);
  fields.push(normalized.totalStakeChips);
  return sha256Hex(encodeFields(fields));
}

/**
 * Action-bound idempotency key. Derived from the ticket digest rather than
 * chosen by the caller, so a retry of the same intent is recognised as the same
 * action and cannot double-debit, while a different ticket can never collide
 * with an in-flight one.
 */
export function idempotencyKeyFor(action, ticketDigest) {
  if (action !== 'open' && action !== 'settle') {
    fail('IDEMPOTENCY_CONFLICT', 'Idempotency action must be "open" or "settle"', '$.action');
  }
  assertCommitmentHex(ticketDigest, '$.ticketDigest');
  return sha256Hex(encodeFields([IDEMPOTENCY_DOMAIN, MODULE_VERSION, GAME_ID, action, ticketDigest]));
}

/**
 * Accept a ticket into a committed round. Prices nothing and reveals nothing:
 * it validates against the published risk policy, fixes the canonical line
 * order, and returns the digest and idempotency key the RGS debits under.
 */
export function openTicket(context, ticket) {
  const seedContext = assertSeedContext(context);
  const normalized = normalizeTicket(seedContext.variantId, ticket);
  const digest = ticketDigest(seedContext, normalized);
  return Object.freeze({
    schema: TICKET_SCHEMA,
    moduleVersion: MODULE_VERSION,
    gameId: GAME_ID,
    variantId: seedContext.variantId,
    roundId: seedContext.roundId,
    nonce: seedContext.nonce,
    lines: Object.freeze(
      canonicalLineOrder(normalized.lines).map((line) =>
        Object.freeze({ code: line.code, params: line.params, stakeChips: line.stakeChips }),
      ),
    ),
    totalStakeChips: normalized.totalStakeChips,
    ticketDigest: digest,
    idempotencyKey: idempotencyKeyFor('open', digest),
  });
}

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
  if (typeof transcript !== 'object' || transcript === null) {
    fail('INVALID_TRANSCRIPT', 'Transcript must be an object', '$.transcript');
  }
  const variant = assertVariant(transcript.variantId);
  const normalized = normalizeTicket(variant.id, ticket);

  // Defence in depth: settlement never trusts a caller-supplied permutation,
  // even though the production path only ever passes a verified transcript.
  // Snapshot first, exactly as the ticket lines are snapshotted: validating
  // through the ITERATOR protocol and then consuming by INDEX is a double read,
  // and an array carrying an own `Symbol.iterator` can answer the two reads
  // differently — presenting a genuine permutation to the check and something
  // else to `positionsOf`. `Array.prototype.slice` reads length and indices,
  // and every use below is of the snapshot.
  if (!Array.isArray(transcript.permutation)) {
    fail('INVALID_TRANSCRIPT', 'Permutation has the wrong length', '$.transcript.permutation');
  }
  const perm = Array.prototype.slice.call(transcript.permutation);
  if (perm.length !== variant.n) {
    fail('INVALID_TRANSCRIPT', 'Permutation has the wrong length', '$.transcript.permutation');
  }
  const seen = new Set();
  for (let slot = 0; slot < perm.length; slot += 1) {
    const element = perm[slot];
    if (!Number.isInteger(element) || element < 0 || element >= variant.n || seen.has(element)) {
      fail('INVALID_TRANSCRIPT', 'Permutation is not a permutation of the elements', '$.transcript.permutation');
    }
    seen.add(element);
  }
  const ctx = Object.freeze({
    perm: Object.freeze(perm),
    pos: Object.freeze(positionsOf(perm)),
    rank: permutationRank(perm),
    n: variant.n,
  });

  let payout = 0n;
  const lines = normalized.lines.map((line, index) => {
    const won = line.family.resolve(line.instance, ctx) === true;
    const gross = won ? exactChips(line.stakeChips, line.multiplier, `$.lines[${index}].payout`) : 0n;
    payout += gross;
    return Object.freeze({ code: line.code, params: line.params, stakeChips: line.stakeChips, won, grossChips: gross });
  });

  const totalStake = normalized.totalStakeChips;
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

/** Digest of a settlement, over the same canonical line order as the ticket. */
export function settlementDigest(variantId, settlement) {
  const variant = assertVariant(variantId);
  if (typeof settlement !== 'object' || settlement === null || !Array.isArray(settlement.lines)) {
    fail('INVALID_TICKET', 'Settlement must carry a lines array', '$.settlement.lines');
  }
  const ordered = canonicalLineOrder(Array.prototype.slice.call(settlement.lines));
  const fields = [
    SETTLEMENT_DIGEST_DOMAIN,
    MODULE_VERSION,
    GAME_ID,
    variant.id,
    settlement.totalStakeChips,
    settlement.grossChips,
    settlement.creditedChips,
    settlement.capped ? 1 : 0,
    settlement.netChips,
    ordered.length,
  ];
  for (const line of ordered) {
    fields.push(line.code, canonicalParams(line.params), line.stakeChips, line.won ? 1 : 0, line.grossChips);
  }
  return sha256Hex(encodeFields(fields));
}

/* -------------------------------------------------------------------- *
 * Receipts — the binding between the round and the bet.                  *
 * -------------------------------------------------------------------- */

/**
 * The bytes an operator signs to make a round non-repudiable.
 *
 * The commitment chain proves the permutation was fixed before the ticket
 * existed and that the revealed seed opens it. It does **not** prove what the
 * player staked, what was settled, or that the operator ever acknowledged the
 * bet — a player holding only a transcript can prove the draw was honest and
 * cannot prove they were on it. The receipt closes exactly that gap by binding,
 * in one signed object: the pre-round publication (`seedCommitment`), the round
 * (`commitment`), the ticket (`ticketDigest`) and the outcome
 * (`settlementDigest`).
 *
 * The signature is an operator key, so this is a *different* trust assumption
 * from commit-reveal: it is non-repudiation against a named signer, not
 * verification from first principles. docs/ENGINE.md §11 says so in those terms.
 */
export function receiptCoreBytes(receipt) {
  return encodeFields([
    RECEIPT_DOMAIN,
    RECEIPT_SCHEMA,
    MODULE_VERSION,
    GAME_ID,
    receipt.adapterVersion,
    receipt.adapterFingerprint,
    receipt.variantId,
    receipt.roundId,
    receipt.nonce,
    receipt.seedCommitment,
    receipt.commitment,
    receipt.ticketDigest,
    receipt.settlementDigest,
    receipt.totalStakeChips,
    receipt.creditedChips,
    receipt.signerId,
  ]);
}

/**
 * Build the unsigned receipt for a settled round.
 *
 * @param {{transcript: object, ticket: object, settlement: object, signerId: string}} input
 */
export function makeReceipt({ transcript, ticket, settlement, signerId }) {
  if (typeof transcript !== 'object' || transcript === null) {
    fail('INVALID_TRANSCRIPT', 'Receipt requires a transcript', '$.transcript');
  }
  const variant = assertVariant(transcript.variantId);
  if (typeof signerId !== 'string' || signerId.length === 0 || !/^[\x20-\x7E]{1,128}$/u.test(signerId)) {
    fail('INVALID_CONTEXT', 'Receipt signer id must be 1-128 bytes of printable ASCII', '$.signerId');
  }
  assertCommitmentHex(transcript.seedCommitment, '$.transcript.seedCommitment');
  assertCommitmentHex(transcript.commitment, '$.transcript.commitment');
  const context = {
    variantId: variant.id,
    roundId: transcript.roundId,
    nonce: transcript.nonce,
  };
  const normalized = normalizeTicket(variant.id, ticket);
  const core = {
    schema: RECEIPT_SCHEMA,
    moduleVersion: MODULE_VERSION,
    gameId: GAME_ID,
    adapterVersion: ADAPTER_VERSION,
    adapterFingerprint: adapterFingerprint(variant.id),
    variantId: variant.id,
    roundId: assertRoundId(transcript.roundId),
    nonce: assertNonce(transcript.nonce),
    seedCommitment: transcript.seedCommitment,
    commitment: transcript.commitment,
    ticketDigest: ticketDigest(context, normalized),
    settlementDigest: settlementDigest(variant.id, settlement),
    totalStakeChips: settlement.totalStakeChips,
    creditedChips: settlement.creditedChips,
    signerId,
  };
  return Object.freeze({
    ...core,
    digest: sha256Hex(receiptCoreBytes(core)),
    signature: null,
  });
}

/* --- Ed25519 helpers -------------------------------------------------- *
 * Deterministic key material from a 32-byte seed, so a signed receipt is a
 * reproducible wire-format fixture. RFC 8032 signatures are deterministic, so
 * the fixture's signature bytes are stable across machines and Node versions.
 * ---------------------------------------------------------------------- */

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519KeyPairFromSeed(seedHex) {
  const seed = normalizeServerSeed(seedHex);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return Object.freeze({
    privateKey,
    publicKey,
    /** Raw 32-byte Ed25519 public key, the form an operator publishes. */
    publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString('hex'),
  });
}

/** Sign a receipt's core bytes. Returns the receipt with `signature` filled in. */
export function signReceipt(receipt, privateKey) {
  const signature = cryptoSign(null, receiptCoreBytes(receipt), privateKey).toString('hex');
  return Object.freeze({ ...receipt, signature });
}

/**
 * Verify a receipt against the round it claims to describe.
 *
 * Recomputes every digest through the production code path and, when a public
 * key is supplied, checks the operator signature. Returns a typed result rather
 * than throwing, exactly like `verifyTranscript`, and reports
 * `signatureChecked: false` when no key was given rather than implying the
 * signature was accepted.
 */
export function verifyReceipt(receipt, { transcript, ticket, settlement, publicKey } = {}) {
  const reject = (code, message, path) => Object.freeze({ ok: false, code, message, path, signatureChecked: false });
  try {
    if (typeof receipt !== 'object' || receipt === null) return reject('INVALID_TICKET', 'Receipt must be an object', '$');
    if (receipt.schema !== RECEIPT_SCHEMA) return reject('UNSUPPORTED_VERSION', 'Unknown receipt schema', '$.schema');
    if (receipt.moduleVersion !== MODULE_VERSION) return reject('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
    if (receipt.gameId !== GAME_ID || receipt.adapterVersion !== ADAPTER_VERSION) {
      return reject('ADAPTER_MISMATCH', 'Receipt belongs to another adapter', '$.adapterVersion');
    }
    const variant = assertVariant(receipt.variantId);
    if (receipt.adapterFingerprint !== adapterFingerprint(variant.id)) {
      return reject('ADAPTER_MISMATCH', 'Adapter fingerprint does not match this build', '$.adapterFingerprint');
    }
    if (typeof transcript !== 'object' || transcript === null) {
      return reject('INVALID_TRANSCRIPT', 'Receipt verification requires the transcript', '$.transcript');
    }
    if (
      transcript.variantId !== receipt.variantId ||
      transcript.roundId !== receipt.roundId ||
      transcript.nonce !== receipt.nonce
    ) {
      return reject('TRANSCRIPT_MISMATCH', 'Receipt does not describe this round', '$.roundId');
    }
    if (!constantTimeHexEqual(String(transcript.seedCommitment), String(receipt.seedCommitment))) {
      return reject('COMMITMENT_MISMATCH', 'Receipt seed commitment does not match the transcript', '$.seedCommitment');
    }
    if (!constantTimeHexEqual(String(transcript.commitment), String(receipt.commitment))) {
      return reject('COMMITMENT_MISMATCH', 'Receipt commitment does not match the transcript', '$.commitment');
    }
    const context = { variantId: variant.id, roundId: receipt.roundId, nonce: receipt.nonce };
    const recomputedTicket = ticketDigest(context, ticket);
    if (!constantTimeHexEqual(recomputedTicket, String(receipt.ticketDigest))) {
      return reject('TRANSCRIPT_MISMATCH', 'Receipt does not bind this ticket', '$.ticketDigest');
    }
    const recomputedSettlement = settlementDigest(variant.id, settlement);
    if (!constantTimeHexEqual(recomputedSettlement, String(receipt.settlementDigest))) {
      return reject('TRANSCRIPT_MISMATCH', 'Receipt does not bind this settlement', '$.settlementDigest');
    }
    if (receipt.totalStakeChips !== settlement.totalStakeChips || receipt.creditedChips !== settlement.creditedChips) {
      return reject('TRANSCRIPT_MISMATCH', 'Receipt money fields disagree with the settlement', '$.creditedChips');
    }
    const recomputedDigest = sha256Hex(receiptCoreBytes(receipt));
    if (!constantTimeHexEqual(recomputedDigest, String(receipt.digest))) {
      return reject('COMMITMENT_MISMATCH', 'Receipt digest does not cover its own fields', '$.digest');
    }
    if (publicKey === undefined || publicKey === null) {
      return Object.freeze({ ok: true, digest: recomputedDigest, signatureChecked: false, signatureValid: null });
    }
    if (typeof receipt.signature !== 'string' || !/^[0-9a-f]+$/u.test(receipt.signature)) {
      return reject('INVALID_TICKET', 'Receipt is unsigned or the signature is malformed', '$.signature');
    }
    const signatureValid = cryptoVerify(
      null,
      receiptCoreBytes(receipt),
      publicKey,
      Buffer.from(receipt.signature, 'hex'),
    );
    if (!signatureValid) {
      return Object.freeze({
        ok: false,
        code: 'COMMITMENT_MISMATCH',
        message: 'Receipt signature does not verify under the supplied operator key',
        path: '$.signature',
        signatureChecked: true,
        signatureValid: false,
      });
    }
    return Object.freeze({ ok: true, digest: recomputedDigest, signatureChecked: true, signatureValid: true });
  } catch (error) {
    if (error instanceof AetherOrderError) return reject(error.code, error.message, error.path);
    return reject('INVALID_TICKET', 'Receipt verification failed', '$');
  }
}

/* -------------------------------------------------------------------- *
 * Wire serialisation and round snapshots.                                *
 * -------------------------------------------------------------------- */

const TRANSCRIPT_FIELDS = Object.freeze([
  'schema',
  'moduleVersion',
  'gameId',
  'adapterVersion',
  'adapterFingerprint',
  'variantId',
  'roundId',
  'clientSeed',
  'nonce',
  'n',
  'permutation',
  'previousCommitment',
  'seedCommitment',
  'commitment',
]);

/** Canonical JSON with a published byte ceiling. Key order is deterministic. */
export function serializeTranscript(transcript) {
  const picked = {};
  for (const field of TRANSCRIPT_FIELDS) {
    if (!(field in transcript)) fail('INVALID_TRANSCRIPT', `Transcript is missing ${field}`, `$.${field}`);
    picked[field] = field === 'permutation' ? Array.prototype.slice.call(transcript[field]) : transcript[field];
  }
  const json = canonicalJson(picked);
  if (Buffer.byteLength(json, 'utf8') > LIMITS.maxTranscriptBytes) {
    fail('INVALID_TRANSCRIPT', 'Serialised transcript exceeds the published byte limit', '$');
  }
  return json;
}

/**
 * Parse and strictly validate a transcript off the wire. Unknown fields are
 * dropped rather than carried, so a hostile payload cannot smuggle state past a
 * verifier that only re-derives the declared ones.
 */
export function deserializeTranscript(input) {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > LIMITS.maxTranscriptBytes) {
      fail('INVALID_TRANSCRIPT', 'Serialised transcript exceeds the published byte limit', '$');
    }
    try {
      value = JSON.parse(value);
    } catch {
      return fail('INVALID_TRANSCRIPT', 'Transcript is not valid JSON', '$');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_TRANSCRIPT', 'Transcript must be an object', '$');
  }
  if (value.schema !== TRANSCRIPT_SCHEMA) fail('UNSUPPORTED_VERSION', 'Unknown transcript schema', '$.schema');
  if (value.moduleVersion !== MODULE_VERSION) fail('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
  const variant = assertVariant(value.variantId);
  const ctx = assertRoundContext({
    variantId: value.variantId,
    roundId: value.roundId,
    clientSeed: value.clientSeed,
    nonce: value.nonce,
  });
  if (value.gameId !== GAME_ID) fail('ADAPTER_MISMATCH', 'Transcript belongs to another game', '$.gameId');
  if (typeof value.adapterVersion !== 'string') fail('INVALID_TRANSCRIPT', 'Adapter version must be a string', '$.adapterVersion');
  assertCommitmentHex(value.adapterFingerprint, '$.adapterFingerprint');
  assertCommitmentHex(value.previousCommitment, '$.previousCommitment');
  assertCommitmentHex(value.seedCommitment, '$.seedCommitment');
  assertCommitmentHex(value.commitment, '$.commitment');
  if (value.n !== variant.n) fail('INVALID_TRANSCRIPT', 'Sphere count does not match the variant', '$.n');
  if (!Array.isArray(value.permutation)) fail('INVALID_TRANSCRIPT', 'Permutation must be an array', '$.permutation');
  const permutation = Array.prototype.slice.call(value.permutation);
  if (permutation.length !== variant.n) fail('INVALID_TRANSCRIPT', 'Permutation has the wrong length', '$.permutation');
  const seen = new Set();
  for (let slot = 0; slot < permutation.length; slot += 1) {
    const element = permutation[slot];
    if (!Number.isInteger(element) || element < 0 || element >= variant.n || seen.has(element)) {
      fail('INVALID_TRANSCRIPT', 'Permutation is not a permutation of the elements', '$.permutation');
    }
    seen.add(element);
  }
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    moduleVersion: MODULE_VERSION,
    gameId: GAME_ID,
    adapterVersion: value.adapterVersion,
    adapterFingerprint: value.adapterFingerprint,
    variantId: variant.id,
    roundId: ctx.roundId,
    clientSeed: ctx.clientSeed,
    nonce: ctx.nonce,
    n: variant.n,
    permutation: Object.freeze(permutation),
    previousCommitment: value.previousCommitment,
    seedCommitment: value.seedCommitment,
    commitment: value.commitment,
  });
}

const SNAPSHOT_PHASES = Object.freeze(['COMMITTED', 'TICKETED', 'SETTLED']);

/**
 * A resumable round. This is what an RGS persists between the pre-round
 * publication and the reveal, and what a client restores after a disconnect:
 * every phase carries exactly the fields that phase has produced, so a
 * half-written snapshot cannot be mistaken for a complete round.
 */
export function makeRoundSnapshot({ phase, seedContext, seedCommitment: commitmentHex, transcript, ticket, settlement, receipt }) {
  if (!SNAPSHOT_PHASES.includes(phase)) fail('INVALID_TRANSCRIPT', 'Unknown round phase', '$.phase');
  const ctx = assertSeedContext(seedContext);
  assertCommitmentHex(commitmentHex, '$.seedCommitment');
  if (phase !== 'COMMITTED' && (typeof ticket !== 'object' || ticket === null)) {
    fail('INVALID_TICKET', 'A TICKETED or SETTLED snapshot must carry its ticket', '$.ticket');
  }
  if (phase === 'SETTLED' && (typeof transcript !== 'object' || transcript === null)) {
    fail('INVALID_TRANSCRIPT', 'A SETTLED snapshot must carry its transcript', '$.transcript');
  }
  return Object.freeze({
    schema: ROUND_SNAPSHOT_SCHEMA,
    moduleVersion: MODULE_VERSION,
    gameId: GAME_ID,
    phase,
    variantId: ctx.variantId,
    roundId: ctx.roundId,
    nonce: ctx.nonce,
    seedCommitment: commitmentHex,
    transcript: transcript ?? null,
    ticket: ticket ?? null,
    settlement: settlement ?? null,
    receipt: receipt ?? null,
  });
}

export function serializeRoundSnapshot(snapshot) {
  const json = canonicalJson(snapshot);
  if (Buffer.byteLength(json, 'utf8') > LIMITS.maxSnapshotBytes) {
    fail('INVALID_TRANSCRIPT', 'Serialised snapshot exceeds the published byte limit', '$');
  }
  return json;
}

export function deserializeRoundSnapshot(input) {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > LIMITS.maxSnapshotBytes) {
      fail('INVALID_TRANSCRIPT', 'Serialised snapshot exceeds the published byte limit', '$');
    }
    try {
      value = JSON.parse(value);
    } catch {
      return fail('INVALID_TRANSCRIPT', 'Snapshot is not valid JSON', '$');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_TRANSCRIPT', 'Snapshot must be an object', '$');
  }
  if (value.schema !== ROUND_SNAPSHOT_SCHEMA) fail('UNSUPPORTED_VERSION', 'Unknown snapshot schema', '$.schema');
  if (value.moduleVersion !== MODULE_VERSION) fail('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
  return makeRoundSnapshot({
    phase: value.phase,
    seedContext: { variantId: value.variantId, roundId: value.roundId, nonce: value.nonce },
    seedCommitment: value.seedCommitment,
    transcript: value.transcript ?? undefined,
    ticket: reviveChips(value.ticket) ?? undefined,
    settlement: reviveChips(value.settlement) ?? undefined,
    receipt: reviveChips(value.receipt) ?? undefined,
  });
}

/** Money fields travel as base-10 strings in canonical JSON; revive them exactly. */
const CHIP_FIELDS = new Set(['stakeChips', 'totalStakeChips', 'grossChips', 'creditedChips', 'netChips']);

function reviveChips(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(reviveChips);
  if (typeof node !== 'object') return node;
  const out = {};
  for (const [key, raw] of Object.entries(node)) {
    if (CHIP_FIELDS.has(key)) {
      if (typeof raw === 'bigint') {
        out[key] = raw;
      } else if (typeof raw === 'string' && /^-?\d+$/u.test(raw)) {
        out[key] = BigInt(raw);
      } else {
        fail('INVALID_TICKET', `Money field ${key} must be an integer chip amount`, `$.${key}`);
      }
    } else {
      out[key] = reviveChips(raw);
    }
  }
  return Object.freeze(out);
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
