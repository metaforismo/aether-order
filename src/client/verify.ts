/**
 * The verifier — an independent re-derivation, in the browser.
 *
 * This is deliberately a *second* implementation. The whole point of
 * commit-reveal is that the player does not have to take the operator's word for
 * the draw, and a client that asks the server "was that fair?" has verified
 * nothing. So the canonical field encoder, the rejection sampler, the shuffle
 * and the two hashes are re-implemented here against docs/ENGINE.md §7 and
 * checked against the engine's own output by `tests/verifier.test.ts` — the
 * porting checklist in §10: "If a single commitment digest differs, the port is
 * wrong."
 *
 * SHA-256, HMAC-SHA256 and Ed25519 come from WebCrypto (docs/DESIGN.md §7.3);
 * only the encoding and the shuffle are ours. Where Ed25519 is unavailable the
 * receipt card reads "signature not checked on this device", reached by reading
 * `bindingsVerified` and never `ok` (§7.8).
 */

const MODULE_VERSION = 'reveal-engine/permutation-v1';
const TRANSCRIPT_SCHEMA = 'reveal-engine/permutation-transcript-v1';
const RECEIPT_SCHEMA = 'reveal-engine/permutation-receipt-v1';
const SEED_COMMIT_DOMAIN = 'aether-order/seed-commit-v1';
const RECEIPT_DOMAIN = 'aether-order/receipt-v1';
const GAME_ID = 'aether-order';
const RANGE = 1n << 256n;

export type Field = string | Uint8Array | bigint | number;

const utf8 = new TextEncoder();

function uint32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function bytesOf(field: Field): Uint8Array {
  if (typeof field === 'bigint') return utf8.encode(field.toString(10));
  if (typeof field === 'number') {
    if (!Number.isSafeInteger(field)) throw new Error('Canonical number is not safe');
    return utf8.encode(String(field));
  }
  if (typeof field === 'string') return utf8.encode(field);
  return field;
}

/** docs/ENGINE.md §7.1: uint32 field count, then uint32 length + bytes each. */
export function encodeFields(fields: readonly Field[]): Uint8Array {
  const parts = fields.map(bytesOf);
  let size = 4;
  for (const part of parts) size += 4 + part.byteLength;
  const out = new Uint8Array(size);
  out.set(uint32be(parts.length), 0);
  let offset = 4;
  for (const part of parts) {
    out.set(uint32be(part.byteLength), offset);
    offset += 4;
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/u.test(hex) || hex.length % 2 !== 0) throw new Error('Not hexadecimal');
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1)
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', payload as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacKey(seed: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    seed as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function hmacBig(key: CryptoKey, payload: Uint8Array): Promise<bigint> {
  const mac = await crypto.subtle.sign('HMAC', key, payload as BufferSource);
  return BigInt(`0x${bytesToHex(new Uint8Array(mac))}`);
}

export interface RoundContext {
  gameId: string;
  variantId: string;
  roundId: string;
  clientSeed: string;
  nonce: number;
}

/** docs/ENGINE.md §7.3. The loop is unbounded on purpose: a cap reintroduces bias. */
async function uniformBelow(
  key: CryptoKey,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: bigint,
): Promise<bigint> {
  const limit = RANGE - (RANGE % modulus);
  for (let rejection = 0n; ; rejection += 1n) {
    const payload = encodeFields([
      'sampler',
      MODULE_VERSION,
      context.gameId,
      context.variantId,
      context.roundId,
      context.clientSeed,
      context.nonce,
      label,
      counter,
      rejection,
      modulus,
    ]);
    const value = await hmacBig(key, payload);
    if (value < limit) return value % modulus;
  }
}

/** docs/ENGINE.md §7.4: descending Fisher-Yates over the sampler's draws. */
export async function derivePermutation(
  serverSeedHex: string,
  n: number,
  context: RoundContext,
): Promise<number[]> {
  const key = await hmacKey(hexToBytes(serverSeedHex));
  const result = Array.from({ length: n }, (_unused, index) => index);
  for (let counter = 0; counter < n - 1; counter += 1) {
    const index = n - 1 - counter;
    const pick = Number(
      await uniformBelow(key, context, 'shuffle', counter, BigInt(n - counter)),
    );
    const saved = result[index] as number;
    result[index] = result[pick] as number;
    result[pick] = saved;
  }
  return result;
}

