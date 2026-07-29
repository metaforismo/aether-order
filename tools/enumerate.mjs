#!/usr/bin/env node
/**
 * AETHER ORDER — exhaustive exact enumeration.
 *
 * This script is the proof behind docs/MATH.md. It enumerates the complete
 * outcome space of every shipped variant (5! = 120 and 7! = 5040 permutations),
 * evaluates every legal bet instance against every outcome, and prints each bet
 * type's exact probability, multiplier and RTP as reduced BigInt fractions.
 *
 * There is no sampling anywhere on the critical path. The optional Monte Carlo
 * pass is a cross-check on the derivation pipeline, never a source of a
 * published number.
 *
 * Usage:
 *   node tools/enumerate.mjs                     # both variants, human readable
 *   node tools/enumerate.mjs --variant=classic   # one variant
 *   node tools/enumerate.mjs --markdown          # emit the docs/MATH.md tables
 *   node tools/enumerate.mjs --json              # machine-readable paytable
 *   node tools/enumerate.mjs --write             # refresh docs/paytable.json + fixtures
 *   node tools/enumerate.mjs --monte-carlo=200000  # sanity cross-check only
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  enumerateVariant,
  proveCapHeadroom,
  proveCoverTickets,
  proveMaxRoundCredit,
  proveRejectionUniformity,
  proveShuffleBijection,
  proveStakeQuantum,
  proveTicketInvariance,
  render,
  rtpCandidateProfile,
} from './lib/analysis.mjs';
import { BET_FAMILIES } from './lib/bets.mjs';
import { canonicalJson } from './lib/canonical.mjs';
import {
  ADAPTER_VERSION,
  CHIPS_PER_CREDIT,
  GAME_ID,
  LIMITS,
  MODULE_VERSION,
  STAKE_LADDER,
  STAKE_QUANTUM,
  TARGET_RTP,
  VARIANT_IDS,
  getVariant,
} from './lib/model.mjs';
import { derivePermutation, makeTranscript, verifyTranscript, ZERO_COMMITMENT } from './lib/derive.mjs';
import { permutationRank, positionsOf } from './lib/permutations.mjs';
import { rational } from './lib/rational.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* -------------------------------------------------------------- */
/* Argument parsing                                                */
/* -------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback = null) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const wantJson = flag('json');
const wantMarkdown = flag('markdown');
const wantWrite = flag('write');
const monteCarloRounds = Number(option('monte-carlo', '0'));
const requestedVariant = option('variant');
const variantIds = requestedVariant ? [requestedVariant] : [...VARIANT_IDS];

let failures = 0;
const out = [];
const say = (line = '') => out.push(line);
const quiet = wantJson || wantMarkdown;

function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  say(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  return condition;
}

/* -------------------------------------------------------------- */
/* Deterministic helpers used only by cross-checks and fixtures     */
/* -------------------------------------------------------------- */

/** Deterministic 32-byte seed from a label. Fixtures must be reproducible. */
const seedFrom = (label) => createHash('sha256').update(`aether-order/fixture/${label}`).digest('hex');

