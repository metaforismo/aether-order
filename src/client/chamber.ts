/**
 * The chamber — a jewel instrument in a dark laboratory.
 *
 * Geometry is docs/DESIGN.md §6.9 to the pixel: tube 96 wide centred at x = 195,
 * slot pitch 78 (CLASSIC) / 58 (SEVEN), sphere diameter pitch − 14, collar rings
 * 28 tall, two five-vane impellers diagonally opposed and off the tube's axis,
 * one 1 px `--specular` line at x = 135 running from the top collar to 60% depth.
 * Materials are §6.2, lighting is §6.3, motion is §6.4.
 *
 * ## What this lane is, and what it is not
 *
 * §7 specifies a WebGL2 renderer: one fragment shader for the fluid, a 256 × 256
 * sprite master, a bright-pass and two separable blurs for bloom, a 256-particle
 * closed-form bubble buffer, and a `uniform vec3 pulses[8]` that carries every
 * lock's displacement. This is the **DOM/SVG lane**, and it is not that. What it
 * does instead, and why each substitution is defensible:
 *
 * | §7 asks for | Here |
 * | --- | --- |
 * | fluid shader with a domain-warped caustic | two counter-drifting layers of soft elliptical gradients, `transform`-animated |
 * | refraction resample of the sphere layer | the tube's front glass — wall bands, a lens gradient at each inner wall, and a broad sheen that crosses every seated sphere (§6.2's glass read is "a 6 px inner edge gradient plus one thin highlight", never a full glass shader) |
 * | bloom via bright-pass + blur | an emissive bleed baked into each sphere's own gradient stack (`sphere.ts`), which is where §6.3 says bloom is allowed to touch and nowhere else |
 * | 256 point sprites | 22 closed-form bubbles, CSS-keyframed, alive only through CHARGE and AGITATE |
 * | `pulses[8]` displacement | one expanding ring of light per lock plus §6.4's 2 px chamber flex, both `transform` and `opacity` |
 *
 * **No SVG filter appears anywhere in this file.** Every soft edge is a gradient
 * stop. That is not a stylistic preference: §7.1.1's rule is that during SETTLE
 * the chrome layer animates `transform` and `opacity` only, on pre-promoted
 * layers, because anything that invalidates raster is re-uploaded every frame. A
 * `feGaussianBlur` over the chamber rect would break that rule the first time
 * something moved underneath it.
 *
 * ## Three rules this file exists to keep
 *
 * **Every animated transform is applied to an element whose position is set by an
 * ancestor.** A CSS `transform` on an SVG element *replaces* the element's
 * `transform` presentation attribute rather than composing with it, so an
 * animated `.impeller` or `.stamp` that also carries `transform="translate(…)"`
 * silently teleports to the viewBox origin the moment the animation applies.
 * Every animated node here is an inner group inside a positioning one.
 *
 * **The lock ring's gold is transient.** §6.1 use 1 is "the slot ring *at the
 * moment it locks*". A tube left with `n` gold rings after a losing round is gold
 * on something that is not a win, so each slot carries two stacked rings — a gold
 * one that flashes and fades and a neutral one that stays — and only `opacity`
 * ever animates.
 *
 * **Nothing dramatic happens unless the server said the round won.** The
 * celebrated close — the duck, the desaturation, the 0.35× fall, the gold rim,
 * the prismatic burst, the motes and the stamp — is behind `celebrate`, which is
 * `roundPresentation`'s single comparison and never a comparison of this
 * client's. A losing close is one fall at full speed with no colour change and no
 * audio event, and it is byte-for-byte the same whether the ticket missed by one
 * sphere or by five (§9's no-near-miss rule at the render layer).
 *
 * One inconsistency in the source geometry, recorded rather than silently
 * "fixed": §6.9 gives SEVEN a 390-tall chamber and a tube of `n × 58 + 24` = 430,
 * which does not fit inside it. This renderer keeps the pitch and the sphere
 * diameter — the two numbers readability depends on — and lets the chamber be at
 * least as tall as its tube.
 */

import type { WinVoicing } from './audio.js';
import { ticker, type Turbulence } from './choreo.js';
import { mountOrbDefs, orbArt } from './sphere.js';
import type { ElementInfo, VariantInfo } from './types.js';

const TUBE_WIDTH = 96;
const TUBE_X = 195 - TUBE_WIDTH / 2;
const TUBE_RIM = 12;
const TUBE_WALL = 6;
const COLLAR = 28;
const WIDTH = 390;
const CENTRE_X = 195;
const IMPELLER_RADIUS = 48;

/**
 * §6.9 puts the impellers at (72, 88) and (318, 342) in a 390 × 430 chamber.
 * Held as fractions of the chamber height so the pair stays diagonally opposed
 * and symmetric when the chamber grows to fill S4's full-bleed stage.
 */
const IMPELLER_Y = [88 / 430, 342 / 430] as const;

/** One revolution per 1.6 s at full speed, in radians per second. */
const IMPELLER_OMEGA = (Math.PI * 2) / 1.6;

/** How long the prismatic burst runs. Mirrors `burst-open` in styles.css. */
const BURST_MS = 1100;

/**
 * Where the spheres drift while the tube is empty: a lane (x) and a fraction of
 * the chamber height. The left lane sits below the top-left impeller and the
 * right lane above the bottom-right one, so no sphere is ever parked on top of
 * the machinery in either variant or at any chamber height (§6.9).
 *
 * The fractions are spaced by one sphere diameter within a lane and start low
 * enough that the topmost sphere clears the 28 px collar. Round 1's first
 * fraction was 0.16, which put a 64 px sphere's top edge exactly on the collar's
 * bottom line — fine while the only motion was a 8 px CSS drift, and a sphere
 * sliding over the machined steel the moment there was real turbulence.
 */
const DRIFT: readonly (readonly [number, number])[] = [
  [308, 0.19],
  [82, 0.44],
  [308, 0.34],
  [82, 0.61],
  [308, 0.49],
  [82, 0.78],
  [308, 0.64],
];

export type Beat = 'idle' | 'charge' | 'agitate' | 'settle' | 'close' | 'done';

