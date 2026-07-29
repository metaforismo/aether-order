/**
 * The chamber, at graybox fidelity.
 *
 * Geometry is docs/DESIGN.md §6.9: tube 96 wide centred at x = 195, slot pitch
 * 78 (CLASSIC) / 58 (SEVEN), sphere diameter pitch − 14, collar rings 28 tall,
 * two five-vane impellers diagonally opposed and off the tube's axis, one 1 px
 * specular line at x = 135.
 *
 * What is placeholder: this is DOM and SVG, not the WebGL lane §7 specifies.
 * There is no fluid shader, no bloom, no caustic, no bubble buffer and no sprite
 * master — a sphere is a circle with an emissive core and an etched glyph. What
 * is *not* placeholder is the choreography's structure: the falls are driven by
 * the transcript, one lock at a time, and the impeller is the only thing on
 * screen that rotates (§6.4).
 *
 * One inconsistency in the source geometry, recorded rather than silently
 * "fixed": §6.9 gives SEVEN a 390-tall chamber and a tube of `n x 58 + 24` =
 * 430, which does not fit inside it. This renderer keeps the pitch and the
 * sphere diameter — the two numbers readability depends on — and lets the
 * chamber be as tall as its tube, scaling to the space the layout leaves.
 */

import { glyphMarkup } from './glyphs.js';
import type { VariantInfo } from './types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const TUBE_WIDTH = 96;
const TUBE_X = 195 - TUBE_WIDTH / 2;
const TUBE_RIM = 12;
const COLLAR = 28;
const WIDTH = 390;

/** Where the spheres drift while the tube is empty, per element index. */
const DRIFT: readonly (readonly [number, number])[] = [
  [92, 118],
  [300, 96],
  [70, 236],
  [312, 214],
  [104, 336],
  [304, 330],
  [80, 168],
];

export type Beat = 'idle' | 'charge' | 'agitate' | 'settle' | 'close' | 'done';

/** Mix a body tint toward white to stand in for §6.1's emissive core. */
function lighten(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const channel = (offset: number): number => {
    const base = Number.parseInt(value.slice(offset, offset + 2), 16);
    return Math.round(base + (255 - base) * amount);
  };
  return `rgb(${channel(0)},${channel(2)},${channel(4)})`;
}

export class Chamber {
  readonly #root: HTMLElement;
  #variant: VariantInfo | null = null;
  #height = 430;
  #slots: number[] = [];
  #spheres = new Map<number, SVGGElement>();
  #rings = new Map<number, SVGGElement>();
  #rim: SVGRectElement | null = null;
  #stamp: SVGGElement | null = null;
  #svg: SVGSVGElement | null = null;

  constructor(root: HTMLElement) {
    this.#root = root;
  }

  get height(): number {
    return this.#height;
  }

  /** Centre y of slot `k`, 1-indexed from the bottom of the tube. */
  slotY(k: number): number {
    return this.#slots[k - 1] ?? 0;
  }

  render(variant: VariantInfo): void {
    this.#variant = variant;
    const { n } = variant;
    const pitch = variant.geometry.slotPitch;
    const diameter = variant.geometry.sphereDiameter;
    const tubeHeight = n * pitch + TUBE_RIM * 2;
    const height = tubeHeight + 16;
    this.#height = height;
    const tubeTop = 8;
    const tubeBottom = tubeTop + tubeHeight;
    this.#slots = Array.from(
      { length: n },
      (_unused, index) => tubeBottom - TUBE_RIM - (index + 0.5) * pitch,
    );

    const slotCells = this.#slots
      .map(
        (y, index) => `
        <line x1="${TUBE_X + 6}" y1="${y + pitch / 2}" x2="${TUBE_X + TUBE_WIDTH - 6}" y2="${
          y + pitch / 2
        }" stroke="var(--glass-edge)" stroke-opacity="0.28" stroke-width="1"/>
        <text x="${TUBE_X + 12}" y="${y + 4}" fill="var(--ink-dim)" font-size="11" opacity="0.55">${
          index + 1
        }</text>`,
      )
      .join('');

    const rings = this.#slots
      .map(
        (y, index) =>
          `<g class="lock-ring" data-slot="${index + 1}"><rect x="${TUBE_X + 4}" y="${
            y - pitch / 2 + 3
          }" width="${TUBE_WIDTH - 8}" height="${pitch - 6}" rx="4" fill="none" stroke="var(--gold)" stroke-width="1.5"/></g>`,
      )
      .join('');

    const spheres = variant.elements
      .map((element, index) => {
        const [x, y] = DRIFT[index] ?? [195, 200];
        const radius = diameter / 2;
        return `<g class="sphere sphere-slot" data-element="${index}" style="transform:translate(${x}px,${y}px)">
          <g class="sphere-body" style="animation-delay:${index * -1.3}s">
            <circle r="${radius}" fill="${element.hex}" fill-opacity="0.9"/>
            <circle r="${radius * 0.55}" fill="${lighten(element.hex, 0.45)}" opacity="0.85"/>
            <circle r="${radius}" fill="url(#fresnel)"/>
            <g class="sphere-glyph" style="color:var(--void);opacity:0.24" transform="translate(${
              -radius * 0.46
            },${-radius * 0.46}) scale(${(radius * 0.92) / 24})">${glyphMarkup(element.glyph)}</g>
          </g>
        </g>`;
      })
      .join('');

