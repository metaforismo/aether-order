/**
 * Palette separation, computed rather than typed.
 *
 * docs/DESIGN.md §6.1 argues — correctly — that a seven-colour set clearing
 * 4.5:1 against `--void` cannot be separated by luminance, and concludes that
 * the glyph is the colour-blind channel rather than a backup for it. §11 quotes
 * that conclusion and §15's open question 4 makes glyph discriminability under
 * protanopia/deuteranopia simulation the entire remedy, taking the *pair list*
 * as its input.
 *
 * Round 4 typed that pair list by hand. Every individual ratio in it was right
 * and the SET was wrong: it named AMBER↔AQUA, CORAL↔VIOLET, INDIGO↔VIOLET and
 * ROSE↔CORAL as "the closest pairs", which skips AMBER↔ROSE at 1.2470 — third
 * closest, effectively tied with INDIGO↔VIOLET — and lists the fifth-closest
 * instead. The test beneath it computed and sorted all 21 pairs and then only
 * asserted `pairs[0]` plus four substring checks, so it never guarded the
 * property the prose claimed, and its own comment about its own sorted data was
 * wrong too.
 *
 * That omission is not cosmetic. AMBER `#FFB020` and ROSE `#FF7FD1` both shift
 * toward yellow/beige under red-green deficiency and are arguably the most
 * confusable pair in the set — and it is the one pair the remedy's input list
 * left out.
 *
 * So the list is generated here, the document quotes this module, and
 * `tests/framebudget.test.mjs` asserts the published set IS the k closest pairs
 * in order, not merely that each named ratio is arithmetically correct.
 */

import { ELEMENTS } from './model.mjs';

/** The page background every foreground token is measured against (§6.1). */
export const VOID = '#05070C';

/** WCAG AA for normal text. Every sphere must clear it against `--void`. */
export const CONTRAST_FLOOR = 4.5;

/** How many pairs docs/DESIGN.md §6.1 publishes as "the closest pairs". */
export const PUBLISHED_CLOSEST_PAIRS = 5;

const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a `#rrggbb` string. */
export function relativeLuminance(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/u.test(hex)) throw new RangeError(`Not a six-digit hex colour: ${hex}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio, order-independent. */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every unordered pair of sphere colours, ascending by contrast ratio.
 *
 * `C(7,2) = 21` pairs. The sort is total because ties are broken by the pair's
 * element ids, so the published list is deterministic even if two pairs ever
 * land on the same ratio.
 */
export function spherePairs(elements = ELEMENTS) {
  const pairs = [];
  for (let i = 0; i < elements.length; i += 1) {
    for (let j = i + 1; j < elements.length; j += 1) {
      pairs.push(
        Object.freeze({
          a: elements[i],
          b: elements[j],
          key: `${elements[i].id}|${elements[j].id}`,
          ratio: contrastRatio(elements[i].hex, elements[j].hex),
        }),
      );
    }
  }
  pairs.sort((x, y) => (x.ratio === y.ratio ? (x.key < y.key ? -1 : 1) : x.ratio - y.ratio));
  return Object.freeze(pairs);
}

/** The `k` closest pairs, in order. This is the list §6.1 publishes. */
export function closestPairs(k = PUBLISHED_CLOSEST_PAIRS, elements = ELEMENTS) {
  return Object.freeze(spherePairs(elements).slice(0, k));
}

/**
 * The contrast span a set clearing the floor against `--void` must live inside.
 *
 * A colour at ratio >= FLOOR against the void has `(L + 0.05) >= FLOOR * (Lv +
 * 0.05)`, and the brightest possible colour is white at `(1 + 0.05)`.
 */
export function luminanceSpan(floor = CONTRAST_FLOOR, background = VOID) {
  return 1.05 / (floor * (relativeLuminance(background) + 0.05));
}

/**
 * An upper bound on the best achievable minimum separation for `k` colours.
 *
 * Spread `k` colours geometrically across the span and the closest adjacent
 * pair is `span^(1/(k-1))`. It is attained only by a set containing pure white
 * and sitting exactly on the floor, which leaves no freedom for hue at all — so
 * it really is a bound nobody can beat, not a target anybody can hit.
 */
export function bestAchievableSeparation(k, floor = CONTRAST_FLOOR, background = VOID) {
  if (!Number.isInteger(k) || k < 2) throw new RangeError('bestAchievableSeparation needs k >= 2');
  return luminanceSpan(floor, background) ** (1 / (k - 1));
}

/** Two decimals, the form §6.1 quotes: `1.10:1`. */
export const ratioText = (ratio) => `${ratio.toFixed(2)}:1`;

/**
 * The generated §6.1 table. The document pastes this between its markers and
 * the test suite fails the build if the two disagree.
 */
export function closestPairsMarkdown(k = PUBLISHED_CLOSEST_PAIRS, elements = ELEMENTS) {
  const lines = ['| Rank | Pair | Ratio | Also in CLASSIC |', '| --- | --- | --- | --- |'];
  closestPairs(k, elements).forEach((pair, index) => {
    const inClassic = elements.indexOf(pair.a) < 5 && elements.indexOf(pair.b) < 5;
    lines.push(
      `| ${index + 1} | ${pair.a.name}↔${pair.b.name} | ${ratioText(pair.ratio)} | ${inClassic ? 'yes' : 'no'} |`,
    );
  });
  return lines.join('\n');
}
