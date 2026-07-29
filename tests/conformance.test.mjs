/**
 * The packaged adapter conformance runner — docs/ENGINE.md §8.
 *
 * The specification has always listed twelve checks. Two of them (the
 * behavioural fingerprint and the claim-alias report) were listed and never
 * implemented, and the status table did not say so. This suite asserts that all
 * twelve run, that they pass, and — the part that matters — that the document's
 * list and the code's list are the same list.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { assertAdapterConforms, claimAliasReport } from '../tools/lib/conform.mjs';
import { enumerateVariant } from '../tools/lib/analysis.mjs';
import { claimSignature } from '../tools/lib/derive.mjs';
import { VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_MD = readFileSync(join(ROOT, 'docs', 'ENGINE.md'), 'utf8');
const PAYTABLE = JSON.parse(readFileSync(join(ROOT, 'docs', 'paytable.json'), 'utf8'));

describe.each(VARIANT_IDS)('conformance — %s', (variantId) => {
  const report = assertAdapterConforms(variantId);

  it('passes every check', () => {
    const failures = report.checks.filter((check) => !check.ok);
    expect(failures.map((check) => `${check.id} ${check.name}: ${check.detail}`)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('runs exactly the twelve checks the specification lists, in order', () => {
    expect(report.checks.map((check) => check.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('gives every check a non-empty explanation', () => {
    for (const check of report.checks) expect(check.detail.length).toBeGreaterThan(0);
  });

  it('does not claim exhaustiveness for the two sampled checks', () => {
    const { n } = getVariant(variantId);
    const determinism = report.checks.find((check) => check.id === 3);
    if (n <= 5) expect(determinism.detail).toContain('exhaustive');
    else expect(determinism.detail).toContain('stride sample');
  });
});

describe('docs/ENGINE.md §8 lists exactly the implemented checks', () => {
  // The numbered list between the §8 heading and the caveat paragraph.
  const section = ENGINE_MD.slice(ENGINE_MD.indexOf('## 8. Adapter conformance'), ENGINE_MD.indexOf('## 9. Errors'));

  it.each([
    [1, 'Structure'],
    [2, 'Catalogue completeness'],
    [3, 'Determinism'],
    [4, 'Purity'],
    [5, 'Non-degeneracy'],
    [6, 'Homogeneity'],
    [7, 'Pricing identity'],
    [8, 'Quantum'],
    [9, 'Cap headroom'],
    [10, 'Shuffle bijection'],
    [11, 'Behavioural fingerprint'],
    [12, 'Claim aliasing'],
  ])('check %i is documented as "%s"', (id, name) => {
    expect(section).toContain(`${id}. **${name}**`);
  });

  it('no longer says checks 11 and 12 are unimplemented', () => {
    expect(ENGINE_MD).not.toContain('Conformance checks 1–10');
    expect(section).toContain('assertAdapterConforms');
  });
});

describe.each(VARIANT_IDS)('the claim-alias report — %s', (variantId) => {
  const { n } = getVariant(variantId);
  const report = claimAliasReport(variantId);
  const analysis = enumerateVariant(variantId);

  it('finds exactly the FIRST/SLOT and LAST/SLOT pairs, and nothing else', () => {
    expect(report.groups).toHaveLength(2 * n);
    const codes = report.groups.map((group) => group.spellings.map((s) => s.code).sort().join('+'));
    expect(new Set(codes)).toEqual(new Set(['first+slot', 'last+slot']));
    for (const group of report.groups) expect(group.spellings).toHaveLength(2);
  });

  it('every reported group really is one claim under the settlement path', () => {
    for (const group of report.groups) {
      const signatures = group.spellings.map((s) => claimSignature(variantId, s.code, { params: s.params }));
      expect(new Set(signatures).size).toBe(1);
    }
  });

  it('accounts for every instance exactly once', () => {
    const aliased = report.groups.reduce((total, group) => total + group.spellings.length, 0);
    expect(report.instances - aliased + report.groups.length).toBe(report.distinctClaims);
    expect(report.instances).toBe(analysis.rows.reduce((total, row) => total + row.instances, 0));
  });

  it('is published in docs/paytable.json for the ticket builder', () => {
    const published = PAYTABLE.variants[variantId];
    expect(published.instances).toBe(report.instances);
    expect(published.distinctClaims).toBe(report.distinctClaims);
    expect(published.claimAliases).toHaveLength(report.groups.length);
    expect(published.claimAliases[0].spellings.map((s) => s.code).sort()).toEqual(['first', 'slot']);
  });
});