/**
 * The tier of the best line that won, which voices the celebration (§9).
 *
 * One definition, shared with the sound layer, because the picture and the audio
 * must be voiced by the same thing — §8 and §9 describe one ladder, not two.
 */
export type Voicing = WinVoicing;

/** Deterministic 0..1 stream, so the bubble field is stable across renders. */
function stream(seed: number): () => number {
  let state = seed || 0x1b873593;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export class Chamber {
  readonly #root: HTMLElement;
  #variant: VariantInfo | null = null;
  #height = 430;
  #slots: number[] = [];
  #orbs = new Map<number, SVGGElement>();
  #orbY = new Map<number, SVGGElement>();
  #orbMotion = new Map<number, SVGGElement>();
  /** Per-sphere travel limits, so turbulence can never cross the machinery. */
  #bounds = new Map<number, readonly [number, number, number, number]>();
  #rings = new Map<number, SVGGElement>();
  #pulses = new Map<number, SVGGElement>();
  #numerals = new Map<number, SVGTextElement>();
  #impellers: SVGGElement[] = [];
  #tube: SVGGElement | null = null;
  #rim: SVGRectElement | null = null;
  #burst: SVGGElement | null = null;
  #stamp: SVGGElement | null = null;
  #motes: HTMLElement | null = null;
  #svg: SVGSVGElement | null = null;

  /* The round so far, so a re-layout can restore it rather than erase it. */
  #beat: Beat = 'idle';
  #seated = new Map<number, number>();
  #rimLit = false;
  #mono = false;
  #burstAt = 0;
  #stampText = '';
  #stampOn = false;
  #voicing: Voicing = 'FORM';

  /* The motion driver: one registration on the shared ticker. */
  #detach: (() => void) | null = null;
  #lastMs = 0;
  #angle = 0;
  #omega = 0;
  #targetOmega = 0;
  #omegaTau = 0.12;
  #turbulence: Turbulence | null = null;
  #turbulenceStart = 0;
  #reduced = false;

  /**
   * `motesHost` lives in the stage rather than inside the chamber's own markup,
   * and that is a bug fix rather than a preference.
   *
   * The chamber is redrawn whenever the space the layout gives it changes, and
   * one of those moments is the switch from S4 to S5 — about 220 ms after the
   * celebration starts, because the deck grows from one pinned row to a headline
   * plus buttons. A shower owned by the chamber's `innerHTML` was therefore
   * deleted a fifth of a second into a three-second fall, every single time. The
   * frame dump is how that was found; the container outliving the redraw is the
   * fix.
   */
  constructor(root: HTMLElement, motesHost?: HTMLElement | null) {
    this.#root = root;
    this.#motes = motesHost ?? null;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.#reduced = query.matches;
    query.addEventListener('change', (event) => {
      this.#reduced = event.matches;
    });
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

  /* ----------------------------------------------------------------- draw -- */

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
    mountOrbDefs(variant.elements);
    const { n } = variant;
    const pitch = variant.geometry.slotPitch;
    const diameter = variant.geometry.sphereDiameter;
    const tubeHeight = n * pitch + TUBE_RIM * 2;
    const floor = tubeHeight + 16;
    // Enough headroom to fill S4's stage on the 390 x 844 reference device
    // without the chamber turning into an arbitrarily tall column on a desktop
    // window the game is not designed for (§5: portrait only).
    const ceiling = Math.round(floor * 1.8);
    const chamberHeight = Math.round(Math.min(ceiling, Math.max(floor, height ?? floor)));
    this.#height = chamberHeight;

    const glassTop = 8;
    const glassHeight = chamberHeight - 16;
    const tubeTop = Math.round((chamberHeight - tubeHeight) / 2);
    const tubeBottom = tubeTop + tubeHeight;
    this.#slots = Array.from(
      { length: n },
      (_unused, index) => tubeBottom - TUBE_RIM - (index + 0.5) * pitch,
    );

    this.#root.innerHTML = `
      <svg class="chamber" viewBox="0 0 ${WIDTH} ${chamberHeight}" preserveAspectRatio="xMidYMid meet" data-beat="idle" role="img" aria-label="Chamber with ${n} spheres and a ${n}-slot tube">
        <defs>${this.#defs(chamberHeight, glassTop, glassHeight, tubeTop, tubeHeight)}</defs>
        <rect x="0" y="0" width="${WIDTH}" height="${chamberHeight}" fill="var(--void)"/>
        <!-- The back plate: --abyss, so the liquid has something behind it. -->
        <rect x="16" y="${glassTop}" width="${WIDTH - 32}" height="${glassHeight}" rx="24" fill="var(--abyss)"/>
        <g clip-path="url(#glass-clip)">
          <rect class="liquid" x="16" y="${glassTop}" width="${
            WIDTH - 32
          }" height="${glassHeight}" fill="url(#brine)"/>
          ${this.#lightShaft(chamberHeight)}
          ${this.#impeller(72, Math.round(chamberHeight * IMPELLER_Y[0]))}
          ${this.#impeller(318, Math.round(chamberHeight * IMPELLER_Y[1]))}
          ${this.#caustics(chamberHeight)}
          ${this.#bubbles(chamberHeight)}
          <!-- CHARGE deepens the liquid tint 8% (§6.4). Opacity, nothing else. -->
          <rect class="tint" x="16" y="${glassTop}" width="${
            WIDTH - 32
          }" height="${glassHeight}" fill="var(--brine-deep)"/>
          ${this.#collars(chamberHeight, glassTop, glassHeight)}
          <!--
            §6.9's one specular line: 1 px --specular at x = 135, from the top
            collar to 60% depth. §6.6 reference 1 calls this the whole glass
            read; everything else in the chamber is gradient. §6.6 reference 2
            adds the constraint that keeps it that way: if the composition has
            two shiny things competing, delete one. So the tube's own highlight
            below is a soft sheen and never a second hard line.
          -->
          <line x1="135" y1="${glassTop + COLLAR}" x2="135" y2="${
            glassTop + glassHeight * 0.6
          }" stroke="var(--specular)" stroke-width="1" opacity="0.42"/>
          <g class="tube" data-tube>
            ${this.#tubeBack(tubeTop, tubeHeight, pitch)}
            ${this.#lockRings(pitch)}
            ${this.#spheres(variant, chamberHeight, diameter)}
            ${this.#tubeGlass(tubeTop, tubeHeight)}
            <rect class="tube-rim" x="${TUBE_X - 2}" y="${tubeTop - 2}" width="${
              TUBE_WIDTH + 4
            }" height="${tubeHeight + 4}" rx="10" fill="none" stroke="url(#rim-gold)" stroke-width="2"/>
            ${this.#lockPulses(pitch)}
          </g>
          ${this.#burstMarkup(chamberHeight)}
        </g>
        <!--
          The cylinder read, and the last thing over the liquid: a 1 px edge
          tint plus §6.2's 6 px inner edge gradient, bright at both walls and
          empty in the middle. That gradient is what makes 358 px of flat
          rectangle read as borosilicate rather than as a box.
        -->
        <rect x="16" y="${glassTop}" width="${
          WIDTH - 32
        }" height="${glassHeight}" rx="24" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.5" stroke-width="1"/>
        <rect x="19" y="${glassTop + 3}" width="${WIDTH - 38}" height="${
          glassHeight - 6
        }" rx="21" fill="none" stroke="url(#glass-wall)" stroke-width="6"/>
        <g class="stamp-at" transform="translate(${CENTRE_X},${Math.round(chamberHeight / 2)})">
          <g class="stamp">
            <rect class="stamp__glow" x="-118" y="-46" width="236" height="92" rx="46" fill="url(#stamp-glow)"/>
            <!--
              The plate is translucent on purpose. §9 step 5 stamps the figure
              "over the tube", and in CLASSIC the tube's centre is a slot — so an
              opaque plate hides one sphere of the settled column on the screen
              whose whole job is to be the record of the round (§5 S5). At 0.84 the
              sphere behind reads through as a glow and the numerals still clear
              their contrast floor against it.
            -->
            <rect class="stamp__plate" x="-72" y="-25" width="144" height="50" rx="5" fill="rgba(5,7,12,0.84)" stroke="var(--gold)" stroke-width="1.5"/>
            <rect class="stamp__inner" x="-68" y="-21" width="136" height="42" rx="3" fill="none" stroke="var(--gold-hot)" stroke-width="0.75" stroke-opacity="0.45"/>
            <text class="stamp__value" text-anchor="middle" y="9" fill="var(--gold-hot)"></text>
          </g>
        </g>
      </svg>`;

    this.#svg = this.#root.querySelector('svg');
    this.#orbs = new Map();
    this.#orbY = new Map();
    this.#orbMotion = new Map();
    this.#bounds = new Map();
    this.#rings = new Map();
    this.#pulses = new Map();
    this.#numerals = new Map();
    const radius = diameter / 2;
    const safeTop = glassTop + COLLAR + radius + 4;
    const safeBottom = glassTop + glassHeight - COLLAR - radius - 4;
    for (const node of this.#root.querySelectorAll<SVGGElement>('.orb')) {
      const index = Number(node.dataset.element);
      this.#orbs.set(index, node);
      this.#orbY.set(index, node.querySelector('.orb__y') as SVGGElement);
      this.#orbMotion.set(index, node.querySelector('.orb__m') as SVGGElement);
      const [baseX, fraction] = DRIFT[index] ?? [CENTRE_X, 0.5];
      const baseY = Math.round(chamberHeight * fraction);
      this.#bounds.set(index, [
        16 + radius + 4 - baseX,
        WIDTH - 16 - radius - 4 - baseX,
        Math.min(0, safeTop - baseY),
        Math.max(0, safeBottom - baseY),
      ]);
    }
    for (const node of this.#root.querySelectorAll<SVGGElement>('.lock-ring'))
      this.#rings.set(Number(node.dataset.slot), node);
    for (const node of this.#root.querySelectorAll<SVGGElement>('.pulse-at'))
      this.#pulses.set(Number(node.dataset.slot), node);
    for (const node of this.#root.querySelectorAll<SVGTextElement>('.slot-no'))
      this.#numerals.set(Number(node.dataset.slot), node);
    this.#impellers = [...this.#root.querySelectorAll<SVGGElement>('.impeller')];
    this.#tube = this.#root.querySelector('[data-tube]');
    this.#rim = this.#root.querySelector('.tube-rim');
    this.#burst = this.#root.querySelector('.burst');
    this.#stamp = this.#root.querySelector('.stamp');

    this.#restore();
  }

  /* --------------------------------------------------------------- pieces -- */

  #defs(
    chamberHeight: number,
    glassTop: number,
    glassHeight: number,
    tubeTop: number,
    tubeHeight: number,
  ): string {
    return `
      <linearGradient id="brine" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="var(--brine-deep)"/>
        <stop offset="0.5" stop-color="var(--brine)"/>
        <stop offset="1" stop-color="var(--brine-lit)"/>
      </linearGradient>
      <!-- §6.2: brushed 316 steel, anisotropic highlight running horizontally. -->
      <linearGradient id="collar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--chrome-dark)"/>
        <stop offset="0.3" stop-color="var(--chrome)"/>
        <stop offset="0.52" stop-color="var(--chrome-mid)"/>
        <stop offset="1" stop-color="var(--chrome-dark)"/>
      </linearGradient>
      <linearGradient id="collar-grain" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--void)" stop-opacity="0.5"/>
        <stop offset="0.22" stop-color="var(--specular)" stop-opacity="0.16"/>
        <stop offset="0.5" stop-color="var(--void)" stop-opacity="0.3"/>
        <stop offset="0.78" stop-color="var(--specular)" stop-opacity="0.12"/>
        <stop offset="1" stop-color="var(--void)" stop-opacity="0.5"/>
      </linearGradient>
      <!-- The cylinder: bright at both walls, nothing in the middle (§6.2). -->
      <linearGradient id="glass-wall" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.75"/>
        <stop offset="0.13" stop-color="var(--glass-edge)" stop-opacity="0.04"/>
        <stop offset="0.87" stop-color="var(--glass-edge)" stop-opacity="0.04"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0.6"/>
      </linearGradient>
      <!-- Volumetric key from above, so the chamber is the only bright object. -->
      <radialGradient id="shaft">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0.16"/>
        <stop offset="0.4" stop-color="var(--glass-edge)" stop-opacity="0.07"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="caustic">
        <stop offset="0" stop-color="var(--brine-lit)" stop-opacity="0.85"/>
        <stop offset="0.55" stop-color="var(--brine-lit)" stop-opacity="0.3"/>
        <stop offset="1" stop-color="var(--brine-lit)" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="floor-caustic">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.3"/>
        <stop offset="0.6" stop-color="var(--glass-edge)" stop-opacity="0.09"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="tube-well" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--void)" stop-opacity="0.72"/>
        <stop offset="0.42" stop-color="var(--void)" stop-opacity="0.3"/>
        <stop offset="1" stop-color="var(--void)" stop-opacity="0.66"/>
      </linearGradient>
      <!--
        The tube's front glass, and the DOM lane's stand-in for §7 technique 2's
        refraction resample: a wall band whose gradient runs bright → dark →
        bright compresses whatever sits behind it toward the wall, which is what
        the eye reads as thickness.
      -->
      <linearGradient id="tube-wall-l" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.5"/>
        <stop offset="0.55" stop-color="var(--void)" stop-opacity="0.45"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0.14"/>
      </linearGradient>
      <linearGradient id="tube-wall-r" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.1"/>
        <stop offset="0.4" stop-color="var(--void)" stop-opacity="0.45"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="tube-sheen" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0.16"/>
        <stop offset="0.6" stop-color="var(--specular)" stop-opacity="0.03"/>
        <stop offset="1" stop-color="var(--specular)" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="rim-gold" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="var(--gold-hot)"/>
        <stop offset="0.5" stop-color="var(--gold)"/>
        <stop offset="1" stop-color="var(--gold-hot)"/>
      </linearGradient>
      <radialGradient id="stamp-glow">
        <stop offset="0" stop-color="var(--gold-hot)" stop-opacity="0.3"/>
        <stop offset="0.62" stop-color="var(--gold)" stop-opacity="0.09"/>
        <stop offset="1" stop-color="var(--gold)" stop-opacity="0"/>
      </radialGradient>
      <!--
        The core is deliberately small and not very bright. The burst's job is to
        throw light *through* the chamber, and a big hot centre washes out the
        settled column underneath it — which is the record of the round (§5 S5)
        and the one thing a celebration may not take away.
      -->
      <radialGradient id="burst-core">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0.6"/>
        <stop offset="0.3" stop-color="var(--gold-hot)" stop-opacity="0.26"/>
        <stop offset="1" stop-color="var(--gold)" stop-opacity="0"/>
      </radialGradient>
      <clipPath id="glass-clip">
        <rect x="16" y="${glassTop}" width="${WIDTH - 32}" height="${glassHeight}" rx="24"/>
      </clipPath>
      <clipPath id="tube-clip">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8"/>
      </clipPath>
`;
  }

  /**
   * §6.3's key: a single cool source above-left, read as a soft pool of light
   * entering through the top collar.
   *
   * An ellipse rather than a polygon. The first version was a widening quad
   * filled with a vertical gradient, which fades at its bottom edge and does not
   * fade at its *sides* — so the light had two hard diagonal edges running down
   * the chamber, a seam where there should have been a haze. A radial fill has no
   * edge in any direction.
   */
  #lightShaft(chamberHeight: number): string {
    return `<ellipse class="shaft" cx="${CENTRE_X - 18}" cy="${
      8 + COLLAR
    }" rx="188" ry="${Math.round(chamberHeight * 0.62)}" fill="url(#shaft)"/>`;
  }

  /**
   * Two counter-drifting layers of soft ellipses, plus §6.3's one elliptical
   * caustic on the base plate.
   *
   * §6.2 fakes Beer–Lambert depth with the vertical gradient and adds "a
   * scrolling caustic"; §6.3 requires the base-plate caustic to be driven by the
   * same field as the liquid so the two never desync — here they share one
   * keyframe pair, which is the strongest form of that guarantee.
   */
  #caustics(chamberHeight: number): string {
    const next = stream(0x9e3779b9);
    const blob = (layer: number): string => {
      const cx = 30 + next() * 330;
      const cy = next() * chamberHeight;
      const rx = 44 + next() * 74;
      const ry = 16 + next() * 30;
      return `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(
        0,
      )}" ry="${ry.toFixed(0)}" fill="url(#caustic)" opacity="${(0.1 + layer * 0.04).toFixed(2)}"/>`;
    };
    const layerA = Array.from({ length: 5 }, () => blob(0)).join('');
    const layerB = Array.from({ length: 4 }, () => blob(1)).join('');
    return `
      <g class="caustic caustic--a">${layerA}</g>
      <g class="caustic caustic--b">${layerB}</g>
      <g class="floor-caustic-at" transform="translate(${CENTRE_X},${chamberHeight - COLLAR - 14})">
        <ellipse class="floor-caustic" rx="152" ry="30" fill="url(#floor-caustic)"/>
      </g>`;
  }

  /**
   * §7 technique 4's bubbles, at DOM scale: closed-form, deterministic, and
   * alive only through CHARGE and AGITATE. 22 rather than 256 because each one
   * here is a composited node instead of a point sprite.
   */
  #bubbles(chamberHeight: number): string {
    const next = stream(0x85ebca6b);
    const cells = Array.from({ length: 22 }, () => {
      const x = 26 + next() * 338;
      const size = 1.4 + next() * 2.6;
      const delay = next() * 1.1;
      const duration = 1.5 + next() * 1.6;
      const rise = chamberHeight * (0.45 + next() * 0.5);
      return `<circle cx="${x.toFixed(0)}" cy="${(chamberHeight - COLLAR - 12).toFixed(
        0,
      )}" r="${size.toFixed(1)}" fill="var(--glass-edge)" style="--rise:${-rise.toFixed(
        0,
      )}px;animation-delay:${delay.toFixed(2)}s;animation-duration:${duration.toFixed(2)}s"/>`;
    }).join('');
    return `<g class="bubbles">${cells}</g>`;
  }

  /** §6.2: brushed 316 steel, grain horizontal, at 6% over the collar body. */
  #collars(chamberHeight: number, glassTop: number, glassHeight: number): string {
    const band = (y: number): string => `
      <g>
        <rect x="16" y="${y}" width="${WIDTH - 32}" height="${COLLAR}" fill="url(#collar)" opacity="0.9"/>
        <rect x="16" y="${y}" width="${WIDTH - 32}" height="${COLLAR}" fill="url(#collar-grain)" opacity="0.4"/>
        <line x1="16" y1="${y + 0.5}" x2="${WIDTH - 16}" y2="${
          y + 0.5
        }" stroke="var(--specular)" stroke-width="1" opacity="0.28"/>
        <line x1="16" y1="${y + COLLAR - 0.5}" x2="${WIDTH - 16}" y2="${
          y + COLLAR - 0.5
        }" stroke="var(--void)" stroke-width="1" opacity="0.55"/>
      </g>`;
    return `${band(glassTop)}${band(glassTop + glassHeight - COLLAR)}`;
  }

  /** The tube behind the spheres: the well, the slot divisions, the numerals. */
  #tubeBack(tubeTop: number, tubeHeight: number, pitch: number): string {
    const engraved = this.#slots
      .map((y, index) => {
        if (index === 0) return '';
        const line = y + pitch / 2;
        return `
          <line x1="${TUBE_X + TUBE_WALL}" y1="${line}" x2="${
            TUBE_X + TUBE_WIDTH - TUBE_WALL
          }" y2="${line}" stroke="var(--void)" stroke-opacity="0.7" stroke-width="1"/>
          <line x1="${TUBE_X + TUBE_WALL}" y1="${line + 1}" x2="${
            TUBE_X + TUBE_WIDTH - TUBE_WALL
          }" y2="${line + 1}" stroke="var(--glass-edge)" stroke-opacity="0.42" stroke-width="1"/>`;
      })
      .join('');
    // §11: a boundary the player needs to perceive clears 3:1 against the
    // surface it sits on, achieved with --glass-edge rather than with the fill.
    // An engraved pair — one dark line, one light — reads at a distance where a
    // single hairline at 28% did not.
    const numerals = this.#slots
      .map(
        (y, index) =>
          `<text class="slot-no" data-slot="${index + 1}" x="${TUBE_X + 13}" y="${
            y + 4
          }" fill="var(--ink-dim)">${index + 1}</text>`,
      )
      .join('');
    return `
      <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8" fill="url(#tube-well)"/>
      <g clip-path="url(#tube-clip)">${engraved}</g>
      ${numerals}`;
  }

  /**
   * The tube's front glass — drawn *over* the spheres on purpose.
   *
   * A seated sphere seen through a wall band and a sheen is a sphere inside a
   * tube; the same sphere drawn on top of the glass is a sticker. This is the
   * cheapest honest version of §6.2's glass: a 6 px inner edge gradient at each
   * wall, one broad soft sheen, and a meniscus arc at each end, which §6.6
   * reference 1 identifies as the one line that carries the whole glass read.
   */
  #tubeGlass(tubeTop: number, tubeHeight: number): string {
    const bottom = tubeTop + tubeHeight;
    return `
      <g class="tube-glass" clip-path="url(#tube-clip)">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WALL}" height="${tubeHeight}" fill="url(#tube-wall-l)"/>
        <rect x="${TUBE_X + TUBE_WIDTH - TUBE_WALL}" y="${tubeTop}" width="${TUBE_WALL}" height="${tubeHeight}" fill="url(#tube-wall-r)"/>
        <rect x="${TUBE_X + TUBE_WALL}" y="${tubeTop}" width="26" height="${tubeHeight}" fill="url(#tube-sheen)"/>
        <path d="M${TUBE_X + 2} ${tubeTop + 9} Q${CENTRE_X} ${tubeTop + 20} ${
          TUBE_X + TUBE_WIDTH - 2
        } ${tubeTop + 9}" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.4" stroke-width="1"/>
        <path d="M${TUBE_X + 2} ${bottom - 9} Q${CENTRE_X} ${bottom - 20} ${
          TUBE_X + TUBE_WIDTH - 2
        } ${bottom - 9}" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.3" stroke-width="1"/>
      </g>
      <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.45" stroke-width="1"/>`;
  }

  /** Two stacked rings per slot: the gold flash, and the seated state. */
  #lockRings(pitch: number): string {
    return this.#slots
      .map((y, index) => {
        const box = `x="${TUBE_X + 4}" y="${y - pitch / 2 + 3}" width="${
          TUBE_WIDTH - 8
        }" height="${pitch - 6}" rx="4" fill="none"`;
        return `<g class="lock-ring" data-slot="${index + 1}">
          <rect class="lock-ring__seat" ${box} stroke="var(--glass-edge)" stroke-width="1.5"/>
          <rect class="lock-ring__gold" ${box} stroke="url(#rim-gold)" stroke-width="1.5"/>
        </g>`;
      })
      .join('');
  }

  /**
   * The ring of light that pulses at each lock-in.
   *
   * §7 technique 5 injects one displacement pulse per lock into a shader
   * uniform; this is that beat in the DOM lane, as an expanding ellipse that
   * scales and fades. It is `transform` and `opacity` on a pre-rasterised
   * stroke — never an animated `stroke-width`, which is the property §7.1.1
   * names as the way a build breaks the frame budget while decorating it. §6.4
   * bounds the overlap for free: a 380 ms pulse against a 360–420 ms stagger
   * means at most one is ever in flight.
   */
  #lockPulses(pitch: number): string {
    return this.#slots
      .map(
        (y, index) => `<g class="pulse-at" data-slot="${index + 1}" transform="translate(${CENTRE_X},${y})">
          <g class="pulse">
            <ellipse rx="${TUBE_WIDTH / 2 - 4}" ry="${(pitch / 2 - 3).toFixed(
              1,
            )}" fill="none" stroke="var(--gold-hot)" stroke-width="1.5"/>
          </g>
        </g>`,
      )
      .join('');
  }

  /**
   * The spheres, and the three nested transforms each one needs.
   *
   * `.orb` carries x, `.orb__y` carries y and `.orb__m` carries motion — the
   * idle drift as a CSS keyframe, the agitation as a per-frame write from the
   * shared ticker. They are separate elements because x and y are *different
   * eases*: §6.4's 340 ms expo-out belongs to the fall, and a sphere that
   * traverses horizontally on the same curve slides rather than swoops. Splitting
   * them buys the arc — across, then down — inside the beat's published duration,
   * with the vertical curve exactly as published.
   */
  #spheres(variant: VariantInfo, chamberHeight: number, diameter: number): string {
    return variant.elements
      .map((element: ElementInfo, index: number) => {
        const [x, fraction] = DRIFT[index] ?? [CENTRE_X, 0.5];
        const y = Math.round(chamberHeight * fraction);
        return `<g class="orb" data-element="${index}" style="transform:translateX(${x}px)">
          <g class="orb__y" style="transform:translateY(${y}px)">
            <g class="orb__m" style="animation-delay:${(index * -1.7).toFixed(1)}s">
              ${orbArt(element, diameter / 2)}
            </g>
          </g>
        </g>`;
      })
      .join('');
  }

  /**
   * Five 18 px vanes at 72°. Five, not seven, in both variants: it is machinery,
   * not a counter, and a five-vane wheel at 3.2 Hz never appears to stand still
   * under the settle cadence the way a seven-vane one does at 360 ms (§6.9).
   *
   * The rotation lives on an INNER group so the per-frame transform cannot
   * overwrite the placement (see the file header).
   */
  #impeller(cx: number, cy: number): string {
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
        <circle r="${IMPELLER_RADIUS - 7}" fill="none" stroke="var(--chrome-dark)" stroke-width="1"/>
        <circle r="6" fill="var(--chrome-mid)"/>${vanes}
      </g>
    </g>`;
  }

  /**
   * The prismatic burst — light thrown through the chamber when the round won.
   *
   * The spokes are tinted from the sphere palette rather than from a new set of
   * hues: §6.1 keeps the environment neutral so the spheres are the only colour
   * in the world, and glass splitting the light of the objects already in it is
   * the only prism this art direction has. Behind `celebrate`, always.
   */
  #burstMarkup(chamberHeight: number): string {
    const hues = (this.#variant?.elements ?? []).map((element) => element.hex);
    const length = Math.max(200, chamberHeight * 0.62);
    const spokes = Array.from({ length: 16 }, (_unused, index) => {
      const angle = (index / 16) * 360 + 11;
      const hex = hues[index % Math.max(1, hues.length)] ?? '#EAF3FA';
      const width = index % 2 === 0 ? 6 : 2.6;
      return `<path transform="rotate(${angle.toFixed(1)})" d="M${-width / 2} 0 L${
        width / 2
      } 0 L0 ${-length.toFixed(0)} Z" fill="${hex}" opacity="${index % 2 === 0 ? 0.8 : 0.45}"/>`;
    }).join('');
    return `<g class="burst-at" transform="translate(${CENTRE_X},${Math.round(chamberHeight / 2)})">
      <g class="burst">
        <g class="burst__spokes">${spokes}</g>
        <circle class="burst__core" r="${(length * 0.34).toFixed(0)}" fill="url(#burst-core)"/>
      </g>
    </g>`;
  }

  /* -------------------------------------------------------------- restore -- */

  /**
   * Re-apply the round so far, without transitions.
   *
   * A re-layout (a mode change, a rotation, a resize) must not erase a settled
   * tube: the result screen is the record of the round (§5 S5) and a chamber
   * that forgot where the spheres landed is not a record.
   */
  #restore(): void {
    const svg = this.#svg;
    // Every restored state is an END state, so nothing may transition into it: a
    // freshly created `.tube-rim` that is then given `--lit` would re-run §9's
    // 560 ms bottom-up ignition in the middle of the beat it already finished.
    svg?.classList.add('chamber--restoring');
    this.setBeat(this.#beat);
    this.igniteRim(this.#rimLit);
    this.setStamp(this.#stampText, this.#stampOn);
    this.desaturate(this.#mono);
    for (const [slot, element] of this.#seated) {
      const orb = this.#orbs.get(element);
      const orbY = this.#orbY.get(element);
      if (!orb || !orbY) continue;
      orb.style.transition = 'none';
      orbY.style.transition = 'none';
      orb.style.transform = `translateX(${CENTRE_X}px)`;
      orbY.style.transform = `translateY(${this.slotY(slot)}px)`;
      orb.classList.add('orb--seated');
      void orb.getBoundingClientRect();
      orb.style.transition = '';
      orbY.style.transition = '';
      const ring = this.#rings.get(slot);
      if (ring) ring.classList.add('lock-ring--on', 'lock-ring--settled');
      this.#numerals.get(slot)?.classList.add('slot-no--lit');
    }
    // The burst is the one thing that is legitimately mid-flight across a
    // redraw, so it resumes rather than restarting: a negative animation delay
    // is exactly "continue from where you were".
    const elapsed = performance.now() - this.#burstAt;
    const burst = this.#burst;
    if (burst && this.#burstAt > 0 && elapsed < BURST_MS && !this.#reduced) {
      burst.dataset.voicing = this.#voicing;
      burst.style.animationDelay = `${-Math.round(elapsed)}ms`;
      burst.classList.add('burst--on');
    }
    if (svg) {
      void svg.getBoundingClientRect();
      requestAnimationFrame(() => svg.classList.remove('chamber--restoring'));
    }
  }

  reset(): void {
    if (!this.#variant) return;
    this.#seated.clear();
    this.#turbulence = null;
    this.#beat = 'idle';
    this.setBeat('idle');
    this.igniteRim(false);
    this.setStamp('', false);
    this.desaturate(false);
    this.#burstAt = 0;
    this.#burst?.classList.remove('burst--on', 'burst--calm');
    if (this.#motes) this.#motes.innerHTML = '';
    for (const [index, orb] of this.#orbs) {
      const [x, fraction] = DRIFT[index] ?? [CENTRE_X, 0.5];
      const orbY = this.#orbY.get(index);
      const motion = this.#orbMotion.get(index);
      orb.style.setProperty('--fall', '340ms');
      orb.style.transition = 'none';
      orb.style.transform = `translateX(${x}px)`;
      orb.style.opacity = '';
      orb.classList.remove('orb--seated');
      if (orbY) {
        orbY.style.transition = 'none';
        orbY.style.transform = `translateY(${Math.round(this.#height * fraction)}px)`;
      }
      if (motion) motion.style.transform = '';
      void orb.getBoundingClientRect();
      orb.style.transition = '';
      if (orbY) orbY.style.transition = '';
    }
    for (const ring of this.#rings.values())
      ring.classList.remove('lock-ring--on', 'lock-ring--settled');
    for (const pulse of this.#pulses.values())
      pulse.querySelector('.pulse')?.classList.remove('pulse--on');
    for (const numeral of this.#numerals.values()) numeral.classList.remove('slot-no--lit');
  }

  /* ---------------------------------------------------------------- beats -- */

  setBeat(beat: Beat): void {
    this.#beat = beat;
    this.#svg?.setAttribute('data-beat', beat);
    // §6.9: the impeller spins up over the 260 ms CHARGE, holds through AGITATE,
    // and decelerates to a stop across the first two locks. It never reverses,
    // never pulses, and never reacts to the outcome.
    if (beat === 'charge' || beat === 'agitate') {
      this.#targetOmega = IMPELLER_OMEGA;
      this.#omegaTau = 0.14;
    } else if (beat === 'settle') {
      this.#targetOmega = 0;
      this.#omegaTau = 0.3;
    } else {
      this.#targetOmega = 0;
      this.#omegaTau = beat === 'idle' ? 0.05 : 0.3;
    }
    if (beat === 'settle' || beat === 'close' || beat === 'done') this.#turbulence = null;
    if (beat === 'idle') {
      this.#omega = 0;
      this.#angle = 0;
      for (const impeller of this.#impellers) impeller.style.transform = '';
    }
    this.#drive();
  }

  /**
   * Start the agitation from the track built at COMMIT.
   *
   * `prefers-reduced-motion` gets §6.4's calm variant instead: no turbulence at
   * all, and the same 900 ms of wall clock, so the audio phrase still lands and
   * the round is exactly as long as the one everybody else watched.
   */
  agitate(track: Turbulence): void {
    if (this.#reduced) return;
    this.#turbulence = track;
    this.#turbulenceStart = performance.now();
    this.#drive();
  }

  /** Register on the shared ticker only while something actually moves. */
  #drive(): void {
    const wanted = this.#turbulence !== null || this.#targetOmega > 0 || this.#omega > 0.01;
    if (!wanted) {
      this.#detach?.();
      this.#detach = null;
      return;
    }
    if (this.#detach) return;
    this.#lastMs = performance.now();
    this.#detach = ticker.add(() => this.#frame());
  }

  #frame(): void {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.#lastMs) / 1000));
    this.#lastMs = now;

    // Exponential approach to the target rate: a spin-up and a spin-down with no
    // keyframe to fight and no discontinuity when the target changes mid-beat.
    const alpha = 1 - Math.exp(-dt / this.#omegaTau);
    this.#omega += (this.#targetOmega - this.#omega) * alpha;
    if (this.#omega > 0.0005) {
      this.#angle = (this.#angle + this.#omega * dt) % (Math.PI * 2);
      const degrees = ((this.#angle * 180) / Math.PI).toFixed(2);
      for (const impeller of this.#impellers) impeller.style.transform = `rotate(${degrees}deg)`;
    }

    const track = this.#turbulence;
    if (track) {
      const seconds = (now - this.#turbulenceStart) / 1000;
      for (const [index, motion] of this.#orbMotion) {
        if (this.#seatedElement(index)) continue;
        const [x, y] = track.at(index, seconds);
        // Clamped rather than trusted: the track is a closed form that knows
        // nothing about the collar rings, and a sphere sliding over machined
        // steel is the one artefact that would give the whole illusion away.
        const limits = this.#bounds.get(index) ?? [-30, 30, -30, 30];
        const dx = Math.max(limits[0], Math.min(limits[1], x));
        const dy = Math.max(limits[2], Math.min(limits[3], y));
        motion.style.transform = `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)`;
      }
    }

    if (this.#turbulence === null && this.#omega <= 0.0005) {
      this.#omega = 0;
      this.#detach?.();
      this.#detach = null;
    }
  }

  #seatedElement(element: number): boolean {
    for (const seated of this.#seated.values()) if (seated === element) return true;
    return false;
  }

  /* ---------------------------------------------------------------- seats -- */

  /**
   * Seat one sphere into one slot. `slot` is 1-indexed from the bottom.
   *
   * The horizontal move finishes at 46% of the fall so the sphere is over the
   * tube's axis before most of the drop has happened: across, then down, which is
   * what makes 64 px of resin read as heavy. The vertical curve is §6.4's
   * published fall exactly — 340 ms of `cubic-bezier(.16,1,.3,1)`, expo-out, and
   * the sphere never overshoots its slot.
   *
   * Under `prefers-reduced-motion` the fall is a 120 ms cross-dissolve instead
   * (§6.4), which is a fade at both ends rather than a fast version of the same
   * travel — a fast travel is the thing the preference exists to avoid.
   */
  seat(slot: number, element: number, fallMs: number): void {
    this.#seated.set(slot, element);
    const orb = this.#orbs.get(element);
    const orbY = this.#orbY.get(element);
    const motion = this.#orbMotion.get(element);
    if (!orb || !orbY) return;
    if (motion) {
      motion.style.transition = 'transform 220ms cubic-bezier(.4,0,.2,1)';
      motion.style.transform = 'translate(0px,0px)';
    }
    if (this.#reduced) {
      orb.classList.add('orb--dissolve');
      orb.style.opacity = '0';
      window.setTimeout(() => {
        orb.style.transition = 'none';
        orbY.style.transition = 'none';
        orb.style.transform = `translateX(${CENTRE_X}px)`;
        orbY.style.transform = `translateY(${this.slotY(slot)}px)`;
        void orb.getBoundingClientRect();
        orb.style.transition = '';
        orbY.style.transition = '';
        orb.classList.add('orb--seated');
        orb.style.opacity = '';
      }, Math.max(40, fallMs * 0.5));
      return;
    }
    orb.style.setProperty('--fall', `${fallMs}ms`);
    orb.style.setProperty('--fall-x', `${Math.round(fallMs * 0.46)}ms`);
    orb.style.transform = `translateX(${CENTRE_X}px)`;
    orbY.style.transform = `translateY(${this.slotY(slot)}px)`;
    orb.classList.add('orb--seated');
  }

  /**
   * The lock: the gold ring flashes, the ring of light pulses outward, the slot's
   * numeral lights, and the chamber flexes 2 px (§6.4).
   *
   * Every one of those is `transform`, `opacity` or `color`. The 4% ring
   * overshoot is a `scale` on a pre-rasterised ring and the flex is a `translate`
   * on the tube group, never a new path — §7.1.1's rule, kept rather than
   * quoted.
   */
  lock(slot: number): void {
    const ring = this.#rings.get(slot);
    if (ring) {
      ring.classList.add('lock-ring--on');
      // The gold is the moment, not the state: it decays to the neutral seated
      // ring on its own, and a losing tube is never left wearing five golds.
      window.setTimeout(() => ring.classList.add('lock-ring--settled'), 40);
    }
    this.#numerals.get(slot)?.classList.add('slot-no--lit');
    const pulse = this.#pulses.get(slot)?.querySelector('.pulse');
    if (pulse && !this.#reduced) {
      pulse.classList.remove('pulse--on');
      void (pulse as SVGGElement).getBoundingClientRect();
      pulse.classList.add('pulse--on');
    }
    const tube = this.#tube;
    if (tube && !this.#reduced) {
      tube.classList.remove('tube--flex');
      void tube.getBoundingClientRect();
      tube.classList.add('tube--flex');
    }
  }

  /* ---------------------------------------------------------- celebration -- */

  igniteRim(on: boolean): void {
    this.#rimLit = on;
    this.#rim?.classList.toggle('tube-rim--lit', on);
  }

  /**
   * The celebrated close's desaturation — §9 step 2: "the liquid desaturates
   * toward monochrome over 400 ms; the settled spheres keep their colour and
   * everything else goes grey."
   *
   * Implemented as one class on the SVG that drops the *opacity* of the coloured
   * environment layers, not as a `filter: saturate()`: a filter over the chamber
   * rect would re-raster every frame the last sphere moved, which is exactly the
   * cost §7.1.1 refuses to pay.
   */
  desaturate(on: boolean): void {
    this.#mono = on;
    this.#svg?.classList.toggle('chamber--mono', on);
  }

  /**
   * The prismatic burst and the mote fall.
   *
   * §6.1 lists six places gold may appear and the sixth is "the tube's
   * full-height rim during a celebrated close". The motes are that same beat and
   * that same semantic — something is settled, and it is true — rather than a
   * seventh use: they exist only inside the window the gold rim is lit, and they
   * are removed with it. Nothing speculative, pending or merely available ever
   * gets gold anywhere in this client.
   *
   * `voicing` is the tier of the best line that won, and it scales the *shape* of
   * the burst rather than its brightness, exactly as §8 scales the chord: an
   * ORDER win throws the full sixteen spokes and a shower, a FLOW win at 1.92×
   * gets a quiet flare. Both are celebrated, because both won.
   */
  celebrate(voicing: Voicing): void {
    this.#voicing = voicing;
    this.#burstAt = performance.now();
    const burst = this.#burst;
    if (burst) {
      burst.dataset.voicing = voicing;
      burst.classList.remove('burst--on', 'burst--calm');
      burst.style.animationDelay = '';
      void burst.getBoundingClientRect();
      if (!this.#reduced) burst.classList.add('burst--on');
      else burst.classList.add('burst--calm');
    }
    this.#dropMotes(voicing);
  }

  /**
   * The slow golden fall.
   *
   * DOM rather than SVG, and CSS keyframes rather than a per-frame write: a mote
   * is one composited node whose whole life is `transform` and `opacity`, so the
   * shower costs the main thread nothing after it is mounted. Removed on the next
   * `reset`, i.e. at the start of the next round.
   */
  #dropMotes(voicing: Voicing): void {
    const host = this.#motes;
    if (!host || this.#reduced) return;
    const count = voicing === 'ORDER' ? 26 : voicing === 'FORM' ? 16 : 9;
    const next = stream(0xc2b2ae35 + count);
    host.innerHTML = Array.from({ length: count }, () => {
      const x = next() * 100;
      const delay = next() * 0.9;
      const duration = 2.4 + next() * 1.9;
      const size = 2 + next() * 3.4;
      const drift = (next() * 2 - 1) * 26;
      return `<i style="left:${x.toFixed(1)}%;--size:${size.toFixed(1)}px;--drift:${drift.toFixed(
        0,
      )}px;animation-delay:${delay.toFixed(2)}s;animation-duration:${duration.toFixed(2)}s"></i>`;
    }).join('');
  }

  /* ---------------------------------------------------------------- stamp -- */

  setStamp(text: string, on: boolean): void {
    this.#stampText = text;
    this.#stampOn = on;
    if (!this.#stamp) return;
    const label = this.#stamp.querySelector('text');
    const plate = this.#stamp.querySelector<SVGRectElement>('.stamp__plate');
    const inner = this.#stamp.querySelector<SVGRectElement>('.stamp__inner');
    if (label) label.textContent = text;
    // The plate is sized to its content so SEVEN's four-figure multiple does not
    // spill out of a box drawn for three.
    const width = Math.max(144, text.length * 19 + 46);
    if (plate) {
      plate.setAttribute('x', String(-width / 2));
      plate.setAttribute('width', String(width));
    }
    if (inner) {
      inner.setAttribute('x', String(-width / 2 + 4));
      inner.setAttribute('width', String(width - 8));
    }
    this.#stamp.classList.toggle('stamp--on', on);
  }

}
