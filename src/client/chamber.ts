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
 * | fluid shader with a domain-warped caustic | two counter-drifting layers of soft elliptical gradients plus a caustic band stack inside the tube, all `transform`-animated |
 * | refraction resample of the sphere layer | the tube's front glass — wall bands, a cylinder shading pass, a meniscus at each end and a broad sheen that crosses every seated sphere (§6.2's glass read is "a 6 px inner edge gradient plus one thin highlight", never a full glass shader) |
 * | bloom via bright-pass + blur | an emissive bleed baked into each sphere's own gradient stack (`sphere.ts`), which is where §6.3 says bloom is allowed to touch and nowhere else |
 * | 256 point sprites | 22 closed-form bubbles in the chamber plus 10 inside the tube, CSS-keyframed, alive only through CHARGE and AGITATE |
 * | `pulses[8]` displacement | one expanding ring of light per lock plus §6.4's 2 px chamber flex, both `transform` and `opacity` |
 *
 * **No SVG filter appears anywhere in this file.** Every soft edge is a gradient
 * stop. That is not a stylistic preference: §7.1.1's rule is that during SETTLE
 * the chrome layer animates `transform` and `opacity` only, on pre-promoted
 * layers, because anything that invalidates raster is re-uploaded every frame. A
 * `feGaussianBlur` over the chamber rect would break that rule the first time
 * something moved underneath it.
 *
 * ## The chamber is drawn once, and every mode change is a transform
 *
 * Round 1 of the art pass redrew the whole instrument whenever the layout gave
 * the stage a different height — which is every mode change, twice a round. The
 * drawing snapped from about 470 to 625 CSS px inside one frame on the largest
 * element on screen, the multiplier stamp visibly slid as the result deck
 * mounted, and the measured layout shift was 0.176 per round against a 0.1
 * threshold. That is exactly the layout animation the frame budget forbids.
 *
 * So the geometry is now split into four groups by *how they must respond* when
 * the visible band changes, and the response is a `transform` on a pre-promoted
 * group in every case:
 *
 * | Group | Responds by | Why |
 * | --- | --- | --- |
 * | `.cham-stretch` | `scaleY` about the viewBox origin | the glass body, the liquid and the caustics are low-frequency fields; stretching them is what a taller vessel looks like |
 * | `.cham-top` | nothing | the top collar is machined steel at a fixed distance from the housing's top edge |
 * | `.cham-bottom` | `translateY` | so is the bottom collar, and the base plate's caustic sits on it |
 * | `.column` | `translateY` | the tube, the spheres, the rings and the stamp keep their published pitch and diameter at every height, and stay centred in whatever band is visible |
 *
 * `render()` therefore runs once per (variant, viewport) and `fit()` runs on
 * every layout change, writing three custom properties. Nothing is re-parsed,
 * no state is restored, the stamp never moves relative to the tube, and the
 * growth from S1 to S4 is one 320 ms transform.
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
 * least as tall as its tube plus both collars.
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
 * The headroom the shortest chamber keeps above and below the tube.
 *
 * 12 rather than a full collar's 28: on the 390 × 844 reference device the home
 * screen's stage is 442 CSS px and the tube plus both collars is 470, so demanding
 * clearance for the collars would put S1 permanently in the scale-down regime. The
 * bands overlap the tube's rim instead — which is what a tube passing *through* a
 * machined collar looks like, and the column is drawn over them.
 */
const COLLAR_CLEAR = 12;

/** One revolution per 1.6 s at full speed, in radians per second. */
const IMPELLER_OMEGA = (Math.PI * 2) / 1.6;

/** How long the prismatic burst runs. Mirrors `burst-open` in styles.css. */
const BURST_MS = 1400;

/**
 * The interval between one sphere's celebration pop and the next one's.
 *
 * 68 ms rather than §6.4's 420 ms settle stagger: the settle stagger is a
 * sequence of *decisions* and has to be read one at a time, and this is one
 * event running up a column that is already settled. Five spheres at 68 ms plus
 * the 620 ms pop is 892 ms — inside the 1,060 ms celebrated close plus the
 * 220 ms stamp (§9), so the column has finished celebrating when the beat ends.
 */
const POP_STAGGER_MS = 68;

/**
 * Where the spheres drift while the tube is empty: a lane (x) and a fraction of
 * the **tube's** vertical extent.
 *
 * The fractions are relative to the tube rather than to the chamber because the
 * tube is the one band guaranteed to be visible at every layout: `.column` is
 * centred in whatever the deck leaves, so a sphere parked at a fraction of the
 * *drawing* height would be clipped on the home screen and visible during the
 * round. Two lanes, inset far enough from the walls that turbulence has room to
 * swing both ways, and clear of both impellers in x.
 */
const DRIFT: readonly (readonly [number, number])[] = [
  [285, 0.14],
  [105, 0.56],
  [285, 0.32],
  [105, 0.74],
  [285, 0.5],
  [105, 0.86],
  [285, 0.66],
];

/**
 * The impellers, as fractions of the tube's extent (§6.9: diagonally opposed, off
 * the tube's axis, "so neither ever sits behind a sphere at rest").
 *
 * Top-left and bottom-right, which is what puts the resting spheres on the
 * opposite diagonal: the right lane holds the upper ones and the left lane the
 * lower ones, and the closest sphere-to-impeller centre distance is 98 units
 * against a 80-unit sum of radii in CLASSIC.
 */
const IMPELLER_AT: readonly (readonly [number, number])[] = [
  [72, 0.16],
  [318, 0.84],
];

export type Beat = 'idle' | 'charge' | 'agitate' | 'settle' | 'close' | 'done';

/**
 * The tier of the best line that won, which voices the celebration (§9).
 *
 * One definition, shared with the sound layer, because the picture and the audio
 * must be voiced by the same thing — §8 and §9 describe one ladder, not two.
 */
export type Voicing = WinVoicing;

/**
 * Keep a displacement inside a sphere's room, **without ever pinning it there**.
 *
 * A hard `min`/`max` is the obvious version and it is wrong for a fluid: the
 * amplitude §6.4's envelope asks for is larger than the headroom the sphere
 * nearest the top collar actually has, so a frame dump of the agitation caught
 * that sphere resting at exactly `-38.00 px` for consecutive frames — a body in
 * turbulent liquid stopped dead against an invisible ceiling, twice a beat.
 *
 * `tanh` is the same bound applied smoothly. Its slope at zero is 1, so the
 * published motion is untouched anywhere near the middle of the room; it bends
 * as it approaches the wall and asymptotes to it, so the sphere decelerates into
 * the boundary and turns around instead of sticking to it. Each side is scaled
 * by its own limit, because the room is asymmetric — the sphere with 38 px above
 * it has 250 px below.
 */
