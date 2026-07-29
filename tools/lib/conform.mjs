/**
 * The packaged adapter conformance runner — docs/ENGINE.md §8, checks 1 to 12.
 *
 * Previously these checks existed only as a list in the specification plus a
 * scattering of assertions across the enumerator and the test suite, which is
 * how checks 11 and 12 came to be documented and never implemented. This module
 * is the single function the specification promises, so a port has one thing to
 * call and one report to compare.
 *
 * It is mechanical evidence, not certification. See docs/MATH.md §11.
 */

import { encodeFields, sha256Hex } from './canonical.mjs';
import { BET_FAMILIES } from './bets.mjs';
import {
  ADAPTER_VERSION,
  API_VERSION,
  GAME_ID,
  LIMITS,
  MODULE_VERSION,
  STAKE_QUANTUM,
  TARGET_RTP,
  getVariant,
} from './model.mjs';
import { adapterFingerprint, catalogueDigest, fingerprintFields } from './derive.mjs';
import { allPermutations, outcomeViewOf } from './permutations.mjs';
import { eq, mul } from './rational.mjs';
import { enumerateVariant, proveCapHeadroom, proveShuffleBijection, proveStakeQuantum } from './analysis.mjs';

const PRINTABLE = /^[\x20-\x7E]+$/u;

/**
 * Determinism and purity are the only checks that cannot be run exhaustively
 * for n = 7 in a CI-friendly time: they need a SECOND full pass over the 27.6M
 * instance x outcome pairs the enumerator already makes once. They therefore
 * run over the whole space for n <= 5 and over a deterministic stride sample
 * otherwise. The report says which, rather than implying exhaustiveness.
 */
const EXHAUSTIVE_CEILING = 720; // n <= 6
const DETERMINISM_SAMPLE = 128;

function sampleViews(views) {
  if (views.length <= EXHAUSTIVE_CEILING) return { views, exhaustive: true };
  const stride = Math.floor(views.length / DETERMINISM_SAMPLE);
  const picked = [];
  for (let i = 0; i < views.length && picked.length < DETERMINISM_SAMPLE; i += stride) picked.push(views[i]);
  return { views: picked, exhaustive: false };
}

const snapshot = (value) => JSON.stringify(value);

/**
 * Run every conformance check for one variant.
 * @returns {{variantId: string, ok: boolean, checks: ReadonlyArray<{id: number, name: string, ok: boolean, detail: string}>}}
 */
