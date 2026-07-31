/**
 * The client is an asserted artefact too — for the two properties that were
 * silently wrong in the graybox and are invisible to every other test here.
 *
 * **The type scale.** §6.5 publishes eight steps (48 / 40 / 28 / 22 / 17 / 15 / 13 /
 * 11). Round 1 held them as fixed pixels, so OS and browser text scaling was a
 * no-op and §11's "text scaling to 200%" was not merely unmet but
 * unimplementable. Round 2 converted them to `rem` — and then set
 * `html { font-size: var(--t-sm) }`, which resolves against the initial root and
 * *becomes* the root: every step shipped at 93.75% of itself (37.5 / 26.25 /
 * 20.63 / 15.94 / 14.06 / 12.19 / 10.31), with the smallest at 10.31 px, still
 * under the 11 px floor the conversion was made to fix. Both defects are one
 * declaration in a stylesheet no test read, so this file reads it: the steps are
 * parsed out of the document and recomputed against a 16 px root, and the root
 * is asserted to be nobody's business but the player's.
 *
 * **§1's three-second test.** It names five things a new player must see, and it
 * is a stated build acceptance criterion. Round 1 shipped four of them: the one
 * line of copy that says what the game is lived one level down inside the picker
 * sheet, which is after the tap the criterion is about. The two sentences are
 * parsed from §1 and matched against the client source, so neither can drift.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(ROOT, name), 'utf8');
const DESIGN = read('docs/DESIGN.md');
const SOURCE = read('src/client/styles.css');
/**
 * The stylesheet with its comments removed.
 *
 * Not a nicety: the comments in this file quote CSS, braces included — the note
 * above the `html` rule contains the exact declaration this suite exists to
 * forbid. Matching rules against the commented text both misses real
 * declarations (the brace walk desynchronises) and fails on prose, so every
 * assertion below reads the stripped source. The first draft of this file did
 * not, and a deliberately reintroduced `html { font-size: … }` went undetected.
 */