/** xorshift32 — deterministic ticket generator for the invariance sweep. */
function xorshift32(state) {
  let x = state >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

function generateTickets(n, count) {
  const next = xorshift32(0x5eed_1234);
  const tickets = [];
  for (let t = 0; t < count; t += 1) {
    const lines = 1 + (next() % LIMITS.maxLinesPerTicket);
    tickets.push({
      name: `pseudo-random ticket #${t + 1}`,
      lines: Array.from({ length: lines }, () => {
        const family = BET_FAMILIES[next() % BET_FAMILIES.length];
        return {
          code: family.code,
          instanceIndex: next() % 100_000,
          stakeChips: STAKE_LADDER[next() % STAKE_LADDER.length],
        };
      }),
    });
  }
  return tickets;
}

function structuredTickets() {
  return [
    {
      name: 'single low-volatility line',
      lines: [{ code: 'before', instanceIndex: 0, stakeChips: 100n }],
    },
    {
      name: 'perfect hedge (BEFORE 0<1 and BEFORE 1<0) — exactly one line always wins',
      lines: [
        { code: 'before', label: '0<1', stakeChips: 100n },
        { code: 'before', label: '1<0', stakeChips: 100n },
      ],
    },
    {
      name: 'correlated stack (FIRST + EARLY + OPENING on the same colour)',
      lines: [
        { code: 'first', label: 'f0', stakeChips: 250n },
        { code: 'early', label: 'e0', stakeChips: 250n },
        { code: 'opening', label: '01|open', stakeChips: 250n },
      ],
    },
    {
      name: 'barbell (lowest and highest tier together)',
      lines: [
        { code: 'before', instanceIndex: 3, stakeChips: 5000n },
        { code: 'full', instanceIndex: 7, stakeChips: 25n },
      ],
    },
    {
      name: 'twelve mixed lines at the ticket line limit',
      lines: Array.from({ length: 12 }, (_, index) => ({
        code: BET_FAMILIES[index % BET_FAMILIES.length].code,
        instanceIndex: index * 7,
        stakeChips: STAKE_LADDER[index % STAKE_LADDER.length],
      })),
    },
  ];
}

/* -------------------------------------------------------------- */
/* Monte Carlo cross-check (sanity only — never a published number) */
/* -------------------------------------------------------------- */

function monteCarlo(variantId, rounds) {
  const variant = getVariant(variantId);
  const tally = new Map();
  const probes = BET_FAMILIES.map((family) => {
    const instance = family.instances(variant.n, { permutationCount: factorialNumber(variant.n) })[0];
    tally.set(family.code, 0);
    return { family, instance };
  });
  const baseSeed = seedFrom(`monte-carlo/${variantId}`);
  for (let round = 0; round < rounds; round += 1) {
    const perm = derivePermutation(baseSeed, {
      variantId,
      roundId: `mc-${round}`,
      clientSeed: 'cross-check',
      nonce: round,
    });
    const ctx = { perm, pos: positionsOf(perm), rank: permutationRank(perm), n: variant.n };
    for (const probe of probes) {
      if (probe.family.resolve(probe.instance, ctx)) tally.set(probe.family.code, tally.get(probe.family.code) + 1);
    }
  }
  return probes.map(({ family }) => ({ code: family.code, hits: tally.get(family.code), rounds }));
}

function factorialNumber(n) {
  let value = 1;
  for (let i = 2; i <= n; i += 1) value *= i;
  return value;
}

/* -------------------------------------------------------------- */
/* Report                                                          */
/* -------------------------------------------------------------- */

const machine = { gameId: GAME_ID, adapterVersion: ADAPTER_VERSION, moduleVersion: MODULE_VERSION, variants: {} };
const markdown = [];

say('AETHER ORDER — exhaustive exact enumeration');
say('='.repeat(72));
say(`game            ${GAME_ID} (adapter ${ADAPTER_VERSION}, module ${MODULE_VERSION})`);
say(`target RTP      ${render.fraction(TARGET_RTP)} = ${render.percent(TARGET_RTP)}`);
say(`stake quantum   ${STAKE_QUANTUM} chips (1 credit = ${CHIPS_PER_CREDIT} chips)`);
say(`round cap       ${LIMITS.maxWinMultiple}x total ticket stake`);
say(`arithmetic      exact BigInt rationals; no floating point on any money path`);
say();

for (const variantId of variantIds) {
  const variant = getVariant(variantId);
  const analysis = enumerateVariant(variantId);

  say('-'.repeat(72));
  say(`VARIANT  ${analysis.displayName}  (id: ${analysis.variantId})`);
  say('-'.repeat(72));
  say(`spheres              ${analysis.n}`);
  say(`outcome space        ${analysis.n}! = ${analysis.permutationCount} permutations, uniform`);
  say(`adapter fingerprint  ${analysis.adapterFingerprint}`);
  say(`bet evaluations      ${analysis.evaluations.toLocaleString('en-US')} (instance x outcome pairs)`);
  say();

  /* --- Proof 1: shuffle bijection ------------------------------ */
  const bijection = proveShuffleBijection(analysis.n);
  say('[1] Shuffle bijectivity — every draw vector maps to a distinct permutation');
  check(
    'Fisher-Yates is a bijection from draw vectors onto S_n',
    bijection.bijective,
    `${bijection.drawVectors} vectors -> ${bijection.distinctImages}/${bijection.permutationCount} permutations, each exactly once`,
  );
  say();

  /* --- Proof 2: sampler uniformity ----------------------------- */
  say('[2] Rejection sampler — exact uniformity on an exhaustively enumerable domain');
  say(`      Moduli are exactly the ones the ${analysis.n}-sphere shuffle draws from.`);
  for (let modulus = 2; modulus <= analysis.n; modulus += 1) {
    const proof = proveRejectionUniformity(10, BigInt(modulus));
    check(
      `uniform mod ${String(modulus).padEnd(2)} over 2^10 values`,
      proof.uniform,
      `accept ${proof.acceptRegion}/${proof.domainSize}, ${proof.perResidue} per residue; ` +
        `naive truncation bias ${render.fraction(proof.naiveBias)} (${render.approxPercent(proof.naiveBias)})`,
    );
  }
  say('      The shipped sampler applies the identical accept rule at 2^256.');
  say();

  /* --- Proof 3: the paytable ----------------------------------- */
  say('[3] Paytable — exhaustive over the full outcome space');
  say();
  const head = ['code', 'tier', 'inst', 'wins', 'probability', 'multiplier', 'decimal', 'EV', 'RTP'];
  const widths = [10, 6, 6, 6, 14, 12, 11, 8, 10];
  const rowText = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('');
  say(`  ${rowText(head)}`);
  say(`  ${widths.map((w) => '-'.repeat(w - 1)).join(' ')}`);
  for (const row of analysis.rows) {
    say(
      `  ${rowText([
        row.code,
        row.tier,
        row.instances,
        row.winsPerInstance,
        render.fraction(row.probability),
        render.fraction(row.multiplier),
        `${render.multiplierDecimal(row.multiplier)}x`,
        render.fraction(row.expectedValue),
        render.percent(row.expectedValue),
      ])}`,
    );
  }
  say();
  check(
    'every bet type returns exactly the target RTP',
    analysis.exact,
    analysis.exact ? `all ${analysis.rows.length} bet types at ${render.fraction(TARGET_RTP)}` : `${analysis.offenders.length} mispriced`,
  );
  check(
    'every published multiplier equals RTP / probability exactly',
    analysis.rows.every((row) => row.multiplierIsFair),
  );
  check(
    'every instance inside a bet type shares one win count',
    true,
    'enforced during enumeration; a heterogeneous family throws',
  );
  check('tier labels are monotone in variance', analysis.tiersMonotone);
  say();

  /* --- Volatility ---------------------------------------------- */
  say('[4] Volatility — exact variance of the return per unit staked');
  say();
  const vHead = ['code', 'tier', 'probability', 'variance (exact)', 'sd (approx)'];
  const vWidths = [10, 6, 14, 22, 12];
  const vRow = (cells) => cells.map((cell, i) => String(cell).padEnd(vWidths[i])).join('');
  say(`  ${vRow(vHead)}`);
  say(`  ${vWidths.map((w) => '-'.repeat(w - 1)).join(' ')}`);
  for (const row of analysis.rows) {
    say(`  ${vRow([row.code, row.tier, render.fraction(row.probability), render.fraction(row.variance), render.sd(row.variance)])}`);
  }
  say();

  /* --- Proof 4: cap headroom ----------------------------------- */
  const cap = proveCapHeadroom(analysis);
  say('[5] Round cap — proved non-binding');
  check(
    'the cap can never reduce a payout on this paytable',
    !cap.capCanBind,
    `sup multiplier ${render.multiplierDecimal(cap.supremumMultiplier)}x < cap ${LIMITS.maxWinMultiple}x (headroom ${render.multiplierDecimal(cap.headroom)}x)`,
  );
  say('      A ticket return is a convex combination of its line multipliers, so');
  say('      max over all allocations and outcomes equals the largest multiplier.');
  const best = proveMaxRoundCredit(variantId);
  check(
    'best possible round settles below the cap',
    !best.capped && best.allLinesWon && best.optimal,
    `${best.lines} lines, stake ${best.totalStakeChips} chips -> credit ${best.creditedChips} chips ` +
      `(${render.approx(best.creditedCredits, 2)} credits, ${render.approx(best.roundMultiple, 2)}x ticket)`,
  );
  say('      A ticket may not repeat a claim, so greedy-by-multiplier over the');
  say('      distinct winning instances is a true maximum, not a lower bound.');
  say();

  /* --- Proof 5: rounding --------------------------------------- */
  const quantum = proveStakeQuantum(analysis);
  say('[6] Rounding — the stake quantum removes it entirely');
  check(
    'every multiplier denominator divides the stake quantum',
    quantum.denominatorsDivideQuantum,
    `quantum ${quantum.quantum} chips`,
  );
  check('every legal stake produces an integer chip payout', quantum.everyLegalStakeExact);
  check('floor rounding is a no-op, so realised RTP === theoretical RTP', quantum.roundingIsNoOp);
  say();

  /* --- Proof 6: covers ----------------------------------------- */
  const covers = proveCoverTickets(analysis);
  say('[7] Complete covers — hedging returns exactly the target RTP with zero variance');
  for (const cover of covers.covers) {
    check(
      `cover of ${cover.code} (${cover.lines} lines)`,
      cover.matchesTargetRtp,
      `stake ${cover.totalStakeChips} chips -> certain return ${cover.guaranteedReturnChips} chips = ${render.fraction(cover.ratio)}`,
    );
  }
  say('      Covers above the 12-line ticket limit are shown as mathematical bounds,');
  say('      not as purchasable tickets.');
  say();

  /* --- Proof 7: ticket invariance ------------------------------ */
  const tickets = [...structuredTickets(), ...generateTickets(analysis.n, 40)];
  const invariance = proveTicketInvariance(variantId, tickets);
  say('[8] Ticket invariance — EV computed outcome-by-outcome over the whole space');
  check(
    `all ${invariance.tickets.length} tickets return exactly ${render.fraction(TARGET_RTP)}`,
    invariance.allMatch,
  );
  check('no ticket has a guaranteed profit', !invariance.anyGuaranteedProfit);
  for (const ticket of invariance.tickets.slice(0, structuredTickets().length)) {
    say(
      `      ${String(ticket.lines).padStart(2)} line(s)  ${render.fraction(ticket.rtp)}  ` +
        `worst ${ticket.worstOutcomeChips} / stake ${ticket.totalStakeChips} chips  —  ${ticket.name}`,
    );
  }
  say();

  /* --- Proof 8: derivation round trip -------------------------- */
  say('[9] Derivation round trip — commit, derive, reveal, re-derive');
  const seed = seedFrom(`round-trip/${variantId}`);
  const transcript = makeTranscript(seed, {
    variantId,
    roundId: 'enumerate-demo',
    clientSeed: 'axiom',
    nonce: 0,
  });
  const verified = verifyTranscript(seed, transcript);
  check('a freshly built transcript verifies against its revealed seed', verified.ok, transcript.commitment);
  const tampered = { ...transcript, permutation: [...transcript.permutation].reverse() };
  const tamperResult = verifyTranscript(seed, tampered);
  check(
    'a tampered permutation is rejected',
    !tamperResult.ok && tamperResult.code === 'TRANSCRIPT_MISMATCH',
    tamperResult.code,
  );
  const wrongSeed = verifyTranscript(seedFrom('wrong-seed'), transcript);
  check('a wrong revealed seed is rejected', !wrongSeed.ok, wrongSeed.code);
  say(`      permutation ${transcript.permutation.join('-')} (${variant.elements.map((e) => e.id).join(', ')})`);
  say();

  /* --- Monte Carlo cross-check --------------------------------- */
  if (monteCarloRounds > 0) {
    say(`[10] Monte Carlo cross-check — ${monteCarloRounds.toLocaleString('en-US')} derived rounds (sanity only)`);
    const results = monteCarlo(variantId, monteCarloRounds);
    for (const result of results) {
      const row = analysis.rows.find((candidate) => candidate.code === result.code);
      const exactP = Number(row.probability.n) / Number(row.probability.d);
      const observed = result.hits / result.rounds;
      const sigma = Math.sqrt((exactP * (1 - exactP)) / result.rounds);
      const z = sigma === 0 ? 0 : (observed - exactP) / sigma;
      check(
        `${result.code.padEnd(10)} observed ${observed.toFixed(6)} vs exact ${exactP.toFixed(6)}`,
        Math.abs(z) < 5,
        `z = ${z.toFixed(2)}`,
      );
    }
    say('      Monte Carlo never sets a published number. It only cross-checks that');
    say('      the derivation pipeline agrees with the exhaustive enumeration.');
    say();
  }

  /* --- Machine + markdown output -------------------------------- */
  machine.variants[variantId] = {
    displayName: analysis.displayName,
    n: analysis.n,
    permutationCount: analysis.permutationCount,
    adapterFingerprint: analysis.adapterFingerprint,
    targetRtp: render.fraction(TARGET_RTP),
    maxWinMultiple: LIMITS.maxWinMultiple.toString(),
    supremumMultiplier: render.fraction(analysis.maxMultiplier),
    stakeQuantumChips: STAKE_QUANTUM.toString(),
    bets: analysis.rows.map((row) => ({
      code: row.code,
      name: row.name,
      tier: row.tier,
      instances: row.instances,
      winsPerInstance: row.winsPerInstance,
      probability: render.fraction(row.probability),
      multiplier: render.fraction(row.multiplier),
      decimal: `${render.multiplierDecimal(row.multiplier)}x`,
      rtp: render.fraction(row.expectedValue),
      variance: render.fraction(row.variance),
    })),
  };

  markdown.push(`<!-- paytable:${variantId}:start -->`);
  markdown.push('| Code | Tier | Instances | Wins | Probability | Multiplier | Decimal | RTP |');
  markdown.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of analysis.rows) {
    markdown.push(
      `| \`${row.code}\` | ${row.tier} | ${row.instances} | ${row.winsPerInstance} | ` +
        `${render.fraction(row.probability)} | ${render.fraction(row.multiplier)} | ` +
        `${render.multiplierDecimal(row.multiplier)}× | ${render.fraction(row.expectedValue)} |`,
    );
  }
  markdown.push(`<!-- paytable:${variantId}:end -->`);
  markdown.push('');
}

