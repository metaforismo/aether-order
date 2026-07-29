/**
 * The seven sphere glyphs — docs/DESIGN.md §6.8.
 *
 * They are the colour-blind channel, not a backup for it: §6.1 proves that seven
 * colours clearing 4.5:1 against `--void` cannot be separated by luminance, so a
 * build that drops a glyph has dropped the channel. Every glyph is drawn on a
 * 24 x 24 grid with a single construction (solid fill or 2.5 px stroke, never
 * both) and sized so the filled areas are roughly equal.
 *
 * "Roughly" is the graybox part, and it is stated rather than implied: §15's
 * open question 4 asks for the areas to be within 15% *and* for a
 * protanopia/deuteranopia pass on real hardware. Neither has been run here.
 */

export interface Glyph {
  readonly markup: string;
}

const GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  disc: '<circle cx="12" cy="12" r="6.2" fill="currentColor"/>',
  ring: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/>',
  triangle: '<path d="M12 3.2 20.3 17.6H3.7Z" fill="currentColor"/>',
  square: '<rect x="6.5" y="6.5" width="11" height="11" fill="currentColor"/>',
  diamond: '<path d="M12 4.2 19.8 12 12 19.8 4.2 12Z" fill="currentColor"/>',
  chevron:
    '<path d="M4 9.5 12 16l8-6.5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="butt" stroke-linejoin="miter"/>',
  hexagon: '<path d="M12 5.2 18 8.6v6.8L12 18.8 6 15.4V8.6Z" fill="currentColor"/>',
});

/** Inner markup for a 24 x 24 glyph group. `currentColor` carries the tint. */
export function glyphMarkup(name: string): string {
  return GLYPHS[name] ?? GLYPHS.disc ?? '';
}

/** A standalone glyph, sized, for chips and colour tokens. */
export function glyphSvg(name: string, size: number, color: string, opacity = 1): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" style="color:${color};opacity:${opacity}">${glyphMarkup(
    name,
  )}</svg>`;
}
