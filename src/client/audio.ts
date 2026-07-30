/**
 * The sound layer, synthesised — no audio files, no samples, no payload.
 *
 * docs/DESIGN.md §8 is the spec and it is unusually prescriptive, because the
 * sound is where a game of this shape is most tempted to lie. The rules this
 * module exists to keep, in the order they matter:
 *
 * 1. **Everything is playable muted.** Audio is atmosphere and confirmation
 *    only; it never carries information the screen does not. Nothing in this
 *    file is consulted by anything that decides or displays an outcome.
 * 2. **The locks play the same rising phrase every round, whatever the result.**
 *    A struck-glass tone per slot from a five-note (seven in SEVEN) pentatonic
 *    set, ascending by slot index, slot 1 lowest. The audio must not dramatise a
 *    win before settlement and must not signal a loss early, so the phrase
 *    cannot depend on the outcome — and here it cannot, because `lock()` is
 *    given a slot index and nothing else.
 * 3. **A win, and only a win, blooms into a chord.** The trigger is the server's
 *    `presentation.celebrate` — `creditedChips > totalStakeChips` on the round,
 *    evaluated once in `roundPresentation` — never "a line hit". Within genuine
 *    wins the treatment is scaled by **voicing, not loudness** (§8), so a small
 *    win is not made to feel like a failure.
 * 4. **A loss makes no sound at all.** No sting, no descending tone, no negative
 *    cue — and equally no chord. The bed simply returns. Both halves are hard
 *    rules (§10), so there is no `lose()` method to call by accident.
 * 5. **No per-line audio during SETTLE.** Lines change state as the tube fills
 *    (§2.1); a cue per line would turn honest early information into eleven
 *    little drum rolls. There is no API for it here either.
 *
 * The randomised grain in the agitation is **seeded from the transcript** (§8),
 * so a replay sounds identical and a clip is reproducible — the same property
 * §7 technique 7 gives the picture.
 *
 * Autoplay: the context is created on the first real user gesture and never
 * before, so nothing is ever heard before the player has touched the screen.
 * The preference is remembered; the context is not resumed without a gesture.
 */

import type { BetInfo } from './types.js';

/** The mix target §8 publishes. Not a measurement — a bus level chosen for it. */
const MASTER = 0.5;
const STORE_KEY = 'aether.sound';

/**
 * A major pentatonic, ascending, as semitone offsets from the root.
 *
 * Seven entries because SEVEN needs seven and §12 wants the rising phrase to get
 * *longer* in the high-volatility variant rather than tighter; CLASSIC uses the
 * first five. The root is a fifth octave C so the locks read as struck glass
 * rather than as a bell.
 */
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14] as const;
const ROOT_HZ = 523.25;

const semitone = (steps: number): number => ROOT_HZ * 2 ** (steps / 12);

