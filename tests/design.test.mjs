/**
 * The design documents are tested artefacts too.
 *
 * Three classes of defect motivated this file, all of them found by review
 * rather than by CI:
 *
 *   - a normative TypeScript signature in docs/ENGINE.md that had drifted from
 *     the code it describes, sitting next to the security argument it
 *     contradicted;
 *   - an accessibility claim ("no token ships below 4.5:1") that was false for
 *     six tokens, quoted beside four ratios that were exactly right;
 *   - player-protection rules stated only in prose, where a client is free to
 *     reimplement them slightly differently.
 *
 * Everything here recomputes rather than trusts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as derive from '../tools/lib/derive.mjs';
import * as conform from '../tools/lib/conform.mjs';
import { ELEMENTS, PLAY_POLICY } from '../tools/lib/model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(ROOT, name), 'utf8');
const DESIGN = read('docs/DESIGN.md');
const ENGINE = read('docs/ENGINE.md');
const MATH = read('docs/MATH.md');
const README = read('README.md');

/* ------------------------------------------------------------------ *
 * 1. Contrast — recomputed, not quoted.                                *
 * ------------------------------------------------------------------ */

const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every `--token | #hex` row in the environment palette table. */
function paletteTokens() {
  const tokens = new Map();
  for (const match of DESIGN.matchAll(/\|\s*`(--[a-z-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|/gu)) {
    tokens.set(match[1], match[2]);
  }
  return tokens;
}

/** Tokens that can carry text, an icon, or a state the player must perceive. */
const FOREGROUND = ['--ink', '--ink-dim', '--gold', '--gold-hot', '--win', '--specular', '--chrome', '--glass-edge', '--chrome-mid'];
/** AAA-for-normal-text tokens: the four the document actually quotes. */
const AAA = ['--ink', '--ink-dim', '--gold', '--win'];

describe('docs/DESIGN.md palette and contrast', () => {
  const tokens = paletteTokens();
  const VOID = tokens.get('--void');

  it('parses a complete palette with a background token', () => {
    expect(VOID).toBe('#05070C');
    expect(tokens.size).toBeGreaterThanOrEqual(14);
  });

  it('every contrast ratio the document quotes is arithmetically correct', () => {
    // Matches "`--ink` 17.22:1" and "`--abyss` is 1.07:1" alike.
    const claims = [...DESIGN.matchAll(/`(--[a-z-]+)`(?: is)? (\d+\.\d{2}):1/gu)];
    expect(claims.length).toBeGreaterThanOrEqual(9);
    for (const [, token, quoted] of claims) {
      const hex = tokens.get(token);
      expect(hex, `${token} is quoted with a ratio but absent from the palette table`).toBeDefined();
      expect(contrast(hex, VOID).toFixed(2), `${token}`).toBe(quoted);
    }
  });

  it('every foreground token clears 4.5:1, and the AAA four clear 7:1', () => {
    for (const token of FOREGROUND) {
      expect(contrast(tokens.get(token), VOID), `${token}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const token of AAA) {
      expect(contrast(tokens.get(token), VOID), `${token}`).toBeGreaterThanOrEqual(7);
    }
  });

  it('scopes the contrast rule to foreground tokens rather than claiming it of all', () => {
    // The old blanket claim was false for six surface tokens.
    expect(DESIGN).not.toContain('no token in the palette is allowed to ship below 4.5:1');
    expect(DESIGN).toContain('no foreground token may ship below');
    expect(DESIGN).toContain('Surface tokens are explicitly exempt');
  });

  it('every sphere colour is legible against the void and matches the shipped model', () => {
    for (const element of ELEMENTS) {
      expect(contrast(element.hex, VOID), element.id).toBeGreaterThanOrEqual(4.5);
      expect(DESIGN, `${element.name} ${element.hex} missing from the sphere table`).toContain(element.hex);
    }
  });

  it('names the true worst colour pair rather than the assumed one', () => {
    const byId = Object.fromEntries(ELEMENTS.map((element) => [element.id, element.hex]));
    const indigoViolet = contrast(byId.indigo, byId.violet);
    const roseCoral = contrast(byId.rose, byId.coral);
    expect(indigoViolet).toBeLessThan(roseCoral);
    expect(DESIGN).toContain('INDIGO↔VIOLET at 1.24:1');
    expect(DESIGN).toContain('ROSE↔CORAL at 1.34:1');
    expect(indigoViolet.toFixed(2)).toBe('1.24');
    expect(roseCoral.toFixed(2)).toBe('1.34');
  });
});

/* ------------------------------------------------------------------ *
 * 2. The player-protection rules are code, and the docs quote the code. *
 * ------------------------------------------------------------------ */