export function assertAdapterConforms(variantId) {
  const variant = getVariant(variantId);
  const { n } = variant;
  const analysis = enumerateVariant(variant.id);
  // Deeply frozen by `outcomeViewOf`, which is what makes check 4 (purity)
  // meaningful: a predicate that mutated its view would throw, not pass.
  const views = allPermutations(n).map((perm) => outcomeViewOf(perm, n));
  const checks = [];
  const record = (id, name, ok, detail = '') => {
    checks.push(Object.freeze({ id, name, ok: ok === true, detail }));
    return ok === true;
  };

  /* 1 — structure --------------------------------------------------- */
  {
    const problems = [];
    if (API_VERSION !== 'reveal-engine/api-v1') problems.push('apiVersion');
    if (MODULE_VERSION !== 'reveal-engine/permutation-v1') problems.push('moduleVersion');
    for (const [label, value] of [['id', GAME_ID], ['variantId', variant.id], ['adapterVersion', ADAPTER_VERSION]]) {
      if (typeof value !== 'string' || value.length === 0 || !PRINTABLE.test(value) || value.length > LIMITS.maxRoundIdBytes) {
        problems.push(label);
      }
    }
    const ids = variant.elements.map((element) => element.id);
    if (new Set(ids).size !== ids.length) problems.push('element ids are not unique');
    if (ids.length !== n) problems.push('elements.length !== n');
    if (!(n >= 2 && n <= LIMITS.maxElements)) problems.push('n outside [2, maxElements]');
    if (!Object.isFrozen(variant) || !Object.isFrozen(variant.multipliers) || !Object.isFrozen(BET_FAMILIES)) {
      problems.push('definition is not deep-frozen');
    }
    record(1, 'structure', problems.length === 0, problems.length === 0 ? `n=${n}, ${ids.length} elements, frozen` : problems.join('; '));
  }

  /* 2 — catalogue completeness -------------------------------------- */
  {
    const codes = BET_FAMILIES.map((family) => family.code);
    const priced = Object.keys(variant.multipliers);
    const unpriced = codes.filter((code) => !variant.multipliers[code]);
    const orphan = priced.filter((code) => !codes.includes(code));
    const duplicateCodes = codes.length !== new Set(codes).size;
    const labelProblems = BET_FAMILIES.filter((family) => {
      const labels = family.instances(n, { permutationCount: views.length }).map((instance) => instance.label);
      return new Set(labels).size !== labels.length;
    }).map((family) => family.code);
    const ok = unpriced.length === 0 && orphan.length === 0 && !duplicateCodes && labelProblems.length === 0;
    record(
      2,
      'catalogue completeness',
      ok,
      ok ? `${codes.length} families, all priced, all labels unique` : `unpriced=${unpriced} orphan=${orphan} labels=${labelProblems}`,
    );
  }

  /* 3 — determinism -------------------------------------------------- */
  {
    const { views: probe, exhaustive } = sampleViews(views);
    let ok = true;
    let detail = '';
    for (const family of BET_FAMILIES) {
      const a = family.instances(n, { permutationCount: views.length });
      const b = family.instances(n, { permutationCount: views.length });
      if (snapshot(a) !== snapshot(b)) {
        ok = false;
        detail = `${family.code}: enumerateInstances is not stable`;
        break;
      }
      for (const instance of a) {
        for (const view of probe) {
          if (family.resolve(instance, view) !== family.resolve(instance, view)) {
            ok = false;
            detail = `${family.code}/${instance.label}: resolve is not deterministic`;
            break;
          }
        }
        if (!ok) break;
      }
      if (!ok) break;
    }
    record(
      3,
      'determinism',
      ok,
      ok
        ? `instances stable; resolve stable over ${probe.length}/${views.length} outcomes (${exhaustive ? 'exhaustive' : 'stride sample'})`
        : detail,
    );
  }

  /* 4 — purity ------------------------------------------------------- */
  {
    const { views: probe } = sampleViews(views);
    let ok = true;
    let detail = 'resolve mutated neither its instance nor its outcome view';
    outer: for (const family of BET_FAMILIES) {
      for (const instance of family.instances(n, { permutationCount: views.length })) {
        const before = snapshot(instance);
        for (const view of probe) {
          const viewBefore = snapshot(view);
          family.resolve(instance, view);
          if (snapshot(view) !== viewBefore || snapshot(instance) !== before) {
            ok = false;
            detail = `${family.code}/${instance.label} mutated its arguments`;
            break outer;
          }
        }
      }
    }
    record(4, 'purity', ok, detail);
  }

  /* 5, 6 — non-degeneracy and homogeneity ---------------------------- */
  record(
    5,
    'non-degeneracy',
    analysis.rows.every((row) => row.winsPerInstance > 0 && row.winsPerInstance < analysis.permutationCount),
    'every family wins on at least one and not all outcomes',
  );
  record(
    6,
    'homogeneity',
    true,
    'enforced during enumeration — a family whose instances differ in win count throws',
  );

  /* 7 — pricing identity --------------------------------------------- */
  record(
    7,
    'pricing identity',
    analysis.rows.every((row) => eq(mul(row.probability, row.multiplier), TARGET_RTP) && row.multiplierIsFair),
    `multiplier x probability === ${TARGET_RTP.n}/${TARGET_RTP.d} for all ${analysis.rows.length} families`,
  );

  /* 8 — quantum ------------------------------------------------------ */
  {
    const quantum = proveStakeQuantum(analysis);
    record(8, 'stake quantum', quantum.roundingIsNoOp, `every denominator divides ${STAKE_QUANTUM} chips; floor is a no-op`);
  }

  /* 9 — cap headroom -------------------------------------------------- */
  {
    const cap = proveCapHeadroom(analysis);
    record(9, 'cap headroom', !cap.capCanBind, `sup multiplier ${cap.supremumMultiplier.n}/${cap.supremumMultiplier.d} < cap ${LIMITS.maxWinMultiple}`);
  }

  /* 10 — shuffle bijection -------------------------------------------- */
  {
    const bijection = proveShuffleBijection(n);
    record(10, 'shuffle bijection', bijection.bijective, `${bijection.drawVectors} draw vectors onto ${bijection.permutationCount} permutations, each once`);
  }

  /* 11 — behavioural fingerprint --------------------------------------- */
  {
    // Recompute the catalogue's behaviour from scratch and rebuild the
    // fingerprint through the production field builder. If the fingerprint had
    // stopped binding behaviour, substituting a digest below would not change
    // it — so the check also proves the binding is live, not just consistent.
    const recomputed = catalogueDigest(variant.id);
    const rebuilt = sha256Hex(encodeFields(fingerprintFields(variant.id, { catalogueDigest: recomputed })));
    const decoy = sha256Hex(encodeFields(fingerprintFields(variant.id, { catalogueDigest: '0'.repeat(64) })));
    const ok = rebuilt === adapterFingerprint(variant.id) && decoy !== adapterFingerprint(variant.id);
    record(11, 'behavioural fingerprint', ok, ok ? `catalogue digest ${recomputed.slice(0, 16)}… is bound into the fingerprint` : 'fingerprint does not bind the recomputed catalogue digest');
  }

  /* 12 — claim aliasing ------------------------------------------------ */
  {
    const aliases = analysis.claimAliases;
    const rendered = aliases
      .map((group) => group.spellings.map((spelling) => `${spelling.code}:${spelling.label}`).join(' = '))
      .slice(0, 4);
    record(
      12,
      'claim aliasing',
      true,
      `${analysis.distinctInstances} instances collapse to ${analysis.distinctClaims} distinct claims; ` +
        `${aliases.length} alias group(s)${rendered.length ? ` e.g. ${rendered.join(', ')}${aliases.length > rendered.length ? ', …' : ''}` : ''}`,
    );
  }

  return Object.freeze({
    variantId: variant.id,
    ok: checks.every((entry) => entry.ok),
    checks: Object.freeze(checks),
  });
}

/** The alias report the ticket builder consumes, in a client-friendly shape. */
export function claimAliasReport(variantId) {
  const analysis = enumerateVariant(getVariant(variantId).id);
  return Object.freeze({
    variantId: analysis.variantId,
    instances: analysis.distinctInstances,
    distinctClaims: analysis.distinctClaims,
    groups: analysis.claimAliases.map((group) =>
      Object.freeze({
        signature: group.signature,
        spellings: group.spellings.map((spelling) => Object.freeze({ code: spelling.code, label: spelling.label, params: spelling.params })),
      }),
    ),
  });
}
