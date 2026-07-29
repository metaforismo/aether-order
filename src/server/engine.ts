/**
 * The single point at which this service touches Reveal Engine.
 *
 * Nothing here re-implements a lifecycle surface. The permutation module ships
 * AETHER ORDER's adapter (`@axiom-games/reveal-engine/modules/permutation/aether`),
 * so the game's element set, bet catalogue, multipliers, risk policy and play
 * policy come from the package rather than from a copy living in this repo —
 * which is the property docs/ENGINE.md §2 relies on when it says a change to any
 * of them must move the adapter fingerprint.
 *
 * The one thing this module does add is a cross-check: the fingerprint the
 * packaged engine computes must equal the fingerprint `docs/paytable.json`
 * publishes. If a future engine build silently changes a predicate, the server
 * refuses to start instead of settling rounds under a paytable nobody published.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AETHER_ORDER_DEFINITIONS,
  allPermutations,
  assertPermutationAdapterConforms,
  outcomeViewOf,
  permutationAdapterFingerprint,
  permutationClaimSignature,
  permutationPlayPolicyDigest,
  type BetFamily,
  type BetInstance,
  type OutcomeView,
  type PermutationGameDefinition,
  type Permutation,
} from '@axiom-games/reveal-engine/modules/permutation/aether';

export type VariantId = 'classic' | 'seven';

export const VARIANT_IDS: readonly VariantId[] = Object.freeze(['classic', 'seven']);

export const GAMES: Readonly<Record<VariantId, PermutationGameDefinition>> = Object.freeze({
  classic: AETHER_ORDER_DEFINITIONS.classic,
  seven: AETHER_ORDER_DEFINITIONS.seven,
});

export function isVariantId(value: unknown): value is VariantId {
  return value === 'classic' || value === 'seven';
}

export function gameFor(variantId: unknown): PermutationGameDefinition {
  if (!isVariantId(variantId)) throw new TypeError(`Unknown variant: ${String(variantId)}`);
  return GAMES[variantId];
}

/* -------------------------------------------------------------------------- *
 * The published paytable, and the integrity check against it.
 * -------------------------------------------------------------------------- */

export interface PublishedElement {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly hex: string;
  readonly glyph: string;
}

export interface PublishedBet {
  readonly code: string;
  readonly name: string;
  readonly tier: 'FLOW' | 'FORM' | 'ORDER';
  readonly instances: number;
  readonly winsPerInstance: number;
  readonly probability: string;
  readonly multiplier: string;
  readonly decimal: string;
  readonly rtp: string;
  readonly variance: string;
  readonly medianRoundsToFirstHit: number;
}

export interface PublishedAliasGroup {
  readonly signature: string;
  readonly spellings: readonly { readonly code: string; readonly label: string }[];
}

export interface PublishedVariant {
  readonly n: number;
  readonly displayName: string;
  readonly permutationCount: number;
  readonly instances: number;
  readonly distinctClaims: number;
  readonly latestResolutionLock: number;
  readonly stakeQuantumChips: string;
  readonly targetRtp: string;
  readonly adapterFingerprint: string;
  readonly elements: readonly PublishedElement[];
  readonly bets: readonly PublishedBet[];
  readonly claimAliases: readonly PublishedAliasGroup[];
  readonly roundCredit: Readonly<Record<string, unknown>>;
}

export interface PublishedPaytable {
  readonly adapterVersion: string;
  readonly gameId: string;
  readonly moduleVersion: string;
  readonly playPolicy: Readonly<Record<string, unknown>>;
  readonly playPolicyDigest: string;
  readonly sharedChamber: Readonly<Record<string, number | string | boolean>>;
  readonly variants: Readonly<Record<VariantId, PublishedVariant>>;
}

const paytablePath = fileURLToPath(new URL('../../docs/paytable.json', import.meta.url));

export const PAYTABLE: PublishedPaytable = JSON.parse(
  readFileSync(paytablePath, 'utf8'),
) as PublishedPaytable;

/**
 * Refuse to serve a round under an adapter the published artefacts do not
 * describe. Cheap, once, at startup — every check here is a comparison against
 * a value the engine memoised when it constructed the definition.
 */
