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
 * chamber be at least as tall as its tube.
 *
 * ## Two rules this file exists to keep
 *
 * **Every animated transform is applied to an element whose position is set by
 * an ancestor.** A CSS `transform` on an SVG element *replaces* the element's
 * `transform` presentation attribute rather than composing with it, so an
 * animated `.impeller` or `.stamp` that also carries `transform="translate(…)"`
 * silently teleports to the viewBox origin the moment the animation applies.
 * Both are therefore an outer positioning `<g>` wrapping an inner animated one.
 *
 * **The lock ring's gold is transient.** §6.1 use 1 is "the slot ring *at the
 * moment it locks*". A tube left with `n` gold rings after a losing round is
 * gold on something that is not a win, so each slot carries two stacked rings —
 * a gold one that flashes and fades and a neutral one that stays — and only
 * `opacity` ever animates, per §6.4.
 */

import { glyphMarkup } from './glyphs.js';
import type { VariantInfo } from './types.js';

const TUBE_WIDTH = 96;
const TUBE_X = 195 - TUBE_WIDTH / 2;
const TUBE_RIM = 12;
const COLLAR = 28;
const WIDTH = 390;
const IMPELLER_RADIUS = 48;

/**
 * §6.9 puts the impellers at (72, 88) and (318, 342) in a 390 × 430 chamber.
 * Held as fractions of the chamber height so the pair stays diagonally opposed
 * and symmetric when the chamber grows to fill S4's full-bleed stage.
 */
const IMPELLER_Y = [88 / 430, 342 / 430] as const;

/**
 * Where the spheres drift while the tube is empty: a lane (x) and a fraction of
 * the chamber height. The left lane sits below the top-left impeller and the
 * right lane above the bottom-right one, so no sphere is ever parked on top of
 * the machinery in either variant or at any chamber height (§6.9).
 */
