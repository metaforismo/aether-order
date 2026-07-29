/**
 * docs/ENGINE.md §8: the twelve adapter conformance checks, run in CI.
 *
 * The service does not pay for these on every boot — at `n = 7` they re-derive
 * 27.6M predicate evaluations — so this is where they run, on the packaged
 * adapter the service actually consumes. What the service *does* check at every
 * startup is the fingerprint against the published artefact, which is asserted
 * here too: an engine build whose catalogue has drifted from
 * `docs/paytable.json` must not be able to settle a round.
 */

import { describe, expect, it } from 'vitest';
import { assertPermutationAdapterConforms } from '@axiom-games/reveal-engine/modules/permutation/aether';
import {
  GAMES,
  PAYTABLE,
  VARIANT_IDS,
  assertPublishedArtefactsMatchEngine,
  permutationAdapterFingerprint,
  permutationPlayPolicyDigest,
} from '../src/server/engine.js';

describe('the packaged adapter', () => {
  it('matches the artefacts this repository publishes', () => {
    expect(() => assertPublishedArtefactsMatchEngine()).not.toThrow();
    for (const variantId of VARIANT_IDS)
      expect(permutationAdapterFingerprint(GAMES[variantId])).toBe(
        PAYTABLE.variants[variantId].adapterFingerprint,
      );
    expect(permutationPlayPolicyDigest(GAMES.classic.play)).toBe(PAYTABLE.playPolicyDigest);
  });

  it.each(VARIANT_IDS)('passes all twelve conformance checks (%s)', (variantId) => {
    const report = assertPermutationAdapterConforms(GAMES[variantId]);
    const failed = report.checks.filter((check) => !check.ok);
    expect(failed.map((check) => `${check.id} ${check.name}: ${check.detail}`)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  }, 60_000);

  it('publishes a play policy that cannot be loosened by a player', () => {
    const policy = GAMES.classic.play;
    expect(policy.autoplay).toBe('none');
    expect(policy.skipShortensPresentationOnly).toBe(true);
    expect(policy.realityCheckOverride).toBe('tighten-only');
    // Every option a player may choose is at most the operator recurrence, so
    // the schedule a player receives is always a superset of the published one.
    for (const option of policy.playerRealityCheckIntervalOptions)
      expect(option).toBeLessThanOrEqual(policy.realityCheckRecurrenceMinutes);
  });
});