export async function seedCommitment(
  serverSeedHex: string,
  context: { variantId: string; roundId: string; nonce: number },
): Promise<string> {
  return sha256Hex(
    encodeFields([
      SEED_COMMIT_DOMAIN,
      hexToBytes(serverSeedHex),
      GAME_ID,
      context.variantId,
      context.roundId,
      context.nonce,
    ]),
  );
}

export interface TranscriptLike {
  schema: string;
  moduleVersion: string;
  gameId: string;
  adapterVersion: string;
  adapterFingerprint: string;
  variantId: string;
  roundId: string;
  clientSeed: string;
  nonce: number;
  n: number;
  permutation: number[];
  previousCommitment: string;
  seedCommitment: string;
  commitment: string;
}

function transcriptBytes(transcript: TranscriptLike): Uint8Array {
  const fields: Field[] = [
    'AETHER ORDER permutation transcript',
    TRANSCRIPT_SCHEMA,
    MODULE_VERSION,
    transcript.gameId,
    transcript.adapterVersion,
    transcript.adapterFingerprint,
    transcript.variantId,
    transcript.roundId,
    transcript.clientSeed,
    transcript.nonce,
    transcript.n,
    transcript.permutation.length,
  ];
  transcript.permutation.forEach((element, slot) => fields.push(slot, element));
  fields.push(transcript.previousCommitment);
  return encodeFields(fields);
}

export async function transcriptCommitment(
  serverSeedHex: string,
  transcript: TranscriptLike,
): Promise<string> {
  return sha256Hex(
    encodeFields([
      'commitment',
      MODULE_VERSION,
      hexToBytes(serverSeedHex),
      transcriptBytes(transcript),
    ]),
  );
}

export interface LocalVerification {
  ok: boolean;
  code: string | null;
  detail: string;
  derivedPermutation: number[];
  seedCommitment: string;
  commitment: string;
}

/**
 * docs/ENGINE.md §7.10, in the order it lists: fail closed on an unknown schema,
 * re-derive, and require the pre-round seed commitment rather than treating a
 * missing one as nothing to check.
 */
export async function verifyTranscriptLocally(
  serverSeedHex: string,
  transcript: TranscriptLike,
): Promise<LocalVerification> {
  const empty = { derivedPermutation: [] as number[], seedCommitment: '', commitment: '' };
  if (transcript.schema !== TRANSCRIPT_SCHEMA || transcript.moduleVersion !== MODULE_VERSION)
    return { ok: false, code: 'UNSUPPORTED_VERSION', detail: '$.schema', ...empty };
  if (!/^[0-9a-f]{64}$/u.test(transcript.seedCommitment))
    return { ok: false, code: 'INVALID_TRANSCRIPT', detail: '$.seedCommitment', ...empty };

  const derived = await derivePermutation(serverSeedHex, transcript.n, {
    gameId: transcript.gameId,
    variantId: transcript.variantId,
    roundId: transcript.roundId,
    clientSeed: transcript.clientSeed,
    nonce: transcript.nonce,
  });
  const seedHash = await seedCommitment(serverSeedHex, transcript);
  const commitment = await transcriptCommitment(serverSeedHex, transcript);
  const result = { derivedPermutation: derived, seedCommitment: seedHash, commitment };

  if (derived.some((element, slot) => element !== transcript.permutation[slot]))
    return { ok: false, code: 'TRANSCRIPT_MISMATCH', detail: '$.permutation', ...result };
  if (seedHash !== transcript.seedCommitment)
    return { ok: false, code: 'COMMITMENT_MISMATCH', detail: '$.seedCommitment', ...result };
  if (commitment !== transcript.commitment)
    return { ok: false, code: 'COMMITMENT_MISMATCH', detail: '$.commitment', ...result };
  return { ok: true, code: null, detail: 'verified locally', ...result };
}

