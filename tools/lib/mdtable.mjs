/**
 * Markdown table extraction.
 *
 * The published paytable lives in docs/MATH.md as a human-readable table. The
 * test suite parses it out of that file and compares it, cell by cell, against
 * the exhaustive enumeration. The documentation is therefore a tested artefact:
 * a typo in a multiplier fails CI.
 */

import { readFileSync } from 'node:fs';

/**
 * Extract the rows of a fenced table.
 *
 * The fence is a pair of HTML comments:
 *   <!-- paytable:classic:start -->  ... table ...  <!-- paytable:classic:end -->
 *
 * @param {string} markdown
 * @param {string} name fence name, e.g. 'paytable:classic'
 * @returns {{ header: string[], rows: string[][] }}
 */
export function extractFencedTable(markdown, name) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`Fenced block "${name}" not found or malformed`);
  }
  const body = markdown.slice(from + start.length, to);
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));
  if (lines.length < 3) throw new Error(`Fenced block "${name}" has no table rows`);

  const cells = (line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const header = cells(lines[0]);
  const separator = cells(lines[1]);
  if (!separator.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
    throw new Error(`Fenced block "${name}" is missing its separator row`);
  }
  const rows = lines.slice(2).map(cells);
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`Fenced block "${name}" has a ragged row: ${row.join(' | ')}`);
    }
  }
  return { header, rows };
}

export function readFencedTable(path, name) {
  return extractFencedTable(readFileSync(path, 'utf8'), name);
}

/** Strip markdown code ticks from a cell: `before` -> before. */
export const untick = (cell) => cell.replace(/^`|`$/gu, '');

/** Collect every `1234.56×` style token inside a slice of a document. */
export function collectMultiplierTokens(markdown, fromMarker, toMarker) {
  const from = markdown.indexOf(fromMarker);
  const to = markdown.indexOf(toMarker);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`Marker pair not found: "${fromMarker}" .. "${toMarker}"`);
  }
  const slice = markdown.slice(from, to);
  return [...slice.matchAll(/(\d+\.\d{2})×/gu)].map((match) => match[1]);
}
