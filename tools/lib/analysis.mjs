/**
 * Exhaustive exact analysis of an AETHER ORDER variant.
 *
 * Nothing in this module estimates. Every probability is a count of winning
 * permutations over n!, carried as a reduced BigInt fraction. The functions here
 * are the shared engine behind tools/enumerate.mjs and the vitest suite, so the
 * published paytable and the proof cannot drift apart.
 */

import {
  allDrawVectors,
  allPermutations,
  assertSafeCount,
  factorial,
  factorialBig,
  fisherYates,
  permutationRank,
  positionsOf,
} from './permutations.mjs';
import { BET_FAMILIES, TIERS } from './bets.mjs';
import {
  CHIPS_PER_CREDIT,
  LIMITS,
  STAKE_LADDER,
  STAKE_QUANTUM,
  TARGET_RTP,
  getVariant,
} from './model.mjs';
import { adapterFingerprint, claimSignature, exactChips, settleTicket } from './derive.mjs';
import {
  approxDecimal,
  approxSqrt,
  cmp,
  div,
  eq,
  exactDecimal,
  fmt,
  mul,
  rational,
  sub,
} from './rational.mjs';

/**
 * Proof 1 — the shuffle is a bijection from draw vectors onto permutations.
 *
 * The sampler produces each draw vector with equal probability (Proof 2 below).
 * If the map from draw vectors to permutations is a bijection, the induced
 * distribution on S_n is exactly uniform. This enumerates all n! draw vectors
 * and checks that every permutation is produced exactly once — an exhaustive
 * proof, not a statistical one.
 */
