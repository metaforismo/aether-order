/**
 * The sphere, as a jewel — one construction, used everywhere.
 *
 * docs/DESIGN.md §6.2 makes the spheres "cast resin with an emissive core, **not
 * chrome**", §6.3 forbids an external rim light and asks instead for an interior
 * falloff that darkens the silhouette *from within*, and §7 technique 3 says
 * seven colours cost one sprite master tinted per element. This module is the
 * DOM/SVG lane's version of that master: **one** set of gradients, mounted once
 * per session, referenced by every sphere on every screen — the chamber, the
 * picker's colour tokens, the FULL ORDER tube, the variant sheet, the history
 * strip. A player who taps AMBER in the picker is looking at the same object
 * that lands in slot 1, which is most of why the app reads as one product.
 *
 * The stack, outside in, and why each layer is there:
 *
 * | Layer | Why |
 * | --- | --- |
 * | emissive bleed | §6.3's bloom, "applied only to emissive cores and gold". It peaks *inside* the body and only decays outward, so what escapes the silhouette is a halo in the liquid and never a bright ring on the sphere's edge — the sign error §6.3 names. |
 * | body | radial gradient, focal above-left at 35° (§6.3's key), emissive core at the centre, darkening to `--void` at the edge. |
 * | interior caustic | §7 technique 3: "apparent rotation comes from scrolling the interior caustic UV". Two soft lobes, well inside the silhouette so no clip is needed, translated by CSS. |
 * | etched glyph | §6.8: 46% of the diameter, `--void`, subtractive. The colour-blind channel, not a decoration. |
 * | interior fresnel | §6.3's absorption falloff. It *removes* light at the edge. |
 * | specular | §6.2's "one thin specular line" read as a glossy dot; §6.6 reference 2's restraint — one highlight, thin. |
 * | fill bounce | §6.3's warm 3000 K bounce off the base plate at intensity 0.12, so the underside is not dead black. |
 *
 * Nothing here uses an SVG filter. Every soft edge is a gradient stop, which is
 * what keeps the whole sphere layer composited rather than re-rastered when it
 * moves (§7.1.1).
 */

import { glyphMarkup } from './glyphs.js';
import type { ElementInfo } from './types.js';
import { esc } from './ui.js';

/** `--void`, as channels, because the darkening mixes toward it numerically. */
const VOID_RGB = [5, 7, 12] as const;

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const at = (offset: number): number => Number.parseInt(value.slice(offset, offset + 2), 16);
  return [at(0), at(2), at(4)];
}

