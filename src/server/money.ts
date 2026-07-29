/**
 * Money on the wire.
 *
 * Chips are the unit of account everywhere inside the server (docs/MATH.md §6:
 * one display credit is 100 chips, the stake quantum is 25 chips). They are
 * `bigint` in memory and base-10 strings on the wire, because JSON has no
 * integer type that can carry them safely and a float on a money path is the
 * one thing docs/MATH.md forbids outright.
 */

export const CHIPS_PER_CREDIT = 100n;

/** Exact decimal rendering of an integer chip amount: 192n -> "1.92". */
export function credits(chips: bigint): string {
  const negative = chips < 0n;
  const absolute = negative ? -chips : chips;
  const whole = absolute / CHIPS_PER_CREDIT;
  const fraction = absolute % CHIPS_PER_CREDIT;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** Wire encoding for a chip amount. Never a number. */
export const chipString = (chips: bigint): string => chips.toString(10);

/** Parse a wire chip amount. Rejects anything that is not an integer string. */
export function parseChips(value: unknown, path: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value);
  throw new TypeError(`${path} must be an integer chip amount encoded as a string`);
}