const DRIFT: readonly (readonly [number, number])[] = [
  [308, 0.16],
  [82, 0.45],
  [308, 0.31],
  [82, 0.62],
  [308, 0.46],
  [82, 0.79],
  [308, 0.61],
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

  /* The round so far, so a re-layout can restore it rather than erase it. */
  #beat: Beat = 'idle';
  #seated = new Map<number, number>();
  #rimLit = false;
  #stampText = '';
  #stampOn = false;

  constructor(root: HTMLElement) {
    this.#root = root;
  }

  get height(): number {
    return this.#height;
  }

  /** The shortest chamber that still holds this variant's tube. */
  minHeight(variant: VariantInfo): number {
    return variant.n * variant.geometry.slotPitch + TUBE_RIM * 2 + 16;
  }

  /** Centre y of slot `k`, 1-indexed from the bottom of the tube. */
  slotY(k: number): number {
    return this.#slots[k - 1] ?? 0;
  }

  /**
   * Draw the chamber at `height` viewBox units tall.
   *
   * S4 asks the chamber to go full-bleed, and an SVG with a fixed viewBox in a
   * taller box letterboxes instead — two bands of dead page background that read
   * as a layout bug rather than as a crop. So the *chamber* grows with the space
   * the layout gives it while the tube keeps its slot pitch and its sphere
   * diameter, which are the two numbers readability depends on.
   */
  render(variant: VariantInfo, height?: number): void {
    this.#variant = variant;
    const { n } = variant;
    const pitch = variant.geometry.slotPitch;
    const diameter = variant.geometry.sphereDiameter;
    const tubeHeight = n * pitch + TUBE_RIM * 2;
    const floor = tubeHeight + 16;
    // Enough headroom to fill S4's stage on the 390 x 844 reference device
    // without the chamber turning into an arbitrarily tall column on a desktop
    // window the game is not designed for (§5: portrait only).
    const ceiling = Math.round(floor * 1.8);
    const chamberHeight = Math.round(
      Math.min(ceiling, Math.max(floor, height ?? floor)),
    );
    this.#height = chamberHeight;

    const tubeTop = Math.round((chamberHeight - tubeHeight) / 2);
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

    // Two stacked rings per slot. The gold one is the lock flash (§6.1 use 1)
    // and fades; the neutral one is the seated slot and stays. Only opacity
    // animates, so nothing here invalidates raster during SETTLE (§6.4).
    const rings = this.#slots
      .map((y, index) => {
        const box = `x="${TUBE_X + 4}" y="${y - pitch / 2 + 3}" width="${TUBE_WIDTH - 8}" height="${
          pitch - 6
        }" rx="4" fill="none"`;
        return `<g class="lock-ring" data-slot="${index + 1}">
          <rect class="lock-ring__seat" ${box} stroke="var(--glass-edge)" stroke-width="1.5"/>
          <rect class="lock-ring__gold" ${box} stroke="var(--gold)" stroke-width="1.5"/>
        </g>`;
      })
      .join('');

    const spheres = variant.elements
      .map((element, index) => {
        const [x, fraction] = DRIFT[index] ?? [195, 0.5];
        const y = Math.round(chamberHeight * fraction);
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

    // Five 18 px vanes at 72 degrees. Five, not seven, in both variants: it is
    // machinery, not a counter. The rotation lives on an INNER group so the
    // spin keyframe cannot overwrite the placement (see the file header).
    const impeller = (cx: number, cy: number): string => {
      const vanes = Array.from({ length: 5 }, (_unused, index) => {
        const angle = (index * 72 * Math.PI) / 180;
        const inner = IMPELLER_RADIUS * 0.54;
        const outer = IMPELLER_RADIUS * 0.92;
        return `<line x1="${(Math.cos(angle) * inner).toFixed(2)}" y1="${(
          Math.sin(angle) * inner
        ).toFixed(2)}" x2="${(Math.cos(angle) * outer).toFixed(2)}" y2="${(
          Math.sin(angle) * outer
        ).toFixed(2)}" stroke="var(--chrome-mid)" stroke-width="4" stroke-linecap="round"/>`;
      }).join('');
      return `<g class="impeller-at" transform="translate(${cx},${cy})">
        <g class="impeller">
          <circle r="${IMPELLER_RADIUS}" fill="none" stroke="var(--chrome-mid)" stroke-width="3"/>
          <circle r="6" fill="var(--chrome-mid)"/>${vanes}
        </g>
      </g>`;
    };

    this.#root.innerHTML = `
      <svg class="chamber" viewBox="0 0 ${WIDTH} ${chamberHeight}" preserveAspectRatio="xMidYMid meet" data-beat="idle" role="img" aria-label="Chamber with ${n} spheres and a ${n}-slot tube">
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
          <clipPath id="glass-clip">
            <rect x="16" y="8" width="${WIDTH - 32}" height="${chamberHeight - 16}" rx="24"/>
          </clipPath>
        </defs>
        <rect x="0" y="0" width="${WIDTH}" height="${chamberHeight}" fill="var(--void)"/>
        <rect x="16" y="8" width="${WIDTH - 32}" height="${chamberHeight - 16}" rx="24" fill="url(#brine)" stroke="var(--glass-edge)" stroke-opacity="0.5"/>
        <g clip-path="url(#glass-clip)">
          ${impeller(72, Math.round(chamberHeight * IMPELLER_Y[0]))}
          ${impeller(318, Math.round(chamberHeight * IMPELLER_Y[1]))}
          <rect x="16" y="8" width="${WIDTH - 32}" height="${COLLAR}" fill="url(#collar)" opacity="0.75"/>
          <rect x="16" y="${chamberHeight - COLLAR - 8}" width="${
            WIDTH - 32
          }" height="${COLLAR}" fill="url(#collar)" opacity="0.75"/>
          <line x1="135" y1="${8 + COLLAR}" x2="135" y2="${
            8 + (chamberHeight - 16) * 0.6
          }" stroke="var(--specular)" stroke-width="1" opacity="0.5"/>
          <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8" fill="rgba(5,7,12,0.35)" stroke="var(--glass-edge)" stroke-opacity="0.4" stroke-width="6"/>
          ${slotCells}
          <rect class="tube-rim" x="${TUBE_X - 2}" y="${tubeTop - 2}" width="${
            TUBE_WIDTH + 4
          }" height="${tubeHeight + 4}" rx="10" fill="none" stroke="var(--gold)" stroke-width="2"/>
          ${rings}
          ${spheres}
        </g>
        <g class="stamp-at" transform="translate(195,${Math.round(chamberHeight / 2)})">
          <g class="stamp">
            <rect class="stamp__plate" x="-64" y="-22" width="128" height="44" rx="4" fill="rgba(5,7,12,0.92)" stroke="var(--gold)" stroke-width="1.5"/>
            <text class="stamp__value" text-anchor="middle" y="8" font-size="24" font-weight="600" fill="var(--gold)"></text>
          </g>
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

    this.#restore();
  }

  /**
   * Re-apply the round so far, without transitions.
   *
   * A re-layout (a mode change, a rotation, a resize) must not erase a settled
   * tube: the result screen is the record of the round (§5 S5) and a chamber
   * that forgot where the spheres landed is not a record.
   */
  #restore(): void {
    this.setBeat(this.#beat);
    this.igniteRim(this.#rimLit);
    this.setStamp(this.#stampText, this.#stampOn);
    for (const [slot, element] of this.#seated) {
      const node = this.#spheres.get(element);
      if (!node) continue;
      node.style.transition = 'none';
      node.style.transform = `translate(195px,${this.slotY(slot)}px)`;
      node.classList.add('sphere--seated');
      void node.getBoundingClientRect();
      node.style.transition = '';
      const ring = this.#rings.get(slot);
      if (ring) ring.classList.add('lock-ring--on', 'lock-ring--settled');
    }
  }

  reset(): void {
    if (!this.#variant) return;
    this.#seated.clear();
    this.#beat = 'idle';
    this.setBeat('idle');
    this.igniteRim(false);
    this.setStamp('', false);
    for (const [index, node] of this.#spheres) {
      const [x, fraction] = DRIFT[index] ?? [195, 0.5];
      node.style.setProperty('--fall', '340ms');
      node.style.transition = 'none';
      node.style.transform = `translate(${x}px,${Math.round(this.#height * fraction)}px)`;
      node.classList.remove('sphere--seated');
      void node.getBoundingClientRect();
      node.style.transition = '';
    }
    for (const ring of this.#rings.values())
      ring.classList.remove('lock-ring--on', 'lock-ring--settled');
  }

  setBeat(beat: Beat): void {
    this.#beat = beat;
    this.#svg?.setAttribute('data-beat', beat);
  }

  /** Seat one sphere into one slot. `slot` is 1-indexed from the bottom. */
  seat(slot: number, element: number, fallMs: number): void {
    this.#seated.set(slot, element);
    const node = this.#spheres.get(element);
    if (!node) return;
    node.style.setProperty('--fall', `${fallMs}ms`);
    node.style.transform = `translate(195px,${this.slotY(slot)}px)`;
    node.classList.add('sphere--seated');
  }

  lock(slot: number): void {
    const ring = this.#rings.get(slot);
    if (!ring) return;
    ring.classList.add('lock-ring--on');
    // The gold is the moment, not the state: it decays to the neutral seated
    // ring on its own, and a losing tube is never left wearing six golds.
    window.setTimeout(() => ring.classList.add('lock-ring--settled'), 40);
  }

  igniteRim(on: boolean): void {
    this.#rimLit = on;
    this.#rim?.classList.toggle('tube-rim--lit', on);
  }

  setStamp(text: string, on: boolean): void {
    this.#stampText = text;
    this.#stampOn = on;
    if (!this.#stamp) return;
    const label = this.#stamp.querySelector('text');
    const plate = this.#stamp.querySelector<SVGRectElement>('.stamp__plate');
    if (label) label.textContent = text;
    if (plate) {
      // The plate is sized to its content so a four-figure multiplier does not
      // spill out of a box drawn for three.
      const width = Math.max(128, text.length * 17 + 40);
      plate.setAttribute('x', String(-width / 2));
      plate.setAttribute('width', String(width));
    }
    this.#stamp.classList.toggle('stamp--on', on);
  }
}