function bounded(value: number, low: number, high: number): number {
  if (value === 0) return 0;
  const limit = value > 0 ? high : -low;
  if (limit <= 0) return 0;
  return Math.sign(value) * limit * Math.tanh(Math.abs(value) / limit);
}

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
  /** The drawing's height in viewBox units — the reference box, not the crop. */
  #height = 486;
  /** The reference box in CSS pixels the drawing was sized for. */
  #box = 486;
  #tubeTop = 0;
  #tubeHeight = 0;
  #slots: number[] = [];
  #orbs = new Map<number, SVGGElement>();
  #orbY = new Map<number, SVGGElement>();
  #orbMotion = new Map<number, SVGGElement>();
  /** Per-sphere travel limits, so turbulence can never cross the machinery. */
  #bounds = new Map<number, readonly [number, number, number, number]>();
  #rings = new Map<number, SVGGElement>();
  #pulses = new Map<number, SVGGElement>();
  #numerals = new Map<number, SVGTextElement>();
  /** One rect per slot, filled at `celebrate` with the settled sphere's light. */
  #floods = new Map<number, SVGRectElement>();
  #impellers: SVGGElement[] = [];
  #tube: SVGGElement | null = null;
  #rim: SVGGElement | null = null;
  #burst: SVGGElement | null = null;
  #flash: SVGRectElement | null = null;
  #stamp: SVGGElement | null = null;
  #shock: SVGGElement | null = null;
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
  #won = false;
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
   * The chamber used to be redrawn whenever the space the layout gave it changed,
   * and one of those moments was the switch from S4 to S5 — about 220 ms after
   * the celebration starts. A shower owned by the chamber's `innerHTML` was
   * therefore deleted a fifth of a second into a three-second fall, every single
   * time. The redraw is gone now (see the header), and the container still
   * outlives it: the variant toggle and a rotation both still redraw.
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

  /** The reference box, in CSS pixels, this drawing was built for. */
  get box(): number {
    return this.#box;
  }

  /** The shortest chamber that still holds this variant's tube and both collars. */
  minHeight(variant: VariantInfo): number {
    return variant.n * variant.geometry.slotPitch + TUBE_RIM * 2 + COLLAR_CLEAR * 2;
  }

  /** Centre y of slot `k`, 1-indexed from the bottom of the tube. */
  slotY(k: number): number {
    return this.#slots[k - 1] ?? 0;
  }

  /* ----------------------------------------------------------------- draw -- */

  /**
   * Draw the chamber for a reference box `box` CSS pixels tall.
   *
   * The drawing is sized so its aspect ratio matches the holder exactly — the
   * holder is `box` tall and the full app width — which means the SVG scale is
   * `width / 390` with no letterbox in either axis, and one viewBox unit is one
   * device-independent pixel at the reference 390 px width.
   *
   * Called once per (variant, viewport). Everything the layout does after that
   * goes through `fit`.
   */
  render(variant: VariantInfo, box?: number): void {
    this.#variant = variant;
    mountOrbDefs(variant.elements);
    const { n } = variant;
    const pitch = variant.geometry.slotPitch;
    const diameter = variant.geometry.sphereDiameter;
    const tubeHeight = n * pitch + TUBE_RIM * 2;
    const floor = this.minHeight(variant);
    const scale = (this.#root.clientWidth || WIDTH) / WIDTH;
    const wanted = box === undefined ? floor : box / (scale || 1);
    // A ceiling as well as a floor: the game is portrait-only (§5) and a desktop
    // window it was not designed for should not turn the instrument into an
    // arbitrarily tall column.
    const height = Math.round(Math.min(floor * 1.95, Math.max(floor, wanted)));
    this.#height = height;
    this.#box = box === undefined ? Math.round(height * scale) : box;
    this.#tubeHeight = tubeHeight;
    // The holder is given the drawing's exact aspect so the SVG's `meet` fit has
    // no letterbox in either axis and one viewBox unit is one CSS pixel at the
    // reference 390 px width. The stage's `overflow: hidden` supplies the crop.
    this.#root.style.height = `${(height * (scale || 1)).toFixed(2)}px`;

    const glassTop = 8;
    const glassHeight = height - 16;
    const tubeTop = Math.round((height - tubeHeight) / 2);
    const tubeBottom = tubeTop + tubeHeight;
    this.#tubeTop = tubeTop;
    this.#slots = Array.from(
      { length: n },
      (_unused, index) => tubeBottom - TUBE_RIM - (index + 0.5) * pitch,
    );

    this.#root.innerHTML = `
      <svg class="chamber" viewBox="0 0 ${WIDTH} ${height}" preserveAspectRatio="xMidYMid meet" data-beat="idle" role="img" aria-label="Chamber with ${n} spheres and a ${n}-slot tube">
        <defs>${this.#defs(height, glassTop, glassHeight, tubeTop, tubeHeight, pitch)}</defs>
        <rect x="0" y="0" width="${WIDTH}" height="${height}" fill="var(--void)"/>
        <g class="cham-fit">
          <g class="cham-stretch">
            <g clip-path="url(#glass-clip)">
              <!-- The back plate: --abyss, so the liquid has something behind it. -->
              <rect x="16" y="${glassTop}" width="${WIDTH - 32}" height="${glassHeight}" fill="var(--abyss)"/>
              <rect class="liquid" x="16" y="${glassTop}" width="${
                WIDTH - 32
              }" height="${glassHeight}" fill="url(#brine)"/>
              ${this.#lightShaft(height)}
              ${this.#caustics(height)}
              ${this.#bubbles(height)}
              <!-- CHARGE deepens the liquid tint 8% (§6.4). Opacity, nothing else. -->
              <rect class="tint" x="16" y="${glassTop}" width="${
                WIDTH - 32
              }" height="${glassHeight}" fill="var(--brine-deep)"/>
              <!--
                The vignette, and it is §6.1's first sentence rather than a mood:
                "the whole world is neutral so the spheres are the only colour",
                with one faint volumetric key from above. Without it 358 px of
                mid-brine reads as a flat lit box and the objects inside it stop
                being the brightest thing in the frame.
              -->
              <rect class="vignette" x="16" y="${glassTop}" width="${
                WIDTH - 32
              }" height="${glassHeight}" fill="url(#vignette)"/>
            </g>
            <!--
              The cylinder read, and the last thing over the liquid: a 1 px edge
              tint plus §6.2's 6 px inner edge gradient, bright at both walls and
              empty in the middle. That gradient is what makes 358 px of flat
              rectangle read as borosilicate rather than as a box.
            -->
            <rect x="16" y="${glassTop}" width="${
              WIDTH - 32
            }" height="${glassHeight}" rx="24" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.55" stroke-width="1"/>
            <rect x="19" y="${glassTop + 3}" width="${WIDTH - 38}" height="${
              glassHeight - 6
            }" rx="21" fill="none" stroke="url(#glass-wall)" stroke-width="6"/>
          </g>
          <!--
            The machinery. It rides the column's translate and NOT the body's
            scaleY — an impeller inside .cham-stretch is a circle squashed to
            an ellipse at every layout but the tallest, which is what the first
            frame dump of this rebuild showed. It sits over the liquid and under
            the collars and the tube, so the collar lip still crosses in front of
            it and it still reads as silhouette and motion (§6.9).
          -->
          <g class="column-bg">
            <g clip-path="url(#glass-clip)">
              ${IMPELLER_AT.map(([cx, fraction]) =>
                this.#impeller(cx, Math.round(tubeTop + fraction * tubeHeight)),
              ).join('')}
            </g>
          </g>
          <g class="cham-top">${this.#collar(glassTop, 'top')}</g>
          <g class="cham-bottom">
            ${this.#collar(height - glassTop - COLLAR, 'bottom')}
            <g class="floor-caustic-at" transform="translate(${CENTRE_X},${
              height - glassTop - COLLAR - 12
            })">
              <ellipse class="floor-caustic" rx="152" ry="30" fill="url(#floor-caustic)"/>
            </g>
          </g>
          <g class="column">
            <!--
              §6.9's one specular line: 1 px --specular at x = 135, from the top
              collar to 60% depth. §6.6 reference 1 calls this the whole glass
              read; everything else in the chamber is gradient. The stroke is a
              gradient that fades to zero at its lower end — at a flat 0.42 it
              terminated hard in mid-air over the back plate and read as a
              leftover guide rather than as glass.
            -->
            <line x1="135" y1="${tubeTop - 24}" x2="135" y2="${
              tubeTop + tubeHeight * 0.62
            }" stroke="url(#specular-fade)" stroke-width="1"/>
            <!--
              The burst is BEHIND the tube, and that is the same argument the
              stamp's placement makes.

              Drawn over the column it threw eighteen wedges at 95% and a 142-unit
              core straight across the settled spheres, and a frame dump of the
              hero moment of a win showed slots 3 and 4 washed to pale discs with
              their etched glyphs gone. §11 is unconditional that the glyph *is*
              the colour-blind channel — "a build that drops a glyph has dropped
              the channel, not a decoration" — and the celebration is the one
              moment that may not take the record of the round away (§5 S5).
              Behind the column the same light reads as light thrown *through*
              the chamber, which is what §9 asks for and what a prism actually
              does; the tube is 96 units of 390, so the wedges lose nothing.
            -->
            ${this.#burstMarkup(tubeTop, tubeHeight)}
            <g class="tube" data-tube>
              ${this.#tubeBack(tubeTop, tubeHeight, pitch)}
              ${this.#lockRings(pitch)}
              ${this.#spheres(variant, tubeTop, tubeHeight, diameter)}
              ${this.#tubeGlass(tubeTop, tubeHeight)}
              <g class="tube-rim">
                <rect class="tube-rim__bloom" x="${TUBE_X - 14}" y="${tubeTop - 14}" width="${
                  TUBE_WIDTH + 28
                }" height="${tubeHeight + 28}" rx="20" fill="url(#rim-bloom)"/>
                <rect class="tube-rim__line" x="${TUBE_X - 2}" y="${tubeTop - 2}" width="${
                  TUBE_WIDTH + 4
                }" height="${tubeHeight + 4}" rx="10" fill="none" stroke="url(#rim-gold)" stroke-width="3"/>
              </g>
              ${this.#lockPulses(pitch)}
            </g>
            ${this.#stampMarkup(pitch, diameter)}
          </g>
          <!--
            The celebrated close's full-frame lift. One rect, one opacity
            keyframe, behind "celebrate" like everything else in §9.
          -->
          <rect class="cham-flash" x="0" y="0" width="${WIDTH}" height="${height}" fill="url(#flash)" opacity="0"/>
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
    this.#floods = new Map();
    const radius = diameter / 2;
    /*
     * The travel window, in column-local units.
     *
     * `.column` is translated so the tube is centred in whatever band the deck
     * leaves, and the narrowest band the layout can produce is the tube plus
     * `COLLAR_CLEAR` at each end. So a sphere that stays inside that window is
     * on screen at every mode — which is the property round 1's chamber-fraction
     * positions did not have, because they were expressed against a drawing
     * height that changed underneath them.
     */
    const safeTop = tubeTop - COLLAR_CLEAR + radius;
    const safeBottom = tubeTop + tubeHeight + COLLAR_CLEAR - radius;
    for (const node of this.#root.querySelectorAll<SVGGElement>('.orb')) {
      const index = Number(node.dataset.element);
      this.#orbs.set(index, node);
      this.#orbY.set(index, node.querySelector('.orb__y') as SVGGElement);
      this.#orbMotion.set(index, node.querySelector('.orb__m') as SVGGElement);
      const [baseX, fraction] = DRIFT[index] ?? [CENTRE_X, 0.5];
      const baseY = Math.round(tubeTop + fraction * tubeHeight);
      this.#bounds.set(index, [
        18 + radius - baseX,
        WIDTH - 18 - radius - baseX,
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
    for (const node of this.#root.querySelectorAll<SVGRectElement>('.cell-flood'))
      this.#floods.set(Number(node.dataset.slot), node);
    this.#impellers = [...this.#root.querySelectorAll<SVGGElement>('.impeller')];
    this.#tube = this.#root.querySelector('[data-tube]');
    this.#rim = this.#root.querySelector('.tube-rim');
    this.#burst = this.#root.querySelector('.burst');
    this.#flash = this.#root.querySelector('.cham-flash');
    this.#stamp = this.#root.querySelector('.stamp');
    this.#shock = this.#root.querySelector('.stamp-shock');

    this.#restore();
    this.fit(this.#visibleCss);
  }

  /* ------------------------------------------------------------------ fit -- */

  #visibleCss = 0;

  /**
   * Tell the chamber how much of it the layout is actually showing.
   *
   * `visible` is the stage's height in CSS pixels. Everything this method does is
   * three custom properties consumed by `transform`s in styles.css, so a mode
   * change costs no parse, no raster and no layout — which is the whole point
   * (see the header). It is safe to call on every frame of a resize.
   */
  fit(visible: number): void {
    const svg = this.#svg;
    if (!svg || visible <= 0) return;
    this.#visibleCss = visible;
    const scale = (this.#root.clientWidth || WIDTH) / WIDTH;
    const units = visible / (scale || 1);
    // The body may never be shorter than the tube plus both collars, so below
    // that the whole drawing scales down instead — the one regime where the
    // instrument becomes a thumbnail, and it is only reachable at very large
    // text scales on a short screen.
    const need = this.#tubeHeight + COLLAR_CLEAR * 2;
    const band = Math.max(need, Math.min(this.#height, units));
    const fit = Math.min(1, units / band);
    svg.style.setProperty('--k', (band / this.#height).toFixed(4));
    svg.style.setProperty('--dy-bot', `${(band - this.#height).toFixed(1)}px`);
    svg.style.setProperty('--dy-col', `${((band - this.#height) / 2).toFixed(1)}px`);
    svg.style.setProperty('--fit', fit.toFixed(4));
  }

  /* --------------------------------------------------------------- pieces -- */

  #defs(
    height: number,
    glassTop: number,
    glassHeight: number,
    tubeTop: number,
    tubeHeight: number,
    pitch: number,
  ): string {
    const wedges = (this.#variant?.elements ?? [])
      .map(
        (element) => `
      <!--
        A beam, not a spike: offset 0 is the wide base at the centre of the
        burst and offset 1 is the tip, so the wedge is quiet where it crosses
        the tube, swells just outside it, and fades to nothing at its point. A
        flat 0.95 at the base is what made the burst a solid star sitting on the
        settled column.
      -->
      <linearGradient id="wedge-${element.id}" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="${element.hex}" stop-opacity="0.34"/>
        <stop offset="0.17" stop-color="${element.hex}" stop-opacity="0.9"/>
        <stop offset="0.46" stop-color="${element.hex}" stop-opacity="0.42"/>
        <stop offset="0.78" stop-color="${element.hex}" stop-opacity="0.12"/>
        <stop offset="1" stop-color="${element.hex}" stop-opacity="0"/>
      </linearGradient>`,
      )
      .join('');
    return `
      <!--
        The liquid, and the argument that settled where its stops go.

        §6.1 scopes --brine-lit to "liquid where the key light PASSES", which is a
        band and not half the vessel — so round 2 weighted the ramp hard, holding
        --brine-deep flat for the bottom 58% and reaching --brine-lit only in the
        last 13%. That over-corrected: five sixths of the instrument became one
        dark slate value and the frame measured 66% near-black, which is not "the
        spheres are the only colour" but "the lights are off". §6.2 states three
        stops and the shipped gradient is now the three stops, spread across the
        depth. What keeps the spheres the brightest objects in the frame is the
        vignette drawn over this, which is the right tool for it — the liquid's
        own darkness never was.
      -->
      <linearGradient id="brine" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="var(--brine-deep)"/>
        <stop offset="0.44" stop-color="var(--brine)"/>
        <stop offset="0.86" stop-color="var(--brine-lit)"/>
        <stop offset="1" stop-color="var(--brine-lit)"/>
      </linearGradient>
      <!-- §6.2: brushed 316 steel, anisotropic highlight running horizontally. -->
      <linearGradient id="collar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--chrome-dark)"/>
        <stop offset="0.28" stop-color="var(--chrome)"/>
        <stop offset="0.5" stop-color="var(--chrome-mid)"/>
        <stop offset="0.78" stop-color="var(--chrome-dark)"/>
        <stop offset="1" stop-color="var(--void)"/>
      </linearGradient>
      <linearGradient id="collar-grain" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--void)" stop-opacity="0.5"/>
        <stop offset="0.22" stop-color="var(--specular)" stop-opacity="0.18"/>
        <stop offset="0.5" stop-color="var(--void)" stop-opacity="0.3"/>
        <stop offset="0.78" stop-color="var(--specular)" stop-opacity="0.13"/>
        <stop offset="1" stop-color="var(--void)" stop-opacity="0.5"/>
      </linearGradient>
      <!-- The cylinder: bright at both walls, nothing in the middle (§6.2). -->
      <linearGradient id="glass-wall" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.8"/>
        <stop offset="0.13" stop-color="var(--glass-edge)" stop-opacity="0.05"/>
        <stop offset="0.87" stop-color="var(--glass-edge)" stop-opacity="0.05"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0.66"/>
      </linearGradient>
      <!--
        §6.9's specular line, as a stroke that fades out rather than stopping.
        The coordinates are the spec's; the flat opacity was what made it read as
        a stray guide terminating in mid-air over the back plate.
      -->
      <linearGradient id="specular-fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0"/>
        <stop offset="0.12" stop-color="var(--specular)" stop-opacity="0.55"/>
        <stop offset="0.6" stop-color="var(--specular)" stop-opacity="0.22"/>
        <stop offset="1" stop-color="var(--specular)" stop-opacity="0"/>
      </linearGradient>
      <!--
        Volumetric key from above, so the chamber is the only bright object.
        §6.3 gives the key intensity 1.0; at 20% of --specular it was a haze
        rather than a source, and a laboratory whose light you cannot see is a
        laboratory with the lights off.
      -->
      <radialGradient id="shaft">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0.34"/>
        <stop offset="0.4" stop-color="var(--glass-edge)" stop-opacity="0.15"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="caustic">
        <stop offset="0" stop-color="var(--brine-lit)" stop-opacity="0.95"/>
        <stop offset="0.55" stop-color="var(--brine-lit)" stop-opacity="0.38"/>
        <stop offset="1" stop-color="var(--brine-lit)" stop-opacity="0"/>
      </radialGradient>
      <!-- Corners fall to the void, so the light reads as one source from above. -->
      <radialGradient id="vignette" cx="0.5" cy="0.26" r="0.82">
        <stop offset="0" stop-color="var(--void)" stop-opacity="0"/>
        <stop offset="0.4" stop-color="var(--void)" stop-opacity="0.2"/>
        <stop offset="0.72" stop-color="var(--void)" stop-opacity="0.62"/>
        <stop offset="1" stop-color="var(--void)" stop-opacity="0.9"/>
      </radialGradient>
      <radialGradient id="floor-caustic">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.34"/>
        <stop offset="0.6" stop-color="var(--glass-edge)" stop-opacity="0.1"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0"/>
      </radialGradient>
      <!--
        The liquid column inside the tube, which round 1 drew as --void at 30
        to 72% over the brine — a back plate that measured a constant
        rgb(14,29,44) with no surface, no bubbles and no caustic in it. It is a
        lit column of brine now, because the tube is where the key light is
        channelled and it is the one part of the frame the player reads.

        Its stops sit higher than the chamber's for a reason that only appeared
        once the chamber's own liquid was spread across its depth: the column
        carries three darkening overlays for the cylinder read, so at the same
        stops it became a shadow running down the middle of a lit box — the hero
        object as the darkest band in the frame, which inverts the hierarchy the
        whole instrument is built on.
      -->
      <linearGradient id="tube-column" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="var(--brine)"/>
        <stop offset="0.3" stop-color="var(--brine-lit)"/>
        <stop offset="1" stop-color="var(--brine-lit)"/>
      </linearGradient>
      <!-- Cylinder shading: the column is round, so it darkens at both walls. -->
      <linearGradient id="tube-round" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--void)" stop-opacity="0.72"/>
        <stop offset="0.18" stop-color="var(--void)" stop-opacity="0.24"/>
        <stop offset="0.4" stop-color="var(--specular)" stop-opacity="0.07"/>
        <stop offset="0.7" stop-color="var(--void)" stop-opacity="0.16"/>
        <stop offset="1" stop-color="var(--void)" stop-opacity="0.66"/>
      </linearGradient>
      <linearGradient id="tube-caustic" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0"/>
        <stop offset="0.5" stop-color="var(--glass-edge)" stop-opacity="0.5"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0"/>
      </linearGradient>
      <!--
        The tube's front glass, and the DOM lane's stand-in for §7 technique 2's
        refraction resample: a wall band whose gradient runs bright → dark →
        bright compresses whatever sits behind it toward the wall, which is what
        the eye reads as thickness.
      -->
      <linearGradient id="tube-wall-l" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.6"/>
        <stop offset="0.55" stop-color="var(--void)" stop-opacity="0.45"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0.14"/>
      </linearGradient>
      <linearGradient id="tube-wall-r" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--glass-edge)" stop-opacity="0.1"/>
        <stop offset="0.4" stop-color="var(--void)" stop-opacity="0.45"/>
        <stop offset="1" stop-color="var(--glass-edge)" stop-opacity="0.7"/>
      </linearGradient>
      <linearGradient id="tube-sheen" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0.2"/>
        <stop offset="0.6" stop-color="var(--specular)" stop-opacity="0.04"/>
        <stop offset="1" stop-color="var(--specular)" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="rim-gold" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="var(--gold-hot)"/>
        <stop offset="0.5" stop-color="var(--gold)"/>
        <stop offset="1" stop-color="var(--gold-hot)"/>
      </linearGradient>
      <linearGradient id="rim-bloom" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--gold)" stop-opacity="0"/>
        <stop offset="0.14" stop-color="var(--gold)" stop-opacity="0.3"/>
        <stop offset="0.5" stop-color="var(--gold-hot)" stop-opacity="0.1"/>
        <stop offset="0.86" stop-color="var(--gold)" stop-opacity="0.3"/>
        <stop offset="1" stop-color="var(--gold)" stop-opacity="0"/>
      </linearGradient>
      <!-- Brushed machinery: light from above-left, shadow below-right (§6.3). -->
      <linearGradient id="impeller-metal" x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stop-color="var(--chrome)"/>
        <stop offset="0.42" stop-color="var(--chrome-mid)"/>
        <stop offset="1" stop-color="var(--chrome-dark)"/>
      </linearGradient>
      <linearGradient id="impeller-vane" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="var(--chrome)"/>
        <stop offset="0.5" stop-color="var(--chrome-mid)"/>
        <stop offset="1" stop-color="var(--chrome-dark)"/>
      </linearGradient>
      <radialGradient id="impeller-hub" cx="0.36" cy="0.3" r="0.72">
        <stop offset="0" stop-color="var(--chrome)"/>
        <stop offset="0.6" stop-color="var(--chrome-mid)"/>
        <stop offset="1" stop-color="var(--chrome-dark)"/>
      </radialGradient>
      <!-- The stamp: PVD gold, warm, low roughness, one thin specular (§6.2). -->
      <linearGradient id="stamp-face" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--gold-hot)"/>
        <stop offset="0.4" stop-color="var(--gold)"/>
        <stop offset="0.62" stop-color="#8f7133"/>
        <stop offset="1" stop-color="var(--gold)"/>
      </linearGradient>
      <linearGradient id="stamp-well" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0b0f18"/>
        <stop offset="0.55" stop-color="#181f2e"/>
        <stop offset="1" stop-color="#0b0f18"/>
      </linearGradient>
      <linearGradient id="stamp-shine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0"/>
        <stop offset="0.45" stop-color="var(--specular)" stop-opacity="0.5"/>
        <stop offset="0.55" stop-color="var(--specular)" stop-opacity="0.5"/>
        <stop offset="1" stop-color="var(--specular)" stop-opacity="0"/>
      </linearGradient>
      <radialGradient id="stamp-glow">
        <stop offset="0" stop-color="var(--gold-hot)" stop-opacity="0.42"/>
        <stop offset="0.45" stop-color="var(--gold)" stop-opacity="0.16"/>
        <stop offset="1" stop-color="var(--gold)" stop-opacity="0"/>
      </radialGradient>
      <!--
        The frame lift, and it is a **ring** rather than a disc.
        A radial centred on the drawing is centred on the tube, so round 1's
        version put its hottest gold exactly where the five settled spheres are:
        measured at the peak of a win, the tube's cells read rgb(137,115,88) —
        khaki — because a gold wash over saturated colour is a desaturation of
        it. The centre is clear to 0.3 of the box, which is 58 units against the
        tube's 48-unit half-width, so the column keeps its own light and the
        chamber around it is what lifts.
      -->
      <radialGradient id="flash">
        <stop offset="0" stop-color="var(--gold-hot)" stop-opacity="0"/>
        <stop offset="0.3" stop-color="var(--gold-hot)" stop-opacity="0.1"/>
        <stop offset="0.62" stop-color="var(--gold)" stop-opacity="0.3"/>
        <stop offset="1" stop-color="var(--gold)" stop-opacity="0.08"/>
      </radialGradient>
      <!--
        The core is deliberately small and not very bright. The burst's job is to
        throw light *through* the chamber, and a big hot centre washes out the
        settled column underneath it — which is the record of the round (§5 S5)
        and the one thing a celebration may not take away.
      -->
      <radialGradient id="burst-core">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0.66"/>
        <stop offset="0.28" stop-color="var(--gold-hot)" stop-opacity="0.3"/>
        <stop offset="1" stop-color="var(--gold)" stop-opacity="0"/>
      </radialGradient>
      ${wedges}
      <clipPath id="glass-clip">
        <rect x="16" y="${glassTop}" width="${WIDTH - 32}" height="${glassHeight}" rx="24"/>
      </clipPath>
      <clipPath id="tube-clip">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8"/>
      </clipPath>
      <clipPath id="stamp-clip">
        <rect x="-150" y="${-Math.round(pitch / 2)}" width="300" height="${pitch}" rx="8"/>
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
  #lightShaft(height: number): string {
    return `<ellipse class="shaft" cx="${CENTRE_X - 18}" cy="${
      8 + COLLAR
    }" rx="188" ry="${Math.round(height * 0.62)}" fill="url(#shaft)"/>`;
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
  #caustics(height: number): string {
    const next = stream(0x9e3779b9);
    const blob = (layer: number): string => {
      const cx = 30 + next() * 330;
      const cy = next() * height;
      const rx = 44 + next() * 74;
      const ry = 16 + next() * 30;
      return `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(
        0,
      )}" ry="${ry.toFixed(0)}" fill="url(#caustic)" opacity="${(0.16 + layer * 0.06).toFixed(2)}"/>`;
    };
    const layerA = Array.from({ length: 6 }, () => blob(0)).join('');
    const layerB = Array.from({ length: 5 }, () => blob(1)).join('');
    /*
     * The churn wrapper is why the beat named "THE CHAMBER AGITATES" now looks
     * like something is happening to the *liquid* and not only to the spheres.
     * It is a second element carrying a second, faster keyframe, so the 19 s
     * ambient drift underneath it never has to change duration mid-flight — an
     * `animation-duration` swap on a running animation jumps, which is the one
     * thing a fluid may not do.
     */
    return `
      <g class="caustic-churn">
        <g class="caustic caustic--a">${layerA}</g>
        <g class="caustic caustic--b">${layerB}</g>
      </g>`;
  }

  /**
   * §7 technique 4's bubbles, at DOM scale: closed-form, deterministic, and
   * alive only through CHARGE and AGITATE. 22 rather than 256 because each one
   * here is a composited node instead of a point sprite.
   */
  #bubbles(height: number): string {
    const next = stream(0x85ebca6b);
    const cells = Array.from({ length: 22 }, () => {
      const x = 26 + next() * 338;
      const size = 1.4 + next() * 2.8;
      const delay = next() * 1.1;
      const duration = 1.5 + next() * 1.6;
      const rise = height * (0.45 + next() * 0.5);
      return `<circle cx="${x.toFixed(0)}" cy="${(height - COLLAR - 12).toFixed(
        0,
      )}" r="${size.toFixed(1)}" fill="var(--glass-edge)" style="--rise:${-rise.toFixed(
        0,
      )}px;animation-delay:${delay.toFixed(2)}s;animation-duration:${duration.toFixed(2)}s"/>`;
    }).join('');
    return `<g class="bubbles">${cells}</g>`;
  }

  /**
   * One collar band, as a path so only the two corners that meet the housing's
   * shell are rounded.
   *
   * It is a path rather than a rect inside the glass clip because the collars sit
   * *outside* `.cham-stretch`: machined steel does not change height when the
   * vessel does, so the bands translate while the body scales (see the header).
   */
  #collar(y: number, side: 'top' | 'bottom'): string {
    const left = 16;
    const right = WIDTH - 16;
    const r = 24;
    const body =
      side === 'top'
        ? `M${left + r} ${y} H${right - r} A${r} ${r} 0 0 1 ${right} ${y + r} V${y + COLLAR} H${left} V${
            y + r
          } A${r} ${r} 0 0 1 ${left + r} ${y} Z`
        : `M${left} ${y} H${right} V${y + COLLAR - r} A${r} ${r} 0 0 1 ${right - r} ${
            y + COLLAR
          } H${left + r} A${r} ${r} 0 0 1 ${left} ${y + COLLAR - r} Z`;
    const lip = side === 'top' ? y + COLLAR - 0.5 : y + 0.5;
    const sheen = side === 'top' ? y + 0.5 : y + COLLAR - 0.5;
    return `
      <g class="collar">
        <path d="${body}" fill="url(#collar)" opacity="0.95"/>
        <path d="${body}" fill="url(#collar-grain)" opacity="0.4"/>
        <line x1="${left}" y1="${sheen}" x2="${right}" y2="${sheen}" stroke="var(--specular)" stroke-width="1" opacity="0.3"/>
        <line x1="${left}" y1="${lip}" x2="${right}" y2="${lip}" stroke="var(--void)" stroke-width="1" opacity="0.6"/>
      </g>`;
  }

  /**
   * The tube behind the spheres: a lit liquid column, the slot divisions, the
   * caustic bands, the rising bubbles and the numerals.
   */
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
          }" y2="${line + 1}" stroke="var(--glass-edge)" stroke-opacity="0.5" stroke-width="1"/>`;
      })
      .join('');
    // §11: a boundary the player needs to perceive clears 3:1 against the
    // surface it sits on, achieved with --glass-edge rather than with the fill.
    // An engraved pair — one dark line, one light — reads at a distance where a
    // single hairline at 28% did not.
    const numerals = this.#slots
      .map(
        (y, index) =>
          // x = TUBE_X + 8, not + 13: a 64 px sphere centred at 195 spans
          // 163..227, so a numeral set at 160 had its digit clipped by the
          // sphere's left edge the moment its slot filled.
          // `currentColor`, so the unlit-to-lit step is a COLOUR change rather
          // than an opacity one. A foreground dimmed by opacity is exactly the
          // mechanism that shipped a dead ticket line at 2.08:1 in round 1 and
          // the picker's slot numerals at 2.9:1 in round 2, and
          // `tests/client.test.mjs` now fails the build on any text that does it.
          `<text class="slot-no" data-slot="${index + 1}" x="${TUBE_X + 8}" y="${
            y + 4
          }" fill="currentColor">${index + 1}</text>`,
      )
      .join('');
    // Three caustic bands drifting up the column, on the same 19 s period as the
    // chamber's own field so the two never desync (§6.3).
    const bands = [0.22, 0.54, 0.83]
      .map(
        (fraction, index) =>
          `<rect class="tube-caustic tube-caustic--${index}" x="${TUBE_X + TUBE_WALL}" y="${(
            tubeTop +
            tubeHeight * fraction
          ).toFixed(0)}" width="${TUBE_WIDTH - TUBE_WALL * 2}" height="${
            14 + index * 5
          }" fill="url(#tube-caustic)"/>`,
      )
      .join('');
    const next = stream(0x27d4eb2f);
    const fizz = Array.from({ length: 10 }, () => {
      const x = TUBE_X + TUBE_WALL + 4 + next() * (TUBE_WIDTH - TUBE_WALL * 2 - 8);
      const size = 1 + next() * 1.8;
      const delay = next() * 1.4;
      const duration = 1.7 + next() * 1.5;
      const rise = tubeHeight * (0.5 + next() * 0.5);
      return `<circle cx="${x.toFixed(0)}" cy="${(tubeTop + tubeHeight - 14).toFixed(
        0,
      )}" r="${size.toFixed(1)}" fill="var(--specular)" style="--rise:${-rise.toFixed(
        0,
      )}px;animation-delay:${delay.toFixed(2)}s;animation-duration:${duration.toFixed(2)}s"/>`;
    }).join('');
    /*
     * The cells the celebration floods.
     *
     * Round 1's celebrated close washed the whole frame with one gold radial
     * centred on the tube, so the settled column measured rgb(137,115,88) —
     * khaki — at the peak of its own win: the five objects carrying all the
     * colour in the product were the one thing the celebration desaturated. This
     * is the honest version. Each cell is filled, at `celebrate`, with the bloom
     * gradient of the sphere that settled *into that cell*, so the liquid takes
     * the colour of the object rather than the colour of the party, and the tube
     * ends the round lit by what landed in it.
     *
     * Empty and unfilled until then: `fill` is `none` and `opacity` is 0, so a
     * losing round never touches them and the neutral close is byte-identical
     * (§9's no-near-miss rule).
     */
    const floods = this.#slots
      .map(
        (y, index) =>
          `<rect class="cell-flood" data-slot="${index + 1}" x="${TUBE_X}" y="${(
            y -
            pitch / 2
          ).toFixed(1)}" width="${TUBE_WIDTH}" height="${pitch.toFixed(1)}" fill="none"/>`,
      )
      .join('');
    return `
      <g class="tube-well" clip-path="url(#tube-clip)">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" fill="url(#tube-column)"/>
        <g class="tube-bands">${bands}</g>
        <g class="cell-floods">${floods}</g>
        ${engraved}
        <g class="bubbles bubbles--tube">${fizz}</g>
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" fill="url(#tube-round)"/>
        <!--
          The liquid surface. §6.6 reference 1: the meniscus bends the far edge of
          the column into a single thin bright line, and that line is the whole
          glass read.
        -->
        <path d="M${TUBE_X} ${tubeTop + 15} Q${CENTRE_X} ${tubeTop + 3} ${
          TUBE_X + TUBE_WIDTH
        } ${tubeTop + 15}" fill="none" stroke="var(--specular)" stroke-opacity="0.5" stroke-width="1.5"/>
        <path d="M${TUBE_X} ${tubeTop + 19} Q${CENTRE_X} ${tubeTop + 8} ${
          TUBE_X + TUBE_WIDTH
        } ${tubeTop + 19}" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.28" stroke-width="3"/>
      </g>
      ${numerals}`;
  }

  /**
   * The tube's front glass — drawn *over* the spheres on purpose.
   *
   * A seated sphere seen through a wall band and a sheen is a sphere inside a
   * tube; the same sphere drawn on top of the glass is a sticker. This is the
   * cheapest honest version of §6.2's glass: a 6 px inner edge gradient at each
   * wall, one broad soft sheen, and a meniscus arc at the foot, which §6.6
   * reference 1 identifies as the one line that carries the whole glass read.
   */
  #tubeGlass(tubeTop: number, tubeHeight: number): string {
    const bottom = tubeTop + tubeHeight;
    return `
      <g class="tube-glass" clip-path="url(#tube-clip)">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WALL}" height="${tubeHeight}" fill="url(#tube-wall-l)"/>
        <rect x="${TUBE_X + TUBE_WIDTH - TUBE_WALL}" y="${tubeTop}" width="${TUBE_WALL}" height="${tubeHeight}" fill="url(#tube-wall-r)"/>
        <rect x="${TUBE_X + TUBE_WALL}" y="${tubeTop}" width="26" height="${tubeHeight}" fill="url(#tube-sheen)"/>
        <path d="M${TUBE_X + 2} ${bottom - 9} Q${CENTRE_X} ${bottom - 20} ${
          TUBE_X + TUBE_WIDTH - 2
        } ${bottom - 9}" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.34" stroke-width="1"/>
      </g>
      <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8" fill="none" stroke="var(--glass-edge)" stroke-opacity="0.5" stroke-width="1"/>`;
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
            <ellipse class="pulse__wide" rx="${TUBE_WIDTH / 2 + 22}" ry="${(pitch / 2 + 10).toFixed(
              1,
            )}" fill="none" stroke="var(--gold)" stroke-width="6" stroke-opacity="0.28"/>
          </g>
        </g>`,
      )
      .join('');
  }

  /**
   * The spheres, and the four nested transforms each one needs.
   *
   * `.orb` carries x, `.orb__y` carries y, `.orb__m` carries motion — the idle
   * drift as a CSS keyframe, the agitation as a per-frame write from the shared
   * ticker — and `.orb__pop` carries the celebration. They are separate elements
   * because x and y are *different eases*: §6.4's 340 ms expo-out belongs to the
   * fall, and a sphere that traverses horizontally on the same curve slides
   * rather than swoops. Splitting them buys the arc — across, then down — inside
   * the beat's published duration, with the vertical curve exactly as published.
   *
   * `.orb__pop` is its own group and not a fifth job for `.orb__m` because
   * `.orb__m` is written every frame during AGITATE: a class-driven keyframe on
   * an element whose `style.transform` is also being set from JavaScript is a
   * fight, and the frame the fight is lost on is the hero frame of the round.
   *
   * **The anchor circle is why the pop is stable.** `transform-box: fill-box`
   * resolves `transform-origin: center` against the group's own bounding box,
   * and this group's box would otherwise be defined by children that are
   * themselves animating — the emissive bleed scales to 1.55 on a win, the
   * interior caustic translates on a loop — so the origin would drift with the
   * animation it is the origin of. One invisible circle, larger than anything
   * inside it and centred on the sphere, pins the box to a constant square: the
   * sphere scales about its own centre, exactly, in every frame.
   */
  #spheres(
    variant: VariantInfo,
    tubeTop: number,
    tubeHeight: number,
    diameter: number,
  ): string {
    const anchor = (diameter * 2.3).toFixed(0);
    return variant.elements
      .map((element: ElementInfo, index: number) => {
        const [x, fraction] = DRIFT[index] ?? [CENTRE_X, 0.5];
        const y = Math.round(tubeTop + fraction * tubeHeight);
        return `<g class="orb" data-element="${index}" style="transform:translateX(${x}px)">
          <g class="orb__y" style="transform:translateY(${y}px)">
            <g class="orb__m" style="animation-delay:${(index * -1.7).toFixed(1)}s">
              <g class="orb__pop">
                <circle class="orb__anchor" r="${anchor}" fill="none"/>
                ${orbArt(element, diameter / 2)}
              </g>
            </g>
          </g>
        </g>`;
      })
      .join('');
  }

  /**
   * Five 18 px vanes at 72°, tapering from 6 px at the hub to 2 px at the rim.
   * Five, not seven, in both variants: it is machinery, not a counter, and a
   * five-vane wheel at 3.2 Hz never appears to stand still under the settle
   * cadence the way a seven-vane one does at 360 ms (§6.9).
   *
   * Round 1 drew the vanes as uniform-width rounded bars floating in the annulus
   * with a gap between the hub and each vane's inner end, all of it at 26 to 42%
   * opacity on 3 px strokes — so the pair read as Illustrator guides or a loading
   * spinner rather than as machinery. They are shaded quads bolted to the hub
   * now, the ring has a lit face and a shadow side, and §6.9 was amended to
   * describe the object rather than the wireframe.
   *
   * The rotation lives on an INNER group so the per-frame transform cannot
   * overwrite the placement (see the file header).
   */
  #impeller(cx: number, cy: number): string {
    const hub = 11;
    const rim = IMPELLER_RADIUS - 6;
    const vanes = Array.from({ length: 5 }, (_unused, index) => {
      const angle = (index * 72 * Math.PI) / 180;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      // Perpendicular, for the taper: 6 px across at the hub, 2 px at the rim.
      const px = -ny;
      const py = nx;
      const point = (r: number, half: number, sign: number): string =>
        `${(nx * r + px * half * sign).toFixed(2)} ${(ny * r + py * half * sign).toFixed(2)}`;
      return `<path d="M${point(hub - 1, 3, 1)} L${point(rim, 1, 1)} L${point(
        rim,
        1,
        -1,
      )} L${point(hub - 1, 3, -1)} Z" fill="url(#impeller-vane)"/>`;
    }).join('');
    return `<g class="impeller-at" transform="translate(${cx},${cy})">
      <g class="impeller">
        <circle r="${IMPELLER_RADIUS}" fill="none" stroke="url(#impeller-metal)" stroke-width="5"/>
        <circle r="${IMPELLER_RADIUS - 2.5}" fill="none" stroke="var(--void)" stroke-width="1" stroke-opacity="0.6"/>
        <circle r="${IMPELLER_RADIUS - 9}" fill="none" stroke="var(--chrome-dark)" stroke-width="1.5"/>
        ${vanes}
        <circle r="${hub}" fill="url(#impeller-hub)"/>
        <circle r="${hub}" fill="none" stroke="var(--void)" stroke-width="1" stroke-opacity="0.5"/>
        <circle r="3.4" fill="var(--chrome-dark)"/>
      </g>
    </g>`;
  }

  /**
   * The prismatic burst — light thrown through the chamber when the round won.
   *
   * The wedges are tinted from the sphere palette rather than from a new set of
   * hues: §6.1 keeps the environment neutral so the spheres are the only colour
   * in the world, and glass splitting the light of the objects already in it is
   * the only prism this art direction has. Behind `celebrate`, always.
   *
   * Round 1 drew them as 2.6 and 6 px flat triangles, which photograph as a
   * lens-flare sketch. They are wide gradient wedges now, each fading to zero at
   * its tip, so the beat reads as light rather than as line work.
   */
  #burstMarkup(tubeTop: number, tubeHeight: number): string {
    const elements = this.#variant?.elements ?? [];
    const length = Math.max(300, tubeHeight * 0.86);
    const spokes = Array.from({ length: 18 }, (_unused, index) => {
      const angle = (index / 18) * 360 + 10;
      const element = elements[index % Math.max(1, elements.length)];
      const fill = element ? `url(#wedge-${element.id})` : 'var(--specular)';
      const width = index % 2 === 0 ? 26 : 11;
      return `<path transform="rotate(${angle.toFixed(1)})" d="M${-width / 2} 0 L${
        width / 2
      } 0 L0 ${-length.toFixed(0)} Z" fill="${fill}"/>`;
    }).join('');
    return `<g class="burst-at" transform="translate(${CENTRE_X},${Math.round(
      tubeTop + tubeHeight / 2,
    )})">
      <g class="burst">
        <g class="burst__spokes">${spokes}</g>
        <circle class="burst__core" r="${(length * 0.4).toFixed(0)}" fill="url(#burst-core)"/>
        <g class="burst__ring">
          <circle r="${(length * 0.32).toFixed(
            0,
          )}" fill="none" stroke="var(--gold-hot)" stroke-width="3" stroke-opacity="0.7"/>
        </g>
      </g>
    </g>`;
  }

  /**
   * The multiplier stamp — a machined plate, not a tooltip.
   *
   * Two things were wrong with round 1's version and both are geometry rather
   * than taste. It sat at the tube's exact centre, which in CLASSIC is slot 3, so
   * a 144 × 50 plate at 84% black **erased the settled sphere's etched glyph** —
   * and §11 is unconditional that the glyph is the colour-blind channel, not a
   * decoration on top of one. And four gold or chrome edges crossed within 8 px
   * of each other, so the hero frame of a win read as clutter.
   *
   * So it is seated on a **slot division** instead: the plate spans the chamber,
   * its half-height is bounded by `gap/2 + radius − glyphHalf − 3` so both
   * neighbouring glyphs stay clear of it by construction, and the numerals sit in
   * a recessed well with one gold bevel and one specular sweep. Nothing is
   * occluded that carries information, and the object has material.
   */
  #stampMarkup(pitch: number, diameter: number): string {
    const middle = Math.ceil((this.#variant?.n ?? 5) / 2);
    const y = Math.round(this.slotY(middle) - pitch / 2);
    const radius = diameter / 2;
    const gap = pitch - diameter;
    const half = Math.max(15, Math.min(23, Math.round(gap / 2 + radius - radius * 0.46 - 3)));
    const width = 302;
    const inner = half - 6;
    return `<g class="stamp-at" transform="translate(${CENTRE_X},${y})" data-half="${half}">
      <!--
        The landing shock: one stroked ellipse, scaled and faded, thrown outward
        from the plate at the instant it lands. It is the impact the round-1
        stamp did not have — that one cross-faded in over 220 ms, which reads as
        a tooltip appearing rather than as a machined plate arriving.
      -->
      <g class="stamp-shock">
        <ellipse rx="${width * 0.44}" ry="${half * 1.9}" fill="none" stroke="var(--gold-hot)" stroke-width="2" stroke-opacity="0.8"/>
      </g>
      <g class="stamp">
        <!-- The pop's origin anchor; see the sphere markup. The shine translates
             300 px inside a clip, which would otherwise drag the box with it. -->
        <circle class="stamp__anchor" r="${(width * 0.8).toFixed(0)}" fill="none"/>
        <ellipse class="stamp__glow" rx="${width * 0.62}" ry="${half * 3.4}" fill="url(#stamp-glow)"/>
        <rect class="stamp__plate" x="${-width / 2}" y="${-half}" width="${width}" height="${
          half * 2
        }" rx="${half}" fill="url(#stamp-face)"/>
        <rect x="${-width / 2 + 1.5}" y="${-half + 1.5}" width="${width - 3}" height="${
          half * 2 - 3
        }" rx="${half - 1.5}" fill="none" stroke="var(--gold-hot)" stroke-width="1" stroke-opacity="0.6"/>
        <rect class="stamp__well" x="${-width / 2 + 5}" y="${-inner}" width="${
          width - 10
        }" height="${inner * 2}" rx="${inner}" fill="url(#stamp-well)"/>
        <text class="stamp__value" text-anchor="middle" y="${Math.round(
          half * 0.34,
        )}" fill="var(--gold-hot)"></text>
        <g clip-path="url(#stamp-clip)">
          <rect class="stamp__shine" x="${-width / 2}" y="${-half}" width="76" height="${
            half * 2
          }" fill="url(#stamp-shine)" opacity="0.55"/>
        </g>
      </g>
    </g>`;
  }

  /* -------------------------------------------------------------- restore -- */

  /**
   * Re-apply the round so far, without transitions.
   *
   * A redraw — a variant switch or a viewport change — must not erase a settled
   * tube: the result screen is the record of the round (§5 S5) and a chamber that
   * forgot where the spheres landed is not a record. Mode changes no longer
   * redraw at all, so this runs far less often than it used to.
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
      // A celebrated tube stays lit by what landed in it, so the record screen
      // survives a redraw with its colour. `--on` carries the resting opacity as
      // a declaration rather than as an animation fill, which is what lets
      // `chamber--restoring` switch every animation off and keep the state.
      if (this.#won) this.#floodCell(slot, element, 0);
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
    this.#won = false;
    this.#burst?.classList.remove('burst--on', 'burst--calm');
    this.#flash?.classList.remove('cham-flash--on');
    this.#tube?.classList.remove('tube--won');
    this.#tube?.classList.remove('tube--impact');
    this.#shock?.classList.remove('stamp-shock--on');
    this.#stamp?.classList.remove('stamp--land');
    for (const flood of this.#floods.values()) {
      flood.classList.remove('cell-flood--on');
      flood.style.removeProperty('--pop-delay');
      flood.setAttribute('fill', 'none');
    }
    if (this.#motes) this.#motes.innerHTML = '';
    for (const [index, orb] of this.#orbs) {
      const [x, fraction] = DRIFT[index] ?? [CENTRE_X, 0.5];
      const orbY = this.#orbY.get(index);
      const motion = this.#orbMotion.get(index);
      orb.style.setProperty('--fall', '340ms');
      orb.style.transition = 'none';
      orb.style.transform = `translateX(${x}px)`;
      orb.style.opacity = '';
      orb.classList.remove('orb--seated', 'orb--won');
      orb.style.removeProperty('--pop-delay');
      if (orbY) {
        orbY.style.transition = 'none';
        orbY.style.transform = `translateY(${Math.round(
          this.#tubeTop + fraction * this.#tubeHeight,
        )}px)`;
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
      /*
       * …and it does not turn at all under `prefers-reduced-motion`.
       *
       * §6.4 swaps the agitation for a cross-dissolve and the falls for fades; it
       * does not mention the impeller, and the stylesheet's reduced-motion block
       * lists `.impeller` alongside the caustics and the bubbles — but the
       * rotation is a per-frame write from the ticker rather than a keyframe, so
       * that rule was a no-op and the one continuously rotating element on screen
       * kept turning for exactly the players the preference exists for. The
       * stylesheet's intent is the correct one; this is where it has to be kept.
       */
      this.#targetOmega = this.#reduced ? 0 : IMPELLER_OMEGA;
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
        // Bounded rather than trusted: the track is a closed form that knows
        // nothing about the collar rings, and a sphere sliding over machined
        // steel is the one artefact that would give the whole illusion away.
        const limits = this.#bounds.get(index) ?? [-30, 30, -30, 30];
        const dx = bounded(x, limits[0], limits[1]);
        const dy = bounded(y, limits[2], limits[3]);
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
   * The prismatic burst, the frame lift, the seated bloom and the mote fall.
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
   * ORDER win throws the full eighteen wedges and a long shower, a FLOW win at
   * 1.92× gets a quiet flare. Both are celebrated, because both won.
   */
  celebrate(voicing: Voicing): void {
    this.#voicing = voicing;
    this.#won = true;
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
    const flash = this.#flash;
    if (flash) {
      flash.classList.remove('cham-flash--on');
      void flash.getBoundingClientRect();
      flash.dataset.voicing = voicing;
      flash.classList.add('cham-flash--on');
    }
    // The settled column blooms once, on `opacity` alone: the spheres are the
    // only light sources in the world (§6.6 reference 3), so the honest way to
    // say the round won is to turn them up.
    const tube = this.#tube;
    if (tube) {
      tube.classList.remove('tube--won');
      void tube.getBoundingClientRect();
      tube.classList.add('tube--won');
    }
    /*
     * **The spheres are the celebration.** Round 1's win fired an eighteen-wedge
     * burst behind the tube, a gold ring, a gold rim and a plate that faded in —
     * and across all 147 frames of the window every `.orb` held one unchanging
     * transform, opacity 1 and `filter: none`. Everything that moved was drawn
     * behind or around the five objects the player had just spent four seconds
     * watching, which is the difference between a celebration and a backdrop.
     *
     * So the column runs up itself, **in the order it settled** — slot 1 first,
     * one stagger behind the next, the same bottom-up reading the round already
     * taught. Each sphere overshoots its own size, its emissive core swells
     * inside its body, and the cell it landed in floods with its light. The
     * bloom is split between the body's inside and the cell around it for a
     * geometric reason, not a stylistic one: the slots are 78 units apart in a
     * 96-unit tube, so any halo big enough to read crosses into the sphere
     * above (see `sphere.ts`). Every one of these is `transform` or `opacity` on
     * a group that is already composited (§7.1.1), and nothing here is per-line:
     * §2.1 gates every celebration on the round, and this fires on `celebrate`
     * alone.
     */
    for (const [slot, element] of this.#seated) {
      const delay = (slot - 1) * POP_STAGGER_MS;
      const orb = this.#orbs.get(element);
      if (orb) {
        orb.style.setProperty('--pop-delay', `${delay}ms`);
        orb.classList.remove('orb--won');
        void orb.getBoundingClientRect();
        orb.classList.add('orb--won');
      }
      this.#floodCell(slot, element, delay);
    }
    /*
     * And the stamp lands rather than appearing. §9 step 5 puts the number on
     * the last beat of the set piece, and round 1 cross-faded a plate in over
     * 220 ms — the one object a player would screen-record, arriving like a
     * tooltip. It drops from 2.3× with an overshoot, throws a shock ring, and
     * the tube recoils under it.
     *
     * **The recoil is on the tube and not on the chamber, and that is a measured
     * decision.** Written as a translate on the outermost group it was correct,
     * cheap-looking and the single most expensive thing in this file: a
     * transform on the SVG root repaints the whole 390 × 700 drawing for every
     * frame it runs, and a full celebration measured 17 to 40 frames over 20 ms
     * against a baseline of 0 to 1. On the tube — the same subtree the 2 px lock
     * flex has always used — the whole beat is back inside 60 fps with nothing
     * removed from it. It replaces `tube--flex` rather than fighting it: both
     * animate the same element and `lock(n)` fires one tick earlier.
     *
     * All of it is behind `celebrate` and none of it exists on a losing round,
     * which is §9's no-manufactured-near-miss rule at the render layer: the
     * neutral close is still one fall, one lock and no dramatic beat.
     */
    if (!this.#reduced) {
      this.#tube?.classList.remove('tube--flex');
      for (const [node, name] of [
        [this.#stamp, 'stamp--land'],
        [this.#shock, 'stamp-shock--on'],
        [this.#tube, 'tube--impact'],
      ] as const) {
        if (!node) continue;
        node.classList.remove(name);
        void node.getBoundingClientRect();
        node.classList.add(name);
      }
    }
    this.#dropMotes(voicing);
  }

  /**
   * Fill one tube cell with the light of the sphere that settled into it.
   *
   * The fill is the sphere's own bloom gradient (`sphere.ts`), so the cell takes
   * the object's colour rather than a colour chosen for the party — and because
   * the gradient is `objectBoundingBox`, one definition serves a 64 px sphere and
   * a 96 × 78 cell without a second asset.
   */
  #floodCell(slot: number, element: number, delay: number): void {
    const flood = this.#floods.get(slot);
    const id = this.#variant?.elements[element]?.id;
    if (!flood || id === undefined) return;
    flood.setAttribute('fill', `url(#orb-bloom-${id})`);
    flood.style.setProperty('--pop-delay', `${delay}ms`);
    flood.classList.remove('cell-flood--on');
    void flood.getBoundingClientRect();
    flood.classList.add('cell-flood--on');
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
    const count = voicing === 'ORDER' ? 44 : voicing === 'FORM' ? 28 : 16;
    const next = stream(0xc2b2ae35 + count);
    host.innerHTML = Array.from({ length: count }, () => {
      const x = next() * 100;
      const delay = next() * 1.1;
      const duration = 2.4 + next() * 2.1;
      const size = 2.4 + next() * 4.2;
      const drift = (next() * 2 - 1) * 30;
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
    if (label) label.textContent = text;
    this.#stamp.classList.toggle('stamp--on', on);
  }
}