/* --- Target RTP justification, computed ----------------------- */
if (variantIds.length === VARIANT_IDS.length) {
  say('-'.repeat(72));
  say('TARGET RTP — why 24/25 and not a neighbour');
  say('-'.repeat(72));
  say('Pricing every bet at rho/p makes the least common denominator of the');
  say('multipliers the required stake quantum, and fixes the decimals needed.');
  say();
  const head = ['candidate', 'rho', 'quantum (chips)', 'credits', 'decimals'];
  const widths = [12, 10, 18, 10, 10];
  const row = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('');
  say(`  ${row(head)}`);
  say(`  ${widths.map((w) => '-'.repeat(w - 1)).join(' ')}`);
  const candidates = [rational(47n, 50n), rational(19n, 20n), rational(191n, 200n), TARGET_RTP, rational(97n, 100n)];
  let best = null;
  for (const rho of candidates) {
    const profile = rtpCandidateProfile(rho);
    if (best === null || profile.stakeQuantumChips < best.stakeQuantumChips) best = profile;
    say(
      `  ${row([
        `${profile.percent}%`,
        render.fraction(rho),
        profile.stakeQuantumChips,
        render.approx(rational(profile.stakeQuantumChips, CHIPS_PER_CREDIT), 2),
        profile.displayDecimals,
      ])}`,
    );
  }
  say();
  check(
    'the shipped target RTP minimises the stake quantum and the decimals',
    best !== null && best.stakeQuantumChips === STAKE_QUANTUM && best.displayDecimals === 2,
    `24/25 -> quantum ${STAKE_QUANTUM} chips, 2 decimals`,
  );
  say();
}

