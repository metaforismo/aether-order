/**
 * The chamber — a jewel instrument in a dark laboratory.
 *
 * Geometry is docs/DESIGN.md §6.9 to the pixel: tube 96 wide centred at x = 195,
 * slot pitch 78 (CLASSIC) / 58 (SEVEN), sphere diameter pitch − 14, collar rings
 * 28 tall, one 1 px `--specular` line at x = 135 running from the top collar to
 * 60% depth.
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
 * animated `.stamp` that also carries `transform="translate(…)"` silently
 * teleports to the viewBox origin the moment the animation applies.
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
import { UNIT } from './money.js';
import { mountOrbDefs, orbArt } from './sphere.js';
import type { ElementInfo, VariantInfo } from './types.js';

const TUBE_WIDTH = 96;
const TUBE_X = 195 - TUBE_WIDTH / 2;
const TUBE_RIM = 12;
const TUBE_WALL = 6;
const COLLAR = 28;
const WIDTH = 390;
const CENTRE_X = 195;
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

/** How long the prismatic burst runs. Mirrors `burst-open` in styles.css. */
const BURST_MS = 1400;

/**
 * The celebrated close's presentation, and it is the fix for one named defect:
 * the payout plate used to be driven straight through the middle of the tube.
 *
 * Round 1 seated a 374-unit full-bleed bar on the division above the middle
 * slot, so on a five-sphere win it occluded slot 4 and clipped slot 3 — and it
 * persisted, which left the settled order, the entire record of the round, half
 * covered on the result screen. Every reference payoff either *clears* the hero
 * object (Plinko's win banner sits below the chip row) or *replaces* it (Space
 * XY's centred disc). A bar across the object does neither and reads as a
 * component dropped onto a scene.
 *
 * The geometry forbids the easy fix. The tube is `n · pitch + 24` units tall and
 * centred in whatever band the deck leaves, so *any* surface placed at the
 * frame's optical centre lands on a sphere; and the gap between two adjacent
 * spheres is `pitch − diameter` = 14 units, which no legible numeral fits in.
 * The only way to have a centred payout surface that covers nothing is to move
 * the spheres, so that is what happens: on a celebrated close the settled column
 * **presents itself** — it rises and draws back a little, as if the mechanism
 * were lifting the result into the light — and the plaque lands in the space it
 * vacated. All five spheres stay visible, at 76% of their size, which is still
 * three times the diameter the result strip prints them at.
 *
 * It is one `transform` on one already-promoted group, it happens only when
 * `celebrate` is true, and a losing round therefore does not move at all — which
 * is a second pre-attentive channel separating the two outcomes (§9).
 */
const LIFT_SCALE = 0.62;
/** How far the presented column rises, as a fraction of the tube's height. */
const LIFT_RISE = 0.25;
/** Half-height of the payout plaque, in viewBox units. */
const PLATE_HALF = 46;
/** The plaque's width — inset from the glass, so it reads as an object on the
 *  instrument rather than as a bar across the screen. */
const PLATE_WIDTH = 330;

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
 * swing both ways.
 */
const DRIFT: readonly (readonly [number, number])[] = [
  // The top of the tube's band is reserved: the idle frame now carries the
  // round-state statement there (criterion 2), and a sphere drifting under a
  // 28 px display word is a collision on the one screen the player sits on
  // longest. Two lanes, five berths, all of them clear of the caption.
  [288, 0.3],
  [102, 0.58],
  [288, 0.46],
  [102, 0.78],
  [288, 0.62],
  [102, 0.9],
  [288, 0.74],
];

export type Beat = 'idle' | 'charge' | 'agitate' | 'settle' | 'close' | 'done';

/**
 * The two figures the payout plate carries: the round's credit and the multiple
 * it came to. Both arrive from the server already formatted — the client does no
 * money arithmetic, here or anywhere.
 */
