/**
 * The choreography and the settlement must be reading the same catalogue.
 *
 * `tools/lib/resolution.mjs` is the repository's reference implementation of
 * docs/DESIGN.md §2.1 and the oracle for the generated tables in that document.
 * `src/server/resolution.ts` computes the same thing over the *engine's* bet
 * families — the ones that actually settle the money — because a resolution
 * track derived from a different catalogue than the settlement is exactly the
 * drift that keeps a dead line lit so a player can be shown how close they came.
 *
 * So the two are compared directly, and the universal bound is asserted rather
 * than believed: no line, on any ticket, in any round, resolves later than lock
 * `n - 1`.
 */

import { describe, expect, it } from 'vitest';
import { allPermutations, unrankPermutation } from '@axiom-games/reveal-engine/modules/permutation/aether';
import { getFamily } from '../tools/lib/bets.mjs';
import { decisiveLock as referenceDecisiveLock, resolutionTrack as referenceTrack } from '../tools/lib/resolution.mjs';
import { GAMES, familyFor, instanceFor } from '../src/server/engine.js';
import { decisiveLock, resolutionTrack } from '../src/server/resolution.js';

/** A deterministic spread of settled orders, not a random one. */
function sampleOrders(n: number, count: number): number[][] {
  const total = allPermutations(n).length;
  const step = Math.max(1, Math.floor(total / count));
  const orders: number[][] = [];
  for (let rank = 0; rank < total && orders.length < count; rank += step)
    orders.push([...unrankPermutation(n, rank)]);
  return orders;
}

function referenceInstances(code: string, n: number): { params: object }[] {
  const family = getFamily(code) as {
    instances: (n: number, context: { permutationCount: number }) => { params: object }[];
  };
  const permutationCount = allPermutations(n).length;
  return family.instances(n, { permutationCount });
}

describe.each([
  ['classic', 12],
  ['seven', 4],
] as const)('%s — decisiveLock agrees with the reference', (variantId, orderCount) => {
  const game = GAMES[variantId];
  const orders = sampleOrders(game.n, orderCount);

  for (const family of GAMES[variantId].bets) {
    it(`${family.code}`, () => {
      const reference = getFamily(family.code) as { resolve: (i: unknown, v: unknown) => boolean };
      // FULL ORDER has n! instances; the rest are small. Take a bounded spread
      // of every family so the comparison stays exhaustive where it can be.
      const all = referenceInstances(family.code, game.n);
      const stride = Math.max(1, Math.floor(all.length / 24));
      let pairs = 0;
      for (let index = 0; index < all.length; index += stride) {
        const params = (all[index] as { params: object }).params;
        const engineFamily = familyFor(game, family.code);
        expect(engineFamily).toBeDefined();
        const engineInstance = instanceFor(game, engineFamily!, params);
        expect(engineInstance, `${family.code} ${JSON.stringify(params)}`).toBeDefined();
        const referenceInstance = all[index] as never;

        for (const order of orders) {
          const mine = decisiveLock(game.n, engineFamily!, engineInstance!, order);
          const theirs = referenceDecisiveLock(game.n, reference, referenceInstance, order);
          expect({ code: family.code, ...mine, completionsChecked: 0 }).toEqual({
            code: family.code,
            lock: theirs.lock,
            verdict: theirs.verdict,
            completionsChecked: 0,
          });
          // docs/DESIGN.md §2.1: after n-1 locks exactly one arrangement is
          // possible, so nothing can still be undecided. Not "usually"; never.
          expect(mine.lock).toBeLessThanOrEqual(game.n - 1);
          expect(mine.lock).toBeGreaterThanOrEqual(1);
          pairs += 1;
        }
      }
      expect(pairs).toBeGreaterThan(0);
    });
  }
});

describe('resolutionTrack', () => {
  it('reports the same beat structure as the reference for a mixed ticket', () => {
    const game = GAMES.classic;
    const permutation = [...unrankPermutation(5, 37)];
    const lines = [
      { code: 'first', params: { c: permutation[0] as number } },
      { code: 'neighbours', params: { a: 1, b: 3 } },
      { code: 'full', params: { order: permutation.join('-') } },
      { code: 'late', params: { c: 2 } },
    ];
    const mine = resolutionTrack(game, lines, permutation);
    const theirs = referenceTrack('classic', { lines }, permutation);

    expect(mine.lines.map((line) => [line.code, line.lock, line.verdict])).toEqual(
      theirs.lines.map((line) => [line.code, line.lock, line.verdict]),
    );
    expect(mine.latestUsedLock).toBe(theirs.latestUsedLock);
    expect(mine.settlementKnownAtLock).toBe(4);
    expect(mine.closeCarriesInformation).toBe(false);
  });

  it('never leaves a line undecided past the penultimate lock, on any ticket', () => {
    for (const variantId of ['classic', 'seven'] as const) {
      const game = GAMES[variantId];
      const permutation = [...unrankPermutation(game.n, 3)];
      const lines = game.bets.map((family) => {
        const instance = family.enumerateInstances(game.n)[0];
        return { code: family.code, params: instance!.params };
      });
      const track = resolutionTrack(game, lines, permutation);
      expect(track.latestUsedLock).toBeLessThanOrEqual(game.n - 1);
      expect(track.latestPossibleLock).toBe(game.n - 1);
    }
  });
});
