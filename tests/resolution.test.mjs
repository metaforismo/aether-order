/**
 * The resolution track, which is where round 2 shipped a manufactured
 * near-miss by contradiction.
 *
 * docs/DESIGN.md §2.1 stated the rule correctly — a line changes state at the
 * first lock after which its verdict is identical for every completion of the
 * tube — and then published a table underneath it saying LAST resolves at
 * "lock n". After lock n-1 exactly one completion remains, so LAST is decided
 * at lock n-1 at the latest and usually far earlier. A LAST line that died at
 * lock 1 would have stayed lit until the tube was full: precisely the "kept
 * alive to look close" that §2.1 and §9 both ban, on a FORM-tier chip every
 * player uses, during the round's most dramatic beat.
 *
 * It survived review because the celebration gate is code with tests and the
 * resolution track was prose. This file is the other half of that repair: the
 * rule is now `tools/lib/resolution.mjs`, and the document is asserted against
 * it exactly as docs/MATH.md is asserted against the enumerator.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BET_FAMILIES } from '../tools/lib/bets.mjs';
import { allPermutations, factorial } from '../tools/lib/permutations.mjs';
import { getVariant } from '../tools/lib/model.mjs';
import {
  completionCount,
  completionsAfterPenultimateLock,
  completionsOf,
  decisiveLock,
  decisiveLockByEnumeration,
  resolutionTable,
  resolutionTrack,
} from '../tools/lib/resolution.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

const CLASSIC_PERMS = allPermutations(5);
const CLASSIC = resolutionTable('classic', { permutations: CLASSIC_PERMS });

/** The same fixed sample the enumerator uses, so both report the same table. */
function sevenSample() {
  const all = allPermutations(7);
  const ranks = new Set();
  let state = 12345;
  while (ranks.size < 40) {
    state = (state * 1103515245 + 12345) % 2147483648;
    ranks.add(state % 5040);
  }
  return { ranks, permutations: [...ranks].map((rank) => all[rank]) };
}

const SEVEN_SAMPLE = sevenSample();
const SEVEN = resolutionTable('seven', {
  permutations: SEVEN_SAMPLE.permutations,
  instanceFilter: (family, instance) => family.code !== 'full' || SEVEN_SAMPLE.ranks.has(instance.params.rank),
});

/* ------------------------------------------------------------------ *
 * 1. The universal bound, structurally.                                *
 * ------------------------------------------------------------------ */