export function assertPublishedArtefactsMatchEngine(): void {
  for (const variantId of VARIANT_IDS) {
    const game = GAMES[variantId];
    const published = PAYTABLE.variants[variantId];
    if (!published) throw new Error(`docs/paytable.json does not publish variant ${variantId}`);
    if (game.adapterVersion !== PAYTABLE.adapterVersion)
      throw new Error(
        `Adapter version mismatch: engine ${game.adapterVersion}, published ${PAYTABLE.adapterVersion}`,
      );
    if (game.n !== published.n)
      throw new Error(`Element count mismatch for ${variantId}: ${game.n} vs ${published.n}`);
    const fingerprint = permutationAdapterFingerprint(game);
    if (fingerprint !== published.adapterFingerprint)
      throw new Error(
        `Adapter fingerprint mismatch for ${variantId}: engine ${fingerprint}, published ${published.adapterFingerprint}`,
      );
  }
  const digest = permutationPlayPolicyDigest(GAMES.classic.play);
  if (digest !== PAYTABLE.playPolicyDigest)
    throw new Error(
      `Play policy digest mismatch: engine ${digest}, published ${PAYTABLE.playPolicyDigest}`,
    );
}

/** docs/ENGINE.md §8 checks 1-12, run at startup rather than merely shipped. */
export function assertAdaptersConform(): void {
  for (const variantId of VARIANT_IDS) {
    const report = assertPermutationAdapterConforms(GAMES[variantId]);
    if (!report.ok) {
      const failed = report.checks.filter((check) => !check.ok);
      throw new Error(
        `Adapter conformance failed for ${variantId}: ${failed
          .map((check) => `${check.id} ${check.name}: ${check.detail}`)
          .join('; ')}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Instance lookup and outcome views, memoised per process.
 * -------------------------------------------------------------------------- */

const instanceIndexCache = new Map<string, Map<string, BetInstance>>();
const viewCache = new Map<VariantId, readonly OutcomeView[]>();

/** Sorted `key=value` rendering. Used only as an index key, never as identity. */
export function paramsKey(params: object): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String((params as Record<string, unknown>)[key])}`)
    .join(',');
}

export function familyFor(game: PermutationGameDefinition, code: string): BetFamily | undefined {
  return game.bets.find((family) => family.code === code);
}

/**
 * Resolve caller parameters to the adapter's own frozen instance.
 *
 * The rendering is an index key; the match is confirmed field by field with
 * `===`, so `{c: '0'}` never passes as `{c: 0}` merely because the two render
 * alike. The instance set is a pure function of `(family, n)` and is built once
 * per process here — in the consumer, never in the adapter, so that conformance
 * check 3 keeps calling `enumerateInstances` twice for real.
 */
export function instanceFor(
  game: PermutationGameDefinition,
  family: BetFamily,
  params: unknown,
): BetInstance | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const snapshot = { ...(params as Record<string, unknown>) };
  const key = `${game.variantId}|${family.code}`;
  let index = instanceIndexCache.get(key);
  if (!index) {
    index = new Map<string, BetInstance>();
    for (const instance of family.enumerateInstances(game.n))
      index.set(paramsKey(instance.params), instance);
    instanceIndexCache.set(key, index);
  }
  const candidate = index.get(paramsKey(snapshot));
  if (!candidate) return undefined;
  const keys = Object.keys(candidate.params);
  if (keys.length !== Object.keys(snapshot).length) return undefined;
  const same = keys.every(
    (name) => (candidate.params as Record<string, unknown>)[name] === snapshot[name],
  );
  return same ? candidate : undefined;
}

/** Every outcome view for a variant, built once. 120 or 5,040 of them. */
export function viewsFor(variantId: VariantId): readonly OutcomeView[] {
  const cached = viewCache.get(variantId);
  if (cached) return cached;
  const game = GAMES[variantId];
  const views = Object.freeze(
    allPermutations(game.n).map((permutation: Permutation) => outcomeViewOf(permutation, game.n)),
  );
  viewCache.set(variantId, views);
  return views;
}

export { permutationClaimSignature, permutationAdapterFingerprint, permutationPlayPolicyDigest };
export type { PermutationGameDefinition, BetFamily, BetInstance, OutcomeView, Permutation };