/** xorshift32 over the transcript seed — the same stream shape as choreo.ts. */
function stream(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Which win this is, as a tier.
 *
 * Taken from the catalogue's own published type rather than restated, so a tier
 * that appears in the paytable and not here is a compile error rather than a
 * silently unvoiced celebration.
 */
export type WinVoicing = BetInfo['tier'];

export class Sound {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #bed: GainNode | null = null;
  #bedFilter: BiquadFilterNode | null = null;
  #sub: GainNode | null = null;
  #noise: AudioBuffer | null = null;
  #muted: boolean;
  /** Set once a real gesture has been seen; nothing sounds before it. */
  #armed = false;

  constructor() {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORE_KEY);
    } catch {
      stored = null;
    }
    this.#muted = stored === 'off';
  }

  get muted(): boolean {
    return this.#muted;
  }

  /**
   * Called from the first pointerdown anywhere in the app.
   *
   * Browsers refuse to start an `AudioContext` outside a user gesture, and that
   * refusal is the right default rather than an obstacle: a casino game that
   * makes noise before the player has touched it is a game the player mutes at
   * the OS level and never unmutes.
   */
  arm(): void {
    if (this.#armed) return;
    this.#armed = true;
    if (!this.#muted) this.#start();
  }

  toggleMute(): boolean {
    this.#muted = !this.#muted;
    try {
      window.localStorage.setItem(STORE_KEY, this.#muted ? 'off' : 'on');
    } catch {
      /* A private window is not a reason to fail a tap. */
    }
    if (this.#muted) {
      this.#stop();
    } else if (this.#armed) {
      this.#start();
    }
    return this.#muted;
  }

  /* ------------------------------------------------------------- the bed -- */

  #start(): void {
    if (this.#context) {
      void this.#context.resume();
      this.#bed?.gain.setTargetAtTime(0.16, this.#context.currentTime, 0.4);
      this.#sub?.gain.setTargetAtTime(0.3, this.#context.currentTime, 0.4);
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    this.#context = context;

    // A soft-knee compressor on the bus, so a lock landing on top of the bed
    // never clips and the chord does not have to be loud to feel big.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 12;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.2;
    limiter.connect(context.destination);

    const master = context.createGain();
    master.gain.value = MASTER;
    master.connect(limiter);
    this.#master = master;

    // §8: "42 Hz sub drone plus filtered pink noise, slow 0.1 Hz filter sweep.
    // Present from IDLE, always."
    const subGain = context.createGain();
    subGain.gain.value = 0.0001;
    subGain.connect(master);
    const sub = context.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 42;
    sub.connect(subGain);
    sub.start();
    // A second oscillator a hair off pitch gives the drone a slow beat, which is
    // what stops 42 Hz reading as a test tone.
    const subDetune = context.createOscillator();
    subDetune.type = 'sine';
    subDetune.frequency.value = 42.7;
    const subDetuneGain = context.createGain();
    subDetuneGain.gain.value = 0.4;
    subDetune.connect(subDetuneGain).connect(subGain);
    subDetune.start();
    subGain.gain.setTargetAtTime(0.3, context.currentTime, 1.2);
    this.#sub = subGain;

    this.#noise = pinkNoise(context, 4);
    const bedGain = context.createGain();
    bedGain.gain.value = 0.0001;
    bedGain.connect(master);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 1.4;
    filter.connect(bedGain);
    const bedSource = context.createBufferSource();
    bedSource.buffer = this.#noise;
    bedSource.loop = true;
    bedSource.connect(filter);
    bedSource.start();
    // The 0.1 Hz sweep, as an LFO on the cutoff rather than as a scheduled ramp:
    // it has to keep breathing for a twenty-minute session without a timer.
    const sweep = context.createOscillator();
    sweep.frequency.value = 0.1;
    const sweepDepth = context.createGain();
    sweepDepth.gain.value = 190;
    sweep.connect(sweepDepth).connect(filter.frequency);
    sweep.start();
    bedGain.gain.setTargetAtTime(0.16, context.currentTime, 1.2);
    this.#bed = bedGain;
    this.#bedFilter = filter;
  }

  #stop(): void {
    const context = this.#context;
    if (!context) return;
    this.#bed?.gain.setTargetAtTime(0.0001, context.currentTime, 0.12);
    this.#sub?.gain.setTargetAtTime(0.0001, context.currentTime, 0.12);
    // Suspended rather than closed: a player toggling sound twice should not pay
    // for a second graph, and a closed context cannot be reopened.
    window.setTimeout(() => {
      if (this.#muted) void context.suspend();
    }, 400);
  }

  /** True when there is a live graph to schedule against. */
  #live(): AudioContext | null {
    if (this.#muted || !this.#armed) return null;
    const context = this.#context;
    if (!context) return null;
    if (context.state === 'suspended') void context.resume();
    return context;
  }

  /* ----------------------------------------------------------- the beats -- */

  /**
   * CHARGE — §8: "a rising resonant filter on the noise bed, no new source. The
   * chamber gets louder, not busier."
   */
  charge(ms: number): void {
    const context = this.#live();
    if (!context || !this.#bedFilter || !this.#bed) return;
    const now = context.currentTime;
    const seconds = ms / 1000;
    this.#bedFilter.frequency.cancelScheduledValues(now);
    this.#bedFilter.frequency.setTargetAtTime(1700, now, seconds * 0.5);
    this.#bedFilter.Q.setTargetAtTime(6.5, now, seconds * 0.5);
    this.#bed.gain.setTargetAtTime(0.26, now, seconds * 0.6);
  }

  /**
   * AGITATE — granular water impacts, pitch-randomised ±2 semitones, seeded from
   * the transcript so a replay is identical (§8). A liquid murmur, not a rattle:
   * every grain is filtered noise with a fast decay, never a tone.
   */
  agitate(ms: number, seed: number): void {
    const context = this.#live();
    if (!context || !this.#noise || !this.#master) return;
    const next = stream(seed);
    const count = Math.max(6, Math.round(ms / 52));
    for (let index = 0; index < count; index += 1) {
      const at = context.currentTime + (index / count) * (ms / 1000) + next() * 0.012;
      // ±2 semitones around a 900 Hz body, per §8's pitch randomisation.
      const cents = (next() * 4 - 2) / 12;
      this.#grain(
        context,
        at,
        900 * 2 ** cents,
        0.055 + next() * 0.05,
        0.1 + next() * 0.09,
        next() * 3,
      );
    }
    this.#bedFilter?.frequency.setTargetAtTime(1200, context.currentTime, 0.3);
  }

  /**
   * One water impact: bandpassed noise with an exponential decay.
   *
   * `offset` is where in the noise buffer the grain reads from, and it is a
   * parameter rather than a `Math.random()` because §8's randomisation is seeded
   * from the transcript: a grain that picked its own start would make the same
   * round sound different on replay.
   */
  #grain(
    context: AudioContext,
    at: number,
    hz: number,
    length: number,
    level: number,
    offset = 0,
  ): void {
    if (!this.#noise || !this.#master) return;
    const source = context.createBufferSource();
    source.buffer = this.#noise;
    source.loop = true;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = hz;
    band.Q.value = 2.2;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(band).connect(gain).connect(this.#master);
    source.start(at, offset);
    source.stop(at + length + 0.02);
  }

  /**
   * One lock — the crystalline tink.
   *
   * Struck glass, additively: three inharmonic partials with very different
   * decays plus a short noise transient for the strike. `slot` is 1-indexed from
   * the bottom of the tube and picks the note, so the phrase ascends with the
   * column and is identical in every round (§8 rule 2 above).
   */
  lock(slot: number, of: number): void {
    const context = this.#live();
    if (!context || !this.#master) return;
    const step = PENTATONIC[Math.min(PENTATONIC.length - 1, slot - 1)] ?? 0;
    const base = semitone(step);
    const at = context.currentTime + 0.004;
    // Glass rings above its fundamental and decays fastest at the top.
    const partials: [number, number, number][] = [
      [1, 0.16, 1.5],
      [2.76, 0.075, 0.8],
      [5.4, 0.032, 0.45],
    ];
    for (const [ratio, level, decay] of partials) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = base * ratio;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(level, at + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      oscillator.connect(gain).connect(this.#master);
      oscillator.start(at);
      oscillator.stop(at + decay + 0.05);
    }
    this.#grain(context, at, base * 3.1, 0.05, 0.07);
    // The bed relaxes one step per lock: by the last one the chamber is quiet
    // again, which is what makes the close feel like an ending without a cue.
    const remaining = Math.max(0, of - slot) / Math.max(1, of);
    this.#bedFilter?.frequency.setTargetAtTime(420 + remaining * 700, context.currentTime, 0.25);
    this.#bed?.gain.setTargetAtTime(0.16 + remaining * 0.06, context.currentTime, 0.25);
  }

  /**
   * The celebrated close — §9 step 1: "audio ducks to the single 42 Hz sub tone.
   * Everything else drops out."
   *
   * Called only when the server said `celebrate`. There is no counterpart for a
   * losing close, on purpose: a losing round's close is 430 ms with no audio
   * event at all, and the absence is the rule (§9).
   */
  duck(ms: number): void {
    const context = this.#live();
    if (!context) return;
    this.#bed?.gain.setTargetAtTime(0.02, context.currentTime, ms / 3000);
    this.#sub?.gain.setTargetAtTime(0.42, context.currentTime, ms / 3000);
  }

  /**
   * The win — the pentatonic set blooms into a chord plus one sub drop.
   *
   * `voicing` is the tier of the best line that won, and it changes **which
   * notes sound**, never how loud they are (§8). ORDER gets the glass arpeggio
   * ringing up through the set; FLOW gets a root and a fifth. A 1.92× win is a
   * real win and is allowed to feel like one.
   */
  win(voicing: WinVoicing): void {
    const context = this.#live();
    const master = this.#master;
    if (!context || !master) return;
    const at = context.currentTime + 0.01;
    const steps =
      voicing === 'ORDER'
        ? [0, 4, 7, 9, 12, 16, 19]
        : voicing === 'FORM'
          ? [0, 4, 7, 12]
          : [0, 7];
    const spread = voicing === 'ORDER' ? 0.075 : voicing === 'FORM' ? 0.05 : 0.03;
    steps.forEach((step, index) => {
      const start = at + index * spread;
      const oscillator = context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = semitone(step);
      const gain = context.createGain();
      const level = 0.1 / Math.sqrt(steps.length / 2);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.5);
      oscillator.connect(gain).connect(master);
      oscillator.start(start);
      oscillator.stop(start + 1.6);
    });

    // One sub drop. One, and it is the same one at every tier — the drop is the
    // full-frequency return §9 step 5 asks for, not a size indicator.
    const drop = context.createOscillator();
    drop.type = 'sine';
    drop.frequency.setValueAtTime(96, at);
    drop.frequency.exponentialRampToValueAtTime(38, at + 0.55);
    const dropGain = context.createGain();
    dropGain.gain.setValueAtTime(0.0001, at);
    dropGain.gain.exponentialRampToValueAtTime(0.34, at + 0.02);
    dropGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
    drop.connect(dropGain).connect(master);
    drop.start(at);
    drop.stop(at + 1);

    this.#bed?.gain.setTargetAtTime(0.16, at + 0.2, 0.4);
    this.#sub?.gain.setTargetAtTime(0.3, at + 0.6, 0.6);
    this.#bedFilter?.frequency.setTargetAtTime(420, at + 0.2, 0.5);
  }

  /**
   * The bed, restored.
   *
   * Every round ends here — the winning ones after their chord and the losing
   * ones with nothing having happened at all.
   */
  rest(): void {
    const context = this.#live();
    if (!context) return;
    this.#bedFilter?.frequency.cancelScheduledValues(context.currentTime);
    this.#bedFilter?.frequency.setTargetAtTime(420, context.currentTime, 0.6);
    this.#bedFilter?.Q.setTargetAtTime(1.4, context.currentTime, 0.6);
    this.#bed?.gain.setTargetAtTime(0.16, context.currentTime, 0.6);
    this.#sub?.gain.setTargetAtTime(0.3, context.currentTime, 0.6);
  }

  /** A confirmation tick for a tap. Never used to mark an outcome. */
  tick(): void {
    const context = this.#live();
    if (!context || !this.#master) return;
    const at = context.currentTime + 0.002;
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 1180;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.05, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    oscillator.connect(gain).connect(this.#master);
    oscillator.start(at);
    oscillator.stop(at + 0.06);
  }
}

/**
 * Pink noise, generated once.
 *
 * Voss–McCartney's filter form: white noise through a fixed IIR whose response
 * is −3 dB/octave. Four seconds looped is long enough that the loop point is
 * inaudible under a 0.1 Hz filter sweep, and it is the only "asset" the sound
 * layer has — computed, not downloaded.
 *
 * The white source is a **fixed-seed** stream rather than `Math.random()`. The
 * bed is atmosphere and nobody could hear the difference, but the agitation
 * grains read out of this same buffer, and §8's promise that a replay sounds
 * identical is only true if the buffer they read is too.
 */
function pinkNoise(context: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  const random = stream(0x41455448);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let index = 0; index < length; index += 1) {
    const white = random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    data[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return buffer;
}

/**
 * Haptics — §8: one 8 ms light impact per lock, one 24 ms medium on a win,
 * nothing on a loss, and **off by default on Android where implementations
 * vary**.
 *
 * `navigator.vibrate` exists only on Android, so "off by default on Android"
 * plus "the only platform with the API is Android" means the honest default is
 * off everywhere and the control is a preference. iOS has no web haptic API at
 * all, so on the reference iPhone this is a no-op however it is set — stated
 * here rather than left to look like a bug.
 */
export const haptics = {
  enabled: false,
  lock(): void {
    if (this.enabled) navigator.vibrate?.(8);
  },
  win(): void {
    if (this.enabled) navigator.vibrate?.(24);
  },
};

export const sound = new Sound();
