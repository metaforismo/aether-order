/**
 * The catalogue the client renders.
 *
 * Everything here is either the engine's adapter (codes, names, tiers,
 * multipliers, limits, play policy) or the published artefact the enumerator
 * regenerates and CI diff-checks (`docs/paytable.json`: exact probabilities,
 * element colours and glyphs, alias groups, the real max-win figure). The client
 * declares no paytable of its own — docs/DESIGN.md §10's "free play is the real
 * game" only holds if there is one catalogue.
 *
 * The alias groups are published with *parameters*, not just labels, because the
 * client's job is to merge two chips that mean the same thing (§4) and it does
 * that on the picks the player made, not on a printable string.
 */

import { PAYTABLE, VARIANT_IDS, GAMES, familyFor, paramsKey, type VariantId } from './engine.js';
import { chipString } from './money.js';
import { multiplierDecimal } from './ticket.js';

/** The picker shape a chip needs, docs/DESIGN.md §5 S2 A-E. */
const PICKER_SHAPE: Readonly<Record<string, 'A' | 'B' | 'C' | 'D' | 'E'>> = Object.freeze({
  early: 'A',
  late: 'A',
  first: 'A',
  last: 'A',
  slot: 'B',
  before: 'C',
  stack: 'C',
  neighbours: 'C',
  opening: 'C',
  podium: 'D',
  full: 'E',
});

/** Whether the two picks of a shape-C chip are ordered or interchangeable. */
const ORDERED_PAIR: Readonly<Record<string, boolean>> = Object.freeze({
  before: true,
  stack: true,
  opening: true,
  neighbours: false,
});

/** docs/MATH.md §6, the published stake ladder, in chips. */
export const STAKE_LADDER_CHIPS: readonly bigint[] = Object.freeze([
  25n,
  50n,
  100n,
  250n,
  500n,
  1000n,
  2500n,
  5000n,
]);

/** docs/DESIGN.md §2 and §6.4. One place for the beat durations. */
export const CHOREOGRAPHY = Object.freeze({
  commitMs: 120,
  chargeMs: 260,
  agitateMs: 900,
  fallMs: 340,
  reboundMs: 90,
  lineStateChangeMs: 120,
  closeNeutralMs: 430,
  closeCelebratedMs: 1060,
  stampMs: 220,
  skipCompressedMs: 1200,
  staggerMs: Object.freeze({ classic: 420, seven: 360 }),
});

export interface WireCatalogue {
  readonly gameId: string;
  readonly adapterVersion: string;
  readonly moduleVersion: string;
  readonly playPolicy: Readonly<Record<string, unknown>>;
  readonly playPolicyDigest: string;
  readonly sharedChamber: Readonly<Record<string, unknown>>;
  readonly choreography: typeof CHOREOGRAPHY;
  readonly variants: Readonly<Record<string, unknown>>;
}

function labelIndex(variantId: VariantId, code: string): Map<string, object> {
  const game = GAMES[variantId];
  const family = familyFor(game, code);
  const index = new Map<string, object>();
  if (!family) return index;
  for (const instance of family.enumerateInstances(game.n))
    index.set(instance.label, instance.params);
  return index;
}

function buildVariant(variantId: VariantId): Record<string, unknown> {
  const game = GAMES[variantId];
  const published = PAYTABLE.variants[variantId];
  const betsByCode = new Map(published.bets.map((bet) => [bet.code, bet]));

  const bets = game.bets.map((family) => {
    const bet = betsByCode.get(family.code);
    return {
      code: family.code,
      name: family.name,
      tier: family.tier,
      picks: family.picks,
      rule: family.rule,
      shape: PICKER_SHAPE[family.code] ?? 'A',
      orderedPair: ORDERED_PAIR[family.code] ?? null,
      multiplier: bet?.multiplier ?? null,
      multiplierDecimal: multiplierDecimal(game, family.code),
      probability: bet?.probability ?? null,
      winsPerInstance: bet?.winsPerInstance ?? null,
      instances: bet?.instances ?? null,
      medianRoundsToFirstHit: bet?.medianRoundsToFirstHit ?? null,
      variance: bet?.variance ?? null,
      rtp: bet?.rtp ?? null,
    };
  });

  const indices = new Map<string, Map<string, object>>();
  const claimAliases = published.claimAliases.map((group) => ({
    signature: group.signature,
    spellings: group.spellings.map((spelling) => {
      let index = indices.get(spelling.code);
      if (!index) {
        index = labelIndex(variantId, spelling.code);
        indices.set(spelling.code, index);
      }
      return {
        code: spelling.code,
        label: spelling.label,
        params: index.get(spelling.label) ?? null,
      };
    }),
  }));

  return {
    id: variantId,
    /** The wordmark's own name for the variant (§6.7's SEVEN lockup). */
    displayName: published.displayName,
    /** The one-word label the top-rail toggle carries (§12). */
    label: variantId === 'classic' ? 'CLASSIC' : 'SEVEN',
    n: game.n,
    permutationCount: published.permutationCount,
    targetRtp: published.targetRtp,
    adapterFingerprint: published.adapterFingerprint,
    elements: published.elements,
    bets,
    claimAliases,
    roundCredit: published.roundCredit,
    latestResolutionLock: published.latestResolutionLock,
    limits: {
      stakeQuantumChips: chipString(game.pricing.stakeQuantum),
      minLineStakeChips: chipString(game.risk.minLineStake),
      maxLineStakeChips: chipString(game.risk.maxLineStake),
      maxTicketStakeChips: chipString(game.risk.maxTicketStake),
      maxLinesPerTicket: game.risk.maxLinesPerTicket,
      maxWinMultiple: chipString(game.risk.maxWinMultiple),
      requireDistinctLines: game.risk.requireDistinctLines,
      stakeLadderChips: STAKE_LADDER_CHIPS.map(chipString),
    },
    geometry: variantId === 'classic'
      ? { slotPitch: 78, sphereDiameter: 64, chamberHeight: 430 }
      : { slotPitch: 58, sphereDiameter: 44, chamberHeight: 390 },
    staggerMs: CHOREOGRAPHY.staggerMs[variantId],
  };
}

let cached: WireCatalogue | null = null;

export function wireCatalogue(): WireCatalogue {
  if (cached) return cached;
  const variants: Record<string, unknown> = {};
  for (const variantId of VARIANT_IDS) variants[variantId] = buildVariant(variantId);
  cached = Object.freeze({
    gameId: PAYTABLE.gameId,
    adapterVersion: PAYTABLE.adapterVersion,
    moduleVersion: PAYTABLE.moduleVersion,
    playPolicy: PAYTABLE.playPolicy,
    playPolicyDigest: PAYTABLE.playPolicyDigest,
    sharedChamber: PAYTABLE.sharedChamber,
    choreography: CHOREOGRAPHY,
    variants,
  });
  return cached;
}

export { paramsKey };
