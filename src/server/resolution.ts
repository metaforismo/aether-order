/**
 * When a line stops being undecided — docs/DESIGN.md §2.1, over the engine's
 * catalogue.
 *
 * The rule is normative and it is the anti-near-miss mechanism:
 *
 *   A line changes state at the first lock after which its verdict is identical
 *   for EVERY completion of the tube consistent with the locked prefix.
 *
 * and its sharp consequence is that after `n-1` locks exactly one completion
 * remains, so **every line is decided by lock `n-1`, in every round, without
 * exception**. The final fall carries no information.
 *
 * `tools/lib/resolution.mjs` is the repository's reference implementation of
 * this and it is the oracle for the generated tables in the design document.
 * This module computes the same thing over the *engine's* bet families — the
 * ones that actually settle the money — and `tests/resolution-parity.test.ts`
 * fails the build if the two ever disagree. A choreography track derived from a
 * different catalogue than the settlement is exactly the drift that lets a dead
 * line stay lit.
 */

import type { BetFamily, BetInstance, PermutationGameDefinition } from './engine.js';
import { familyFor, instanceFor } from './engine.js';

/**
 * A view that is mutated in place across the completion sweep rather than
 * reallocated. `resolve` predicates are pure functions of `(instance, view)`
 * that read and return — conformance check 4 enforces exactly that — so reuse
 * is safe. `rank` and `order` are getters because only FULL ORDER reads either.
 */
interface MutableView {
  n: number;
  perm: number[];
  pos: number[];
  readonly rank: number;
  readonly order: string;
}

function permutationRank(perm: readonly number[]): number {
  let rank = 0;
  for (let index = 0; index < perm.length; index += 1) {
    let smaller = 0;
    for (let later = index + 1; later < perm.length; later += 1)
      if ((perm[later] as number) < (perm[index] as number)) smaller += 1;
    rank = rank * (perm.length - index) + smaller;
  }
  return rank;
}

function makeView(n: number): MutableView {
  const perm = new Array<number>(n).fill(0);
  const pos = new Array<number>(n).fill(0);
  const view = { n, perm, pos } as MutableView;
  Object.defineProperty(view, 'rank', { enumerable: true, get: () => permutationRank(perm) });
  Object.defineProperty(view, 'order', { enumerable: true, get: () => perm.join('-') });
  return view;
}

interface Swept {
  readonly agree: boolean;
  readonly verdict: boolean;
  readonly checked: number;
}

/** Depth-first over the unplaced elements, aborting at the first disagreement. */
function verdictIsConstant(
  n: number,
  family: BetFamily,
  instance: BetInstance,
  source: readonly number[],
  k: number,
  view: MutableView,
): Swept {
  const { perm, pos } = view;
  const placed = new Array<boolean>(n).fill(false);
  for (let slot = 0; slot < k; slot += 1) {
    const element = source[slot] as number;
    perm[slot] = element;
    pos[element] = slot;
    placed[element] = true;
  }

  let verdict = -1;
  let checked = 0;
  const walk = (slot: number): boolean => {
    if (slot === n) {
      checked += 1;
      const resolved = family.resolve(instance, view as never) === true ? 1 : 0;
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

  const agree = walk(k);
  return { agree, verdict: verdict === 1, checked };
}

export interface DecisiveLock {
  readonly lock: number;
  readonly verdict: boolean;
  readonly completionsChecked: number;
}

/**
 * The lock at which a line stops being undecided, and the verdict it stops on.
 * `lock` is 1-indexed and counts locks that have happened: `lock === 3` means
 * the line changes state as the third sphere seats.
 */
export function decisiveLock(
  n: number,
  family: BetFamily,
  instance: BetInstance,
  perm: readonly number[],
  view: MutableView = makeView(n),
): DecisiveLock {
  if (!Array.isArray(perm) || perm.length !== n)
    throw new RangeError(`decisiveLock needs a complete permutation of ${n} elements`);
  let completionsChecked = 0;
  for (let k = 0; k <= n; k += 1) {
    const swept = verdictIsConstant(n, family, instance, perm, k, view);
    completionsChecked += swept.checked;
    if (swept.agree)
      return Object.freeze({ lock: k, verdict: swept.verdict, completionsChecked });
  }
  /* Unreachable: the k = n prefix has exactly one completion. */
  throw new Error('decisiveLock failed to terminate');
}

export interface ResolutionLine {
  readonly index: number;
  readonly code: string;
  readonly name: string;
  readonly tier: string;
  readonly label: string;
  readonly lock: number;
  readonly verdict: boolean;
}

export interface ResolutionTrack {
  readonly variantId: string;
  readonly n: number;
  readonly lines: readonly ResolutionLine[];
  /** Structural, not empirical: no line on any ticket can resolve later. */
  readonly latestPossibleLock: number;
  readonly latestUsedLock: number;
  /** The lock after which the credit — and the celebration gate — is known. */
  readonly settlementKnownAtLock: number;
  /** THE CLOSE resolves nothing, in any round, on any ticket. */
  readonly closeCarriesInformation: false;
  readonly resolvesAtPenultimateLock: boolean;
}

/**
 * The resolution track for one opened ticket and one settled order. A pure
 * function of `(ticket, permutation)` — no clock, no device, no session state —
 * which is why the same transcript replays identically.
 *
 * docs/DESIGN.md §7 technique 1 builds this once inside the 260 ms CHARGE beat.
 */
export function resolutionTrack(
  game: PermutationGameDefinition,
  lines: readonly { readonly code: string; readonly params: object }[],
  permutation: readonly number[],
): ResolutionTrack {
  const { n } = game;
  const view = makeView(n);
  const resolved = lines.map((line, index): ResolutionLine => {
    const family = familyFor(game, line.code);
    if (!family) throw new RangeError(`Line ${index} names an unknown bet code ${line.code}`);
    const instance = instanceFor(game, family, line.params);
    if (!instance) throw new RangeError(`Line ${index} is not a legal instance of ${line.code}`);
    const decided = decisiveLock(n, family, instance, permutation, view);
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

  const latestUsedLock = resolved.reduce((worst, line) => (line.lock > worst ? line.lock : worst), 0);

  return Object.freeze({
    variantId: game.variantId,
    n,
    lines: Object.freeze(resolved),
    latestPossibleLock: n - 1,
    latestUsedLock,
    settlementKnownAtLock: n - 1,
    closeCarriesInformation: false,
    resolvesAtPenultimateLock: latestUsedLock === n - 1,
  });
}