const rgb = ([r, g, b]: readonly [number, number, number]): string =>
  `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

/** Toward white — the emissive core. `0.52` reproduces §6.1's published cores. */
export function lighten(hex: string, amount: number): string {
  return rgb(channels(hex).map((c) => c + (255 - c) * amount) as unknown as [number, number, number]);
}

/** Toward `--void` — the interior absorption that shapes the silhouette. */
function darken(hex: string, amount: number): string {
  const [r, g, b] = channels(hex);
  return rgb([
    r + (VOID_RGB[0] - r) * amount,
    g + (VOID_RGB[1] - g) * amount,
    b + (VOID_RGB[2] - b) * amount,
  ]);
}

/** The emissive core tint for an element, as §6.1's table publishes it. */
export const coreTint = (hex: string): string => lighten(hex, 0.52);

/* --------------------------------------------------------------- the defs -- */

/**
 * Gradients for one element.
 *
 * All of them are `objectBoundingBox`, which is what makes one definition serve
 * a 64 px sphere in the chamber and an 18 px token in a sheet: the gradient is
 * expressed in fractions of whatever circle references it.
 */
function elementGradients(element: ElementInfo): string {
  const { id, hex } = element;
  const core = coreTint(hex);
  return `
    <radialGradient id="orb-body-${id}" cx="0.5" cy="0.5" r="0.5" fx="0.34" fy="0.27">
      <stop offset="0" stop-color="${core}"/>
      <stop offset="0.34" stop-color="${hex}"/>
      <stop offset="0.74" stop-color="${darken(hex, 0.3)}"/>
      <stop offset="1" stop-color="${darken(hex, 0.62)}"/>
    </radialGradient>
    <radialGradient id="orb-bleed-${id}">
      <stop offset="0" stop-color="${hex}" stop-opacity="0.5"/>
      <stop offset="0.5" stop-color="${hex}" stop-opacity="0.3"/>
      <stop offset="0.7" stop-color="${hex}" stop-opacity="0.15"/>
      <stop offset="0.86" stop-color="${hex}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${hex}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb-core-${id}">
      <stop offset="0" stop-color="${core}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${core}" stop-opacity="0"/>
    </radialGradient>
    <!--
      The light this sphere throws into the liquid when the round wins, and it is
      §6.3's own bloom rather than a new light: "threshold 0.78, radius 12 px …
      applied only to emissive cores and gold". White-hot at the centre, the
      element's saturated hue outward.

      It is painted by the tube's **cells**, not by the sphere, and that is a
      correction rather than a preference. Drawn as a halo on the orb it is a
      sibling of four other orbs 78 units away in a 96-unit tube, so the topmost
      sphere's halo painted over every body beneath it — a frame dump of the
      celebration caught all five settled spheres milky at the peak of their own
      win. In the cell it is clipped to one slot by construction and can never
      cross into another object's silhouette, and light in the liquid around a
      glowing body is what §6.6 reference 3 describes anyway.

      It is shaped for the cell rather than for the object, which is why it holds
      most of its opacity out to 0.78: the sphere covers the middle of its own
      slot, so a gradient that has already decayed by then floods only the part
      of the cell nobody can see.
    -->
    <radialGradient id="orb-bloom-${id}">
      <stop offset="0" stop-color="${core}" stop-opacity="0.95"/>
      <stop offset="0.42" stop-color="${hex}" stop-opacity="0.92"/>
      <stop offset="0.78" stop-color="${hex}" stop-opacity="0.6"/>
      <stop offset="1" stop-color="${hex}" stop-opacity="0.16"/>
    </radialGradient>`;
}

/** The four definitions that do not vary by element. */
const SHARED_DEFS = `
  <radialGradient id="orb-spec">
    <stop offset="0" stop-color="var(--specular)" stop-opacity="0.95"/>
    <stop offset="0.5" stop-color="var(--specular)" stop-opacity="0.4"/>
    <stop offset="1" stop-color="var(--specular)" stop-opacity="0"/>
  </radialGradient>
  <!--
    §6.3: an INTERIOR falloff. It darkens the silhouette edge from within, the
    way a glowing body inside a translucent shell loses brightness toward its
    rim. A rim light would add light there; this removes it, and a bright ring
    on a sphere's outer edge means the sign is wrong.
  -->
  <radialGradient id="orb-fresnel">
    <stop offset="0.56" stop-color="var(--deep)" stop-opacity="0"/>
    <stop offset="0.86" stop-color="var(--deep)" stop-opacity="0.24"/>
    <stop offset="1" stop-color="var(--deep)" stop-opacity="0.6"/>
  </radialGradient>
  <!-- §6.3's fill: a warm ~3000 K bounce off the base plate at intensity 0.12. -->
  <radialGradient id="orb-bounce">
    <stop offset="0" stop-color="#FFCF95" stop-opacity="0.2"/>
    <stop offset="1" stop-color="#FFCF95" stop-opacity="0"/>
  </radialGradient>`;

/** Every element whose gradients are in the document, by id. */
const mounted = new Map<string, ElementInfo>();

/**
 * Mount the sphere master once, for the whole document — **additively**.
 *
 * Same-document fragment references (`fill="url(#orb-body-amber)"`) resolve
 * across separate inline `<svg>` roots, so one hidden definition block serves
 * the chamber and every sheet.
 *
 * It accumulates rather than replaces, and that is a bug fix. It used to hold
 * exactly the *current variant's* five or seven elements and rebuild on a
 * switch — but the app draws spheres that do not belong to the current variant:
 * the variant sheet shows both rows, so in CLASSIC it renders INDIGO and ROSE
 * tokens whose `url(#orb-body-indigo)` resolved to nothing and painted two black
 * discs into the middle of the sheet that sells SEVEN. The element set is closed
 * and tiny (seven), so the union is simply the right thing to hold; `boot`
 * mounts every variant's elements at start-up and the chamber's per-variant call
 * is then a no-op.
 */
export function mountOrbDefs(elements: readonly ElementInfo[]): void {
  let added = false;
  for (const element of elements) {
    const known = mounted.get(element.id);
    if (known && known.hex === element.hex) continue;
    mounted.set(element.id, element);
    added = true;
  }
  if (!added) return;
  const existing = document.getElementById('orb-defs');
  const markup = `<defs>${[...mounted.values()].map(elementGradients).join('')}${SHARED_DEFS}</defs>`;
  if (existing) {
    existing.innerHTML = markup;
    return;
  }
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('id', 'orb-defs');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.style.position = 'absolute';
  host.innerHTML = markup;
  document.body.prepend(host);
}

/* ---------------------------------------------------------------- the art -- */

export interface OrbOptions {
  /** The scrolling interior caustic. Off for static tokens; on in the chamber. */
  readonly interior?: boolean;
  /** The emissive halo. Off where the sphere sits on a lit surface, e.g. a chip. */
  readonly bleed?: boolean;
  /** Etch strength. §6.8 publishes 0.24 for a sphere in the liquid. */
  readonly etch?: number;
}

/**
 * The art of one sphere, centred on (0, 0), for a sphere of `radius` units.
 *
 * Returned as markup rather than nodes because every caller builds a larger
 * string: `innerHTML` once is one parse and one style resolution, where seven
 * `createElementNS` trees are seven.
 */
export function orbArt(element: ElementInfo, radius: number, options: OrbOptions = {}): string {
  const { id, hex, glyph } = element;
  const interior = options.interior !== false;
  const bleed = options.bleed !== false;
  const etch = options.etch ?? 0.24;
  const round = (value: number): string => value.toFixed(2);
  return `
    ${bleed ? `<circle class="orb__bleed" r="${round(radius * 2.35)}" fill="url(#orb-bleed-${id})"/>` : ''}
    <circle class="orb__body" r="${round(radius)}" fill="url(#orb-body-${id})"/>
    ${
      interior
        ? `<g class="orb__core">
             <ellipse cx="${round(radius * -0.1)}" cy="${round(radius * 0.14)}" rx="${round(
               radius * 0.34,
             )}" ry="${round(radius * 0.24)}" fill="url(#orb-core-${id})"/>
             <ellipse cx="${round(radius * 0.18)}" cy="${round(radius * -0.08)}" rx="${round(
               radius * 0.22,
             )}" ry="${round(radius * 0.16)}" fill="url(#orb-core-${id})" opacity="0.7"/>
           </g>`
        : ''
    }
    <g class="orb__glyph" style="color:var(--void);opacity:${etch}" transform="translate(${round(
      radius * -0.46,
    )},${round(radius * -0.46)}) scale(${round((radius * 0.92) / 24)})">${glyphMarkup(glyph)}</g>
    <circle class="orb__fresnel" r="${round(radius)}" fill="url(#orb-fresnel)"/>
    <ellipse class="orb__bounce" cx="${round(radius * 0.06)}" cy="${round(radius * 0.5)}" rx="${round(
      radius * 0.6,
    )}" ry="${round(radius * 0.34)}" fill="url(#orb-bounce)"/>
    <ellipse class="orb__spec" cx="${round(radius * -0.33)}" cy="${round(radius * -0.4)}" rx="${round(
      radius * 0.24,
    )}" ry="${round(radius * 0.17)}" fill="url(#orb-spec)" transform="rotate(-35 ${round(
      radius * -0.33,
    )} ${round(radius * -0.4)})"/>
    <!--
      A hover affordance, and nothing load-bearing: a standalone orb is
      aria-hidden, so this title is not the colour-blind channel. That job
      belongs to the etched glyph and to the name printed in text beside every
      orb in the product (see 6.1 and 11).
    -->
    <title>${esc(element.name)} — ${esc(hex)}</title>`;
}

/**
 * A standalone sphere at a CSS size, for chips, tokens, slot cells and history.
 *
 * Small orbs etch harder than §6.8's 0.24. That figure is stated for a 64 px
 * sphere glowing in dark liquid; at 18 px on a card the same 24% of `--void` is
 * invisible, and an invisible glyph is a *dropped channel* rather than a subtle
 * one (§11). The construction, the proportion and the colour are unchanged.
 */
export function orbSvg(element: ElementInfo, size: number, options: OrbOptions = {}): string {
  const span = 2.1;
  return `<svg class="orb-svg" viewBox="${-size * span * 0.5} ${-size * span * 0.5} ${
    size * span
  } ${size * span}" width="${size}" height="${size}" aria-hidden="true" style="overflow:visible">${orbArt(
    element,
    size / 2,
    { interior: false, etch: size < 34 ? 0.5 : 0.28, ...options },
  )}</svg>`;
}