const CSS = SOURCE.replace(/\/\*[\s\S]*?\*\//gu, '');
const MAIN = read('src/client/main.ts');

/** The seven steps §6.5 publishes, in order, as numbers. */
function publishedScale() {
  const match = /\*\*Scale at 390 px:\*\*\s*([\d\s/]+)\./u.exec(DESIGN);
  expect(match, 'docs/DESIGN.md §6.5 publishes a type scale').not.toBeNull();
  return match[1]
    .split('/')
    .map((step) => Number.parseFloat(step.trim()))
    .filter((step) => Number.isFinite(step));
}

/** Every `--t-*` token declared in the client stylesheet, in declaration order. */
function declaredTokens() {
  const tokens = [];
  for (const match of CSS.matchAll(/^\s*(--t-[a-z-]+):\s*([^;]+);/gmu))
    tokens.push({ name: match[1], value: match[2].trim() });
  return tokens;
}

describe('the client implements §6.5’s published type scale', () => {
  const scale = publishedScale();
  const tokens = declaredTokens();

  it('declares exactly one token per published step', () => {
    expect(scale).toHaveLength(8);
    expect(tokens.map((token) => token.name)).toEqual([
      '--t-hero',
      '--t-display',
      '--t-xl',
      '--t-lg',
      '--t-md',
      '--t-sm',
      '--t-xs',
      '--t-xxs',
    ]);
  });

  it('sizes every step in rem against a 16 px root, exactly', () => {
    for (const [index, token] of tokens.entries()) {
      const rem = /^([\d.]+)rem$/u.exec(token.value);
      expect(rem, `${token.name} is a rem value`).not.toBeNull();
      // Exact: every published step is a whole number of 1/16 rem, so there is
      // no rounding to allow for and a tolerance would only hide a drift.
      expect(Number.parseFloat(rem[1]) * 16, `${token.name}`).toBe(scale[index]);
    }
  });

  it('never restates the root font size, so OS text scaling is the root', () => {
    // Split rather than match: a `(^|})`-anchored global regex consumes the `}`
    // that would anchor the next rule and therefore reads every *other* rule,
    // which is how the first draft of this assertion passed a stylesheet with
    // `html, body { font-size: var(--t-sm) }` in it.
    for (const block of CSS.split('}')) {
      const brace = block.indexOf('{');
      if (brace < 0) continue;
      const selectors = block.slice(0, brace).split(',').map((selector) => selector.trim());
      if (!selectors.includes('html') && !selectors.includes(':root')) continue;
      expect(block.slice(brace + 1), `${selectors.join(', ')} must not set a font size`).not.toMatch(
        /(^|[\s;])font-size\s*:/u,
      );
    }
  });

  it('sets no font size anywhere except from a published token', () => {
    const sizes = [...CSS.matchAll(/(^|[\s;{])font-size\s*:\s*([^;}]+)/gu)].map((match) =>
      match[2].trim(),
    );
    expect(sizes.length).toBeGreaterThan(20);
    for (const size of sizes) expect(size).toMatch(/^var\(--t-[a-z-]+\)$/u);
  });

  it('pins `small`, whose UA default is 0.83em of whatever it sits in', () => {
    // `small` inherited its way to 10.83 px inside the picker's 13 px slot
    // labels — off the published scale by the same mechanism as the 9 px colour
    // label §11 was already failing on.
    expect(CSS).toMatch(/^small\s*\{[^}]*font-size:\s*var\(--t-xxs\)/mu);
  });

  it('keeps a label wider than its chip on the scale rather than clipping it', () => {
    // NEIGHBOURS at the 13 px step and §6.5's +0.06em is wider than a 96 px
    // chip: it overhung its border at 100% text and was cut off by the edge of
    // the screen at 200%. The name drops one published step; it never shrinks
    // off the scale and it is never clipped.
    expect(MAIN).toMatch(/data-long="yes"/u);
    expect(CSS).toMatch(/\.chip b\[data-long='yes'\]\s*\{[^}]*font-size:\s*var\(--t-xxs\)/u);
    expect(CSS).toMatch(/\.chip b\s*\{[^}]*overflow-wrap:\s*anywhere/u);
  });
});

describe('§1’s three-second test is present on the first screen', () => {
  /** A quoted line of copy from §1, by its item label. */
  const copy = (label) => {
    const match = new RegExp(`\\*\\*${label}:\\*\\*\\s*\\*"([^"]+)"\\*`, 'u').exec(
      DESIGN.slice(DESIGN.indexOf('## 1. The three-second test'), DESIGN.indexOf('## 2. Round anatomy')).replace(
        /\n\s+/gu,
        ' ',
      ),
    );
    expect(match, `§1 quotes ${label}`).not.toBeNull();
    return match[1];
  };

  it('carries item 3 — the one line that says what the game is, once, in the deck', () => {
    const line = copy('One line of copy');
    expect(line).toBe('They settle in a random order. Bet on the order.');
    /*
     * Once, and in the deck.
     *
     * Round 1 shipped it twice — printed inside the chamber's SVG as
     * `.stage__note`, plus a deck copy hidden at every text scale but the
     * largest — and the chamber copy is the one a frame dump caught: it sat on
     * the housing's chrome bevel with both bottom corner radii passing behind
     * its first and last glyphs, and the line was wider than the housing so it
     * began and ended over the void. It was the only text in the app on the art,
     * and it collided with it. §5 S1 now states the placement normatively: the
     * first row of the deck, under the chamber and above the tier tabs.
     */
    expect(MAIN.split(line).length - 1).toBe(1);
    expect(MAIN).toContain(`<p class="premise">${line}</p>`);
    expect(CSS).not.toMatch(/\.stage__note/u);
    expect(DESIGN).toContain('the first row of the deck, not a\n  caption on the instrument');
  });

  it('carries item 5 — the line under the rail', () => {
    const line = copy('One line under the rail');
    expect(line).toBe('Every bet pays 96%.');
    expect(MAIN).toContain(line);
  });

  it('opens on FORM, so the first thing shown is four claims at one price', () => {
    expect(MAIN).toMatch(/tier: 'FORM'/u);
  });
});

describe('§11’s tap floor is a token, not a per-control decision', () => {
  it('declares the floor once', () => {
    expect(CSS).toMatch(/--tap:\s*44px/u);
  });

  it('applies it to the two controls that shipped under it', () => {
    // The variant toggle was 75 x 32 and the ticket strip 366 x 36.
    expect(CSS).toMatch(/\.variant-toggle\s*\{[^}]*min-height:\s*var\(--tap\)/u);
    expect(CSS).toMatch(/\.strip\s*\{[^}]*min-height:\s*var\(--tap\)/u);
  });

  it('gives the round’s only control a 44 x 44 box', () => {
    expect(CSS).toMatch(/\.skip\s*\{[^}]*width:\s*var\(--tap\);\s*height:\s*var\(--tap\)/u);
  });
});

/* ------------------------------------------------------------------ *
 * §11's contrast floor, gated at its actual failure mechanism.         *
 * ------------------------------------------------------------------ */

/**
 * **No foreground text is dimmed with `opacity`. Ever.**
 *
 * Both of this build's shipped contrast failures are the same declaration in
 * different places, and neither was reachable by the gates that existed:
 *
 *   - round 1, `.line[data-state='lost'] { opacity: 0.4 }` over `--ink-dim`,
 *     which put a dead line's stake and multiplier at **2.08:1** and, compounded
 *     with a second 0.8 on the claim cell, its claim text at **1.72:1**;
 *   - round 2, `.slot-cell small { opacity: 0.55 }`, which put the picker's slot
 *     numerals at **2.69:1 to 2.95:1** on every shape-B/D/E picker — SLOT,
 *     PODIUM and FULL ORDER, i.e. the surface where the headline 115.20× bet is
 *     placed. That one shipped in the same pass that declared the class closed.
 *
 * The palette gate could not see either, because it recomputes *tokens* and the
 * defect is a token multiplied afterwards by a number no table contains: a
 * foreground checked at 7.81:1 and rendered at 40% of it. Measuring rendered
 * composites needs a browser and this suite has none — so the gate is on the
 * mechanism instead, which is stronger than a spot check because it fails
 * *before* anything is rendered.
 *
 * §11's own words for the same rule: "a disabled control dims its fill and its
 * border, never its label". Dim with `color`, with a border, with a fill. Not
 * with `opacity`.
 */
describe('§11’s floor is gated at the mechanism that broke it twice', () => {
  /**
   * The last compound selector of a rule — the element the declaration actually
   * lands on. `.colour:disabled .orb-svg` dims an image and is fine; `.slot-cell
   * small` dims text and is not.
   */
  const leafOf = (selector) => selector.trim().split(/[\s>+~]+/u).pop() ?? '';

  /** Leaves that carry text a player must read. */
  const TEXT_LEAF =
    /^(?:small|span|b|em|u|p|h2|text|\.note|\.line|\.sentence|\.footnote|\.premise|\.badge|\.slot-no|\.stamp__value|\.cta__sub|\.lit|\.dim)(?:[.:[]|$)/u;

  /** Every rule outside `@keyframes` that sets a fractional `opacity`. */
  function dimmingRules() {
    // Keyframe bodies are animation, not state, and `opacity` is the one
    // property §7.1.1 wants animations expressed in — they are not this rule.
    const body = CSS.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\}\s*)*\}/gu, '');
    const found = [];
    for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const value = /(?:^|[;\s])opacity:\s*([0-9.]+)\s*;/u.exec(match[2]);
      if (!value || Number.parseFloat(value[1]) >= 1) continue;
      for (const selector of match[1].split(',')) {
        const trimmed = selector.trim();
        if (trimmed === '' || trimmed.includes('::')) continue;
        found.push({ selector: trimmed, opacity: value[1] });
      }
    }
    return found;
  }

  it('finds the dimming rules at all, so the gate cannot pass by parsing nothing', () => {
    // If the walk breaks, everything below passes vacuously. The chamber's art
    // layers are legitimately full of these, so a healthy parse finds plenty.
    expect(dimmingRules().length).toBeGreaterThan(12);
  });

  it('dims no text-bearing element with opacity', () => {
    const offenders = dimmingRules().filter(({ selector }) => TEXT_LEAF.test(leafOf(selector)));
    expect(
      offenders.map((rule) => `${rule.selector} { opacity: ${rule.opacity} }`),
      'a foreground token dimmed by opacity is a contrast floor nothing checks',
    ).toEqual([]);
  });

  it('states the rule where a designer will read it', () => {
    expect(SOURCE).toMatch(
      /Dim a foreground with colour, a border or a fill — never with opacity/u,
    );
  });
});