    const impeller = (cx: number, cy: number): string => {
      // Five 18 px vanes at 72 degrees, tapering 6 px at the hub to 2 px at the
      // rim. Five, not seven, in both variants: it is machinery, not a counter.
      const vanes = Array.from({ length: 5 }, (_unused, index) => {
        const angle = (index * 72 * Math.PI) / 180;
        return `<line x1="${(Math.cos(angle) * 26).toFixed(2)}" y1="${(Math.sin(angle) * 26).toFixed(
          2,
        )}" x2="${(Math.cos(angle) * 44).toFixed(2)}" y2="${(Math.sin(angle) * 44).toFixed(
          2,
        )}" stroke="var(--chrome-mid)" stroke-width="4" stroke-linecap="round"/>`;
      }).join('');
      return `<g class="impeller" transform="translate(${cx},${cy})">
        <circle r="48" fill="none" stroke="var(--chrome-mid)" stroke-width="3"/>
        <circle r="6" fill="var(--chrome-mid)"/>${vanes}
      </g>`;
    };

    this.#root.innerHTML = `
      <svg class="chamber" viewBox="0 0 ${WIDTH} ${height}" preserveAspectRatio="xMidYMid meet" data-beat="idle" role="img" aria-label="Chamber with ${n} spheres and a ${n}-slot tube">
        <defs>
          <linearGradient id="brine" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stop-color="var(--brine-deep)"/>
            <stop offset="0.55" stop-color="var(--brine)"/>
            <stop offset="1" stop-color="var(--brine-lit)"/>
          </linearGradient>
          <linearGradient id="collar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--chrome)"/>
            <stop offset="1" stop-color="var(--chrome-dark)"/>
          </linearGradient>
          <!--
            The interior fresnel (§6.3): an absorption falloff that darkens the
            silhouette edge from within. It REMOVES light at the edge. A rim
            light adds it, and a bright ring on a sphere's outer edge means the
            sign is wrong.
          -->
          <radialGradient id="fresnel">
            <stop offset="0.55" stop-color="var(--void)" stop-opacity="0"/>
            <stop offset="1" stop-color="var(--void)" stop-opacity="0.55"/>
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="${WIDTH}" height="${height}" fill="var(--abyss)"/>
        <rect x="16" y="8" width="${WIDTH - 32}" height="${height - 16}" rx="24" fill="url(#brine)" stroke="var(--glass-edge)" stroke-opacity="0.5"/>
        ${impeller(72, 96)}
        ${impeller(318, height - 96)}
        <rect x="16" y="8" width="${WIDTH - 32}" height="${COLLAR}" rx="10" fill="url(#collar)" opacity="0.75"/>
        <rect x="16" y="${height - COLLAR - 8}" width="${WIDTH - 32}" height="${COLLAR}" rx="10" fill="url(#collar)" opacity="0.75"/>
        <line x1="135" y1="24" x2="135" y2="${8 + (height - 16) * 0.6}" stroke="var(--specular)" stroke-width="1" opacity="0.5"/>
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8" fill="rgba(5,7,12,0.35)" stroke="var(--glass-edge)" stroke-opacity="0.4" stroke-width="6"/>
        ${slotCells}
        <rect class="tube-rim" x="${TUBE_X - 2}" y="${tubeTop - 2}" width="${TUBE_WIDTH + 4}" height="${
          tubeHeight + 4
        }" rx="10" fill="none" stroke="var(--gold)" stroke-width="2"/>
        ${rings}
        ${spheres}
        <g class="stamp" transform="translate(195,${height / 2})">
          <rect x="-64" y="-22" width="128" height="44" rx="4" fill="rgba(5,7,12,0.82)" stroke="var(--gold)" stroke-width="1.5"/>
          <text text-anchor="middle" y="8" font-size="24" font-weight="600" fill="var(--gold)"></text>
        </g>
      </svg>`;

    this.#svg = this.#root.querySelector('svg');
    this.#spheres = new Map();
    this.#rings = new Map();
    for (const node of this.#root.querySelectorAll<SVGGElement>('.sphere'))
      this.#spheres.set(Number(node.dataset.element), node);
    for (const node of this.#root.querySelectorAll<SVGGElement>('.lock-ring'))
      this.#rings.set(Number(node.dataset.slot), node);
    this.#rim = this.#root.querySelector('.tube-rim');
    this.#stamp = this.#root.querySelector('.stamp');
  }

  reset(): void {
    if (!this.#variant) return;
    this.setBeat('idle');
    this.igniteRim(false);
    this.setStamp('', false);
    for (const [index, node] of this.#spheres) {
      const [x, y] = DRIFT[index] ?? [195, 200];
      node.style.setProperty('--fall', '340ms');
      node.style.transition = 'none';
      node.style.transform = `translate(${x}px,${y}px)`;
      node.classList.remove('sphere--seated');
      void node.getBoundingClientRect();
      node.style.transition = '';
    }
    for (const ring of this.#rings.values()) ring.classList.remove('lock-ring--on');
  }

  setBeat(beat: Beat): void {
    this.#svg?.setAttribute('data-beat', beat);
  }

  /** Seat one sphere into one slot. `slot` is 1-indexed from the bottom. */
  seat(slot: number, element: number, fallMs: number): void {
    const node = this.#spheres.get(element);
    if (!node) return;
    node.style.setProperty('--fall', `${fallMs}ms`);
    node.style.transform = `translate(195px,${this.slotY(slot)}px)`;
    node.classList.add('sphere--seated');
  }

  lock(slot: number): void {
    this.#rings.get(slot)?.classList.add('lock-ring--on');
  }

  igniteRim(on: boolean): void {
    this.#rim?.classList.toggle('tube-rim--lit', on);
  }

  setStamp(text: string, on: boolean): void {
    if (!this.#stamp) return;
    const label = this.#stamp.querySelector('text');
    if (label) label.textContent = text;
    this.#stamp.classList.toggle('stamp--on', on);
  }
}