describe('the celebration gate is stated as the comparison it is', () => {
  it('docs/DESIGN.md §10 quotes the exact expression', () => {
    expect(DESIGN).toContain('`creditedChips > totalStakeChips`');
  });

  it('names the single implementation so a client cannot reimplement it', () => {
    expect(DESIGN).toContain('roundPresentation');
    expect(DESIGN).toContain('tools/lib/presentation.mjs');
    expect(README).toContain('tools/lib/presentation.mjs');
  });

  it('states that the balance does not animate upward below the gate', () => {
    expect(DESIGN).toMatch(/balance \*\*writes to its new value without animating\s+upward\*\*/u);
  });

  it('is mirrored in the README rather than left in the spec', () => {
    expect(README).toContain('No losing round is ever presented as a win');
  });
});

describe('the speed-of-play policy is quoted consistently everywhere', () => {
  it('the published policy is the one the documents state', () => {
    expect(PLAY_POLICY.minRoundCycleMs).toBe(2500);
    expect(PLAY_POLICY.maxRoundsPerRollingHour).toBe(900);
    expect(PLAY_POLICY.skipShortensPresentationOnly).toBe(true);
  });

  it('docs/DESIGN.md quotes both numbers', () => {
    expect(DESIGN).toContain(`${PLAY_POLICY.minRoundCycleMs.toLocaleString('en-US')} ms`);
    expect(DESIGN).toContain(`${PLAY_POLICY.maxRoundsPerRollingHour} rounds per rolling 60 minutes`);
  });

  it('docs/MATH.md does the exposure arithmetic from the same numbers', () => {
    expect(MATH).toContain('2,500 ms minimum round cycle');
    expect(MATH).toContain('900 rounds');
    // 900 rounds x 200.00 credits x 4% edge.
    expect(MATH).toContain('180,000 credits/hour');
    expect(MATH).toContain('7,200 credits/hour');
  });

  it('the README states the floor and that SKIP cannot shorten it', () => {
    expect(README).toContain('2.5 seconds');
    expect(README).toContain('900 rounds per rolling hour');
    expect(README).toMatch(/does\s+not let you bet any faster/u);
  });

  it('docs/paytable.json publishes the policy for the client and the RGS', () => {
    const published = JSON.parse(read('docs/paytable.json')).playPolicy;
    expect(published.minRoundCycleMs).toBe(PLAY_POLICY.minRoundCycleMs);
    expect(published.maxRoundsPerRollingHour).toBe(PLAY_POLICY.maxRoundsPerRollingHour);
    expect(published.skipShortensPresentationOnly).toBe(true);
  });
});

describe('the ticket-strip figure is described as a maximum over outcomes', () => {
  it('docs/DESIGN.md calls it the best possible outcome', () => {
    expect(DESIGN).toContain('best possible outcome');
    expect(DESIGN).toContain('best 139.20');
  });

  it('explicitly rejects the sum-of-every-line figure', () => {
    expect(DESIGN).toContain('not** the sum of every line');
    expect(MATH).toContain('The figure the player sees before committing');
  });
});

describe('the repudiation boundary is stated wherever fairness is claimed', () => {
  it.each([
    ['README.md', README],
    ['docs/ENGINE.md', ENGINE],
    ['docs/MATH.md', MATH],
  ])('%s says commit-reveal does not cover the bet', (_name, text) => {
    expect(text).toMatch(/proves? the \*{0,2}draw/iu);
    expect(text.toLowerCase()).toContain('receipt');
  });

  it('the README does not overstate the receipt as verification from first principles', () => {
    expect(README).toContain('needs the operator');
  });
});

/* ------------------------------------------------------------------ *
 * 3. The normative TypeScript surface matches the reference.           *
 * ------------------------------------------------------------------ */

/** Split a parameter list on top-level commas, ignoring object-type braces. */
function splitParams(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '{' || character === '[' || character === '(') depth += 1;
    if (character === '}' || character === ']' || character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part.length > 0);
}

const objectKeys = (text) => {
  const open = text.indexOf('{');
  if (open === -1) return null;
  const body = text.slice(open + 1, text.lastIndexOf('}'));
  return body
    .split(/[;,]/u)
    .map((entry) => entry.split(':')[0].trim().replace(/\?$/u, ''))
    .filter((entry) => /^[A-Za-z_$][\w$]*$/u.test(entry))
    .sort();
};

/** Parse `export function name(params): type;` out of the document's ts blocks. */
function documentedSignatures() {
  const signatures = new Map();
  for (const match of ENGINE.matchAll(/export function (\w+)\(([\s\S]*?)\)\s*:/gu)) {
    signatures.set(match[1], splitParams(match[2]));
  }
  return signatures;
}