export function proveShuffleBijection(n) {
  const total = factorial(n);
  const counts = new Map();
  let vectors = 0;
  for (const draws of allDrawVectors(n)) {
    vectors += 1;
    const key = fisherYates(n, draws).join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const distinct = counts.size;
  const everyOnce = [...counts.values()].every((count) => count === 1);
  return Object.freeze({
    n,
    drawVectors: vectors,
    permutationCount: total,
    distinctImages: distinct,
    bijective: vectors === total && distinct === total && everyOnce,
  });
}

/**
 * Proof 2 — the rejection sampler is exactly uniform, demonstrated
 * exhaustively on a scaled-down domain.
 *
 * The shipped sampler draws a 256-bit value and rejects anything at or above
 * `limit = 2^256 - (2^256 mod modulus)`. `limit` is divisible by `modulus`, so
 * every residue owns exactly `limit / modulus` accepted values. That argument is
 * independent of the domain size, so it can be verified by enumerating the whole
 * domain for a small `bits`. Naive truncation (`value % modulus` with no
 * rejection) is enumerated alongside it to show the bias the rejection removes.
 */
export function proveRejectionUniformity(bits, modulus) {
  const range = 1n << BigInt(bits);
  const limit = range - (range % modulus);
  const accepted = new Array(Number(modulus)).fill(0);
  const naive = new Array(Number(modulus)).fill(0);
  for (let value = 0n; value < range; value += 1n) {
    const residue = Number(value % modulus);
    naive[residue] += 1;
    if (value < limit) accepted[residue] += 1;
  }
  const first = accepted[0];
  const naiveMax = BigInt(Math.max(...naive));
  const naiveMin = BigInt(Math.min(...naive));
  return Object.freeze({
    bits,
    modulus,
    domainSize: range,
    acceptRegion: limit,
    rejected: range - limit,
    uniform: accepted.every((count) => count === first),
    perResidue: first,
    naiveBiased: naiveMax !== naiveMin,
    /** Exact relative bias of naive truncation: (max - min) / min. */
    naiveBias: naiveMin === 0n ? rational(0n) : rational(naiveMax - naiveMin, naiveMin),
  });
}

const TIER_RANK = Object.freeze({ [TIERS.FLOW]: 0, [TIERS.FORM]: 1, [TIERS.ORDER]: 2 });

/**
 * Proof 3 — the full outcome space, every bet instance, exactly.
 *
 * For each family: enumerate every legal instance, evaluate it against every
 * one of the n! permutations, assert that all instances of a family share one
 * win count (so a single published multiplier is honest for the whole family),
 * then derive probability, expected value, RTP and variance as exact fractions.
 */
export function enumerateVariant(variantId) {
  const variant = getVariant(variantId);
  const { n } = variant;
  const permutations = allPermutations(n);
  const permutationCount = permutations.length;
  const permutationCountBig = factorialBig(n);
  if (BigInt(permutationCount) !== permutationCountBig) {
    throw new Error('Permutation enumeration disagrees with n!');
  }

  const contexts = permutations.map((perm) =>
    Object.freeze({ perm, pos: positionsOf(perm), rank: permutationRank(perm), n }),
  );
  // The lexicographic index must equal the computed rank, otherwise `full`
  // instances would not address the permutation they claim to.
  contexts.forEach((ctx, index) => {
    if (ctx.rank !== index) throw new Error(`Rank/index mismatch at ${index}`);
  });

  let evaluations = 0;
  const rows = BET_FAMILIES.map((family) => {
    const instances = family.instances(n, { permutationCount });
    if (instances.length === 0) throw new Error(`Family ${family.code} enumerated no instances`);
    const winCounts = instances.map((instance) => {
      let wins = 0;
      for (let p = 0; p < permutationCount; p += 1) {
        const outcome = family.resolve(instance, contexts[p]);
        if (outcome !== true && outcome !== false) {
          throw new TypeError(`Family ${family.code} returned a non-boolean verdict`);
        }
        if (outcome) wins += 1;
      }
      evaluations += permutationCount;
      return assertSafeCount(wins, permutationCount);
    });

    const wins = winCounts[0];
    const homogeneous = winCounts.every((count) => count === wins);
    if (!homogeneous) {
      throw new Error(
        `Family ${family.code} is not homogeneous: win counts range ` +
          `${Math.min(...winCounts)}..${Math.max(...winCounts)}. ` +
          'A single published multiplier would misprice some instances.',
      );
    }
    if (wins === 0 || wins === permutationCount) {
      throw new Error(`Family ${family.code} is degenerate (always loses or always wins)`);
    }

    const probability = rational(BigInt(wins), permutationCountBig);
    const multiplier = variant.multipliers[family.code];
    if (!multiplier) throw new Error(`Variant ${variant.id} does not price ${family.code}`);

    const expectedValue = mul(probability, multiplier); // EV per unit stake
    const fairMultiplier = div(TARGET_RTP, probability); // what the target RTP demands
    const variance = sub(mul(probability, mul(multiplier, multiplier)), mul(expectedValue, expectedValue));

    return Object.freeze({
      code: family.code,
      name: family.name,
      tier: family.tier,
      picks: family.picks,
      rule: family.rule,
      instances: instances.length,
      winsPerInstance: wins,
      probability,
      multiplier,
      fairMultiplier,
      expectedValue,
      variance,
      matchesTargetRtp: eq(expectedValue, TARGET_RTP),
      multiplierIsFair: eq(multiplier, fairMultiplier),
    });
  });

  const offenders = rows.filter((row) => !row.matchesTargetRtp || !row.multiplierIsFair);
  const maxMultiplier = rows.reduce((best, row) => (cmp(row.multiplier, best) > 0 ? row.multiplier : best), rows[0].multiplier);

  // Tier ordering must be monotone in variance: a higher tier must never be
  // less volatile than a lower one, or the tier labels would mislead.
  const sorted = [...rows].sort((a, b) => cmp(a.variance, b.variance));
  const tiersMonotone = sorted.every((row, index) =>
    index === 0 ? true : TIER_RANK[row.tier] >= TIER_RANK[sorted[index - 1].tier],
  );

  return Object.freeze({
    variantId: variant.id,
    displayName: variant.displayName,
    n,
    permutationCount,
    permutationCountBig,
    adapterFingerprint: adapterFingerprint(variant.id),
    targetRtp: TARGET_RTP,
    rows: Object.freeze(rows),
    evaluations,
    offenders: Object.freeze(offenders),
    exact: offenders.length === 0,
    maxMultiplier,
    tiersMonotone,
  });
}

/**
 * Proof 4 — the round cap can never bind.
 *
 * A ticket's return is sum_b (s_b / S) * m_b * 1[b wins], a convex combination
 * of the per-line multipliers, so it is bounded above by max_b m_b whatever the
 * allocation. If max_b m_b < maxWinMultiple the cap is inert and the advertised
 * RTP is never silently reduced by it.
 */
export function proveCapHeadroom(analysis) {
  const cap = rational(LIMITS.maxWinMultiple);
  const binding = cmp(analysis.maxMultiplier, cap) >= 0;
  return Object.freeze({
    cap,
    supremumMultiplier: analysis.maxMultiplier,
    headroom: sub(cap, analysis.maxMultiplier),
    capCanBind: binding,
  });
}

/**
 * Proof 5 — the stake quantum removes rounding entirely.
 *
 * Every published multiplier has a denominator dividing the stake quantum, so
 * `stake * multiplier` is an exact integer for every rung of the stake ladder
 * and for every legal stake. Floor rounding is therefore a no-op and the
 * realised RTP equals the theoretical RTP: no per-payout truncation deficit.
 */
export function proveStakeQuantum(analysis) {
  const checks = [];
  for (const row of analysis.rows) {
    for (const stake of STAKE_LADDER) {
      const chips = exactChips(stake, row.multiplier, `$.${row.code}`);
      checks.push({ code: row.code, stake, chips });
    }
  }
  // Also check every legal stake, not just the ladder rungs.
  let exhaustive = true;
  for (const row of analysis.rows) {
    for (let stake = LIMITS.minLineStakeChips; stake <= LIMITS.maxLineStakeChips; stake += STAKE_QUANTUM) {
      const product = mul(rational(stake), row.multiplier);
      if (product.d !== 1n) exhaustive = false;
    }
  }
  const denominatorsDivideQuantum = analysis.rows.every((row) => STAKE_QUANTUM % row.multiplier.d === 0n);
  return Object.freeze({
    quantum: STAKE_QUANTUM,
    ladderChecks: checks.length,
    denominatorsDivideQuantum,
    everyLegalStakeExact: exhaustive,
    roundingIsNoOp: denominatorsDivideQuantum && exhaustive,
  });
}

/**
 * Proof 6 — structured "cover" tickets return exactly the target RTP with zero
 * variance, which is the sharpest possible demonstration that no hedge beats
 * the house edge. Covering every colour on FIRST guarantees exactly one winning
 * line; covering every permutation on FULL ORDER does the same.
 */
export function proveCoverTickets(analysis) {
  const { n } = getVariant(analysis.variantId);
  const permutations = allPermutations(n);
  const views = permutations.map((perm) =>
    Object.freeze({ perm, pos: positionsOf(perm), rank: permutationRank(perm), n }),
  );
  const stake = STAKE_QUANTUM;
  const covers = [];

  // A cover is a set of instances whose union is certain. For `first`, `last`
  // and `full` that is every instance; `slot` is covered by fixing one colour
  // and buying every slot for it. Nothing here assumes exactly one line wins —
  // the payout is resolved against every outcome, so a broken predicate shows
  // up as a non-constant payout rather than passing silently.
  for (const code of ['first', 'last', 'slot', 'full']) {
    const row = analysis.rows.find((candidate) => candidate.code === code);
    if (!row) continue;
    const family = BET_FAMILIES.find((candidate) => candidate.code === code);
    const all = family.instances(n, { permutationCount: permutations.length });
    const lines = code === 'slot' ? all.filter((instance) => instance.params.c === 0) : all;

    const payouts = new Set();
    let winCounts = new Set();
    for (const view of views) {
      let payout = 0n;
      let wins = 0;
      for (const instance of lines) {
        if (family.resolve(instance, view) === true) {
          wins += 1;
          payout += exactChips(stake, row.multiplier, `$.${code}`);
        }
      }
      payouts.add(payout);
      winCounts.add(wins);
    }

    const totalStake = stake * BigInt(lines.length);
    const constant = payouts.size === 1;
    const guaranteedReturnChips = constant ? [...payouts][0] : 0n;
    const ratio = rational(guaranteedReturnChips, totalStake);
    covers.push(
      Object.freeze({
        code,
        lines: lines.length,
        totalStakeChips: totalStake,
        guaranteedReturnChips,
        winningLinesPerOutcome: [...winCounts],
        zeroVariance: constant,
        ratio,
        matchesTargetRtp: constant && eq(ratio, TARGET_RTP),
      }),
    );
  }
  return Object.freeze({
    covers: Object.freeze(covers),
    allMatch: covers.every((cover) => cover.matchesTargetRtp),
  });
}

/**
 * Proof 6b — the largest credit a single round can produce.
 *
 * Builds the best possible ticket the published limits allow: pick a
 * permutation, collect every bet instance that wins under it, sort by
 * multiplier, then spend the ticket budget greedily at the maximum line stake.
 * Because the objective is linear in the stakes and the constraints are a
 * budget plus a per-line ceiling — and because a ticket may not repeat a claim
 * (`LIMITS.requireDistinctLines`) — greedy-by-multiplier is optimal: any other
 * selection can be improved by exchanging a chosen line for an unchosen one
 * with a larger multiplier. Without the distinct-line rule the maximum would
 * instead be `maxTicketStake x max multiplier`, since the budget could be piled
 * onto repeats of the single best line. The chosen ticket is settled through
 * the real settlement path, so the number is produced by the code that would
 * pay a player, and the returned `optimal` flag records that the selected
 * multipliers really are the largest available.
 */
export function proveMaxRoundCredit(variantId) {
  const variant = getVariant(variantId);
  const { n } = variant;
  const perm = Array.from({ length: n }, (_, i) => i); // identity: the easiest to reason about
  const ctx = Object.freeze({ perm, pos: positionsOf(perm), rank: permutationRank(perm), n });
  const permutationCount = factorial(n);

  // Every winning claim, deduplicated behaviourally: `first {c:0}` and
  // `slot {c:0,k:0}` are the same claim and cannot both sit on a ticket.
  const winners = [];
  const seenClaims = new Set();
  for (const family of BET_FAMILIES) {
    for (const instance of family.instances(n, { permutationCount })) {
      if (!family.resolve(instance, ctx)) continue;
      const claim = claimSignature(variant.id, family, instance);
      if (seenClaims.has(claim)) continue;
      seenClaims.add(claim);
      winners.push({ code: family.code, params: instance.params, multiplier: variant.multipliers[family.code] });
    }
  }
  const ranked = [...winners].sort((a, b) => cmp(b.multiplier, a.multiplier));

  const lines = [];
  let budget = LIMITS.maxTicketStakeChips;
  for (const winner of ranked) {
    if (lines.length >= LIMITS.maxLinesPerTicket || budget < LIMITS.minLineStakeChips) break;
    const stake = budget < LIMITS.maxLineStakeChips ? budget : LIMITS.maxLineStakeChips;
    lines.push({ code: winner.code, params: winner.params, stakeChips: stake });
    budget -= stake;
  }

  const settlement = settleTicket({ permutation: perm, variantId }, { lines });
  const roundMultiple = rational(settlement.creditedChips, settlement.totalStakeChips);

  const witness = optimalityWitness(variant, winners, lines, settlement.totalStakeChips);

  return Object.freeze({
    lines: lines.length,
    winningInstancesAvailable: winners.length,
    totalStakeChips: settlement.totalStakeChips,
    creditedChips: settlement.creditedChips,
    creditedCredits: rational(settlement.creditedChips, CHIPS_PER_CREDIT),
    roundMultiple,
    capped: settlement.capped,
    allLinesWon: settlement.lines.every((line) => line.won),
    optimal: witness.optimal,
    witness,
  });
}

/**
 * Is this selection of lines the best ticket buildable from `winners`?
 *
 * Deliberately computed WITHOUT reusing whatever ordering produced the
 * selection — a witness that reads back the same sorted array would agree with
 * any comparator, including a reversed one, and prove nothing. Two independent
 * arguments must both hold:
 *
 *  1. **Exchange.** No unchosen winning claim may carry a multiplier strictly
 *     greater than the smallest chosen one. If none does, no swap improves the
 *     ticket; and since every chosen line already sits at the per-line ceiling
 *     with the budget exhausted, no reallocation improves it either.
 *  2. **Independent selection.** Recompute the top-k multipliers from the
 *     *unsorted* winner list by repeated max-extraction — a different algorithm
 *     from `Array.prototype.sort` — and require the same sequence.
 *
 * Exported so the test suite can feed it a deliberately bad selection and
 * confirm it says no.
 */
export function optimalityWitness(variant, winners, lines, totalStakeChips) {
  const key = (entry) => `${entry.code}|${JSON.stringify(entry.params)}`;
  const chosen = lines.map((line) => variant.multipliers[line.code]);
  if (chosen.length === 0) return Object.freeze({ optimal: false, noBetterUnchosen: false, matchesIndependentSelection: false, budgetExhausted: false });

  const chosenKeys = new Set(lines.map(key));
  const unchosen = winners.filter((winner) => !chosenKeys.has(key(winner)));
  const smallestChosen = chosen.reduce((worst, m) => (cmp(m, worst) < 0 ? m : worst), chosen[0]);
  const noBetterUnchosen = unchosen.every((winner) => cmp(winner.multiplier, smallestChosen) <= 0);

  const pool = [...winners];
  const independentTop = [];
  for (let i = 0; i < lines.length && pool.length > 0; i += 1) {
    let best = 0;
    for (let j = 1; j < pool.length; j += 1) if (cmp(pool[j].multiplier, pool[best].multiplier) > 0) best = j;
    independentTop.push(pool.splice(best, 1)[0].multiplier);
  }
  const matchesIndependentSelection =
    independentTop.length === chosen.length &&
    independentTop.every((multiplier, index) => eq(multiplier, chosen[index]));

  const budgetExhausted =
    totalStakeChips === LIMITS.maxTicketStakeChips || lines.length === LIMITS.maxLinesPerTicket;

  return Object.freeze({
    optimal: noBetterUnchosen && matchesIndependentSelection && budgetExhausted,
    noBetterUnchosen,
    matchesIndependentSelection,
    budgetExhausted,
  });
}

/**
 * Proof 7 — expected value is invariant across arbitrary multi-line tickets.
 *
 * Computed the hard way: for each ticket, sum the exact payout over all n!
 * permutations and divide by n!. Correlation between lines is irrelevant to the
 * expectation, and this checks that claim outcome-by-outcome rather than
 * asserting linearity.
 */
export function proveTicketInvariance(variantId, tickets) {
  const variant = getVariant(variantId);
  const { n } = variant;
  const permutations = allPermutations(n);
  const permutationCountBig = factorialBig(n);
  const contexts = permutations.map((perm) =>
    Object.freeze({ perm, pos: positionsOf(perm), rank: permutationRank(perm), n }),
  );
  const results = tickets.map((ticket, index) => {
    let totalStake = 0n;
    let totalPayout = 0n;
    let worst = null;
    let best = null;
    const resolved = ticket.lines.map((line) => {
      const family = BET_FAMILIES.find((candidate) => candidate.code === line.code);
      if (!family) throw new RangeError(`Unknown bet code: ${line.code}`);
      const legal = family.instances(n, { permutationCount: permutations.length });
      const instance = line.label
        ? legal.find((candidate) => candidate.label === line.label)
        : legal[line.instanceIndex % legal.length];
      if (!instance) throw new RangeError(`No instance ${line.label ?? line.instanceIndex} in family ${line.code}`);
      totalStake += line.stakeChips;
      return { family, instance, stakeChips: line.stakeChips, multiplier: variant.multipliers[family.code] };
    });
    if (totalStake <= 0n) throw new RangeError('Ticket has no stake');
    for (const ctx of contexts) {
      let payout = 0n;
      for (const line of resolved) {
        if (line.family.resolve(line.instance, ctx)) {
          payout += exactChips(line.stakeChips, line.multiplier, `$.tickets[${index}]`);
        }
      }
      totalPayout += payout;
      if (worst === null || payout < worst) worst = payout;
      if (best === null || payout > best) best = payout;
    }
    const rtp = div(rational(totalPayout, permutationCountBig), rational(totalStake));
    return Object.freeze({
      name: ticket.name,
      lines: ticket.lines.length,
      totalStakeChips: totalStake,
      rtp,
      matchesTargetRtp: eq(rtp, TARGET_RTP),
      worstOutcomeChips: worst,
      bestOutcomeChips: best,
      bestMultiple: rational(best, totalStake),
      guaranteedProfit: worst > totalStake,
    });
  });
  return Object.freeze({
    tickets: Object.freeze(results),
    allMatch: results.every((result) => result.matchesTargetRtp),
    anyGuaranteedProfit: results.some((result) => result.guaranteedProfit),
  });
}

/** Human-readable rendering helpers shared by the CLI and the docs generator. */
export const render = Object.freeze({
  fraction: fmt,
  /** Exact two-decimal multiplier. Throws if a multiplier ever stops being exact. */
  multiplierDecimal: (multiplier) => exactDecimal(multiplier, 2),
  /** Exact percentage, for the RTP column only. */
  percent: (value) => `${exactDecimal(mul(value, rational(100n)), 3)}%`,
  /** Clearly-approximate percentage, for probability display. */
  approxPercent: (value) => `${approxDecimal(mul(value, rational(100n)), 4)}%`,
  approx: approxDecimal,
  sd: (variance) => approxSqrt(variance, 4),
});