export interface ReceiptLike {
  schema: string;
  moduleVersion: string;
  gameId: string;
  adapterVersion: string;
  adapterFingerprint: string;
  variantId: string;
  roundId: string;
  nonce: number;
  seedCommitment: string;
  commitment: string;
  ticketDigest: string;
  settlementDigest: string;
  totalStake: string;
  credited: string;
  signerId: string;
  digest: string;
  signature: string | null;
}

function receiptCore(receipt: ReceiptLike): Uint8Array {
  return encodeFields([
    RECEIPT_DOMAIN,
    RECEIPT_SCHEMA,
    MODULE_VERSION,
    receipt.gameId,
    receipt.adapterVersion,
    receipt.adapterFingerprint,
    receipt.variantId,
    receipt.roundId,
    receipt.nonce,
    receipt.seedCommitment,
    receipt.commitment,
    receipt.ticketDigest,
    receipt.settlementDigest,
    BigInt(receipt.totalStake),
    BigInt(receipt.credited),
    receipt.signerId,
  ]);
}

export type ReceiptState = 'verified' | 'unchecked' | 'mismatch';

export interface LocalReceiptVerification {
  ok: boolean;
  state: ReceiptState;
  code: string | null;
  path: string;
  digest: string;
  bindingsVerified: boolean;
  signatureChecked: boolean;
}

/**
 * A tri-state, and only one of the three is a pass (docs/ENGINE.md §7.8).
 *
 * With no public key — or no Ed25519 in this browser — every binding is still
 * recomputed and checked, and the result is `ok: false` with
 * `bindingsVerified: true`. The card that renders it must not draw that as a
 * pass, and it must branch on `bindingsVerified`, never on `ok`.
 */
export async function verifyReceiptLocally(
  receipt: ReceiptLike,
  transcript: TranscriptLike,
  publicKeyHex: string | null,
): Promise<LocalReceiptVerification> {
  const fail = (code: string, path: string): LocalReceiptVerification => ({
    ok: false,
    state: 'mismatch',
    code,
    path,
    digest: '',
    bindingsVerified: false,
    signatureChecked: false,
  });
  if (receipt.schema !== RECEIPT_SCHEMA || receipt.moduleVersion !== MODULE_VERSION)
    return fail('UNSUPPORTED_VERSION', '$.schema');
  if (receipt.seedCommitment !== transcript.seedCommitment)
    return fail('TRANSCRIPT_MISMATCH', '$.seedCommitment');
  if (receipt.commitment !== transcript.commitment)
    return fail('TRANSCRIPT_MISMATCH', '$.commitment');
  if (
    receipt.gameId !== transcript.gameId ||
    receipt.variantId !== transcript.variantId ||
    receipt.roundId !== transcript.roundId ||
    receipt.nonce !== transcript.nonce ||
    receipt.adapterFingerprint !== transcript.adapterFingerprint
  )
    return fail('ADAPTER_MISMATCH', '$.adapterFingerprint');

  const digest = await sha256Hex(receiptCore(receipt));
  if (digest !== receipt.digest) return fail('COMMITMENT_MISMATCH', '$.digest');

  if (!receipt.signature || !publicKeyHex)
    return {
      ok: false,
      state: 'unchecked',
      code: 'SIGNATURE_UNCHECKED',
      path: '$.signature',
      digest,
      bindingsVerified: true,
      signatureChecked: false,
    };

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex) as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(receipt.signature) as BufferSource,
      receiptCore(receipt) as BufferSource,
    );
    if (!valid)
      return {
        ok: false,
        state: 'mismatch',
        code: 'COMMITMENT_MISMATCH',
        path: '$.signature',
        digest,
        bindingsVerified: true,
        signatureChecked: true,
      };
    return {
      ok: true,
      state: 'verified',
      code: null,
      path: '$',
      digest,
      bindingsVerified: true,
      signatureChecked: true,
    };
  } catch {
    // No Ed25519 on this device. Not a pass, not an error: the middle state.
    return {
      ok: false,
      state: 'unchecked',
      code: 'SIGNATURE_UNCHECKED',
      path: '$.signature',
      digest,
      bindingsVerified: true,
      signatureChecked: false,
    };
  }
}
