/**
 * Exact rational arithmetic over BigInt.
 *
 * Every probability, multiplier, expected value and RTP in AETHER ORDER is a
 * reduced fraction of BigInts. No IEEE-754 value is ever produced on a money or
 * probability path. The only floating-point values in this repository are
 * clearly-labelled decimal *approximations* printed for human reading (see
 * `approxDecimal`) and the Monte Carlo sanity cross-check.
 */

/** @typedef {{ readonly n: bigint, readonly d: bigint }} Rational */

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * Construct a reduced rational with a strictly positive denominator.
 * @param {bigint} numerator
 * @param {bigint} [denominator]
 * @returns {Rational}
 */
export function rational(numerator, denominator = 1n) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    throw new TypeError('rational() requires BigInt parts');
  }
  if (denominator === 0n) throw new RangeError('rational() denominator must be non-zero');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator) || 1n;
  return Object.freeze({
    n: (sign * numerator) / divisor,
    d: (sign * denominator) / divisor,
  });
}

function check(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.n !== 'bigint' ||
    typeof value.d !== 'bigint' ||
    value.d <= 0n
  ) {
    throw new TypeError('Expected a Rational with a positive BigInt denominator');
  }
  return value;
}

export const ZERO = rational(0n);
export const ONE = rational(1n);

export const add = (a, b) => rational(check(a).n * check(b).d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => rational(check(a).n * check(b).d - b.n * a.d, a.d * b.d);
export const mul = (a, b) => rational(check(a).n * check(b).n, a.d * b.d);

export function div(a, b) {
  check(a);
  check(b);
  if (b.n === 0n) throw new RangeError('Division by zero rational');
  return rational(a.n * b.d, a.d * b.n);
}

/** @returns {-1|0|1} */
export function cmp(a, b) {
  const delta = check(a).n * check(b).d - b.n * a.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

export const eq = (a, b) => cmp(a, b) === 0;

/** Exact integer test. */
export const isInteger = (a) => check(a).n % a.d === 0n;

/** Floor toward negative infinity, as BigInt. */
export function floorDiv(a) {
  check(a);
  const q = a.n / a.d;
  return a.n < 0n && q * a.d !== a.n ? q - 1n : q;
}

/** Canonical `n/d` rendering used in every published table and fixture. */
export function fmt(a) {
  check(a);
  return `${a.n}/${a.d}`;
}

/** Parse the canonical `n/d` rendering back into a Rational. */
export function parseFraction(text) {
  const match = /^(-?\d+)\/(\d+)$/u.exec(String(text).trim());
  if (!match) throw new SyntaxError(`Not a canonical fraction: ${text}`);
  return rational(BigInt(match[1]), BigInt(match[2]));
}

/**
 * Exact fixed-point decimal string. Throws if the value does not terminate at
 * `decimals` places, so a published decimal can never silently round.
 */
export function exactDecimal(a, decimals) {
  check(a);
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError('decimals must be a non-negative integer');
  const scale = 10n ** BigInt(decimals);
  const scaled = a.n * scale;
  if (scaled % a.d !== 0n) {
    throw new RangeError(`${fmt(a)} is not exact at ${decimals} decimal places`);
  }
  const value = scaled / a.d;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? '-' : ''}${whole}${frac}`;
}

/**
 * Decimal *approximation* for human reading only. Never feeds a money path.
 * Returns a string so it cannot be mistaken for an exact operand downstream.
 */
export function approxDecimal(a, decimals = 6) {
  check(a);
  const scale = 10n ** BigInt(decimals);
  const scaled = (a.n * scale) / a.d;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? '-' : ''}${whole}${frac}`;
}

/** Integer square root, used only for the approximate standard-deviation display. */
export function isqrt(value) {
  if (value < 0n) throw new RangeError('isqrt of a negative BigInt');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * Approximate square root of a rational, rendered as a decimal string with
 * `decimals` places. Computed with BigInt integer square root, so the digits are
 * a correctly-truncated approximation rather than a float round-trip.
 */
export function approxSqrt(a, decimals = 4) {
  check(a);
  if (a.n < 0n) throw new RangeError('approxSqrt of a negative rational');
  const scale = 10n ** BigInt(2 * decimals);
  const root = isqrt((a.n * scale) / a.d);
  const digits = root.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  return `${whole}${frac}`;
}
