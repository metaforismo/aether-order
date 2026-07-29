/**
 * When a line stops being undecided — as code, not as prose.
 *
 * docs/DESIGN.md §2.1 states the rule normatively:
 *
 *   A line changes state at the first lock after which its verdict is identical
 *   for EVERY completion of the tube consistent with the locked prefix.
 *
 * That rule is the anti-near-miss mechanism. A line that can no longer win says
 * so at the lock that killed it, instead of being kept nominally alive so the
 * player can be shown how close they came. It is also a rule with a sharp,
 * slightly uncomfortable consequence that the design has to own rather than
 * paper over: after `n-1` locks exactly one completion remains, so
 *
 *   ***every line is decided by lock n-1, in every round, without exception.***
 *
 * The last sphere's fall therefore carries no information, ever. Round 2 of this
 * specification shipped a table that said LAST resolved at lock `n` and SLOT
 * `c @ n` likewise — which is precisely the manufactured near-miss the same
 * section bans, on a chip every player uses, during the round's most dramatic
 * beat. It survived because the rule lived only in prose. It lives here now.
 *
 * Two functions:
 *
 *   - `decisiveLock` is the DEFINITION, evaluated directly: enumerate the
 *     completions of each prefix and find the first one on which they all agree.
 *     Nothing is hand-derived, so a new bet family gets a correct resolution
 *     track for free and cannot silently acquire a near-miss.
 *   - `resolutionTrack` applies it to a ticket and reports the beat structure a
 *     renderer needs, including the lock at which the round's settlement — and
 *     therefore the celebration gate in `presentation.mjs` — is already known.
 *
 * Cost. `decisiveLock` pays `(n - k)!` predicate evaluations at the lock `k`
 * where the verdict becomes constant, and every earlier lock aborts at the first
 * disagreement. That abort is usually immediate but not always: a high-ranked
 * FULL ORDER claim agrees "lose" across thousands of completions before reaching
 * its one winner, so the honest bound is the sum of the factorials,
 * `sum_{k=0..n} (n-k)!` = 154 at n = 5 and 5,914 at n = 7. Measured worst case
 * over the shipped catalogue: 5,649 evaluations for one SEVEN line, and 1.3 ms
 * for a hostile 12-line SEVEN ticket — paid once, at COMMIT, inside a 260 ms
 * CHARGE beat, and never touched again during the round.
 */

import { BET_FAMILIES, getFamily } from './bets.mjs';
import { factorial, orderKey, permutationRank, positionsOf } from './permutations.mjs';
import { getVariant } from './model.mjs';

/**
 * A reusable outcome view.
 *
 * The completion sweep walks millions of permutations, so it mutates one view
 * in place rather than allocating per completion. `resolve` predicates are pure
 * functions of `(instance, view)` that read the view and return — the property
 * the conformance check already enforces — so reuse is safe. The enumerator's
 * purity check is what licenses this, and `tests/resolution.test.mjs` also
 * cross-checks the fast sweep against the allocating `completionsOf` generator
 * on the whole CLASSIC space.
 *
 * `rank` and `order` are getters that recompute on read. Only `full` reads
 * either — `order` since it became the parameter FULL ORDER is spelled with —
 * so caching would cost more bookkeeping than it saves. Both must be present:
 * a predicate handed a view missing a field it reads would silently resolve
 * `undefined === something` to false, which is a wrong answer rather than an
 * error, and `tests/resolution.test.mjs` cross-checks this view against
 * `outcomeViewOf` for exactly that reason.
 */
function makeReusableView(n) {
  const perm = new Array(n);
  const pos = new Array(n);
  const view = { n, perm, pos };
  Object.defineProperty(view, 'rank', {
    enumerable: true,
    get: () => permutationRank(perm),
  });
  Object.defineProperty(view, 'order', {
    enumerable: true,
    get: () => orderKey(perm),
  });
  return view;
}

/** The allocating, obviously-correct view. Used by `completionsOf` consumers. */
function outcomeView(perm, n) {
  const view = { n, perm, pos: positionsOf(perm) };
  Object.defineProperty(view, 'rank', { enumerable: true, get: () => permutationRank(perm) });
  Object.defineProperty(view, 'order', { enumerable: true, get: () => orderKey(perm) });
  return view;
}

/**
 * Does the verdict agree across every completion of `perm`'s first `k` locks?
 *
 * Depth-first over the unplaced elements, aborting at the first disagreement —
 * which is why a lock that does not decide the line costs two evaluations
 * rather than `(n - k)!`.
 */