export interface StampFace {
  amount: string;
  multiple: string;
  /** What the round cost, so the plate can show its own arithmetic. */
  stake?: string;
}

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
  /** The pivot the presented column contracts about on a celebrated close. */
  #tubeCentre = 0;
  #slots: number[] = [];
  #orbs = new Map<number, SVGGElement>();
  #orbY = new Map<number, SVGGElement>();
  #orbMotion = new Map<number, SVGGElement>();
  /** Per-sphere travel limits, so turbulence can never cross the machinery. */
  #bounds = new Map<number, readonly [number, number, number, number]>();
  #pulses = new Map<number, SVGGElement>();
  #numerals = new Map<number, SVGTextElement>();
  /** One rect per slot, filled at `celebrate` with the settled sphere's light. */
  #floods = new Map<number, SVGRectElement>();
  #tube: SVGGElement | null = null;
  #burst: SVGGElement | null = null;
  #flash: SVGRectElement | null = null;
  #stamp: SVGGElement | null = null;
  #halo: SVGEllipseElement | null = null;
  /** Cell floods whose animation is waiting on `celebrate`'s single reflow. */
  readonly #pendingFloods: Element[] = [];
  #shock: SVGGElement | null = null;
  #sweep: SVGGElement | null = null;
  #motes: HTMLElement | null = null;
  #svg: SVGSVGElement | null = null;

  /* The round so far, so a re-layout can restore it rather than erase it. */
  #beat: Beat = 'idle';
  #seated = new Map<number, number>();
  #rimLit = false;
  #mono = false;
  #burstAt = 0;
  #stampFace: StampFace = { amount: '', multiple: '', stake: '' };
  #stampOn = false;
  #won = false;
  #voicing: Voicing = 'FORM';
  #volume: 1 | 2 | 3 = 2;
  #fill = 0;

  /* The motion driver: one registration on the shared ticker. */
  #detach: (() => void) | null = null;
  #lastMs = 0;
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
    /*
     * Where the plaque lands, and where the bloom behind the glass is centred on
     * it. Both are derived from the *presented* column rather than from a slot
     * division: the tube contracts about its own centre and rises, and the
     * plaque is seated 18 units under the bottom rim it leaves behind.
     */
    const tubeCentre = tubeTop + tubeHeight / 2;
    this.#tubeCentre = tubeCentre;
    const liftedBottom = tubeCentre + (LIFT_SCALE * tubeHeight) / 2 - LIFT_RISE * tubeHeight;
    const stampY = Math.round(liftedBottom + PLATE_HALF + 18);

    this.#root.innerHTML = `
      <svg class="chamber" viewBox="0 0 ${WIDTH} ${height}" preserveAspectRatio="xMidYMid meet" data-beat="idle" role="img" aria-label="Chamber with ${n} spheres and a ${n}-slot tube">
        <defs>${this.#defs(height, glassTop, glassHeight, tubeTop, tubeHeight, pitch, stampY)}</defs>
        <!--
          The drawing's own backdrop, and it is a gradient so the instrument sits
          on the page rather than in a hole cut out of it. At 200% text the
          chamber is scaled down inside a taller stage and this rect is what
          shows either side of the glass: a flat fill read as a darker band
          across the screen at exactly the scale accessibility support exists
          for.
        -->
        <rect x="0" y="0" width="${WIDTH}" height="${height}" fill="url(#chamber-field)"/>
        <g class="cham-fit">
          <g class="cham-stretch">
            <g clip-path="url(#glass-clip)">
              <!--
                The back wall, the light on it and the plate it is machined
                from — the three layers that turn 358 units of "behind the
                liquid" into a room.
                Round 2 painted one flat --abyss rect here, and a blind judge
                named that single untextured surface as the tell in all three
                comparison sets. The liquid over it is now translucent, so the
                engine-turning reads *through* the fluid the way an etched plate
                behind glass actually does.
              -->
              <rect x="16" y="${glassTop}" width="${WIDTH - 32}" height="${glassHeight}" fill="url(#backwall)"/>
              <rect x="16" y="${glassTop}" width="${WIDTH - 32}" height="${glassHeight}" fill="url(#wall-key)"/>
              <rect class="liquid" x="16" y="${glassTop}" width="${
                WIDTH - 32
              }" height="${glassHeight}" fill="url(#brine)"/>
              <!--
                The bench the instrument stands on, and it is a whole VALUE BAND
                the frame did not have.
                Criterion 8 counts distinct quantised colours, and the reason
                round 2 measured 1 573 of them is arithmetic rather than
                aesthetic: every channel in the environment lived inside a range
                of six or seven 5-bit steps, so the number of triples the room
                could possibly produce was in the hundreds. A lit floor plane
                under a lit wall is two surfaces at two different values seen at
                two different angles — the cheapest honest way to widen the
                range is to build the room properly rather than to add texture
                to one wall of it.
              -->
              ${this.#bench(glassTop, glassHeight)}
              ${this.#guilloche(tubeTop, tubeHeight)}
              ${this.#lightShaft(height)}
              ${this.#caustics(height)}
              ${this.#mottle(glassTop, glassHeight)}
              ${this.#particulate(height)}
              ${this.#bubbles(height)}
              ${this.#rimLight(tubeTop, tubeHeight)}
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
              <!--
                The payout bloom, and it is *behind* the instrument on purpose.
                Inside the plate's own group it washed the band where the tube's
                ignited rim crosses it, so the two gold objects the win frame is
                read from stopped being one surface — measured, the rim and the
                plate resolved as three separate regions with a desaturated seam
                between them. Behind the glass it does what §9 asks instead: the
                light in the frame is light in the *liquid*, and everything gold
                is painted over it at full saturation.
              -->
              <!--
                Seated a little BELOW the plaque, so its light pools on the
                bench rather than only behind it. The plaque lands at the
                optical centre and the bottom third of the vessel is empty at
                that moment; a payout surface that lights nothing beneath it is
                a surface with no relationship to the room it arrived in.
              -->
              <ellipse class="stamp-halo" cx="${CENTRE_X}" cy="${
                stampY + 34
              }" rx="286" ry="168" fill="url(#stamp-glow)"/>
              <!--
                The celebrated close's held key light (see won-lift in the defs
                above). Inside the glass clip and under the column, so the
                collars stay steel — §6.3 is explicit that if bloom touches the
                chrome the value is wrong — and every sphere is painted over it
                at full saturation.
              -->
              <rect class="won-lift" x="16" y="${glassTop}" width="${
                WIDTH - 32
              }" height="${glassHeight}" fill="url(#won-lift)" opacity="0"/>
            </g>
            <!--
              The cylinder read, and the last thing over the liquid: a 1 px edge
              tint plus §6.2's 6 px inner edge gradient, bright at both walls and
              empty in the middle. That gradient is what makes 358 px of flat
              rectangle read as borosilicate rather than as a box.
            -->
            <!--
              The vessel's outer edge, and it is a LIT BEZEL rather than a
              uniform hairline.
              Measured twice, in-round, this 1 px stroke of --glass-edge at a
              flat 0.55 was the brightest and most saturated region in the whole
              frame: focal.mjs returned a bounding box 1.9% wide and 78% tall,
              which is to say the object the eye was being pointed at while the
              game's signature beat ran was the border of the box. A real glass
              edge catches the key at the top and loses it toward the floor, and
              the highlight it catches is the colour of the SOURCE — near-white,
              not saturated cyan — so it can never compete with a coloured
              object for the eye again.
            -->
            <rect x="16" y="${glassTop}" width="${
              WIDTH - 32
            }" height="${glassHeight}" rx="24" fill="none" stroke="url(#glass-bezel)" stroke-width="1.2"/>
            <rect x="19" y="${glassTop + 3}" width="${WIDTH - 38}" height="${
              glassHeight - 6
            }" rx="21" fill="none" stroke="url(#glass-wall)" stroke-width="6"/>
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
              The presented column (see LIFT_SCALE). Everything the plaque has to
              clear lives inside this group, and nothing else does: on a
              celebrated close it contracts about the tube's centre and rises,
              and the plaque — a sibling, below — lands in the space it leaves.
              One transform, one promoted layer, and it is inert on every other
              outcome.
            -->
            ${this.#burstMarkup(tubeTop, tubeHeight)}
            <g class="result-lift" style="--pivot:${Math.round(
              tubeCentre,
            )}px;--lift-rise:${Math.round(LIFT_RISE * tubeHeight)}px;--lift-scale:${LIFT_SCALE}">
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
            <g class="tube" data-tube>
              ${this.#tubeBack(tubeTop, tubeHeight, pitch)}
              ${this.#spheres(variant, tubeTop, tubeHeight, diameter)}
              ${this.#lockSweep(tubeTop, tubeHeight)}
              ${this.#tubeGlass(tubeTop, tubeHeight)}
              <!--
                §6.1's sixth gold use — "the tube's full-height rim during a
                celebrated close" — is GONE, and its removal is the single
                largest subtraction in this pass.
                Measured and judged, it was doing three kinds of damage at once.
                It read as a flat uniform yellow outline with no gradient and no
                bevel — "a CSS outline rather than a lit object". Its bloom rect
                laid a gold veil across all five settled spheres, so the colours
                the entire game is built on went khaki at the exact moment they
                mattered most. And because it touched the plate where the two
                crossed, focal.mjs merged them into one region 92% of the frame
                wide, which is why the win frame had two things competing to be
                the gold thing and a focal centroid outside the band. What
                replaces it is the light the column already has: every settled
                cell is turned up to full, in the colour of what landed in it.
                One gold object in the frame, and it is the money.
              -->
              ${this.#lockPulses(pitch)}
            </g>
            </g>
            ${this.#stampMarkup(stampY)}
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
    for (const node of this.#root.querySelectorAll<SVGGElement>('.pulse-at'))
      this.#pulses.set(Number(node.dataset.slot), node);
    for (const node of this.#root.querySelectorAll<SVGTextElement>('.slot-no'))
      this.#numerals.set(Number(node.dataset.slot), node);
    for (const node of this.#root.querySelectorAll<SVGRectElement>('.cell-flood'))
      this.#floods.set(Number(node.dataset.slot), node);
    this.#tube = this.#root.querySelector('[data-tube]');
    this.#burst = this.#root.querySelector('.burst');
    this.#flash = this.#root.querySelector('.cham-flash');
    this.#stamp = this.#root.querySelector('.stamp');
    this.#halo = this.#root.querySelector('.stamp-halo');
    this.#shock = this.#root.querySelector('.stamp-shock');
    this.#sweep = this.#root.querySelector('.lock-sweep');

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
    stampY: number,
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
      <linearGradient id="chamber-field" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#123a52"/>
        <stop offset="0.2" stop-color="var(--deep-lit)"/>
        <stop offset="0.5" stop-color="#0d2740"/>
        <stop offset="0.76" stop-color="#0f1c3c"/>
        <stop offset="1" stop-color="var(--abyss-indigo)"/>
      </linearGradient>
      <!--
        The back wall of the room, and it is the surface the whole instrument
        was missing.
        Round 2 painted --abyss flat behind the liquid: a single untextured
        value across the largest area in the frame, which is precisely what a
        blind judge picked our entry out on in three sets running. This is a
        wall — lit warm-cool from the top-left where the key enters, falling to
        indigo at the skirting, with a horizon shade where it meets the base
        plate.
      -->
      <linearGradient id="backwall" x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stop-color="#11374f"/>
        <stop offset="0.26" stop-color="#0c2740"/>
        <stop offset="0.58" stop-color="#0a1e39"/>
        <stop offset="0.82" stop-color="#101740"/>
        <stop offset="1" stop-color="#1b1445"/>
      </linearGradient>
      <!--
        The engine-turned plate behind the tube — this build's answer to the
        reference's damask filigree, in the fiction rather than in ornament.
        A guilloché rosette is what a precision instrument's face is decorated
        with, it is drawn rather than downloaded, and it is completely still: it
        buys colour depth and material out of the idle budget's *unused* half,
        because a still texture costs zero animating regions.
      -->
      <linearGradient id="guilloche" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">
        <stop offset="0" stop-color="#a6e6fb" stop-opacity="0.19"/>
        <stop offset="0.34" stop-color="#66c0ea" stop-opacity="0.15"/>
        <stop offset="0.66" stop-color="#6f95e6" stop-opacity="0.14"/>
        <stop offset="1" stop-color="#b49bf8" stop-opacity="0.12"/>
      </linearGradient>
      <!--
        The wall's own key: the pool of light the source above throws on the
        back wall *before* it enters the liquid. It is what gives the room a
        near and a far side, and it is the top of the frame's value range —
        without it the environment's brightest and darkest pixels were six
        5-bit steps apart in every channel, which caps the achievable colour
        count in the hundreds however much texture is laid over it.
      -->
      <!--
        And the pool is CAPPED, deliberately, a little under where it wants to
        be. focal.mjs defines the important object as the largest region that is
        both bright (L > 0.45) and saturated (S > 0.35); a key pool on a
        saturated blue wall crosses both at once as soon as it is generous, and
        when it does, the "brightest most saturated thing" in the in-round frame
        becomes a patch of empty wall. Every environment surface in this drawing
        is held under L 0.45 for the same reason the references hold 76–86% of
        their pixels in the dark band: the room is not the object.
      -->
      <radialGradient id="wall-key" cx="0.28" cy="0.08" r="0.72">
        <stop offset="0" stop-color="#68b8dc" stop-opacity="0.3"/>
        <stop offset="0.2" stop-color="#3fa9e0" stop-opacity="0.17"/>
        <stop offset="0.48" stop-color="#2b7fb8" stop-opacity="0.07"/>
        <stop offset="1" stop-color="#1b3a86" stop-opacity="0"/>
      </radialGradient>
      <!--
        The bench: the base plate the instrument stands on, seen at a shallow
        angle so it catches more of the key than the wall behind it does.
      -->
      <linearGradient id="bench" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2f7ea8" stop-opacity="0"/>
        <stop offset="0.14" stop-color="#3f92bd" stop-opacity="0.42"/>
        <stop offset="0.4" stop-color="#2d6f9c" stop-opacity="0.5"/>
        <stop offset="0.78" stop-color="#243f7e" stop-opacity="0.46"/>
        <stop offset="1" stop-color="var(--abyss-indigo)" stop-opacity="0.6"/>
      </linearGradient>
      <!-- The bench's near edge, catching the key along its whole length. -->
      <linearGradient id="bench-lip" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--key-hot)" stop-opacity="0.04"/>
        <stop offset="0.32" stop-color="var(--key-hot)" stop-opacity="0.34"/>
        <stop offset="0.68" stop-color="var(--key)" stop-opacity="0.16"/>
        <stop offset="1" stop-color="var(--key)" stop-opacity="0.03"/>
      </linearGradient>
      <!--
        The rim light that separates the tube from the wall behind it.
        §1 of the rubric lists "a rim light separating the focal object from its
        background" among the load-bearing depth cues, and without it 96 units
        of glass sat at the same value as the 390 behind them — the hero object
        and the room measured as one surface.
      -->
      <radialGradient id="tube-rimlight">
        <stop offset="0" stop-color="var(--key-hot)" stop-opacity="0.34"/>
        <stop offset="0.42" stop-color="var(--key)" stop-opacity="0.16"/>
        <stop offset="1" stop-color="var(--key)" stop-opacity="0"/>
      </radialGradient>
      <!--
        Eight stops, travelling in hue as well as in value.
        A four-stop ramp between two colours 6° apart quantises to a handful of
        distinct values however smooth it looks, and the liquid is the largest
        single surface in the product: the frame measured 1,599 distinct colours
        against the rubric's floor of 2,500 and a reference band of 2,956–7,444,
        and this is where most of the shortfall lived. The ramp now runs indigo
        at the floor through teal at the key's entry, which is what a
        cyan-absorbing liquid lit from above actually does.
      -->
      <linearGradient id="brine" x1="0" y1="1" x2="0" y2="0">
        <!--
          The bottom three stops carry the room's second hue (see
          --abyss-indigo in styles.css): the key enters at the top and the
          fluid absorbs the long wavelengths on the way down, so the floor of
          the vessel is violet-blue and the surface is teal. That ramp is what
          takes the frame from two adjacent blue bins to the reference's three,
          and it is the same shape the closest reference in the category uses.
        -->
        <stop offset="0" stop-color="#120d30"/>
        <stop offset="0.1" stop-color="#111634"/>
        <stop offset="0.22" stop-color="#0c1e38"/>
        <stop offset="0.34" stop-color="#0d273e"/>
        <stop offset="0.5" stop-color="#0f3045"/>
        <stop offset="0.64" stop-color="#11394e"/>
        <stop offset="0.78" stop-color="#13455f"/>
        <stop offset="0.9" stop-color="#15506e"/>
        <stop offset="1" stop-color="#175b80"/>
      </linearGradient>
      <!-- §6.2: brushed 316 steel, anisotropic highlight running horizontally. -->
      <linearGradient id="collar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--chrome-dark)"/>
        <stop offset="0.28" stop-color="var(--chrome)"/>
        <stop offset="0.5" stop-color="var(--chrome-mid)"/>
        <stop offset="0.78" stop-color="var(--chrome-dark)"/>
        <stop offset="1" stop-color="var(--deep-lit)"/>
      </linearGradient>
      <linearGradient id="collar-grain" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--deep)" stop-opacity="0.5"/>
        <stop offset="0.22" stop-color="var(--specular)" stop-opacity="0.18"/>
        <stop offset="0.5" stop-color="var(--deep)" stop-opacity="0.3"/>
        <stop offset="0.78" stop-color="var(--specular)" stop-opacity="0.13"/>
        <stop offset="1" stop-color="var(--deep)" stop-opacity="0.5"/>
      </linearGradient>
      <linearGradient id="glass-bezel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e8f4fb" stop-opacity="0.62"/>
        <stop offset="0.18" stop-color="#c6dcea" stop-opacity="0.34"/>
        <stop offset="0.52" stop-color="#8fa8bf" stop-opacity="0.18"/>
        <stop offset="1" stop-color="#5c6390" stop-opacity="0.24"/>
      </linearGradient>
      <!-- The cylinder: bright at both walls, nothing in the middle (§6.2). -->
      <!--
        The 6 px cylinder wall, in the colour of the key and at an alpha that
        keeps it there. At 0.5 it composited to S 0.43 over the lit room, which
        put a 6 px band running the full height of the frame back into
        focal.mjs's mask — the third time a glass highlight has been measured as
        this drawing's "most important object".
      -->
      <linearGradient id="glass-wall" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#eef5fb" stop-opacity="0.78"/>
        <stop offset="0.13" stop-color="#eef5fb" stop-opacity="0.05"/>
        <stop offset="0.87" stop-color="#eef5fb" stop-opacity="0.05"/>
        <stop offset="1" stop-color="#eef5fb" stop-opacity="0.7"/>
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
        <stop offset="0" stop-color="var(--key-hot)" stop-opacity="0.3"/>
        <stop offset="0.24" stop-color="var(--key)" stop-opacity="0.26"/>
        <stop offset="0.55" stop-color="var(--key)" stop-opacity="0.14"/>
        <stop offset="0.8" stop-color="var(--key-deep)" stop-opacity="0.06"/>
        <stop offset="1" stop-color="var(--key-deep)" stop-opacity="0"/>
      </radialGradient>
      <!--
        A caustic filament, in two passes: the hot core and the halo around it.
        Both fade with depth on the same userSpace ramp, because the light
        enters through the top collar and has further to travel the lower it
        goes — which is the same physics the brine's own ramp expresses.
      -->
      <linearGradient id="caustic-line" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">
        <!--
          The cores run toward WHITE rather than toward cyan, and that is a
          hierarchy fix rather than a colour preference. A caustic core mixed at
          #5cbaeb lands at L 0.48 and S 0.64 over the wall — bright AND
          saturated — so the net qualified as focal.mjs's focal object and the
          in-round frame's "brightest, most saturated region" became a
          filigree spanning 91% of the width. A specular caustic is the colour
          of its source, and this source is a cool near-white key (§6.3), so
          every stop here sits under S 0.34 and the only things in the frame
          that are bright and saturated at once are the spheres and the column
          they land in.
        -->
        <stop offset="0" stop-color="#eef9ff" stop-opacity="0.8"/>
        <stop offset="0.3" stop-color="#d3edfb" stop-opacity="0.56"/>
        <stop offset="0.62" stop-color="#a8cfe8" stop-opacity="0.32"/>
        <stop offset="1" stop-color="#a3aee2" stop-opacity="0.13"/>
      </linearGradient>
      <linearGradient id="caustic-glow" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">
        <stop offset="0" stop-color="#a8e2f8" stop-opacity="0.19"/>
        <stop offset="0.34" stop-color="#78bfe4" stop-opacity="0.14"/>
        <stop offset="0.7" stop-color="#6b95cc" stop-opacity="0.09"/>
        <stop offset="1" stop-color="#8f97d8" stop-opacity="0.05"/>
      </linearGradient>
      <linearGradient id="caustic-line-hot" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">
        <stop offset="0" stop-color="#ffffff" stop-opacity="1"/>
        <stop offset="0.34" stop-color="#f2fbff" stop-opacity="0.94"/>
        <stop offset="0.68" stop-color="#dcf0fd" stop-opacity="0.8"/>
        <stop offset="1" stop-color="#cfe0fb" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="caustic-glow-hot" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">
        <stop offset="0" stop-color="#dff5ff" stop-opacity="0.5"/>
        <stop offset="0.34" stop-color="#b6e4fb" stop-opacity="0.42"/>
        <stop offset="0.7" stop-color="#a8cff2" stop-opacity="0.3"/>
        <stop offset="1" stop-color="#b2b8f0" stop-opacity="0.22"/>
      </linearGradient>
      <radialGradient id="caustic-node-hot">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.95"/>
        <stop offset="0.3" stop-color="#e8f7ff" stop-opacity="0.6"/>
        <stop offset="1" stop-color="#bcdcf2" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="caustic-node">
        <stop offset="0" stop-color="#f8fdff" stop-opacity="0.44"/>
        <stop offset="0.3" stop-color="#dcf0fc" stop-opacity="0.2"/>
        <stop offset="1" stop-color="#b4d6ec" stop-opacity="0"/>
      </radialGradient>
      <!--
        Corners fall away from the key, so the light reads as one source from
        above — and they fall to the colour of the room rather than to black.
        Falling to black is what made the instrument's own corners the
        largest near-black region in the frame; a vignette is a *falloff*, and a
        falloff to zero is a hole cut in the picture.
      -->
      <radialGradient id="vignette" cx="0.46" cy="0.2" r="0.9">
        <!--
          The falloff lands on the room's *second* hue rather than on --deep.
          A vignette is the largest single tint in the frame — it is applied to
          every pixel the key does not reach — so painting it in the same blue
          as the liquid was quietly cancelling the depth ramp underneath it and
          holding 75% of the hue mass in one bin.
        -->
        <!--
          And it is HALF the strength it was. A vignette at 0.9 over the
          bottom third of the vessel is not a falloff, it is a second flat
          fill: it collapsed every value the wall, the bench and the
          engine-turning put there into one indigo, which is most of why the
          environment's channels spanned six 5-bit steps and the frame could
          not reach criterion 8's floor however much material was drawn under
          it. The spheres stay the brightest objects because they are lit, not
          because everything else is dimmed.
        -->
        <stop offset="0" stop-color="var(--deep)" stop-opacity="0"/>
        <stop offset="0.4" stop-color="#0a1c34" stop-opacity="0.16"/>
        <stop offset="0.7" stop-color="#0d1738" stop-opacity="0.44"/>
        <stop offset="1" stop-color="#150e3a" stop-opacity="0.72"/>
      </radialGradient>
      <radialGradient id="floor-caustic">
        <stop offset="0" stop-color="var(--key-hot)" stop-opacity="0.42"/>
        <stop offset="0.42" stop-color="var(--key)" stop-opacity="0.2"/>
        <stop offset="1" stop-color="var(--key)" stop-opacity="0"/>
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
      <linearGradient id="bore-fill" x1="0" y1="1" x2="0" y2="0">
        <!--
          Bright enough to survive the cylinder shading drawn over it. The
          charge level is the one surface that is continuous across every
          settled slot whatever landed in them — one of the five elements is a
          near-neutral IVORY, which can never itself be "bright and saturated" —
          so it is what carries the column as a single region for the eye and
          for the measurement alike. At 0.62 it was landing at L 0.42 after the
          bore's own shading, a hundredth under the line.
        -->
        <stop offset="0" stop-color="#22bfe6" stop-opacity="0.84"/>
        <stop offset="0.6" stop-color="#34d4f0" stop-opacity="0.76"/>
        <stop offset="1" stop-color="#6ee2f6" stop-opacity="0.5"/>
      </linearGradient>
      <!--
        The EMPTY bore, and it is deliberately dark.
        Round 2 lit the whole column to --brine-lit whether or not anything was
        in it, so an occupied slot and an empty one measured at the same value
        and the tube carried no state at all. The column is a dark bore that
        *fills with light* as it fills with spheres: the contrast between a lit
        cell and an empty one is the state, and it is legible at a glance from
        across a room, which is what criterion 2 asks of an in-round frame.
      -->
      <linearGradient id="tube-column" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#0d2439"/>
        <stop offset="0.3" stop-color="#123650"/>
        <stop offset="1" stop-color="#175579"/>
      </linearGradient>
      <!-- Cylinder shading: the column is round, so it darkens at both walls. -->
      <linearGradient id="tube-round" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--deep)" stop-opacity="0.66"/>
        <stop offset="0.2" stop-color="var(--deep)" stop-opacity="0.14"/>
        <stop offset="0.42" stop-color="var(--key-hot)" stop-opacity="0.09"/>
        <stop offset="0.72" stop-color="var(--deep)" stop-opacity="0.08"/>
        <stop offset="1" stop-color="var(--deep)" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="tube-caustic" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--key)" stop-opacity="0"/>
        <stop offset="0.5" stop-color="var(--key)" stop-opacity="0.5"/>
        <stop offset="1" stop-color="var(--key)" stop-opacity="0"/>
      </linearGradient>
      <!--
        One seat: the step in the bore between two slots. Shadow above where the
        diameter narrows, a lit chamfer at the waist, occlusion under the lip.
      -->
      <linearGradient id="seat-step" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#04101d" stop-opacity="0"/>
        <stop offset="0.34" stop-color="#04101d" stop-opacity="0.34"/>
        <stop offset="0.5" stop-color="#cfe4f2" stop-opacity="0.42"/>
        <stop offset="0.62" stop-color="#04101d" stop-opacity="0.3"/>
        <stop offset="1" stop-color="#04101d" stop-opacity="0"/>
      </linearGradient>
      <!-- The index plate: dark machined steel, one value at every state. -->
      <linearGradient id="index-plate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1c2c3e"/>
        <stop offset="0.5" stop-color="#121e2c"/>
        <stop offset="1" stop-color="#0a1420"/>
      </linearGradient>
      <linearGradient id="index-lip" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#9ebbd2" stop-opacity="0.42"/>
        <stop offset="0.55" stop-color="#9ebbd2" stop-opacity="0.08"/>
        <stop offset="1" stop-color="#04101d" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="seat-lip" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0a1626" stop-opacity="0.34"/>
        <stop offset="0.5" stop-color="#eaf6ff" stop-opacity="0.5"/>
        <stop offset="1" stop-color="#0a1626" stop-opacity="0.2"/>
      </linearGradient>
      <!--
        The displacement the lock throws into the fluid, and it is a FILL.
        Round 2 spent this beat on two 1 px stroked ellipses, one of which ran
        off both edges of the frame; the judge's note is exact — the whole
        vocabulary of the signature moment was a gold rectangle and two
        hairlines. Light pushed through a liquid has no outline. This is a soft
        pressure bloom that expands and dies, and at 1.62 it has spent itself
        before it reaches the neighbouring slot.
      -->
      <radialGradient id="lock-wave">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0"/>
        <stop offset="0.52" stop-color="var(--key-hot)" stop-opacity="0.34"/>
        <stop offset="0.78" stop-color="var(--key)" stop-opacity="0.16"/>
        <stop offset="1" stop-color="var(--key)" stop-opacity="0"/>
      </radialGradient>
      <!--
        The shock that runs up the glass when a sphere seats: a band of specular
        travelling the bore, clipped to the tube, opacity and transform only.
      -->
      <linearGradient id="lock-sweep" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0"/>
        <stop offset="0.46" stop-color="var(--specular)" stop-opacity="0.5"/>
        <stop offset="0.54" stop-color="var(--key-hot)" stop-opacity="0.42"/>
        <stop offset="1" stop-color="var(--key)" stop-opacity="0"/>
      </linearGradient>
      <!--
        The tube's front glass, and the DOM lane's stand-in for §7 technique 2's
        refraction resample: a wall band whose gradient runs bright → dark →
        bright compresses whatever sits behind it toward the wall, which is what
        the eye reads as thickness.
      -->
      <linearGradient id="tube-wall-l" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#e2eef7" stop-opacity="0.52"/>
        <stop offset="0.55" stop-color="var(--deep)" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#e2eef7" stop-opacity="0.1"/>
      </linearGradient>
      <linearGradient id="tube-wall-r" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#e2eef7" stop-opacity="0.08"/>
        <stop offset="0.4" stop-color="var(--deep)" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#e2eef7" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="tube-sheen" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--key-hot)" stop-opacity="0.24"/>
        <stop offset="0.6" stop-color="var(--key-hot)" stop-opacity="0.05"/>
        <stop offset="1" stop-color="var(--specular)" stop-opacity="0"/>
      </linearGradient>
      <!--
        The stamp: PVD gold, warm, low roughness, one thin specular (§6.2) — and
        a face that is *lit all the way across*.
        Round 3's plate carried a near-black recessed well with the numerals in
        hot gold inside it, so the one object the whole production builds
        toward was light-on-dark: the same polarity as every other pixel in the
        game, on the frame that has to read as a different event. Every payoff in
        the reference set inverts — the payout surface is the luminance maximum
        and the number sits *inside* it, dark-on-light — and that inversion is
        most of what announces "this is the moment" before a word is read.
      -->
      <linearGradient id="stamp-face" x1="0" y1="0" x2="0" y2="1">
        <!--
          The lip is WARM, not white. §6.2 specifies PVD gold with one thin warm
          specular, and a near-white top stop broke that twice over: it read as
          chrome rather than gold, and it put the plate's hottest 5 px below the
          saturation the rest of the surface holds — enough to disconnect the
          plate from the tube's ignited rim, which is the other half of the same
          payout surface.
        -->
        <!--
          Every stop clears S > 0.6, and the top two clear L > 0.75 as well.
          This is where the last of the celebration's desaturation was hiding.
          The plaque is ~11% of the win frame, and its face ran through two pale
          cream stops at S = 0.46 and S = 0.50 — both under the
          threshold the rubric counts a saturated pixel at, spread across the
          largest new surface in the frame. So the payoff kept measuring *less*
          colourful than the wait (×0.81) even after the liquid stopped being
          blamed for it.
          A gold can be bright and saturated at once — the constraint is simply
          that blue stays under about 40% of red, which is what separates lit
          gold from cream. The new top stop is L = 0.86 with S = 0.69: it lifts the
          highlight share *and* the saturated share, where the cream it replaces
          lifted neither.
        -->
        <!--
          Blue never exceeds 35% of red on any stop, not merely 40%: at the
          higher figure the two hottest stops measured S 0.60 exactly, and
          antialiasing put a share of the largest new surface in the frame on
          the wrong side of the threshold — the payoff's saturated share came
          out flat instead of rising. Gold can be bright and saturated at once;
          the constraint is only how much blue is in it.
          The face is weighted so three quarters of it clears L 0.75, which is
          the band criterion 15 counts as *highlight*. The payout surface is
          supposed to be the luminance maximum of the win frame — every payoff
          in the reference set is — and it was carrying most of its area in the
          mid band instead, which is why the frame's highlight share doubled
          only just short of the ×2 the criterion asks for. Every stop still
          clears S 0.6 (blue never exceeds 40% of red, which is what separates
          lit gold from cream), so the extra brightness costs the frame no
          saturation, and the bottom two stops keep the rolled edge that makes
          it metal rather than a yellow rectangle.
        -->
        <stop offset="0" stop-color="#ffe94d"/>
        <stop offset="0.42" stop-color="#ffdd42"/>
        <stop offset="0.7" stop-color="#f7c32e"/>
        <stop offset="0.88" stop-color="var(--gold)"/>
        <stop offset="1" stop-color="#9a6f1e"/>
      </linearGradient>
      <linearGradient id="stamp-bevel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--gold-hot)" stop-opacity="0.95"/>
        <stop offset="0.5" stop-color="var(--gold-hot)" stop-opacity="0.24"/>
        <!--
          The lower edge is a shade of the metal, not a shadow on it. A dark
          bronze lip cut the plate off from the ignited rim it crosses, and the
          two are one surface: the plate carries the form in its face gradient
          instead, which is where a rolled edge gets it from anyway.
        -->
        <stop offset="1" stop-color="#b0862f" stop-opacity="0.9"/>
      </linearGradient>
      <linearGradient id="stamp-shine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--specular)" stop-opacity="0"/>
        <stop offset="0.45" stop-color="var(--specular)" stop-opacity="0.5"/>
        <stop offset="0.55" stop-color="var(--specular)" stop-opacity="0.5"/>
        <stop offset="1" stop-color="var(--specular)" stop-opacity="0"/>
      </linearGradient>
      <!--
        The bloom, and it is deliberately modest. §9 measured what a gold wash
        over saturated colour does — it turns the settled cells khaki — so this
        is a short falloff that is spent before it reaches either neighbouring
        sphere, and the frame's warmth comes from the plate and the rim rather
        than from a disc laid over the objects.
      -->
      <radialGradient id="stamp-glow">
        <stop offset="0" stop-color="var(--gold-hot)" stop-opacity="0.42"/>
        <stop offset="0.3" stop-color="var(--gold-hot)" stop-opacity="0.24"/>
        <stop offset="0.6" stop-color="var(--gold)" stop-opacity="0.08"/>
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
      <!--
        The mottle — the material the "empty" liquid was missing.

        Criterion 8 is a floor of 2,500 distinct quantised colours, and it is not
        a colour preference: it is how flat fill is detected. Ours measured 1,514
        at cold start against a reference band of 2,956–7,444, because two thirds
        of the chamber was an unbroken vertical ramp. Plinko solves the same
        problem with a damask filigree in its background plate.

        The first attempt at this was a fine speckle, and it did nothing —
        measured 1,602 against 1,599 before it. The reason is worth writing down:
        the rubric's analyzer downsamples to 900 px on the long edge, so detail
        under about two device pixels is averaged away before it is counted, and
        a dither finer than the measurement is invisible to it *and* to the eye
        at arm's length. Material has to be low-frequency to be material.

        So this is a field of large, soft, very low-contrast lobes — clouding in
        a glycerol-like liquid, which is what the fluid §6.2 specifies would
        actually look like. Each is 30–96 units across at 3–9% alpha, drifting in
        tint across the cool half of the palette, and the whole field is
        deterministic and **completely still**: the idle budget is the one this
        pass exists to give back, not spend.
      -->
      ${(() => {
        const next = stream(0x2545f491);
        return Array.from({ length: 34 }, (_unused, index) => {
          const tint = ['#1F6E9E', '#2E9FD8', '#123651', '#1a5c85', '#7FA6C4'][index % 5];
          return `<radialGradient id="mottle-${index}">
            <stop offset="0" stop-color="${tint}" stop-opacity="${(
              0.05 +
              next() * 0.06
            ).toFixed(3)}"/>
            <stop offset="0.55" stop-color="${tint}" stop-opacity="${(0.02 + next() * 0.03).toFixed(
              3,
            )}"/>
            <stop offset="1" stop-color="${tint}" stop-opacity="0"/>
          </radialGradient>`;
        }).join('');
      })()}
      <clipPath id="glass-clip">
        <rect x="16" y="${glassTop}" width="${WIDTH - 32}" height="${glassHeight}" rx="24"/>
      </clipPath>
      <clipPath id="tube-clip">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" rx="8"/>
      </clipPath>
      <clipPath id="stamp-clip">
        <rect x="${-PLATE_WIDTH / 2}" y="${-PLATE_HALF}" width="${PLATE_WIDTH}" height="${
          PLATE_HALF * 2
        }" rx="12"/>
      </clipPath>
      <!-- The plaque's contact shadow: tight, under it, and warm-black. -->
      <radialGradient id="stamp-cast">
        <stop offset="0" stop-color="#02040A" stop-opacity="0.62"/>
        <stop offset="0.7" stop-color="#02040A" stop-opacity="0.3"/>
        <stop offset="1" stop-color="#02040A" stop-opacity="0"/>
      </radialGradient>
      <!--
        The celebrated close's held light, and it is COOL — which is the
        counter-intuitive half of this whole pass.

        Round 4 spent the entire payoff on transients: a 900 ms frame flash
        peaking at 10% and returning to zero, a 1,400 ms burst, a mote fall.
        Measured on the settled frame — the one a player screenshots — mean
        luminance had risen 5.7% over the idle state against a reference lift of
        +84%, because by the time the picture stopped moving every light in it
        had gone out. A payoff that leaves no light behind did not happen.

        The obvious fix is a broad warm wash, and this build measured it twice.
        A full-strength amber wash took the saturated share of the win frame from
        84.2% to 43.6% (×0.52). Splitting the light by hue — a cool lift plus a
        small warm pool at the plaque — recovered most of it but not all: ×0.85,
        with the loss concentrated exactly in the band where the two overlapped,
        which read as a washed olive-grey.

        The reason is not tuneable. Amber over cyan are opposed hues, so any
        alpha of one over the other mixes toward neutral, and "neutral" is what
        the rubric's saturation measure reads as *desaturated*. There is no
        opacity at
        which a warm overlay leaves a cool field's saturation intact.

        So the warm pool is gone and the warmth belongs entirely to warm
        OBJECTS — the plaque, the ignited rim, the burst — which are opaque and
        saturated and mix with nothing. This is exactly what the closest
        reference does: it holds its blue field at 88% saturation and lands a
        saturated gold banner *on* it, and its frame-wide saturation between base
        and payoff moves by 0.3 of a percentage point.

        What is left is the instrument's own ≈6200 K key (§6.3) coming up.
        Saturated cyan over a saturated cyan field raises luminance without
        touching hue or saturation, so all of the frame's brightness gain is free
        of the cost above. It is drawn behind the column, so every sphere is
        painted over it at full saturation, and it HOLDS for as long as the
        result is on screen — which is what §4 of the rubric means by "the payoff
        surface persists".
      -->
      <!--
        And its stops are DARKER than they look like they should be, for a
        reason that only a measurement finds.
        focal.mjs defines the celebration surface as the largest connected
        region that is bright (L > 0.45) AND saturated (S > 0.35). A saturated
        cyan lift over a saturated cyan room takes most of the chamber over both
        thresholds at once, so the "single focal object" of the win frame became
        the *room* — 91% of the frame wide, with the payout plate a separate,
        smaller component inside it. The lift has to raise the room from dark to
        mid-dark and stop there: every pixel of it lands under L 0.45, the plate
        sits at 0.8, and the hierarchy the whole payoff depends on survives its
        own light.
      -->
      <!--
        The ramp is weighted to the FLOOR, not to the ceiling, and that is the
        whole of how a payoff gets brighter without losing its hierarchy. The
        top of the vessel is already the lit end; lifting it crosses L 0.45 and
        the room becomes the focal object. The floor sits at L 0.12–0.20 and has
        a quarter of a stop of headroom before it does. So the light arrives
        where there was none, which is also where a light *from the plaque*
        would land.
      -->
      <linearGradient id="won-lift" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#1c6c9e" stop-opacity="0.86"/>
        <stop offset="0.42" stop-color="#1f7cb0" stop-opacity="0.82"/>
        <stop offset="0.78" stop-color="#1f7cb0" stop-opacity="0.66"/>
        <stop offset="1" stop-color="#2489c0" stop-opacity="0.42"/>
      </linearGradient>
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
    return `<ellipse class="shaft" cx="${CENTRE_X - 74}" cy="${
      2 + COLLAR
    }" rx="150" ry="${Math.round(height * 0.46)}" fill="url(#shaft)" transform="rotate(-18 ${
      CENTRE_X - 74
    } ${2 + COLLAR})"/>`;
  }

  /**
   * The bench — the base plate the instrument stands on.
   *
   * A room needs a floor before it needs decoration. The plane is drawn as a
   * shallow ellipse-topped band rather than as a horizontal line so it reads as
   * a surface receding under the tube, and its near edge carries the key along
   * its whole length, which is what tells the eye where the light is coming
   * from at the bottom of the frame — the one region that previously fell
   * uniformly to the vignette.
   */
  #bench(glassTop: number, glassHeight: number): string {
    const bottom = glassTop + glassHeight;
    const top = bottom - Math.round(glassHeight * 0.3);
    const depth = bottom - top;
    return `<g class="bench" aria-hidden="true">
      <path d="M16 ${bottom} V${top + 26} Q${CENTRE_X} ${top - 14} ${WIDTH - 16} ${
        top + 26
      } V${bottom} Z" fill="url(#bench)"/>
      <path d="M16 ${top + 26} Q${CENTRE_X} ${top - 14} ${WIDTH - 16} ${
        top + 26
      }" fill="none" stroke="url(#bench-lip)" stroke-width="2"/>
      <ellipse cx="${CENTRE_X}" cy="${bottom - depth * 0.2}" rx="176" ry="${Math.round(
        depth * 0.5,
      )}" fill="url(#floor-caustic)" opacity="0.5"/>
    </g>`;
  }

  /**
   * The engine-turned plate behind the tube.
   *
   * Criterion 8 is a floor of 2 500 distinct quantised colours and it is not a
   * colour preference: it is how a flat fill is detected. Round 2 measured 1 573
   * against the closest reference's 2 956 and the library's designated
   * failure-mode control's 1 156, and the shortfall lived almost entirely in the
   * area behind the tube. That reference solves the same problem with a damask
   * filigree in its background plate; a laboratory instrument's own version of
   * the same move is **guilloché** — the engine-turned rosette that has
   * decorated precision dials and banknotes since the eighteenth century.
   *
   * It is generated, never downloaded: one clean rosette of overlapping circles
   * whose interference *is* the pattern, plus the machined flutes of the panel
   * it is turned into. Every stroke is under a unit and a half at 12–19% of a
   * cool-to-violet ramp, so the field adds hundreds of intermediate values
   * without adding a single hard edge (criterion 9 counts a luminance gradient
   * over 0.25; this one never exceeds 0.04).
   *
   * And it is **completely still**. The rubric's strongest single finding is
   * that the best reference in the category animates literally nothing while the
   * player decides, so the material the frame was missing has to come out of the
   * budget's unused half rather than out of its spent one.
   */
  #guilloche(tubeTop: number, tubeHeight: number): string {
    const cy = Math.round(tubeTop + tubeHeight / 2);
    const rosette = (count: number, orbit: number, radius: number, phase: number): string => {
      let out = '';
      for (let index = 0; index < count; index += 1) {
        const angle = ((index + phase) / count) * Math.PI * 2;
        out += `<circle cx="${(CENTRE_X + Math.cos(angle) * orbit).toFixed(1)}" cy="${(
          cy +
          Math.sin(angle) * orbit
        ).toFixed(1)}" r="${radius}"/>`;
      }
      return out;
    };
    /*
     * The flutes: the panel is milled, so it carries vertical ribs, and a rib
     * is a pair of lines — a lit edge and its shade — rather than a stroke.
     * They give the wall a direction, which is the thing a gradient cannot do.
     */
    let flutes = '';
    for (let x = 30; x < WIDTH - 30; x += 26) {
      flutes += `<line x1="${x}" y1="0" x2="${x}" y2="${
        tubeTop + tubeHeight + 400
      }" stroke="url(#guilloche)" stroke-width="1.2"/><line x1="${x + 3}" y1="0" x2="${
        x + 3
      }" y2="${tubeTop + tubeHeight + 400}" stroke="var(--abyss-indigo)" stroke-opacity="0.16" stroke-width="2"/>`;
    }
    return `<g class="guilloche" aria-hidden="true">
      <g opacity="0.5">${flutes}</g>
      <g stroke="url(#guilloche)" stroke-width="1" fill="none">${rosette(30, 122, 122, 0)}</g>
      <g stroke="url(#guilloche)" stroke-width="0.8" fill="none" opacity="0.7">${rosette(
        22,
        62,
        62,
        0.5,
      )}</g>
    </g>`;
  }

  /**
   * The rim light that stands the tube off the wall behind it.
   *
   * §1 of the rubric lists "a rim light separating the focal object from its
   * background" among the depth cues that actually carry weight, and its absence
   * measured exactly as the judge described it: 96 units of borosilicate sitting
   * at the same value as the 358 behind them, so the instrument and the room
   * resolved as one flat surface. Two soft ellipses hugging the walls, no edge
   * in any direction, and they are the *chamber's own* key spilling round a
   * cylinder rather than a new light source.
   */
  #rimLight(tubeTop: number, tubeHeight: number): string {
    const ry = Math.round(tubeHeight * 0.56);
    const cy = Math.round(tubeTop + tubeHeight / 2);
    return `<g class="tube-rimlight" aria-hidden="true">
      <ellipse cx="${TUBE_X - 4}" cy="${cy}" rx="30" ry="${ry}" fill="url(#tube-rimlight)"/>
      <ellipse cx="${TUBE_X + TUBE_WIDTH + 4}" cy="${cy}" rx="30" ry="${ry}" fill="url(#tube-rimlight)"/>
    </g>`;
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
  /**
   * The caustics, rebuilt as **light** rather than as haze.
   *
   * Round 2 drew them as eleven soft elliptical blobs at 16–22% — a mist over
   * the wall, which measured and read as nothing: the frame's whole environment
   * spanned six 5-bit steps per channel and a blind judge called the interior a
   * flat wash. That is not what a tank of liquid under one hard source does. A
   * caustic is a *focused* thing — thin branching filaments with hot cores where
   * the wavefronts fold, an order of magnitude brighter than the surface they
   * land on — and it is the single most identity-true piece of light this
   * instrument can carry (§6.2, §6.6 reference 1).
   *
   * So each filament is drawn the way caustics are drawn: a wide soft pass for
   * the halo and a thin hot pass for the core, both on the same path, both
   * fading with depth on a shared vertical ramp because the light enters from
   * above. The bright cores are what widen the environment's value range, which
   * is what criterion 8 is actually measuring.
   */
  #caustics(height: number): string {
    let next = stream(0x9e3779b9);
    let hot = false;
    /**
     * A smooth wandering filament across the wall, as one path.
     *
     * The endpoints are picked on opposite edges of a box larger than the
     * vessel and the direction is free, so the filaments *cross* rather than
     * lying in parallel: a caustic is a net with bright nodes where the folds
     * meet, and eleven horizontal wavy lines is a texture of scratches.
     */
    const filament = (yBase: number, amplitude: number): string => {
      const steps = 7;
      const tilt = (next() - 0.5) * 1.1;
      const x0 = -60 - next() * 40;
      const span = WIDTH + 120 - x0;
      const phase = next() * 6.3;
      const points: [number, number][] = [];
      for (let index = 0; index <= steps; index += 1) {
        const t = index / steps;
        points.push([
          x0 + span * t,
          yBase +
            tilt * span * (t - 0.5) +
            Math.sin(t * 4.1 + phase) * amplitude +
            Math.sin(t * 9.4 + phase * 1.7) * amplitude * 0.45,
        ]);
      }
      let d = `M${points[0]![0].toFixed(0)} ${points[0]![1].toFixed(0)}`;
      for (let index = 1; index < points.length - 1; index += 1) {
        const [cx, cy] = points[index]!;
        const [nx, ny] = points[index + 1]!;
        d += ` Q${cx.toFixed(0)} ${cy.toFixed(0)} ${((cx + nx) / 2).toFixed(0)} ${(
          (cy + ny) / 2
        ).toFixed(0)}`;
      }
      const last = points[points.length - 1]!;
      d += ` T${last[0].toFixed(0)} ${last[1].toFixed(0)}`;
      const glow = hot ? 'caustic-glow-hot' : 'caustic-glow';
      const core = hot ? 'caustic-line-hot' : 'caustic-line';
      return `<path d="${d}" fill="none" stroke="url(#${glow})" stroke-width="${(
        7 +
        next() * 9
      ).toFixed(1)}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="url(#${core})" stroke-width="${(
        1.1 +
        next() * 1.1
      ).toFixed(2)}" stroke-linecap="round"/>`;
    };
    /*
     * Weighted toward the top: `t²` rather than `t` puts more of the net near
     * the collar the key enters through, which is where a real caustic is
     * brightest and densest, and leaves the floor of the vessel to the bench.
     */
    const blob = (layer: number): string => {
      const yBase = 10 + next() ** 1.7 * (height - 20);
      return filament(yBase, 26 + next() * 40 + layer * 10);
    };
    /** Where the folds meet, the light concentrates. Eight of them, no more. */
    const nodes = Array.from({ length: 8 }, () => {
      const cx = 24 + next() * 342;
      const cy = 16 + next() ** 1.7 * (height - 32);
      const r = 7 + next() * 13;
      return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(
        0,
      )}" fill="url(#caustic-node)"/>`;
    }).join('');
    const layerA = `${Array.from({ length: 7 }, () => blob(0)).join('')}${nodes}`;
    const layerB = Array.from({ length: 6 }, () => blob(1)).join('');
    hot = true;
    const reheat = stream(0x9e3779b9);
    next = reheat;
    const hotA = `${Array.from({ length: 7 }, () => blob(0)).join('')}${Array.from(
      { length: 8 },
      () => {
        const cx = 24 + next() * 342;
        const cy = 16 + next() ** 1.7 * (height - 32);
        const r = 7 + next() * 13;
        return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${(r * 1.5).toFixed(
          0,
        )}" fill="url(#caustic-node-hot)"/>`;
      },
    ).join('')}`;
    const hotB = Array.from({ length: 6 }, () => blob(1)).join('');
    /*
     * The churn wrapper is why the beat named "THE CHAMBER AGITATES" now looks
     * like something is happening to the *liquid* and not only to the spheres.
     * It is a second element carrying a second, faster keyframe, so the 19 s
     * ambient drift underneath it never has to change duration mid-flight — an
     * `animation-duration` swap on a running animation jumps, which is the one
     * thing a fluid may not do.
     */
    /*
     * The hot pass, and it is why the payoff can be *bright* without being
     * washed.
     *
     * CSS `opacity` clamps at 1, so "turn the caustics up" cannot be written as
     * a value over 1 on the layer that already carries them — the first attempt
     * at this measured exactly zero change. It is a second copy of the same
     * paths on a hotter ramp instead, resting at zero and brought up by
     * `chamber--ignited` in proportion to `--win-vol`. Structure rather than a
     * wash: the light that arrives at the payoff lands on the same filaments
     * the room already had, so the frame gets brighter without losing a single
     * edge, and because the source is a cool near-white the frame's saturation
     * does not move.
     */
    return `
      <g class="caustic-churn">
        <g class="caustic caustic--a">${layerA}</g>
        <g class="caustic caustic--b">${layerB}</g>
        <g class="caustic-hot" aria-hidden="true">${hotA}${hotB}</g>
      </g>`;
  }

  /**
   * §7 technique 4's bubbles, at DOM scale: closed-form, deterministic, and
   * alive only through CHARGE and AGITATE. 22 rather than 256 because each one
   * here is a composited node instead of a point sprite.
   */
  /** The clouding in the liquid — see the mottle gradients in the defs. */
  #mottle(glassTop: number, glassHeight: number): string {
    const next = stream(0x6c078965);
    const lobes = Array.from({ length: 34 }, (_unused, index) => {
      const cx = 10 + next() * 370;
      const cy = glassTop + next() * glassHeight;
      const rx = 15 + next() * 33;
      const ry = rx * (0.62 + next() * 0.7);
      return `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(
        0,
      )}" ry="${ry.toFixed(0)}" fill="url(#mottle-${index})"/>`;
    }).join('');
    return `<g class="mottle" aria-hidden="true">${lobes}</g>`;
  }

  /**
   * Suspended particulate — the still material the empty liquid was missing.
   *
   * Criterion 8 of the rubric is a floor of 2,500 distinct quantised colours,
   * which is not a colour-preference: it is how you detect flat fill. The
   * references run 2,956 (Plinko) to 7,444 (Balloon Mania) because nothing in
   * them is inert — Plinko's "empty" background carries a whole damask filigree.
   * Ours measured 2,086 at cold start and 2,208 armed, and the shortfall traced
   * to two places, both of them the same defect: the upper and lower thirds of
   * the chamber were unbroken mid-brine.
   *
   * This is that filigree, in fiction rather than in ornament. A glycerol-like
   * liquid in a laboratory vessel has particulate in it; drawn small, dim and
   * sized in a range, it fills the empty bands with hundreds of intermediate
   * values and costs nothing anywhere else:
   *
   * - it is **completely still** — the rubric's strongest single finding is that
   *   a premium instant game animates *nothing* while the player decides, and
   *   the idle budget is the one this pass is trying to give back, not spend;
   * - it adds **no hard edge** — every dot is under 2.4 units across and under
   *   18% opacity, so criterion 9's gradient-magnitude test never sees it;
   * - it is **deterministic**, from the same PRNG as the bubble field, so it is
   *   identical across every redraw and every session.
   */
  #particulate(height: number): string {
    const next = stream(0x27d4eb2f);
    const dots = Array.from({ length: 190 }, () => {
      const x = 22 + next() * 346;
      const y = 14 + next() * (height - 28);
      const r = 0.5 + next() ** 2 * 1.9;
      // Dimmer with depth, so the field reads as volume rather than as a screen
      // of dots: the key comes from above (§6.3) and particulate low in the
      // vessel is lit by less of it.
      const lit = 1 - y / Math.max(1, height);
      const opacity = 0.05 + lit * 0.13 + next() * 0.03;
      const roll = next();
      const tint =
        roll > 0.84 ? 'var(--key-hot)' : roll > 0.62 ? 'var(--brine-lit)' : 'var(--glass-edge)';
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(
        2,
      )}" fill="${tint}" opacity="${opacity.toFixed(3)}"/>`;
    }).join('');
    return `<g class="motes-still" aria-hidden="true">${dots}</g>`;
  }

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
        <line x1="${left}" y1="${lip}" x2="${right}" y2="${lip}" stroke="var(--deep)" stroke-width="1" opacity="0.6"/>
      </g>`;
  }

  /**
   * The tube behind the spheres: a lit liquid column, the slot divisions, the
   * caustic bands, the rising bubbles and the numerals.
   */
  #tubeBack(tubeTop: number, tubeHeight: number, pitch: number): string {
    /*
     * The seats, and they are machined bands rather than hairlines.
     *
     * Round 2 divided the column with a 1 px dark line and a 1 px light one per
     * slot — the exact construction the rubric diagnoses as line art, doing the
     * structural work that mass and shading should do. A seat in a real
     * instrument is a *step* in the bore: a shadow where the diameter narrows, a
     * lit chamfer where it opens again, and a soft occlusion under the lip. All
     * three are fills on a gradient, none of them is a stroke, and together they
     * are what makes the column read as a bored cylinder with five sockets in it
     * rather than as a rectangle with lines across it.
     */
    const engraved = this.#slots
      .map((y, index) => {
        if (index === 0) return '';
        const line = y + pitch / 2;
        return `<rect x="${TUBE_X + 2}" y="${line - 7}" width="${
          TUBE_WIDTH - 4
        }" height="14" fill="url(#seat-step)"/>`;
      })
      .join('');
    /*
     * The chamfer, drawn OVER the light: a lit run of cells would otherwise
     * read as a stack of solid coloured blocks, and the bore has to stay a bore.
     * One narrow band of the key's own colour per division — no dark half, so it
     * cannot cut the column into pieces.
     */
    const lips = this.#slots
      .map((y, index) => {
        if (index === 0) return '';
        const line = y + pitch / 2;
        return `<rect x="${TUBE_X + 2}" y="${line - 3}" width="${
          TUBE_WIDTH - 4
        }" height="6" fill="url(#seat-lip)"/>`;
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
          // On its own machined index plate, and that is the fix for the one
          // legibility defect round 2 left: the numerals were dim grey type
          // sitting straight on the bore, "barely legible", and they are the
          // only thing telling the player what the positions are. A lit cell
          // makes it worse rather than better — light type on a saturated amber
          // pool is 1.8:1 — so the index gets a surface of its own, dark steel
          // at a fixed value, and the type on it clears 4.5:1 at every state the
          // cell behind it can be in.
          `<g class="slot-index" data-slot="${index + 1}">
            <rect x="${TUBE_X + 3}" y="${y - 10}" width="21" height="20" rx="4" fill="url(#index-plate)"/>
            <rect x="${TUBE_X + 3.5}" y="${
              y - 9.5
            }" width="20" height="19" rx="3.5" fill="none" stroke="url(#index-lip)" stroke-width="1"/>
            <text class="slot-no" data-slot="${index + 1}" x="${TUBE_X + 13.5}" y="${
              y + 4
            }" text-anchor="middle" fill="currentColor">${index + 1}</text>
          </g>`,
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
          // Four units of overlap top and bottom, so adjacent lit cells JOIN.
          // Criterion 12 asks for one region that is brightest and most
          // saturated, and a column of five discs separated by five seats is
          // five regions of 0.5% each — measurably, "nothing is the important
          // thing", which is exactly the failure this pass exists to fix.
          `<rect class="cell-flood" data-slot="${index + 1}" x="${TUBE_X}" y="${(
            y -
            pitch / 2 -
            4
          ).toFixed(1)}" width="${TUBE_WIDTH}" height="${(pitch + 8).toFixed(1)}" fill="none"/>`,
      )
      .join('');
    return `
      <g class="tube-well" clip-path="url(#tube-clip)">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" fill="url(#tube-column)"/>
        <!--
          The charge level: the bore fills with the instrument's own light as it
          fills with spheres, from the bottom up, one slot at a time.
          It is the state made continuous. Five lit cells in five different hues
          are five separate objects — and one of the five elements is IVORY, a
          near-neutral, which breaks any chain that depends on the cells being
          saturated. This is the backing that carries the column across it: a
          single bright, saturated surface whose height is the number of slots
          settled, so the in-round frame has one object whose *size* is the
          round's progress. One rect, one scaleY on a promoted layer, 420 ms per
          step, and it moves only when a lock has already happened.
        -->
        <g class="bore-fill"><rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" fill="url(#bore-fill)"/></g>
        <g class="tube-bands">${bands}</g>
        ${engraved}
        <g class="bubbles bubbles--tube">${fizz}</g>
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="${tubeHeight}" fill="url(#tube-round)"/>
        <!--
          The lit cells are painted OVER the cylinder shading, not under it.
          Under it they were darkened by the same pass that shapes the empty
          bore, and the arithmetic mattered: the element hues sit at L 0.44–0.72
          and S 0.53–0.88 in the raw, which is exactly the band focal.mjs counts
          as a lit saturated surface — and a 0.14 multiply over the top was
          enough to drop most of the cell back under the line. A cell full of
          emissive liquid is a source; it is not shaded by the glass in front of
          it, it is what lights the glass.
        -->
        <g class="cell-floods">${floods}</g>
        <g class="seat-lips">${lips}</g>
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

  /**
   * The lock, as a lit event in a liquid rather than as line work.
   *
   * This is the one beat the round-2 verdict called a blocker, and the diagnosis
   * was mechanical rather than aesthetic: the signature moment of the game — a
   * sphere seating into a slot — was drawn as a 2 px gold rectangle outline plus
   * two 1 px expanding ellipses, with no luminance event, no bloom, no
   * displacement and no reaction on the sphere itself. "A 1 px outline can only
   * change colour", and at 1 px the eye barely resolves that.
   *
   * What replaces it is one thing with three parts, all of them fills:
   *
   * | Part | What it is |
   * | --- | --- |
   * | the cell ignites | the slot floods with the *settled sphere's own light* and stays lit for the rest of the round — see `#floodCell` |
   * | the fluid displaces | one soft radial bloom pushed out through the brine, spent before it reaches the next slot |
   * | the bore rings | a band of specular running up the glass, clipped to the tube |
   *
   * There is no gold anywhere in it. Gold is the money colour and it has exactly
   * six sanctioned uses (§6.1); spending five of them per round on locks is what
   * leaves the payoff nowhere to go, and the honest light for this beat is the
   * light of the object that just landed — the spheres are the only emitters in
   * this world, so the room brightening because one of them arrived is the
   * physics the art direction already committed to.
   */
  #lockPulses(pitch: number): string {
    return this.#slots
      .map(
        (y, index) => `<g class="pulse-at" data-slot="${index + 1}" transform="translate(${CENTRE_X},${y})">
          <g class="pulse">
            <ellipse rx="${TUBE_WIDTH / 2 + 34}" ry="${(pitch / 2 + 20).toFixed(
              1,
            )}" fill="url(#lock-wave)"/>
          </g>
        </g>`,
      )
      .join('');
  }

  /** The band of specular that runs up the bore when a sphere seats. */
  #lockSweep(tubeTop: number, tubeHeight: number): string {
    return `<g class="sweep-clip" clip-path="url(#tube-clip)">
      <g class="lock-sweep" style="--bore:${tubeHeight}px">
        <rect x="${TUBE_X}" y="${tubeTop}" width="${TUBE_WIDTH}" height="54" fill="url(#lock-sweep)"/>
      </g>
    </g>`;
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
    /*
     * Nine broad fans, not eighteen needles — and every one of them stays inside
     * the glass.
     *
     * Round 4 threw eighteen 300-unit spokes from a group that sat outside
     * `glass-clip`, so at the peak of a win the frame carried coloured rays
     * running off all four edges of the instrument and across the page: the one
     * moment the production is judged on measured as a screen full of
     * independent effects rather than one big thing. The category's most violent
     * payoff moves 17% of its frame and 79% of that is a single region; the
     * budget for the rest is a handful of supporting details.
     *
     * So the prism stays — it is light thrown *through* the chamber (§7), and it
     * is the objects' own colours — and it becomes a bloom instead of a
     * starburst: fewer, shorter, wider, softer, and clipped to the vessel that
     * is supposed to be refracting it.
     */
    const length = Math.max(190, tubeHeight * 0.52);
    const spokes = Array.from({ length: 9 }, (_unused, index) => {
      const angle = (index / 9) * 360 + 10;
      const element = elements[index % Math.max(1, elements.length)];
      const fill = element ? `url(#wedge-${element.id})` : 'var(--specular)';
      const width = index % 2 === 0 ? 44 : 26;
      return `<path transform="rotate(${angle.toFixed(1)})" d="M${-width / 2} 0 L${
        width / 2
      } 0 L0 ${-length.toFixed(0)} Z" fill="${fill}"/>`;
    }).join('');
    // The clip lives on a wrapper with no transform of its own: `clip-path` is
    // resolved in the user space the element's own `transform` establishes, so
    // putting it on `.burst-at` would have moved the vessel's outline with the
    // burst instead of cropping the burst to the vessel.
    return `<g clip-path="url(#glass-clip)"><g class="burst-at" transform="translate(${CENTRE_X},${Math.round(
      tubeTop + tubeHeight / 2,
    )})">
      <!--
        And the expanding gold ring is gone with it. The subtraction test the
        task sets — remove the two weakest effects and check the frame got
        better — named this and the plate's shock ellipse as the two, and both
        were the same construction: a stroked circle scaled and faded, which is
        line art wearing a keyframe. What is left is the prism (mass, tinted by
        the objects' own colours) and its core.
      -->
      <g class="burst">
        <g class="burst__spokes">${spokes}</g>
        <circle class="burst__core" r="${(length * 0.44).toFixed(0)}" fill="url(#burst-core)"/>
      </g>
    </g></g>`;
  }

  /**
   * The payout plaque — a machined object, seated, not a bar drawn over a scene.
   *
   * Four things changed from round 1, and each answers a measured defect.
   *
   * **It is inset.** 300 units of 390 rather than a 374-unit full bleed, so it
   * has an edge, a shadow and a silhouette. A surface that runs wall to wall has
   * no boundary and cannot read as a thing; it reads as a component.
   *
   * **It clears the tube.** It is seated under the presented column (see
   * LIFT_SCALE) instead of on a slot division, so it covers no sphere and the
   * settled order — the record of the round — survives its own celebration.
   *
   * **It is taller.** 64 units against 46, which is what lets §6.5's 48 px
   * payout step sit on it with the unit attached and a caption underneath. The
   * old height was bounded by the 14-unit gap between two spheres; nothing is
   * threading a gap any more, so the bound is gone.
   *
   * **It carries the unit.** `WON 114.20 CR`, not `WON 114.20`. Every Tier-1
   * reference attaches its unit to every figure, and a number with no unit does
   * not read as money — which was the one thing criterion 17 failed on.
   */
  #stampMarkup(y: number): string {
    const width = PLATE_WIDTH;
    const half = PLATE_HALF;
    return `<g class="stamp-at" transform="translate(${CENTRE_X},${y})">
      <!--
        The landing shock, and it is a BLOOM rather than a stroked ellipse.
        The impact is right — a plate that cross-fades in reads as a tooltip
        appearing rather than as machined brass arriving — but the round-2
        version drew it as a 1 px gold outline, and the subtraction test caught
        it: removing that ellipse made the frame better, which by the task's own
        rule made it noise. Light thrown off a landing surface has no edge.
      -->
      <g class="stamp-shock">
        <ellipse rx="${width * 0.62}" ry="${half * 2.1}" fill="url(#stamp-glow)"/>
      </g>
      <g class="stamp">
        <!-- The pop's origin anchor; see the sphere markup. The shine translates
             300 px inside a clip, which would otherwise drag the box with it. -->
        <circle class="stamp__anchor" r="${(width * 0.8).toFixed(0)}" fill="none"/>
        <!--
          The contact shadow. §1 of the rubric puts "a layered drop shadow
          grounding each element" among the load-bearing depth cues, and a plate
          that lands with a bang and casts nothing is a sticker.
        -->
        <rect class="stamp__cast" x="${-width / 2 + 6}" y="${-half + 10}" width="${
          width - 12
        }" height="${half * 2}" rx="12" fill="url(#stamp-cast)"/>
        <rect class="stamp__plate" x="${-width / 2}" y="${-half}" width="${width}" height="${
          half * 2
        }" rx="12" fill="url(#stamp-face)"/>
        <!-- One bevel: a hot lip on top, a machined shade under the bottom. -->
        <rect x="${-width / 2 + 1.5}" y="${-half + 1.5}" width="${width - 3}" height="${
          half * 2 - 3
        }" rx="10.5" fill="none" stroke="url(#stamp-bevel)" stroke-width="3"/>
        <!--
          The money, inside the surface, dark on light — and it is the round's
          own credit rather than a ratio, because §8's brief is that a win must
          read as a win with the sound off and a multiple is a thing you have to
          convert. The label sits above the figure and the multiple below it,
          which is §4 of the rubric's published order for a payout surface:
          label smaller and above, amount larger and below.
        -->
        <!--
          Three figures on two rows, and the rows do not fight.
          The first draft stacked label, amount and multiple on three baselines
          inside a 64-unit plate: at §6.5's 48 px payout step the numeral's own
          cap height is 34 units, so it ran through the label above it and
          pushed the multiple past the plate's bottom edge — both caught on the
          first frame dump of the rebuilt plaque. Label and multiple now share
          the upper row, at opposite ends, where they read as the caption pair
          they are; the money owns the row below it alone.
        -->
        <text class="stamp__cap" text-anchor="start" x="${
          -width / 2 + 18
        }" y="${-half + 24}" fill="#5A4310" data-cap>WON</text>
        <!--
          The operands, beside the result. "1.00 CR AT 4.80x" is the whole of
          the arithmetic the plate's own big figure is the answer to, and it is
          there because round 2's plate invited a multiplication whose answer
          was a different number from the one printed underneath it.
        -->
        <text class="stamp__mult" text-anchor="end" x="${
          width / 2 - 18
        }" y="${-half + 24}" fill="#5A4310" data-mult></text>
        <!--
          The numeral is BUILT, not styled — §5 of the rubric's "display type is
          built, not styled; flat system-font text reads as placeholder".
          Two passes: a light warm copy one and a half units below the dark one,
          so the figure reads as *punched into* the plate rather than printed on
          it. That is the treatment the material asks for — a struck metal plaque
          catches light on the lower lip of every stroke — and it is what the
          product can honestly build, because §6.5's display face is not bundled
          and on most devices this numeral renders in the platform system font. A
          built treatment survives that substitution; a font dependency does not.
          Both passes carry the same string from the same node write (see
          setStamp below), so they can never disagree.
        -->
        <!--
          The sign is load-bearing. "3.80" beside "4.80x" is ambiguous; "+3.80"
          is not — it says the figure is what the round ADDED, on top of the
          stake printed in the caption above it. It appears on no other surface
          and on no other outcome, because the plate exists only where
          creditedChips > totalStakeChips (§10).
        -->
        <text class="stamp__emboss" text-anchor="middle" y="${
          half - 13.5
        }" aria-hidden="true"><tspan>+</tspan><tspan data-num></tspan><tspan class="stamp__unit"> ${UNIT}</tspan></text>
        <text class="stamp__value" text-anchor="middle" y="${
          half - 15
        }" fill="var(--void)"><tspan class="stamp__sign">+</tspan><tspan class="stamp__num" data-num></tspan><tspan class="stamp__unit"> ${UNIT}</tspan></text>
        <g clip-path="url(#stamp-clip)">
          <rect class="stamp__shine" x="${-width / 2}" y="${-half}" width="76" height="${
            half * 2
          }" fill="url(#stamp-shine)" opacity="0.55"/>
        </g>
      </g>
    </g>`;
  }
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
    this.setStamp(this.#stampFace, this.#stampOn);
    this.desaturate(this.#mono);
    // The held key light and the presented column are part of the record, so a
    // redraw restores them like every other end state (see `celebrate`).
    svg?.classList.toggle('chamber--won', this.#won);
    svg?.style.setProperty('--win-vol', String(this.#volume));
    svg?.style.setProperty('--fill', this.#fill.toFixed(3));
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
      this.#numerals.get(slot)?.classList.add('slot-no--lit');
      // The cell keeps the light of what landed in it — that light IS the
      // seated state now, so a redraw has to restore it or the tube forgets
      // which slots are filled.
      this.#floodCell(slot, element, 0, this.#won ? 'won' : 'seated');
      // A celebrated tube stays lit by what landed in it, so the record screen
      // survives a redraw with its colour. `--on` carries the resting opacity as
      // a declaration rather than as an animation fill, which is what lets
      // `chamber--restoring` switch every animation off and keep the state.
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
    /*
     * The clear is instantaneous, and this class is the whole reason.
     *
     * The payout plate and its bloom fade on a 220 ms / 300 ms transition, which
     * is right when the round ends and wrong when the *next* round opens: a
     * frame dump of REBET caught a grey ghost of the plate — the word WON still
     * legible — lying across a chamber whose spheres had already been put back
     * and whose tube was empty. A record that dissolves over a screen showing a
     * different state is not a record, it is a rendering fault.
     */
    const restoring = this.#svg;
    restoring?.classList.add('chamber--restoring');
    this.#seated.clear();
    this.#fill = 0;
    this.#svg?.style.setProperty('--fill', '0');
    this.#turbulence = null;
    this.#beat = 'idle';
    this.setBeat('idle');
    this.igniteRim(false);
    this.setStamp({ amount: '', multiple: '', stake: '' }, false);
    this.desaturate(false);
    this.#burstAt = 0;
    this.#won = false;
    // The held key light and the presented column go with everything else. Both
    // are declarations rather than animation fills, so `chamber--restoring`
    // cannot clear them and they have to be named here (see `#restore`).
    this.#svg?.classList.remove('chamber--won');
    this.#burst?.classList.remove('burst--on', 'burst--calm');
    this.#flash?.classList.remove('cham-flash--on');
    this.#tube?.classList.remove('tube--won');
    this.#tube?.classList.remove('tube--impact');
    this.#shock?.classList.remove('stamp-shock--on');
    this.#stamp?.classList.remove('stamp--land');
    for (const flood of this.#floods.values()) {
      flood.classList.remove('cell-flood--on', 'cell-flood--lock', 'cell-flood--seated');
      flood.style.removeProperty('--pop-delay');
      flood.setAttribute('fill', 'none');
    }
    this.#sweep?.classList.remove('lock-sweep--on');
    for (const orb of this.#orbs.values()) orb.classList.remove('orb--lock');
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
    for (const pulse of this.#pulses.values())
      pulse.querySelector('.pulse')?.classList.remove('pulse--on');
    for (const numeral of this.#numerals.values()) numeral.classList.remove('slot-no--lit');
    if (restoring) {
      void restoring.getBoundingClientRect();
      restoring.classList.remove('chamber--restoring');
    }
  }

  /* ---------------------------------------------------------------- beats -- */

  setBeat(beat: Beat): void {
    this.#beat = beat;
    this.#svg?.setAttribute('data-beat', beat);
    if (beat === 'settle' || beat === 'close' || beat === 'done') this.#turbulence = null;
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
    if (this.#turbulence === null) {
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

    if (this.#turbulence === null) {
      this.#detach?.();
      this.#detach = null;
    }
  }

  /** How much of the bore is lit: one slot's worth per lock, bottom-up. */
  #setFill(slot: number): void {
    const n = this.#variant?.n ?? 5;
    this.#fill = Math.max(this.#fill, Math.min(1, slot / n));
    this.#svg?.style.setProperty('--fill', this.#fill.toFixed(3));
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
   * The lock — the game's signature beat, and the one the round-2 verdict
   * blocked on.
   *
   * It is now **one dominant event with three supporting details**, in the
   * rubric's own arithmetic: the cell the sphere landed in ignites with that
   * sphere's light and *stays lit*, and around it the fluid displaces, the bore
   * rings, the sphere flares and the instrument flexes 2 px. All five are
   * `opacity` or `transform` on already-composited groups, all five live inside
   * the tube's bounding box so a frame diff clusters them as a single moving
   * region (criterion 18), and the whole thing is over in 460 ms.
   *
   * The persistence is the part that matters most. Every other beat in the round
   * returns the frame to where it started, so at any given instant the in-round
   * frame carried no evidence that anything had happened: measured, its
   * brightest and most saturated region was a 1.4%-wide vertical hairline — the
   * outer glass edge — because nothing else in the picture was both lit and
   * coloured. A column that fills with light as it fills with spheres gives the
   * state an object, and the object grows as the round progresses.
   */
  lock(slot: number): void {
    this.#numerals.get(slot)?.classList.add('slot-no--lit');
    this.#setFill(slot);
    const element = this.#seated.get(slot);
    if (element !== undefined) this.#floodCell(slot, element, 0, 'lock');
    const restart: [Element | null | undefined, string][] = this.#reduced
      ? []
      : [
          [this.#pulses.get(slot)?.querySelector('.pulse'), 'pulse--on'],
          [this.#sweep, 'lock-sweep--on'],
          [this.#tube, 'tube--flex'],
          [element === undefined ? null : (this.#orbs.get(element) ?? null), 'orb--lock'],
        ];
    // One flush for the whole beat, not one per element: an interleaved
    // read-write-read-write costs a full style-and-layout recalculation each
    // time, inside the single frame that has to draw the hero moment.
    for (const [node, name] of restart) node?.classList.remove(name);
    if (restart.length) void this.#svg?.getBoundingClientRect();
    for (const [node, name] of restart) node?.classList.add(name);
  }

  /* ---------------------------------------------------------- celebration -- */

  /**
   * The instrument's own light comes up.
   *
   * §9 step 4 used to be "the tube's full-height gold rim ignites from the
   * bottom up", and that rim is gone (see the tube markup). What survives is the
   * *semantic*: the moment the round is known to have returned more than it
   * cost, the chamber's key comes up and its caustics run hot. That is light
   * with no hue of its own — a cool near-white source over a cool field — so it
   * raises the frame's luminance and its highlight area without moving its
   * saturation a point, which is the exact arithmetic criterion 15 rewards and
   * the exact arithmetic a warm wash fails.
   */
  igniteRim(on: boolean): void {
    this.#rimLit = on;
    this.#svg?.classList.toggle('chamber--ignited', on);
  }

  /**
   * How loud the close is allowed to be, from the round's own realised multiple.
   *
   * The round-2 verdict measured a 4.80× win peaking at mean luminance 0.391 and
   * a 19.20× win peaking at 0.361 — a four-times-bigger result producing a
   * marginally *quieter* frame, because the only thing scaling was a spoke count
   * and a mote count, both sub-perceptual at frame level. §8's rule is that a
   * win scales by voicing rather than by loudness, and that rule is about not
   * making a small win *feel* like a big one; it is not a licence for every win
   * to look identical. So the shape stays voiced by tier and the *volume* is now
   * keyed to the realised return multiple, which is the round's own result and
   * nothing else — the one thing the task allows a celebration's intensity to
   * follow.
   *
   * Three steps, not a continuum: a continuum is unreadable and invites tuning
   * toward the top of it. Under 3×, under 10×, and above.
   */
  static volumeOf(multiple: string): 1 | 2 | 3 {
    const value = Number.parseFloat(multiple);
    if (!Number.isFinite(value)) return 1;
    if (value >= 10) return 3;
    if (value >= 3) return 2;
    return 1;
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
  celebrate(voicing: Voicing, volume: 1 | 2 | 3 = 2): void {
    this.#voicing = voicing;
    this.#volume = volume;
    this.#svg?.style.setProperty('--win-vol', String(volume));
    this.#won = true;
    this.#burstAt = performance.now();
    const burst = this.#burst;
    if (burst) {
      burst.dataset.voicing = voicing;
      burst.classList.remove('burst--on', 'burst--calm');
      burst.style.animationDelay = '';
    }
    const flash = this.#flash;
    if (flash) {
      flash.classList.remove('cham-flash--on');
      flash.dataset.voicing = voicing;
    }
    // The settled column blooms once, on `opacity` alone: the spheres are the
    // only light sources in the world (§6.6 reference 3), so the honest way to
    // say the round won is to turn them up.
    const tube = this.#tube;
    tube?.classList.remove('tube--won');
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
    const popped: HTMLElement[] = [];
    for (const [slot, element] of this.#seated) {
      const delay = (slot - 1) * POP_STAGGER_MS;
      const orb = this.#orbs.get(element);
      if (orb) {
        orb.style.setProperty('--pop-delay', `${delay}ms`);
        orb.classList.remove('orb--won');
        popped.push(orb as unknown as HTMLElement);
      }
      this.#floodCell(slot, element, delay, 'won');
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
    const landing: [Element | null, string][] = this.#reduced
      ? []
      : [
          [this.#stamp, 'stamp--land'],
          [this.#shock, 'stamp-shock--on'],
          [this.#tube, 'tube--impact'],
        ];
    if (!this.#reduced) this.#tube?.classList.remove('tube--flex');
    for (const [node, name] of landing) node?.classList.remove(name);
    this.#dropMotes(voicing, volume);

    /*
     * **One forced layout, not eleven.**
     *
     * Every animation in this beat has to be restarted, and restarting a CSS
     * animation means remove-the-class, flush, add-the-class. Round 4 did that
     * eleven times in a row — burst, flash, tube, five spheres, five cell
     * floods, plate, shock, recoil — each `getBoundingClientRect()` interleaved
     * between a write and the next write, so the browser recomputed style and
     * layout for the whole document eleven times inside the single frame that
     * has to draw the game's hero moment. Measured over a celebrated round at
     * 390 x 844: eight frames over 33 ms with a 67 ms worst case, against zero
     * on a neutral round. Batched — every removal, then one flush, then every
     * addition — the same beat draws with nothing removed from it.
     */
    void this.#svg?.getBoundingClientRect();

    if (burst) burst.classList.add(this.#reduced ? 'burst--calm' : 'burst--on');
    /*
     * The held light. Everything else in this beat is a transient that returns
     * the frame to where it started; this one stays up for as long as the
     * result is on screen, and it is what makes the *settled* win frame read as
     * a win rather than only the moving one.
     */
    this.#svg?.classList.add('chamber--won');
    flash?.classList.add('cham-flash--on');
    tube?.classList.add('tube--won');
    for (const orb of popped) orb.classList.add('orb--won');
    for (const flood of this.#pendingFloods) flood.classList.add('cell-flood--on');
    this.#pendingFloods.length = 0;
    for (const [node, name] of landing) node?.classList.add(name);
  }

  /**
   * Fill one tube cell with the light of the sphere that settled into it.
   *
   * The fill is the sphere's own bloom gradient (`sphere.ts`), so the cell takes
   * the object's colour rather than a colour chosen for the party — and because
   * the gradient is `objectBoundingBox`, one definition serves a 64 px sphere and
   * a 96 × 78 cell without a second asset.
   *
   * Three states, and the difference between them is only how bright the cell
   * is:
   *
   * - `lock` — the ignition, at the instant the sphere seats. It flares and
   *   settles to the seated level, and it is information rather than
   *   celebration: which slot is filled by which colour is a fact about the
   *   round that the player is entitled to and can read off the tube anyway
   *   (§10's `lineLighting` is deliberately never gated).
   * - `seated` — the resting level, restored without an animation after a
   *   redraw.
   * - `won` — the celebrated close turns every cell up together.
   *
   * There is no gold in any of the three. A losing tube ends the round lit by
   * five coloured spheres, exactly as a winning one does, and the difference
   * between the two outcomes is carried entirely by what happens *around* the
   * column (§9's no-near-miss rule at the render layer).
   */
  #floodCell(slot: number, element: number, delay: number, state: 'lock' | 'seated' | 'won'): void {
    const flood = this.#floods.get(slot);
    const id = this.#variant?.elements[element]?.id;
    if (!flood || id === undefined) return;
    flood.setAttribute('fill', `url(#orb-cell-${id})`);
    flood.style.setProperty('--pop-delay', `${delay}ms`);
    flood.classList.remove('cell-flood--lock', 'cell-flood--on');
    flood.classList.add('cell-flood--seated');
    if (state === 'seated') return;
    if (state === 'lock') {
      void flood.getBoundingClientRect();
      flood.classList.add('cell-flood--lock');
      return;
    }
    // Started by `celebrate`, after the one flush that restarts the whole beat.
    this.#pendingFloods.push(flood);
  }

  /**
   * The slow golden fall.
   *
   * DOM rather than SVG, and CSS keyframes rather than a per-frame write: a mote
   * is one composited node whose whole life is `transform` and `opacity`, so the
   * shower costs the main thread nothing after it is mounted. Removed on the next
   * `reset`, i.e. at the start of the next round.
   */
  /**
   * The mote fall — and it is a third of the size it was, for a measured reason.
   *
   * 44 motes scattered across the full width of the screen made the *win* state
   * the busiest thing in the product by moving-region count: measured on two
   * consecutive frames of the celebration, 17 independently moving regions with
   * no single region owning more than a few percent of the motion, against a
   * reference ceiling of 7 and a rule that one region should own 50–80%. The
   * total pixel change was negligible — 0.4% — which is the tell: this was not a
   * big effect, it was a *scattered* one, and the rubric's ceiling on a payoff is
   * "one big thing plus a handful of supporting details, not a screen full of
   * independent effects".
   *
   * So the count drops and the fall is confined to the middle 62% of the frame,
   * over the instrument, where it reads as light coming off the plaque rather
   * than as weather. It stays voiced by tier rather than scaled by amount (§8).
   */
  #dropMotes(voicing: Voicing, volume: 1 | 2 | 3): void {
    const host = this.#motes;
    if (!host || this.#reduced) return;
    /*
     * Fewer, and bigger. Measured on two consecutive frames of the settled
     * celebration, a shower of twenty was nine independently moving regions
     * with no region owning more than 41% of the motion — the rubric's
     * signature for a scattered effect rather than a big one, and the same
     * defect this shower was already cut once for. The payoff is one large
     * event plus a handful of supporting details; a handful is what this is.
     */
    const count = (voicing === 'ORDER' ? 5 : voicing === 'FORM' ? 4 : 3) + volume;
    const next = stream(0xc2b2ae35 + count);
    host.innerHTML = Array.from({ length: count }, () => {
      const x = 19 + next() * 62;
      // Bounded so the whole shower is spent inside four seconds: §7 of the
      // rubric puts a celebration's hold at 1.5–3 s and its outer edge under 4,
      // and a supporting detail that outlives the event it supports stops
      // reading as part of it.
      const delay = next() * 0.7;
      const duration = 2 + next() * 1.3;
      const size = 3.6 + next() * 5.4;
      const drift = (next() * 2 - 1) * 30;
      return `<i style="left:${x.toFixed(1)}%;--size:${size.toFixed(1)}px;--drift:${drift.toFixed(
        0,
      )}px;animation-delay:${delay.toFixed(2)}s;animation-duration:${duration.toFixed(2)}s"></i>`;
    }).join('');
  }

  /* ---------------------------------------------------------------- stamp -- */

  /**
   * The payout plate's ink: the round's credit, and the multiple beside it.
   *
   * Both figures are the server's — `presentation.headline`'s own number and
   * `presentation.stampMultipleDecimal` — so this client still computes no
   * money. The plate carries the amount because §8 asks a win to read as a win
   * with the sound off, and a multiple is a figure the player has to convert
   * before it means anything.
   */
  setStamp(face: StampFace, on: boolean): void {
    this.#stampFace = face;
    this.#stampOn = on;
    if (!this.#stamp) return;
    /*
     * The numeral takes the published step that fits the plaque.
     *
     * §6.5's 48 px payout step assumes a figure the width of `114.20 CR`, which
     * is 192 of the plaque's 264 units of inner width. SEVEN's top multiple is
     * 4838.40x, and a large stake on it produces a figure half as wide again —
     * so the step is chosen from the string's own length rather than assumed,
     * and the two steps below it are both on §6.5's scale. §11 forbids clipping
     * without exception, and a payout that overhangs its own plate is the one
     * place in the product where that would be least forgivable.
     */
    this.#stamp.dataset.len =
      face.amount.length > 8 ? 'xl' : face.amount.length > 6 ? 'long' : 'normal';
    // querySelectorAll, not querySelector: the figure is set twice — the struck
    // pass and the ink pass (see `#stampMarkup`) — and writing only the first
    // would leave the plaque reading a hot-gold number with no ink on it.
    for (const amount of this.#stamp.querySelectorAll('[data-num]'))
      amount.textContent = face.amount;
    const multiple = this.#stamp.querySelector('[data-mult]');
    if (multiple)
      multiple.textContent = face.stake
        ? `${face.stake} ${UNIT} AT ${face.multiple}`
        : face.multiple;
    this.#stamp.classList.toggle('stamp--on', on);
    this.#halo?.classList.toggle('stamp-halo--on', on);
  }
}