/** Parse the reference implementation's real parameter list from its source. */
function referenceParams(fn) {
  const source = fn.toString();
  const open = source.indexOf('(');
  let depth = 0;
  let close = open;
  for (let i = open; i < source.length; i += 1) {
    if ('([{'.includes(source[i])) depth += 1;
    if (')]}'.includes(source[i])) {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  return splitParams(source.slice(open + 1, close)).map((part) => part.split('=')[0].trim());
}

/**
 * doc name -> [reference function, reference name].
 *
 * The reference is game-specific, so wherever the module surface takes a
 * `game` the reference takes `variantId` or nothing at all. That is the ONLY
 * permitted difference; every other parameter must match by name and position.
 */
const SURFACE = [
  ['seedCommitment', derive.seedCommitment],
  ['uniformBelow', derive.uniformBelow],
  ['derivePermutation', derive.derivePermutation],
  ['makePermutationTranscript', derive.makeTranscript],
  ['verifyPermutationTranscript', derive.verifyTranscript],
  ['openTicket', derive.openTicket],
  ['settleTicket', derive.settleTicket],
  ['ticketDigest', derive.ticketDigest],
  ['settlementDigest', derive.settlementDigest],
  ['idempotencyKeyFor', derive.idempotencyKeyFor],
  ['makeReceipt', derive.makeReceipt],
  ['signReceipt', derive.signReceipt],
  ['verifyReceipt', derive.verifyReceipt],
  ['serializeTranscript', derive.serializeTranscript],
  ['deserializeTranscript', derive.deserializeTranscript],
  ['serializeRoundSnapshot', derive.serializeRoundSnapshot],
  ['deserializeRoundSnapshot', derive.deserializeRoundSnapshot],
  ['assertPermutationAdapterConforms', conform.assertAdapterConforms],
];

describe('docs/ENGINE.md declares the surface the reference actually implements', () => {
  const documented = documentedSignatures();

  it('declares every function the reference exposes on the module surface', () => {
    for (const [name] of SURFACE) {
      expect(documented.has(name), `docs/ENGINE.md does not declare ${name}`).toBe(true);
    }
  });

  it.each(SURFACE)('%s matches the reference signature parameter for parameter', (name, fn) => {
    const docParams = documented.get(name);
    const refParams = referenceParams(fn);

    let refIndex = 0;
    for (const declared of docParams) {
      const declaredName = declared.split(':')[0].trim().replace(/\?$/u, '');
      const refParam = refParams[refIndex];

      if (declaredName === 'game') {
        // The module carries the game definition; the reference either takes a
        // variantId in its place, or is bound to a variant and takes neither.
        if (refParam === 'variantId') refIndex += 1;
        continue;
      }

      expect(refParam, `${name}: doc declares "${declaredName}" and the reference has no parameter there`).toBeDefined();

      if (refParam.startsWith('{')) {
        // Destructured in the reference: compare the object's key sets, which
        // is a stronger check than comparing a positional name.
        expect(objectKeys(refParam), `${name}.${declaredName} keys`).toEqual(objectKeys(declared));
      } else {
        expect(refParam, `${name}: parameter ${refIndex + 1}`).toBe(declaredName);
      }
      refIndex += 1;
    }
    expect(refParams.slice(refIndex), `${name}: reference has undeclared trailing parameters`).toEqual([]);
  });

  it('the seed commitment binds the whole context, in the declaration as well as the prose', () => {
    // The exact regression this file exists for: `seedCommitment(seed, roundId)`
    // survived in the normative interface while the prose two sections away
    // argued that binding only the round id is the grindable construction.
    expect(documented.get('seedCommitment')).toEqual(['serverSeedHex: string', 'context: SeedContext']);
    expect(ENGINE).not.toContain('seedCommitment(serverSeedHex: string, roundId: string)');
  });
});

describe('docs/ENGINE.md §10 no longer promises unbuilt surfaces', () => {
  const map = ENGINE.slice(ENGINE.indexOf('## 10. Reference implementation map'), ENGINE.indexOf('## 11. Boundary'));

  it.each(['openTicket', 'Receipts', 'serializeTranscript', 'Round snapshots'])(
    '%s is marked implemented',
    (surface) => {
      const row = map.split('\n').find((line) => line.includes(surface));
      expect(row, `no status row for ${surface}`).toBeDefined();
      expect(row).toContain('implemented');
    },
  );

  it('every remaining "specified only" row carries a reason', () => {
    const rows = map.split('\n').filter((line) => line.includes('specified only'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(/—|\(/u);
  });
});