function verdictIsConstant(n, family, instance, sourcePerm, k, view) {
  const { perm, pos } = view;
  const placed = new Array(n).fill(false);
  for (let slot = 0; slot < k; slot += 1) {
    const element = sourcePerm[slot];
    perm[slot] = element;
    pos[element] = slot;
    placed[element] = true;
  }

  let verdict = -1;
  let checked = 0;
  const walk = (slot) => {
    if (slot === n) {
      checked += 1;
      const resolved = family.resolve(instance, view) === true ? 1 : 0;
      if (verdict === -1) {
        verdict = resolved;
        return true;
      }
      return verdict === resolved;
    }
    for (let element = 0; element < n; element += 1) {
      if (placed[element]) continue;
      placed[element] = true;
      perm[slot] = element;
      pos[element] = slot;
      const agreed = walk(slot + 1);
      placed[element] = false;
      if (!agreed) return false;
    }
    return true;
  };

  return { agree: walk(k), verdict: verdict === 1, checked };
}

/**
 * Every settled order consistent with a locked prefix.
 *
 * `prefix` is the first `k` entries of the tube, bottom-up. Yields `(n - k)!`
 * complete permutations, the prefix followed by each arrangement of the spheres
 * still in the liquid. At `k = n - 1` it yields exactly one, which is the whole
 * argument for the universal bound above.
 *
 * @param {number} n
 * @param {readonly number[]} prefix
 * @returns {Generator<number[]>}
 */
export function* completionsOf(n, prefix) {
  const placed = new Array(n).fill(false);
  for (const element of prefix) {
    if (!Number.isInteger(element) || element < 0 || element >= n) {
      throw new RangeError(`Prefix element ${element} is not an element index in [0, ${n})`);
    }
    if (placed[element]) throw new RangeError(`Prefix repeats element ${element}`);
    placed[element] = true;
  }
  const out = prefix.slice();
  const walk = function* () {
    if (out.length === n) {
      // A copy, not the working array. This generator is the readable
      // reference implementation, not the hot path; sharing a mutating buffer
      // here would be a trap for every consumer that collects the results.
      yield out.slice();
      return;
    }
    for (let element = 0; element < n; element += 1) {
      if (placed[element]) continue;
      placed[element] = true;
      out.push(element);
      yield* walk();
      out.pop();
      placed[element] = false;
    }
  };
  yield* walk();
}

/** How many completions a prefix of length `k` has: `(n - k)!`. */
export const completionCount = (n, k) => factorial(n - k);

/**
 * The lock at which a line stops being undecided, and the verdict it stops on.
 *
 * @param {number} n spheres in the variant
 * @param {{resolve: Function}} family a bet family from the catalogue
 * @param {object} instance the player's parameters
 * @param {readonly number[]} perm the round's settled order, bottom-up
 * @returns {{lock: number, verdict: boolean, completionsChecked: number}}
 *   `lock` is 1-indexed and counts locks that have happened: `lock === 3` means
 *   the line changes state as the third sphere seats. `lock === 0` would mean a
 *   claim that is true (or false) of every permutation — no shipped family is
 *   like that, and the enumerator asserts none becomes so.
 */
export function decisiveLock(n, family, instance, perm, view = makeReusableView(n)) {
  if (!Array.isArray(perm) || perm.length !== n) {
    throw new RangeError(`decisiveLock needs a complete permutation of ${n} elements`);
  }
  let completionsChecked = 0;
  for (let k = 0; k <= n; k += 1) {
    const swept = verdictIsConstant(n, family, instance, perm, k, view);
    completionsChecked += swept.checked;
    if (swept.agree) return Object.freeze({ lock: k, verdict: swept.verdict, completionsChecked });
  }
  /* c8 ignore next 2 -- unreachable: the k = n prefix has exactly one completion. */
  throw new Error('decisiveLock failed to terminate; the k = n prefix must be singleton');
}

/**
 * The same answer, computed the slow, obvious way: materialise every completion
 * through `completionsOf` and compare verdicts. It allocates a fresh view per
 * completion and shares no code with the sweep above, so agreement between the
 * two is real evidence rather than a tautology. `tests/resolution.test.mjs`
 * requires them to agree across the entire CLASSIC space.
 */
export function decisiveLockByEnumeration(n, family, instance, perm) {
  for (let k = 0; k <= n; k += 1) {
    const prefix = perm.slice(0, k);
    let verdict = null;
    let agree = true;
    for (const completion of completionsOf(n, prefix)) {
      const resolved = family.resolve(instance, outcomeView(completion, n)) === true;
      if (verdict === null) verdict = resolved;
      else if (verdict !== resolved) {
        agree = false;
        break;
      }
    }
    if (agree) return Object.freeze({ lock: k, verdict });
  }
  /* c8 ignore next 2 -- unreachable for the same reason. */
  throw new Error('decisiveLockByEnumeration failed to terminate');
}

