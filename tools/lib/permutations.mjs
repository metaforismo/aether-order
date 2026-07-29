/**
 * Permutation utilities.
 *
 * A permutation is an array `perm` of length n where `perm[k]` is the element
 * index that settles into slot k (slot 0 is the first sphere to settle, at the
 * bottom of the tube). `positionsOf(perm)[e]` inverts it: the slot of element e.
 *
 * All counters here are Numbers. That is exact: every count is bounded by
 * n! <= 5040 for the shipped variants, far below Number.MAX_SAFE_INTEGER, and
 * `assertSafeCount` enforces the bound. Counts are lifted to BigInt before any
 * probability, multiplier or money arithmetic happens.
 */

export function assertSafeCount(value, bound) {
  if (!Number.isSafeInteger(value) || value < 0 || value > bound) {
    throw new RangeError(`Count ${value} escaped the exact integer bound ${bound}`);
  }
  return value;
}

/** Factorial as a BigInt. */
export function factorialBig(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('factorial requires a non-negative integer');
  let out = 1n;
  for (let i = 2n; i <= BigInt(n); i += 1n) out *= i;
  return out;
}

/** Factorial as a Number, guarded to stay exact. */
export function factorial(n) {
  const big = factorialBig(n);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('factorial exceeds exact Number range');
  return Number(big);
}

/**
 * Every permutation of [0, n), generated in lexicographic order so the index of
 * a permutation in the returned array equals its rank.
 * @param {number} n
 * @returns {number[][]}
 */
export function allPermutations(n) {
  if (!Number.isInteger(n) || n < 1 || n > 9) throw new RangeError('allPermutations supports n in [1, 9]');
  const out = [];
  const current = [];
  const used = new Array(n).fill(false);
  const walk = () => {
    if (current.length === n) {
      out.push(current.slice());
      return;
    }
    for (let e = 0; e < n; e += 1) {
      if (used[e]) continue;
      used[e] = true;
      current.push(e);
      walk();
      current.pop();
      used[e] = false;
    }
  };
  walk();
  return out;
}

/** `positionsOf(perm)[element] = slot`. */
export function positionsOf(perm) {
  const pos = new Array(perm.length);
  for (let slot = 0; slot < perm.length; slot += 1) pos[perm[slot]] = slot;
  return pos;
}

/**
 * Lexicographic rank of a permutation of [0, n), matching `allPermutations`
 * ordering. Computed from the Lehmer code with exact integer arithmetic.
 */
export function permutationRank(perm) {
  const n = perm.length;
  let rank = 0;
  for (let i = 0; i < n; i += 1) {
    let smaller = 0;
    for (let j = i + 1; j < n; j += 1) if (perm[j] < perm[i]) smaller += 1;
    rank = rank * (n - i) + smaller;
  }
  return assertSafeCount(rank, factorial(n) - 1);
}

/**
 * The shipped shuffle: descending Fisher-Yates.
 *
 * `draws[t]` is the sampler output for step t, and must satisfy
 * 0 <= draws[t] <= n - 1 - t. Step t swaps index (n - 1 - t) with draws[t].
 * This is the exact algorithm specified in docs/ENGINE.md; the enumerator proves
 * it is a bijection from draw vectors onto permutations, hence unbiased whenever
 * the sampler is uniform on each range.
 *
 * @param {number} n
 * @param {readonly number[]} draws length n - 1
 * @returns {number[]}
 */
export function fisherYates(n, draws) {
  if (draws.length !== n - 1) throw new RangeError(`Expected ${n - 1} draws, received ${draws.length}`);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let t = 0; t < n - 1; t += 1) {
    const i = n - 1 - t;
    const j = draws[t];
    if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError(`Draw ${t} out of range: ${j}`);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/**
 * Every legal draw vector for `fisherYates`, in odometer order.
 * There are exactly n! of them: ranges are n, n-1, ..., 2.
 * @param {number} n
 * @returns {Generator<number[]>}
 */
export function* allDrawVectors(n) {
  const ranges = [];
  for (let t = 0; t < n - 1; t += 1) ranges.push(n - t);
  const draws = new Array(n - 1).fill(0);
  for (;;) {
    yield draws.slice();
    let t = n - 2;
    while (t >= 0) {
      draws[t] += 1;
      if (draws[t] < ranges[t]) break;
      draws[t] = 0;
      t -= 1;
    }
    if (t < 0) return;
  }
}
