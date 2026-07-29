/**
 * Canonical byte encoding and hashing.
 *
 * Byte-identical to `reveal-engine`'s `src/internal/canonical.ts`: a field
 * count, then a uint32 big-endian byte length plus bytes for every field.
 *
 * The property this gives is **unambiguous field boundaries**: the split into
 * fields is recoverable from the bytes, so no field can smuggle a separator and
 * ['ab','c'] can never collide with ['a','bc'] or ['abc'].
 *
 * It is deliberately *not* type-tagged. `7`, `7n` and `'7'` encode to the same
 * bytes, because numbers and BigInts are rendered as their base-10 ASCII. That
 * is safe here and only here: every field position in every commitment payload
 * has a fixed declared type, so a value can never migrate between types at the
 * same position. Do not rely on typed injectivity — if a future payload needs
 * two types at one position, add an explicit type tag field.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_FIELD_BYTES = 0xffff_ffff;

function lengthPrefix(length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FIELD_BYTES) {
    throw new RangeError('Canonical field is too large');
  }
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(length);
  return out;
}

/**
 * @param {ReadonlyArray<string | Uint8Array | bigint | number>} fields
 * @returns {Buffer}
 */
export function encodeFields(fields) {
  if (!Array.isArray(fields)) throw new TypeError('encodeFields expects an array');
  const encoded = fields.map((field) => {
    if (typeof field === 'bigint') return Buffer.from(field.toString(10), 'ascii');
    if (typeof field === 'number') {
      if (!Number.isSafeInteger(field)) throw new TypeError('Canonical number is not a safe integer');
      return Buffer.from(String(field), 'ascii');
    }
    if (typeof field === 'string') return Buffer.from(field, 'utf8');
    if (field instanceof Uint8Array) return Buffer.from(field);
    throw new TypeError('Unsupported canonical field type');
  });
  return Buffer.concat([
    lengthPrefix(encoded.length),
    ...encoded.flatMap((part) => [lengthPrefix(part.length), part]),
  ]);
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(keyBytes, payload) {
  return createHmac('sha256', keyBytes).update(payload).digest();
}

/** Constant-time comparison of two 32-byte lowercase hex digests. */
export function constantTimeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Deterministic JSON: object keys sorted, two-space indent, trailing newline.
 * Used for every frozen fixture so a diff is a real semantic change.
 */
export function canonicalJson(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, walk(node[key])]),
      );
    }
    if (typeof node === 'bigint') return node.toString(10);
    return node;
  };
  return `${JSON.stringify(walk(value), null, 2)}\n`;
}