/**
 * The universal bound, asserted structurally rather than believed.
 *
 * Returns the number of completions remaining after `n - 1` locks. It is 1, so
 * every line's verdict is constant over that set, so no line can survive past
 * lock `n - 1`. The enumerator and the test suite both call this rather than
 * quoting the sentence.
 */
export function completionsAfterPenultimateLock(n) {
  return completionCount(n, n - 1);
}

/**
 * The resolution track for one ticket and one settled order.
 *
 * This is what the choreography builder consumes at COMMIT. It is a pure
 * function of (ticket, permutation) — no clock, no device, no session state —
 * which is why the same transcript replays identically and why the exported
 * clip is reproducible.
 *
 * @param {string} variantId
 * @param {{lines: readonly {code: string, params: object}[]}} ticket
 * @param {readonly number[]} permutation
 */
export function resolutionTrack(variantId, ticket, permutation) {
  const variant = getVariant(variantId);
  const { n } = variant;
  if (typeof ticket !== 'object' || ticket === null || !Array.isArray(ticket.lines)) {
    throw new TypeError('resolutionTrack requires a ticket with a lines array');
  }
  const lines = Array.prototype.slice.call(ticket.lines).map((line, index) => {
    const family = getFamily(line.code);
    const instances = family.instances(n, { permutationCount: factorial(n) });
    const instance = instances.find((candidate) => sameParams(candidate.params, line.params));
    if (!instance) throw new RangeError(`Line ${index} is not a legal instance of ${line.code}`);
    const decided = decisiveLock(n, family, instance, permutation);
    return Object.freeze({
      index,
      code: family.code,
      name: family.name,
      tier: family.tier,
      label: instance.label,
      lock: decided.lock,
      verdict: decided.verdict,
    });
  });

  const latest = lines.reduce((worst, line) => (line.lock > worst ? line.lock : worst), 0);

  return Object.freeze({
    variantId: variant.id,
    n,
    lines: Object.freeze(lines),
    /** No line on any ticket can resolve later than this. Structural, not empirical. */
    latestPossibleLock: n - 1,
    /** The latest lock this particular ticket actually uses. */
    latestUsedLock: latest,
    /**
     * The lock after which the round's credit — and therefore the celebration
     * gate — is fully determined. Always `n - 1`.
     */
    settlementKnownAtLock: n - 1,
    /**
     * THE CLOSE. The final sphere's fall. It resolves nothing, in any round, on
     * any ticket. The renderer must treat it as a coda whose treatment is
     * chosen by `roundPresentation`, never as a reveal, and never as suspense.
     */
    closeCarriesInformation: false,
    /** True iff some line survives to the last informative lock. */
    resolvesAtPenultimateLock: latest === n - 1,
  });
}

/** Shallow structural equality over a bet instance's flat numeric parameters. */
function sameParams(a, b) {
  if (typeof b !== 'object' || b === null) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && b[key] === a[key]);
}

/**
 * The published resolution table: for every family, the earliest and the latest
 * lock at which one of its lines can change state.
 *
 * `mode: 'exhaustive'` sweeps every instance against every permutation, which is
 * affordable at n = 5 (35,400 pairs) and not at n = 7. `mode: 'witness'` instead
 * evaluates a supplied set of (instance, permutation) pairs — the extremal
 * witnesses — and reports what they attain. docs/DESIGN.md §2.1 prints this
 * table and tests/resolution.test.mjs asserts the document against it.
 */
export function resolutionTable(variantId, { permutations, instanceFilter } = {}) {
  const variant = getVariant(variantId);
  const { n } = variant;
  const permutationCount = factorial(n);
  const perms = permutations ?? null;
  if (!perms) throw new TypeError('resolutionTable requires an explicit permutation set');

  const view = makeReusableView(n);
  const rows = BET_FAMILIES.map((family) => {
    let instances = family.instances(n, { permutationCount });
    if (instanceFilter) instances = instances.filter((instance) => instanceFilter(family, instance));
    let earliest = Infinity;
    let latest = 0;
    let pairs = 0;
    for (const instance of instances) {
      for (const perm of perms) {
        const { lock } = decisiveLock(n, family, instance, perm, view);
        if (lock < earliest) earliest = lock;
        if (lock > latest) latest = lock;
        pairs += 1;
      }
    }
    return Object.freeze({
      code: family.code,
      name: family.name,
      tier: family.tier,
      earliestLock: earliest,
      latestLock: latest,
      pairs,
    });
  });

  return Object.freeze({ variantId: variant.id, n, latestPossibleLock: n - 1, rows: Object.freeze(rows) });
}