describe('every line is decided by lock n-1', () => {
  it.each([5, 7])('after n-1 locks exactly one completion of the tube remains (n = %i)', (n) => {
    expect(completionsAfterPenultimateLock(n)).toBe(1);
    expect(completionCount(n, n - 1)).toBe(1);
    expect(completionCount(n, n)).toBe(1);
  });

  it.each([5, 7])('the completion count is (n - k)! at every prefix length (n = %i)', (n) => {
    const identity = Array.from({ length: n }, (_, i) => i);
    for (let k = 0; k <= n; k += 1) {
      const seen = [...completionsOf(n, identity.slice(0, k))];
      expect(seen.length, `prefix length ${k}`).toBe(factorial(n - k));
    }
  });

  it('no chip in either variant resolves later than lock n-1', () => {
    for (const table of [CLASSIC, SEVEN]) {
      for (const row of table.rows) {
        expect(row.latestLock, `${table.variantId}/${row.code}`).toBeLessThanOrEqual(table.n - 1);
        expect(row.earliestLock, `${table.variantId}/${row.code}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('the CLASSIC table is exhaustive, not sampled', () => {
    const pairs = CLASSIC.rows.reduce((sum, row) => sum + row.pairs, 0);
    // 295 instances x 120 outcomes.
    expect(pairs).toBe(295 * 120);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The fast sweep equals the definition.                             *
 * ------------------------------------------------------------------ */

describe('the sweep agrees with the definition it implements', () => {
  it('agrees with the allocating enumeration across the entire CLASSIC space', () => {
    const n = 5;
    // Every family, every instance, a fixed spread of outcomes. The two
    // implementations share no code path: one mutates a single view depth-first
    // and aborts early, the other materialises each completion through the
    // generator and allocates a fresh view.
    const outcomes = CLASSIC_PERMS.filter((_, index) => index % 7 === 0);
    for (const family of BET_FAMILIES) {
      for (const instance of family.instances(n, { permutationCount: 120 })) {
        for (const perm of outcomes) {
          const fast = decisiveLock(n, family, instance, perm);
          const slow = decisiveLockByEnumeration(n, family, instance, perm);
          expect(fast.lock, `${family.code} ${instance.label}`).toBe(slow.lock);
          expect(fast.verdict, `${family.code} ${instance.label}`).toBe(slow.verdict);
        }
      }
    }
  });

  it('the verdict it settles on is the real outcome of the round', () => {
    const n = 5;
    for (const family of BET_FAMILIES) {
      for (const instance of family.instances(n, { permutationCount: 120 })) {
        for (const perm of CLASSIC_PERMS.filter((_, index) => index % 11 === 0)) {
          const { verdict } = decisiveLock(n, family, instance, perm);
          const pos = new Array(n);
          perm.forEach((element, slot) => {
            pos[element] = slot;
          });
          const rank = CLASSIC_PERMS.findIndex((candidate) => candidate.every((v, i) => v === perm[i]));
          expect(verdict).toBe(family.resolve(instance, { n, perm, pos, rank }) === true);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. The document matches the code.                                    *
 * ------------------------------------------------------------------ */

/** Parse the §2.1 resolution table out of docs/DESIGN.md. */
function documentedResolution() {
  const start = DESIGN.indexOf('<!-- resolution:start -->');
  const end = DESIGN.indexOf('<!-- resolution:end -->');
  expect(start, 'docs/DESIGN.md is missing the resolution table markers').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rows = new Map();
  for (const line of DESIGN.slice(start, end).split('\n')) {
    const match = line.match(/^\|\s*`([a-z-]+)`\s*\|[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/u);
    if (match) rows.set(match[1], { classicLatest: Number(match[2]), sevenLatest: Number(match[3]) });
  }
  return rows;
}

describe('docs/DESIGN.md §2.1 publishes the table the code computes', () => {
  const documented = documentedResolution();

  it('covers every bet family', () => {
    expect(documented.size).toBe(BET_FAMILIES.length);
    for (const family of BET_FAMILIES) expect(documented.has(family.code), family.code).toBe(true);
  });

  it.each(BET_FAMILIES.map((family) => [family.code]))(
    '%s: the published latest lock matches the enumeration in both variants',
    (code) => {
      const row = documented.get(code);
      expect(row.classicLatest, `${code} CLASSIC`).toBe(CLASSIC.rows.find((entry) => entry.code === code).latestLock);
      expect(row.sevenLatest, `${code} SEVEN`).toBe(SEVEN.rows.find((entry) => entry.code === code).latestLock);
    },
  );

  it('states the universal bound rather than leaving it to be inferred', () => {
    expect(DESIGN).toMatch(/every line is decided by\s+lock `n−1`/u);
    expect(DESIGN).toContain('THE CLOSE');
    expect(DESIGN).toMatch(/final fall\s+carries no information at all/u);
  });

  it('no longer says LAST resolves at the final lock', () => {
    // The exact defect. LAST is a FORM-tier chip and lock n is one lock too late.
    expect(documented.get('last').classicLatest).toBe(4);
    expect(documented.get('last').sevenLatest).toBe(6);
    expect(DESIGN).not.toMatch(/\|\s*LAST\s*\|\s*lock n\s*\|/u);
    expect(README).not.toContain('LAST at the top');
  });

  it('the README describes resolution the same way the table does', () => {
    expect(README).toMatch(/never later than the\s+second-to-last sphere/u);
    expect(README).toMatch(/kept\s+alive to look close/u);
    expect(README).toMatch(/final fall is a finish, not a reveal/u);
  });
});

/* ------------------------------------------------------------------ *
 * 3b. §13.1's round-shape argument is read off the enumeration.        *
 *                                                                      *
 * Round 4 illustrated "the round's shape varies with the ticket" with  *
 * "a FLOW-only ticket is decided in the first two locks and the rest    *
 * of the settle is scenery". Three of the four FLOW chips resolve later *
 * than that, and two of them run to lock n-1 — the LAST informative     *
 * lock — so the tier chosen as the example is the one whose chips       *
 * resolve latest. It was the section's only concrete illustration, in   *
 * the argument the product's watch-value case rests on, and nothing     *
 * tested it because it was prose.                                       *
 * ------------------------------------------------------------------ */

/** Parse the §13.1 round-shape table out of docs/DESIGN.md. */
function documentedShape() {
  const start = DESIGN.indexOf('<!-- shape:start -->');
  const end = DESIGN.indexOf('<!-- shape:end -->');
  expect(start, 'docs/DESIGN.md is missing the round-shape table markers').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rows = [];
  for (const line of DESIGN.slice(start, end).split('\n')) {
    const match = line.match(/^\|\s*`([a-z-]+)`\s*\|([^|]*)\|\s*(FLOW|FORM|ORDER)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/u);
    if (match) {
      rows.push({ code: match[1], chip: match[2].trim(), tier: match[3], earliest: Number(match[4]), latest: Number(match[5]) });
    }
  }
  return rows;
}

describe('docs/DESIGN.md §13.1 reads its round-shape claims off the enumeration', () => {
  const documented = documentedShape();
  const byCode = (code) => CLASSIC.rows.find((row) => row.code === code);

  it('covers every chip, with the tier the catalogue declares', () => {
    expect(documented).toHaveLength(BET_FAMILIES.length);
    for (const row of documented) {
      const family = BET_FAMILIES.find((candidate) => candidate.code === row.code);
      expect(family, row.code).toBeDefined();
      expect(row.tier, row.code).toBe(family.tier);
      expect(row.chip, row.code).toBe(family.name);
    }
  });

  it.each(BET_FAMILIES.map((family) => [family.code]))('%s: both published locks are the enumerated ones', (code) => {
    const row = documented.find((candidate) => candidate.code === code);
    expect(row.earliest, `${code} earliest`).toBe(byCode(code).earliestLock);
    expect(row.latest, `${code} latest`).toBe(byCode(code).latestLock);
  });

  it('is sorted by when the chip is guaranteed decided, so the shape is legible', () => {
    const latest = documented.map((row) => row.latest);
    expect([...latest].sort((a, b) => a - b)).toEqual(latest);
  });

  it('every bullet the section reads off the table is true of the table', () => {
    // FIRST is the only chip whose lock is fixed.
    const fixed = CLASSIC.rows.filter((row) => row.earliestLock === row.latestLock);
    expect(fixed.map((row) => row.code)).toEqual(['first']);
    // LINK · EITHER is the only chip that can never resolve at lock 1.
    const neverFirstLock = CLASSIC.rows.filter((row) => row.earliestLock > 1);
    expect(neverFirstLock.map((row) => row.code)).toEqual(['link-any']);
    // The ORDER ladder is three separate moments: 2, 3, n-1.
    expect(byCode('opening').latestLock).toBe(2);
    expect(byCode('podium').latestLock).toBe(3);
    expect(byCode('full').latestLock).toBe(CLASSIC.n - 1);
    // LATE finishes by n-2, so a LATE-heavy round ends before the tube does.
    expect(byCode('late').latestLock).toBe(CLASSIC.n - 2);
    // Exactly six chips can run to the last informative lock.
    const toTheEnd = CLASSIC.rows.filter((row) => row.latestLock === CLASSIC.n - 1).map((row) => row.code);
    expect(toTheEnd.sort()).toEqual(['before', 'full', 'last', 'link', 'link-any', 'slot']);
    expect(DESIGN).toMatch(/Six of the eleven chips can run to lock `n−1`/u);
  });

  it('no longer claims a FLOW-only ticket is decided in the first two locks', () => {
    // The sentence may appear exactly once, inside the paragraph that withdraws
    // it. It may not appear anywhere the document is still speaking in its own
    // voice — which is where it was.
    const claim = /FLOW-only ticket is decided in the first two\s+locks/gu;
    expect(DESIGN.match(claim) ?? []).toHaveLength(1);
    const withdrawal = DESIGN.indexOf('**The claim this replaces was false');
    expect(withdrawal).toBeGreaterThan(-1);
    expect(DESIGN.slice(0, withdrawal)).not.toMatch(claim);
    // The three FLOW chips that make the old sentence false.
    for (const code of ['before', 'link-any']) {
      expect(byCode(code).latestLock, code).toBe(CLASSIC.n - 1);
    }
    expect(byCode('late').latestLock).toBeGreaterThan(2);
    // And the correction is stated rather than the sentence quietly deleted.
    expect(DESIGN).toMatch(/three of the tier's four chips resolve later than the\s+sentence claimed/u);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The track a renderer consumes.                                    *
 * ------------------------------------------------------------------ */

describe('resolutionTrack is what the choreography builder gets', () => {
  const perm = [2, 0, 4, 1, 3];
  const ticket = {
    lines: [
      { code: 'first', params: { c: 2 } },
      { code: 'last', params: { c: 0 } },
      { code: 'full', params: { rank: 0 } },
      { code: 'slot', params: { c: 3, k: 4 } },
    ],
  };

  it('reports a decisive lock and a verdict for every line', () => {
    const track = resolutionTrack('classic', ticket, perm);
    expect(track.lines).toHaveLength(4);
    expect(track.lines[0]).toMatchObject({ code: 'first', lock: 1, verdict: true });
    // LAST amber loses the moment amber seats at slot 2, not at the top.
    expect(track.lines[1]).toMatchObject({ code: 'last', lock: 2, verdict: false });
    // FULL ORDER rank 0 is [0,1,2,3,4]; it dies on the first lock.
    expect(track.lines[2]).toMatchObject({ code: 'full', lock: 1, verdict: false });
    // SLOT c=3 @ k=4 needs the top slot, and gets it. Once four spheres are
    // seated only one slot is free, so this WINS at lock 4 — one lock before
    // the sphere it names has even left the liquid. That is the whole shape of
    // the format, and it is why the last fall is a coda rather than a reveal.
    expect(track.lines[3]).toMatchObject({ code: 'slot', lock: 4, verdict: true });
  });

  it('states that the final fall carries no information, in every round', () => {
    for (const variantId of ['classic', 'seven']) {
      const { n } = getVariant(variantId);
      const identity = Array.from({ length: n }, (_, i) => i);
      const track = resolutionTrack(variantId, { lines: [{ code: 'last', params: { c: 0 } }] }, identity);
      expect(track.closeCarriesInformation).toBe(false);
      expect(track.settlementKnownAtLock).toBe(n - 1);
      expect(track.latestPossibleLock).toBe(n - 1);
      expect(track.latestUsedLock).toBeLessThanOrEqual(n - 1);
    }
  });

  it('costs no more per line than the sum of the factorials the doc quotes', () => {
    // docs/DESIGN.md §7 technique 1 quotes 5,914 as the per-line bound at n = 7.
    // The worst real case is a high-ranked FULL ORDER claim, which agrees "lose"
    // across thousands of completions before reaching its single winner.
    const bound = (n) => {
      let sum = 0;
      for (let k = 0; k <= n; k += 1) sum += factorial(n - k);
      return sum;
    };
    expect(bound(5)).toBe(154);
    expect(bound(7)).toBe(5914);
    expect(DESIGN).toContain('5,914 predicate');

    const full = BET_FAMILIES.find((family) => family.code === 'full');
    const sevenPerms = allPermutations(7);
    for (const rank of [0, 2519, 5039]) {
      const instance = full.instances(7, { permutationCount: 5040 })[rank];
      const worst = decisiveLock(7, full, instance, sevenPerms[rank]);
      expect(worst.lock).toBe(6);
      expect(worst.completionsChecked).toBeLessThanOrEqual(bound(7));
    }
  });

  it('is a pure function of the ticket and the permutation', () => {
    const a = resolutionTrack('classic', ticket, perm);
    const b = resolutionTrack('classic', ticket, perm);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects a line that is not a legal instance', () => {
    expect(() => resolutionTrack('classic', { lines: [{ code: 'slot', params: { c: 9, k: 0 } }] }, perm)).toThrow(
      /not a legal instance/u,
    );
  });

  it('reads the supplied lines array by index rather than through its own methods', () => {
    // The same hostile shape normalizeTicket defends against: an array carrying
    // an own `map` that reports one line to a length check and hands back more.
    const hostileLines = Object.assign([{ code: 'first', params: { c: 2 } }], {
      map: () => Array.from({ length: 9 }, () => ({ code: 'full', params: { rank: 0 } })),
    });
    expect(resolutionTrack('classic', { lines: hostileLines }, perm).lines).toHaveLength(1);
  });
});