say('='.repeat(72));
say(failures === 0 ? `RESULT  all checks passed` : `RESULT  ${failures} check(s) FAILED`);
say('='.repeat(72));
say('This repository is engineering evidence: source, exhaustive enumeration and');
say('deterministic fixtures. It is not an RNG certificate, a laboratory report,');
say('a regulatory approval, or a certified RTP for any deployed game.');

/* -------------------------------------------------------------- */
/* Emit                                                            */
/* -------------------------------------------------------------- */

if (wantWrite) {
  const paytablePath = join(ROOT, 'docs', 'paytable.json');
  mkdirSync(dirname(paytablePath), { recursive: true });
  writeFileSync(paytablePath, canonicalJson(machine));

  const fixtures = { schemaNote: 'Frozen wire-format vectors. Regenerate only with an intentional protocol change.', vectors: [] };
  for (const variantId of VARIANT_IDS) {
    for (let index = 0; index < 4; index += 1) {
      const serverSeed = seedFrom(`vector/${variantId}/${index}`);
      const context = {
        variantId,
        roundId: `fixture-${variantId}-${index}`,
        clientSeed: index % 2 === 0 ? 'axiom' : '',
        nonce: index,
      };
      const previous = index === 0 ? ZERO_COMMITMENT : fixtures.vectors[fixtures.vectors.length - 1].transcript.commitment;
      const transcript = makeTranscript(serverSeed, context, previous);
      fixtures.vectors.push({ serverSeed, context, transcript });
    }
  }
  const fixturePath = join(ROOT, 'tests', 'fixtures', 'transcripts.json');
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, canonicalJson(fixtures));
  if (!quiet) say(`\nwrote docs/paytable.json and tests/fixtures/transcripts.json`);
}

if (wantJson) {
  process.stdout.write(canonicalJson(machine));
} else if (wantMarkdown) {
  process.stdout.write(`${markdown.join('\n')}\n`);
} else {
  process.stdout.write(`${out.join('\n')}\n`);
}

process.exit(failures === 0 ? 0 : 1);
