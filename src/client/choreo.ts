/**
 * The agitation, choreographed from the committed order.
 *
 * docs/DESIGN.md §7's principle: "the transcript is known the instant the round
 * commits, so the entire round is a *precomputed choreography track*. Nothing is
 * solved at runtime; everything is evaluated." §6.4 gives the vocabulary —
 * "damped sine, 3.2 Hz, ζ = 0.28 … spheres on Lissajous paths, phase-offset per
 * sphere" — and §8 requires the randomisation to be **seeded from the
 * transcript**, so a replay sounds and looks identical and a clip is
 * reproducible.
 *
 * So there is no physics here and there is no `Math.random()` either. Every
 * sphere's path through the 900 ms AGITATE beat is a closed-form function of
 * (element, elapsed seconds) whose constants come out of a hash of the
 * transcript. Two consequences, both load-bearing:
 *
 * - **Every round has its own turbulence.** The same five spheres tumble
 *   differently in every round, which is what stops a four-second game reading
 *   as one looping animation, and it costs nothing because it is arithmetic.
 * - **The turbulence encodes nothing.** It is seeded by the *commitment*, not
 *   arranged by the permutation: no sphere drifts toward the slot it will land
 *   in and the spheres are not pre-sorted at the end of the beat. A player
 *   cannot read the order out of the shake, which is the same reason §3 has to
 *   label the shake as choreography — *"the order was fixed when you committed;
 *   the shake is how we show it"* — rather than as a tell.
 *
 * The evaluated position is written to one `transform` per sphere, on a
 * pre-promoted group, from the single shared ticker below. No layout, no paint.
 */

/** FNV-1a, 32-bit. Small, stable, and enough to spread a phase table. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A deterministic 0..1 stream from a 32-bit seed (xorshift32). */
function stream(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** §6.4: the agitation is 3.2 Hz. Every frequency below is a ratio of it. */
const BASE_HZ = 3.2;
/** §6.4: ζ = 0.28 — the damping that makes the tumble read as fluid, not orbit. */
const ZETA = 0.28;
/** The beat AGITATE lasts, in seconds — the envelope is written against it. */
const AGITATE_SECONDS = 0.9;

interface Lane {
  readonly ax: number;
  readonly ay: number;
  readonly fx: number;
  readonly fy: number;
  readonly px: number;
  readonly py: number;
  readonly wobble: number;
}

export interface Turbulence {
  /** Offset in chamber units for one element, `seconds` into the beat. */
  readonly at: (element: number, seconds: number) => readonly [number, number];
  /** The 32-bit seed, so the audio layer can share the same stream (§8). */
  readonly seed: number;
}

/**
 * Build the track.
 *
 * `amplitude` is in chamber units and is scaled per element so the heavier-
 * looking lanes do not all swing the same distance — five spheres moving in
 * lockstep is the tell that a shake is a CSS keyframe.
 */
export function turbulence(
  commitment: string,
  count: number,
  amplitude: readonly [number, number],
): Turbulence {
  const seed = hash32(commitment || 'aether');
  const next = stream(seed);
  const lanes: Lane[] = [];
  for (let index = 0; index < count; index += 1) {
    // Lissajous: two frequencies whose ratio is near-but-not-quite rational, so
    // the figure never closes inside the 900 ms the beat lasts.
    const fx = BASE_HZ * (0.42 + next() * 0.3);
    const fy = BASE_HZ * (0.53 + next() * 0.34);
    lanes.push({
      ax: amplitude[0] * (0.62 + next() * 0.55),
      ay: amplitude[1] * (0.58 + next() * 0.62),
      fx,
      fy,
      px: next() * Math.PI * 2,
      py: next() * Math.PI * 2,
      wobble: 0.2 + next() * 0.24,
    });
  }
  return {
    seed,
    at(element, seconds) {
      const lane = lanes[element];
      if (!lane) return [0, 0];
      // The envelope: a fluid ramp in, a hold, and a deceleration to rest so the
      // sphere is *still* when its fall begins. §6.4's "fluid deceleration into
      // mechanical certainty" is this curve.
      const t = Math.max(0, Math.min(1, seconds / AGITATE_SECONDS));
      const rise = Math.min(1, t / 0.16);
      const settle = t > 0.74 ? 1 - (t - 0.74) / 0.26 : 1;
      const envelope = rise * rise * (3 - 2 * rise) * Math.max(0, settle) ** 1.4;
      // The damped-sine tumble rides on top of the Lissajous sweep at the base
      // frequency, decaying with ζ, which is what makes it look like water
      // resisting rather than a ball on a string.
      const damp = Math.exp(-ZETA * BASE_HZ * seconds * 0.5);
      const tumble = lane.wobble * damp * Math.sin(2 * Math.PI * BASE_HZ * seconds + lane.px);
      const x = lane.ax * (Math.sin(2 * Math.PI * lane.fx * seconds + lane.px) + tumble);
      const y = lane.ay * (Math.sin(2 * Math.PI * lane.fy * seconds + lane.py) + tumble * 0.6);
      return [x * envelope, y * envelope];
    },
  };
}

/* ------------------------------------------------------------------ ticker -- */

type Frame = (elapsedMs: number) => void;

/**
 * One `requestAnimationFrame` loop for the whole client.
 *
 * Two loops on a mid-range phone is two wake-ups per frame and two chances to
 * miss one. Callers add and remove a frame function; the loop runs only while
 * at least one is registered, so an idle table screen schedules nothing.
 */
class Ticker {
  #frames = new Set<Frame>();
  #handle = 0;
  #started = 0;

  add(frame: Frame): () => void {
    this.#frames.add(frame);
    if (this.#handle === 0) {
      this.#started = performance.now();
      this.#handle = requestAnimationFrame(this.#tick);
    }
    return () => this.remove(frame);
  }

  remove(frame: Frame): void {
    this.#frames.delete(frame);
    if (this.#frames.size === 0 && this.#handle !== 0) {
      cancelAnimationFrame(this.#handle);
      this.#handle = 0;
    }
  }

  readonly #tick = (now: number): void => {
    const elapsed = now - this.#started;
    for (const frame of this.#frames) frame(elapsed);
    this.#handle = this.#frames.size > 0 ? requestAnimationFrame(this.#tick) : 0;
  };
}

export const ticker = new Ticker();
