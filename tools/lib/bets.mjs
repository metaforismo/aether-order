/**
 * The AETHER ORDER bet catalogue.
 *
 * Every family declares:
 *  - `instances(n)`   : the complete, finite set of tickets a player can build;
 *  - `resolve(i, ctx)`: a pure predicate of (instance, permutation).
 *
 * `ctx` carries `perm`, its inverse `pos`, its lexicographic `rank` and its
 * printable `order`. All four are deterministic functions of the permutation
 * alone, so `resolve` remains a pure function of (instance, outcome) — the
 * property the conformance check and the enumerator rely on. Every view is
 * built by `outcomeViewOf`, in one place, so a predicate can never be handed
 * two different shapes.
 *
 * Slots are 0-indexed internally and 1-indexed in every player-facing string.
 * Slot 0 is the first sphere to settle (bottom of the tube).
 */

import { orderKey, unrankPermutation } from './permutations.mjs';

export const TIERS = Object.freeze({
  FLOW: 'FLOW',
  FORM: 'FORM',
  ORDER: 'ORDER',
});

const inst = (code, params, label) => Object.freeze({ code, params: Object.freeze(params), label });

function orderedPairs(n) {
  const out = [];
  for (let a = 0; a < n; a += 1) for (let b = 0; b < n; b += 1) if (a !== b) out.push([a, b]);
  return out;
}

function unorderedPairs(n) {
  const out = [];
  for (let a = 0; a < n; a += 1) for (let b = a + 1; b < n; b += 1) out.push([a, b]);
  return out;
}

function orderedTriples(n) {
  const out = [];
  for (let a = 0; a < n; a += 1) {
    for (let b = 0; b < n; b += 1) {
      if (b === a) continue;
      for (let c = 0; c < n; c += 1) {
        if (c === a || c === b) continue;
        out.push([a, b, c]);
      }
    }
  }
  return out;
}

