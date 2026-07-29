/**
 * What a line *is*, and what it says.
 *
 * Two chips that mean the same thing are one claim (docs/DESIGN.md §4,
 * docs/MATH.md §3.3). The client does not work out which pairs those are: the
 * adapter publishes the complete alias set, and this module turns it into a
 * lookup so `FIRST amber` and `SLOT amber @ 1` land on the same ticket row and
 * combine their stakes instead of quietly becoming two rows.
 *
 * The sentences are the confirmation in every picker (§5 S2). The icons are not.
 */

import type { BetInfo, VariantInfo } from './types.js';

export type Params = Record<string, unknown>;

export function paramsKey(params: Params): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join(',');
}

const aliasIndexes = new WeakMap<VariantInfo, Map<string, string>>();

function aliasIndex(variant: VariantInfo): Map<string, string> {
  const cached = aliasIndexes.get(variant);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const group of variant.claimAliases)
    for (const spelling of group.spellings)
      if (spelling.params) index.set(`${spelling.code}|${paramsKey(spelling.params)}`, group.signature);
  aliasIndexes.set(variant, index);
  return index;
}

/** Behavioural identity, as far as the client can see it: the adapter's own. */
export function claimKey(variant: VariantInfo, code: string, params: Params): string {
  const spelled = `${code}|${paramsKey(params)}`;
  return aliasIndex(variant).get(spelled) ?? spelled;
}

/** The other spelling of a claim, when the adapter publishes one. */
export function aliasOf(
  variant: VariantInfo,
  code: string,
  params: Params,
): { code: string; params: Params } | null {
  const key = claimKey(variant, code, params);
  const group = variant.claimAliases.find((candidate) => candidate.signature === key);
  if (!group) return null;
  const other = group.spellings.find((spelling) => spelling.code !== code);
  return other && other.params ? { code: other.code, params: other.params as Params } : null;
}

export const elementName = (variant: VariantInfo, index: unknown): string =>
  variant.elements[Number(index)]?.name ?? '?';

export const elementHex = (variant: VariantInfo, index: unknown): string =>
  variant.elements[Number(index)]?.hex ?? '#ffffff';

export const elementGlyph = (variant: VariantInfo, index: unknown): string =>
  variant.elements[Number(index)]?.glyph ?? 'disc';

/** The live sentence a picker shows. Plain language, never a formula. */
export function claimSentence(variant: VariantInfo, code: string, params: Params): string {
  const name = (key: string): string => elementName(variant, params[key]);
  switch (code) {
    case 'first':
      return `${name('c')} settles first.`;
    case 'last':
      return `${name('c')} settles last.`;
    case 'early':
      return `${name('c')} is one of the first two to settle.`;
    case 'late':
      return `${name('c')} is one of the last two to settle.`;
    case 'slot':
      return `${name('c')} settles in slot ${Number(params.k) + 1}.`;
    case 'before':
      return `${name('a')} settles before ${name('b')}.`;
    case 'stack':
      return `${name('b')} settles directly above ${name('a')}.`;
    case 'neighbours':
      return `${name('a')} and ${name('b')} settle side by side, either order.`;
    case 'opening':
      return `${name('a')}, then ${name('b')} — the first two, in that order.`;
    case 'podium':
      return `${name('a')}, then ${name('b')}, then ${name('c')} — the first three, in that order.`;
    case 'full':
      return `${String(params.order)
        .split('-')
        .map((index) => elementName(variant, index))
        .join(', ')} — the whole column, bottom to top.`;
    default:
      return '';
  }
}

/** The short form for a ticket row: the chip name plus the picks, in words. */
export function claimSummary(variant: VariantInfo, code: string, params: Params): string {
  const short = (key: string): string => elementName(variant, params[key]).toLowerCase();
  switch (code) {
    case 'first':
    case 'last':
    case 'early':
    case 'late':
      return short('c');
    case 'slot':
      return `${short('c')} @ ${Number(params.k) + 1}`;
    case 'before':
      return `${short('a')} < ${short('b')}`;
    case 'stack':
      return `${short('a')} ▸ ${short('b')}`;
    case 'neighbours':
      return `${short('a')} ~ ${short('b')}`;
    case 'opening':
      return `${short('a')}, ${short('b')}`;
    case 'podium':
      return `${short('a')}, ${short('b')}, ${short('c')}`;
    case 'full':
      return String(params.order)
        .split('-')
        .map((index) => elementName(variant, index).toLowerCase())
        .join('-');
    default:
      return '';
  }
}

export function betByCode(variant: VariantInfo, code: string): BetInfo {
  const bet = variant.bets.find((candidate) => candidate.code === code);
  if (!bet) throw new Error(`Unknown bet code ${code}`);
  return bet;
}

/** Chips a picker can produce, given the picks it has collected. */
export function paramsFor(code: string, picks: number[], slot: number | null, n: number): Params | null {
  switch (code) {
    case 'first':
    case 'last':
    case 'early':
    case 'late':
      return picks.length === 1 ? { c: picks[0] as number } : null;
    case 'slot':
      return picks.length === 1 && slot !== null ? { c: picks[0] as number, k: slot } : null;
    case 'before':
    case 'stack':
    case 'opening':
      return picks.length === 2 ? { a: picks[0] as number, b: picks[1] as number } : null;
    case 'neighbours': {
      if (picks.length !== 2) return null;
      const [left, right] = [picks[0] as number, picks[1] as number].sort((x, y) => x - y);
      return { a: left as number, b: right as number };
    }
    case 'podium':
      return picks.length === 3
        ? { a: picks[0] as number, b: picks[1] as number, c: picks[2] as number }
        : null;
    case 'full':
      return picks.length === n ? { order: picks.join('-') } : null;
    default:
      return null;
  }
}