/** @type {ReadonlyArray<object>} */
export const BET_FAMILIES = Object.freeze([
  Object.freeze({
    code: 'before',
    name: 'BEFORE',
    tier: TIERS.FLOW,
    picks: 'two colours, in order',
    rule: 'The first colour settles at any slot below the second colour.',
    instances: (n) => orderedPairs(n).map(([a, b]) => inst('before', { a, b }, `${a}<${b}`)),
    resolve: (i, { pos }) => pos[i.params.a] < pos[i.params.b],
  }),
  Object.freeze({
    code: 'early',
    name: 'EARLY',
    tier: TIERS.FLOW,
    picks: 'one colour',
    rule: 'The colour is one of the first two spheres to settle (slots 1-2).',
    instances: (n) => Array.from({ length: n }, (_, c) => inst('early', { c }, `e${c}`)),
    resolve: (i, { pos }) => pos[i.params.c] <= 1,
  }),
  Object.freeze({
    code: 'late',
    name: 'LATE',
    tier: TIERS.FLOW,
    picks: 'one colour',
    rule: 'The colour is one of the last two spheres to settle (slots n-1 and n).',
    instances: (n) => Array.from({ length: n }, (_, c) => inst('late', { c }, `l${c}`)),
    resolve: (i, { pos, n }) => pos[i.params.c] >= n - 2,
  }),
  Object.freeze({
    code: 'link-any',
    name: 'LINK · EITHER',
    tier: TIERS.FLOW,
    picks: 'two colours',
    rule: 'The two colours settle in adjacent slots, in either order.',
    instances: (n) => unorderedPairs(n).map(([a, b]) => inst('link-any', { a, b }, `${a}~${b}`)),
    resolve: (i, { pos }) => Math.abs(pos[i.params.a] - pos[i.params.b]) === 1,
  }),
  Object.freeze({
    code: 'first',
    name: 'FIRST',
    tier: TIERS.FORM,
    picks: 'one colour',
    rule: 'The colour is the first sphere to settle (slot 1).',
    instances: (n) => Array.from({ length: n }, (_, c) => inst('first', { c }, `f${c}`)),
    resolve: (i, { pos }) => pos[i.params.c] === 0,
  }),
  Object.freeze({
    code: 'last',
    name: 'LAST',
    tier: TIERS.FORM,
    picks: 'one colour',
    rule: 'The colour is the last sphere to settle (slot n).',
    instances: (n) => Array.from({ length: n }, (_, c) => inst('last', { c }, `t${c}`)),
    resolve: (i, { pos, n }) => pos[i.params.c] === n - 1,
  }),
  Object.freeze({
    code: 'slot',
    name: 'SLOT',
    tier: TIERS.FORM,
    picks: 'one colour and one slot',
    rule: 'The colour settles in exactly that slot.',
    instances: (n) => {
      const out = [];
      for (let c = 0; c < n; c += 1) for (let k = 0; k < n; k += 1) out.push(inst('slot', { c, k }, `${c}@${k}`));
      return out;
    },
    resolve: (i, { pos }) => pos[i.params.c] === i.params.k,
  }),
  Object.freeze({
    code: 'link',
    name: 'LINK',
    tier: TIERS.FORM,
    picks: 'two colours, in order',
    rule: 'The second colour settles in the slot immediately above the first.',
    instances: (n) => orderedPairs(n).map(([a, b]) => inst('link', { a, b }, `${a}>${b}`)),
    resolve: (i, { pos }) => pos[i.params.b] === pos[i.params.a] + 1,
  }),
  Object.freeze({
    code: 'opening',
    name: 'OPENING',
    tier: TIERS.ORDER,
    picks: 'two colours, in order',
    rule: 'The two colours are the first two to settle, in exactly that order.',
    instances: (n) => orderedPairs(n).map(([a, b]) => inst('opening', { a, b }, `${a}${b}|open`)),
    resolve: (i, { pos }) => pos[i.params.a] === 0 && pos[i.params.b] === 1,
  }),
  Object.freeze({
    code: 'podium',
    name: 'PODIUM',
    tier: TIERS.ORDER,
    picks: 'three colours, in order',
    rule: 'The three colours are the first three to settle, in exactly that order.',
    instances: (n) => orderedTriples(n).map(([a, b, c]) => inst('podium', { a, b, c }, `${a}${b}${c}|pod`)),
    resolve: (i, { pos }) => pos[i.params.a] === 0 && pos[i.params.b] === 1 && pos[i.params.c] === 2,
  }),
  Object.freeze({
    code: 'full',
    name: 'FULL ORDER',
    tier: TIERS.ORDER,
    picks: 'the complete order of every colour',
    rule: 'Every sphere settles in exactly the chosen slot.',
    /**
     * Parameterised by the ORDER, not by its lexicographic rank.
     *
     * Round 4 emitted `{ rank }`, so `canonicalParams` rendered `rank=37` and
     * that string went into the ticket digest, the settlement digest and the
     * signed receipt. A player's receipt for the game's largest bet therefore
     * recorded "code=full, params=rank=37" rather than the colour order they
     * chose, and was not auditable in a dispute without re-running a ranking
     * function nobody outside this repository has. docs/ENGINE.md §11 positions
     * the receipt as the answer to "what did I stake?"; for one of eleven bet
     * types the answer was an opaque integer.
     *
     * `order=3-0-1-2-4` is the same shape as the transcript's `permutation`
     * array, so verifying a FULL ORDER line by eye is a comparison, not a
     * computation. Element indices are published in docs/paytable.json.
     */
    instances: (n, { permutationCount }) =>
      Array.from({ length: permutationCount }, (_, rank) => {
        const order = orderKey(unrankPermutation(n, rank));
        return inst('full', { order }, `full:${order}`);
      }),
    resolve: (i, { order }) => order === i.params.order,
  }),
]);

export const BET_CODES = Object.freeze(BET_FAMILIES.map((family) => family.code));

/**
 * The params object for a FULL ORDER line claiming a given settled order.
 *
 * Callers that used to write `{ rank: 7 }` write `fullOrderParams(perm)` or
 * `fullOrderParamsByRank(n, 7)`. The point of the change is that a receipt
 * records the order rather than an index into a ranking function, so the
 * ranking function should not be the thing every call site reaches for.
 */
export const fullOrderParams = (perm) => ({ order: orderKey(perm) });

/** The same, addressed by lexicographic rank. Convenient for fixtures. */
export const fullOrderParamsByRank = (n, rank) => fullOrderParams(unrankPermutation(n, rank));

export function getFamily(code) {
  const family = BET_FAMILIES.find((candidate) => candidate.code === code);
  if (!family) throw new RangeError(`Unknown bet code: ${code}`);
  return family;
}

/**
 * Build every instance of every family for a given n.
 * @param {number} n
 * @param {number} permutationCount n!
 */
export function allInstances(n, permutationCount) {
  return BET_FAMILIES.map((family) => ({
    family,
    instances: family.instances(n, { permutationCount }),
  }));
}
