# AETHER ORDER — product design specification

Five coloured spheres float in a sealed glass chamber. Impellers agitate the
fluid, then the spheres settle one at a time into a vertical tube. That settled
order is the round. You bet on the order.

This document is the complete product spec: the loop, every player decision and
its exact effect, the bet menu, the portrait UX screen by screen, the art
direction, the rendering approach, the sound, the signature clip moment, and the
responsible-design rules the build must not violate. All mathematics lives in
[`MATH.md`](./MATH.md); all protocol lives in [`ENGINE.md`](./ENGINE.md).

---

## 1. The three-second test

A new player opens the game and sees, in this order:

1. **Five glowing spheres** suspended in a dark, faintly cyan liquid column.
2. **A tube with five numbered slots**, empty, running up the middle.
3. **One line of copy:** *"They settle in a random order. Bet on the order."*
4. **Chips with multipliers on them.** `1.92×`, `2.40×`, `4.80×`, `115.20×`.

That is the whole game. There is no meter to learn, no ladder, no currency
beyond the balance, no second screen. If a first-time player cannot place a bet
within three seconds of the chamber rendering, the layout has failed and must be
changed — this is a build acceptance criterion, tested with five unprompted
first-time users per milestone.

**Design axiom.** The fantasy is *order out of chaos*. Everything in the
production — the agitation, the settling cadence, the rising musical phrase, the
gold ring that locks each slot — serves the transition from turbulence to a
fixed, legible column. Nothing in the production may suggest that the player
influences that transition, because they do not.

---

## 2. Round anatomy

One round, start to credited, is about four seconds.

| # | Beat | Duration | What the player sees | What the system does |
| --- | --- | --- | --- | --- |
| 0 | **IDLE** | — | Spheres drift; tube empty; seed chip amber | Server seed drawn; the round context (variant, round id, nonce) and `seedCommitment` published and shown |
| 1 | **BUILD** | player-paced | Chips; running stake and max return | Nothing random; no timer that can expire into a bet |
| 2 | **COMMIT** | 120 ms | CTA collapses into the ticket strip | Wallet debited; ticket + client seed frozen; permutation derived |
| 3 | **CHARGE** | 260 ms | Impeller rings spin up; liquid tint deepens 8% | Choreography track built from the transcript |
| 4 | **AGITATE** | 900 ms | Spheres orbit; bubble field; chamber hum rises | Nothing — purely presentational |
| 5 | **SETTLE** | 2,110 ms (CLASSIC) / 2,590 ms (SEVEN) | Spheres fall into slots one by one, bottom to top; a gold ring locks each | Emits `slotLocked` events from the transcript |
| 6 | **RESOLVE** | 600 ms | Winning lines light in tier order; losers fade to 40% | Settlement already computed; this is display only |
| 7 | **STAMP** | 220 ms | Total multiplier stamps; balance counts up | Wallet credited |
| 8 | **REVEAL** | — | Seed chip turns gold: *verified locally* | Server seed revealed; client re-derives and checks both hashes |

Total: ~4.2 s (CLASSIC), ~4.7 s (SEVEN). **SKIP** jumps from beat 3 to beat 6 in
~1.0 s and is remembered as a preference.

The settle order shown is the transcript's permutation, read bottom to top. A
player who screenshots the tube has screenshotted the outcome; nothing is hidden
behind the animation.

---

## 3. Player decisions — and exactly what each one changes

This section is the anti-fake-agency contract. Every control in the game appears
here with its effect on the outcome distribution stated plainly.

| # | Decision | When | Effect on the distribution | Effect on RTP |
| --- | --- | --- | --- | --- |
| D0 | **Client seed** (optional string) | before COMMIT | Changes *which* permutation is drawn. Does not change its distribution — for every client seed the permutation is uniform on `S_n`. | none |
| D1 | **Variant** CLASSIC / SEVEN | before COMMIT | Changes `n`, the outcome space and the volatility. | none — both are 96.000% |
| D2 | **Bet lines** (which types, which parameters, ≤ 12) | before COMMIT | Changes the variance of the round. | none — every bet type is 96.000% |
| D3 | **Stake per line** | before COMMIT | Scales expected value and standard deviation linearly; variance by the square. | none |
| D4 | **COMMIT** | the moment of commitment | None. The permutation is already fixed by the committed seed. | none |
| — | **SKIP / MUTE / REPLAY / haptics / chamber skin** | after COMMIT | None. These are not inputs to the derivation and cannot be — the transcript must re-derive on a verifier that has no UI context. | none |

**After COMMIT there is no decision of any kind.** No cash-out, no double-up, no
gamble ladder, no "stop the shake", no mid-fall pick, no insurance, no side bet.

This is a deliberate product constraint, not an omission. A post-commit control
whose value depends on partial information is precisely where three bad things
enter a casino game at once: fake agency (a button that feels like skill and
isn't), a latency-sensitive money decision (a player on 4G loses value a player
on fibre keeps), and a loss-chasing hook. AETHER ORDER has none of them because
it has no post-commit decision surface at all.

**Two things that look like agency and are not, and must be labelled as such in
the UI:**

- *The shake.* The agitation is choreography. The tooltip on the chamber reads:
  *"The order was fixed when you committed. The shake is how we show it."*
- *The client seed.* The fairness sheet reads: *"Your seed changes which order
  comes up. It cannot change your odds — every seed gives the same 96%."*

---

## 4. Bet menu

Ten bet types in three tiers. Every one pays a theoretical 96.000%. The tier is
**volatility**, never value — the client is required to say so on the tier tab.

### FLOW — lands often

| Chip | You pick | Wins when | CLASSIC | SEVEN |
| --- | --- | --- | --- | --- |
| **BEFORE** | two colours, in order | the first settles below the second | `1.92×` | `1.92×` |
| **EARLY** | one colour | it is one of the first two to settle | `2.40×` | `3.36×` |
| **LATE** | one colour | it is one of the last two to settle | `2.40×` | `3.36×` |
| **LINK · EITHER** | two colours | they settle side by side, either order | `2.40×` | `3.36×` |

### FORM — the core game

| Chip | You pick | Wins when | CLASSIC | SEVEN |
| --- | --- | --- | --- | --- |
| **FIRST** | one colour | it settles first | `4.80×` | `6.72×` |
| **LAST** | one colour | it settles last | `4.80×` | `6.72×` |
| **SLOT** | one colour, one slot | it settles in exactly that slot | `4.80×` | `6.72×` |
| **LINK** | two colours, in order | the second settles directly above the first | `4.80×` | `6.72×` |

### ORDER — the reason to watch

| Chip | You pick | Wins when | CLASSIC | SEVEN |
| --- | --- | --- | --- | --- |
| **OPENING** | two colours, in order | they are the first two, in that order | `19.20×` | `40.32×` |
| **FULL ORDER** | the whole column | every sphere lands exactly where you said | `115.20×` | `4838.40×` |

FIRST and LAST are one-tap presets of SLOT. They are priced identically — using
the convenience control never costs anything. The paytable sheet says this in
one line so nobody has to work it out.

**Ticket rules.** Up to 12 lines. Stake per line 0.25 – 50.00, in 0.25 steps.
Ticket total ≤ 200.00. A ticket carries **distinct claims only** — tapping the
same chip with the same picks raises that line's stake rather than adding a
second row, which keeps the per-line ceiling meaningful. The ticket strip always
shows, in tabular figures: lines · total stake · *maximum return if every line
hits*. The last figure is computed exactly, never rounded up, and never framed
as expected.

---

## 5. Mobile-first portrait UX

Reference device 390 × 844 (iPhone 14 / Pixel 8 class). Portrait only. Every
interactive element sits below y = 552, inside the one-handed thumb zone.
Minimum tap target 44 × 44. The chamber is never a tap target during a round.

### S1 — TABLE (the home screen; 95% of session time)

```
 54 ┌───────────────────────────────────────────┐
    │  ⌂  BALANCE 128.50        [FREE PLAY]  ◈  │  56  top rail
110 ├───────────────────────────────────────────┤
    │                                           │
    │                 ╭─────╮                   │
    │        ●        │  5  │        ●          │
    │                 │  4  │                   │  430  chamber + tube
    │    ●            │  3  │      ●            │      (tube 96 wide,
    │                 │  2  │                   │       slots 78 tall)
    │            ●    │  1  │                   │
    │                 ╰─────╯                   │
540 ├───────────────────────────────────────────┤
552 │   FLOW  ·  FORM  ·  ORDER                 │  44  tier tabs
596 ├───────────────────────────────────────────┤
604 │  ┌──────┐┌──────┐┌──────┐┌──────┐         │  88  chip rail
    │  │FIRST ││ SLOT ││ LINK ││ LAST │  →      │      (h-scroll)
692 │  │4.80× ││4.80× ││4.80× ││4.80× │         │
    ├───────────────────────────────────────────┤
700 │  3 lines · 3.00 · max 139.20              │  36  ticket strip
736 ├───────────────────────────────────────────┤
744 │  ▮▮▮▮▮▮▮▮  COMMIT  3.00  ▮▮▮▮▮▮▮▮         │  56  primary CTA
800 └───────────────────────────────────────────┘
810                  ▁▁▁▁▁▁                        home indicator
```

- Tier tabs are **labelled with what they mean**: `FLOW · lands often`,
  `FORM · the core game`, `ORDER · rare, big`. Never "low/medium/high risk"
  without the plain-language gloss.
- Tapping a chip opens the picker sheet (S2). Chips already on the ticket show a
  gold count badge and a long-press removes them.
- The `◈` chip top-right is the fairness state: **amber** = committed,
  **gold** = verified locally after reveal. One tap opens S6.

### S2 — PICKER SHEET (bottom sheet, 62% height, drag to dismiss)

Content depends on the chip's arity, and never more than two taps:

- *one colour*: a row of colour tokens, 56 px, each with its glyph and name.
- *one colour + one slot*: colour row, then a vertical slot strip that mirrors
  the real tube — the player picks the slot **on a picture of the tube**, not
  from a number list. This is the single most important affordance in the game.
- *two colours, in order*: two ordered wells labelled `FIRST PICK` /
  `SECOND PICK`, with a live sentence underneath: *"AMBER settles before AQUA."*
  The sentence is the confirmation, not the icons.

Stake stepper is pinned to the sheet's bottom bar with the ladder as discrete
stops. **The stepper never pre-selects a value higher than the previous round's.**

### S3 — TICKET REVIEW (expanded ticket strip, tap to expand)

One row per line: chip name, the plain-language claim, stake, multiplier,
return-if-hit. A `CLEAR ALL` that requires a second confirm. Nothing here is
timed.

### S4 — ROUND

Chamber goes full-bleed: the rail dims to 20% and stops accepting input; the
ticket strip stays visible and pinned so the player can watch their lines. A
thin progress hairline under the top rail tracks the settle cadence. `SKIP` is a
32 px text button, top-right, no confirm.

### S5 — RESULT

Winning lines slide to the top of the ticket strip and light gold; losing lines
fade to 40% opacity and stay in place (they are not removed, hidden, or
animated away — see §9). The total stamps over the tube. Two buttons:
`REBET` (same lines, same stakes) and `NEW TICKET`. Neither is pre-focused.

### S6 — FAIRNESS

Full-screen sheet, mono type. Shows: seed commitment (published pre-round),
client seed (editable, with a `RANDOMISE` button), nonce, round id, revealed
server seed, the derived permutation, and both recomputed hashes with a green
`VERIFIED LOCALLY` state. A `COPY TRANSCRIPT` button and a `HOW THIS WORKS`
expander with the four-step explanation in plain language. **This screen is one
tap from the result at all times**; it is never buried in settings.

### S7 — HISTORY

Reverse-chronological rounds: permutation strip, ticket, net. Each row taps
through to S6 for that round. Header shows **session elapsed time** and
**session net position in currency** — never "wins" or a streak count.

### S8 — PAYTABLE · S9 — LIMITS & PLAY CONTROLS

S8 is the table from §4 with the exact probability shown next to every
multiplier. S9 holds session limit, loss limit, reality-check interval, and the
self-exclusion hand-off. Both are reachable from the `⌂` menu in two taps.

---

## 6. Art direction

**One sentence:** laboratory-grade glass, abyssal water, seven colours of light,
one metal.

### 6.1 Palette

Environment — the whole world is neutral so the spheres are the only colour.

| Token | Hex | Use |
| --- | --- | --- |
| `--void` | `#05070C` | page background, outside the chamber |
| `--abyss` | `#0A1220` | chamber back plate |
| `--brine-deep` | `#0C1E30` | liquid, bottom of the column |
| `--brine` | `#10283F` | liquid, mid |
| `--brine-lit` | `#17405C` | liquid where the key light passes |
| `--glass-edge` | `#7FA6C4` | glass edge tint, 6 px inner gradient |
| `--chrome` | `#C3CEDA` | housing, lit face |
| `--chrome-mid` | `#7A8695` | housing, body |
| `--chrome-dark` | `#414B58` | housing, shadow side |
| `--specular` | `#EAF3FA` | the thin white highlight line |
| `--gold` | `#C9A24A` | **the only accent metal** |
| `--gold-hot` | `#F0D089` | gold at bloom |
| `--ink` | `#E7EEF5` | primary text |
| `--ink-dim` | `#93A3B4` | secondary text |
| `--win` | `#4CE0A6` | win state only |
| `--scrim` | `rgba(5,7,12,0.72)` | sheet backdrop |

Spheres — each is a body tint plus an emissive core plus a glyph.

| Element | Body | Emissive core | Glyph |
| --- | --- | --- | --- |
| AMBER | `#FFB020` | `#FFD98A` | filled disc |
| CORAL | `#FF5A5F` | `#FFB0B3` | ring |
| VIOLET | `#A06BFF` | `#D3BAFF` | triangle |
| AQUA | `#2FE0C8` | `#A6F5E8` | square |
| IVORY | `#F2F4F8` | `#FFFFFF` | diamond |
| INDIGO *(SEVEN)* | `#4C6BFF` | `#B0C0FF` | chevron |
| ROSE *(SEVEN)* | `#FF7FD1` | `#FFC7EA` | hexagon |

**Colour is never the only channel.** Every sphere carries its glyph etched into
the body, and every ticket line names the colour in text. The palette is
deliberately spread across lightness as well as hue so it survives
protanopia/deuteranopia; the glyphs carry it the rest of the way.

Gold appears in exactly three places: the slot ring at the moment it locks, the
multiplier stamp, and the fairness chip once verified. Nowhere else, ever. Gold
means *this is settled and true*.

### 6.2 Materials

- **Chamber glass** — borosilicate, 2.4 mm wall, IOR 1.47. Rendered as a 6 px
  inner edge gradient to `--glass-edge`, plus one 1 px `--specular` line down
  the left third. Never a full glass shader.
- **Liquid** — glycerol-like, faintly cyan-absorbing. Vertical gradient
  `--brine-deep` → `--brine` → `--brine-lit`, plus a scrolling caustic.
  Beer–Lambert depth is faked with the gradient; there is no volumetric pass.
- **Housing** — brushed 316 steel. Anisotropic highlight runs *horizontally*
  across the collar rings; grain is a 128 × 128 tiled noise at 6% opacity.
- **Spheres** — cast resin with an emissive core, **not chrome**. Chrome balls
  read as pachinko; resin with an internal glow reads premium and holds up on
  OLED where the background is true black. No rim light (see reference 3).
- **Gold** — PVD, warm, low roughness, one thin specular line. Never gradient
  mesh, never a "shiny gold" bevel.

### 6.3 Lighting

- **Key:** single, cool (≈6200 K), above-left at 35°, intensity 1.0.
- **Fill:** warm bounce (≈3000 K) off the base plate, intensity 0.12.
- **Rim:** none on spheres. Deliberate — they emit, they are not lit.
- **Caustic:** one elliptical caustic on the base plate, driven by the same
  noise field as the liquid so the two never desync.
- **Bloom:** threshold 0.78, radius 12 px at 390 px width, applied only to
  emissive cores and gold. If bloom ever touches the chrome, the value is wrong.

### 6.4 Motion language

The vocabulary is *fluid deceleration into mechanical certainty*. Turbulent,
overlapping, organic during agitation; crisp, staggered, snapped during settle.

| Beat | Duration | Easing | Detail |
| --- | --- | --- | --- |
| Charge | 260 ms | `cubic-bezier(.4,0,.2,1)` | impeller rings spin up; liquid tint +8% |
| Agitate | 900 ms | damped sine, 3.2 Hz, ζ = 0.28 | spheres on Lissajous paths, phase-offset per sphere |
| Settle stagger | 420 ms (CLASSIC) / 360 ms (SEVEN) | — | interval between locks |
| Fall | 340 ms | `cubic-bezier(.16,1,.3,1)` | expo-out; the sphere never overshoots its slot |
| Lock rebound | 90 ms | `cubic-bezier(.34,1.56,.64,1)` | 4% overshoot on the *ring*, chamber flexes 2 px |
| Resolve | 600 ms | `cubic-bezier(.2,.8,.2,1)` | winning lines light in tier order, FLOW → ORDER |
| Stamp | 220 ms | `cubic-bezier(0,.7,.2,1)` | multiplier scales 1.18 → 1.00 |

Rules: nothing bounces except the lock ring. Nothing rotates on screen except
the impellers. No easing curve is linear. `prefers-reduced-motion` replaces
agitate with a 200 ms cross-dissolve and the falls with 120 ms fades, keeping
the same total duration so the audio phrase still lands.

### 6.5 Typography

- **Display / UI:** Neue Haas Grotesk Display Pro 65 Medium. Fallback stack
  `"Inter Tight", "Helvetica Now Display", system-ui, sans-serif`.
- **Technical (seeds, hashes, transcripts):** JetBrains Mono 400, tracking
  `+0.02em`, hashes truncated with a mid-ellipsis at 16 characters.
- **Scale at 390 px:** 40 / 28 / 22 / 17 / 15 / 13 / 11. Line height 1.05 for
  display, 1.4 for body.
- **Numerals are always `tabular-nums lining-nums`.** Balances and multipliers
  must not jitter as they count.
- **Multipliers always render with two decimals and the `×` glyph (U+00D7)** —
  `4.80×`, never `4.8x`. The paytable is exact to two places (see MATH §5); the
  type must not imply otherwise.
- No italics anywhere. Bet names and tier names are uppercase with `+0.06em`.

### 6.6 Three visual references

Described, not copied — these are qualities to hit, not images to reproduce.

1. **A chromatography column on a matte black bench.** Borosilicate tube of
   faintly tinted glycerol, one cool key from above-left. *Take from it:* the
   caustic ellipse thrown on the base plate, and the way the meniscus bends the
   far edge of the column into a single thin bright line. That line is the whole
   glass read; everything else is gradient.
2. **The sapphire caseback of a high-end mechanical watch.** Brushed steel, a
   blue-cast anti-reflective coating, one polished bevel catching a single white
   highlight. *Take from it:* restraint. One accent metal. Highlights that are
   *thin*. If the composition has two shiny things competing, delete one.
3. **Deep-sea bioluminescence footage.** A near-black field; one organism
   glowing from the inside with soft falloff and no rim light at all. *Take from
   it:* emissive-from-within. The spheres are light sources sitting in dark
   liquid, never objects lit from outside. On an OLED phone in a dark room this
   is what makes the game look expensive.

---

## 7. Rendering: premium fluid, no fluid simulation

**Constraint:** 60 fps on iPhone SE 2, Pixel 6a and Galaxy A54; hard floor
30 fps; ≤ 900 KB initial payload; battery-safe for 20-minute sessions. A
real-time fluid solver is off the table. None is needed.

**Principle:** the transcript is known the instant the round commits, so the
entire round is a *precomputed choreography track*. Nothing is solved at
runtime; everything is evaluated.

**Seven concrete techniques:**

1. **Choreography from the transcript.** At COMMIT the client builds a keyframe
   track: for each sphere, one cubic Bézier from its chamber position to its
   slot, plus a phase offset. The Béziers come from a build-time bake of
   `n × n` canonical paths in normalised tube space; the runtime picks
   `template[startLane][targetSlot]` and time-shifts it. No physics, no solver,
   no collision.
2. **The "fluid" is one fragment shader, not a sim.** A single full-screen pass
   over the tube rect does: a two-octave value-noise domain warp for caustics, a
   refraction offset that resamples the sphere layer, and a vertical depth
   gradient. At 390 × 430 logical, rendered at 0.75× and upscaled, that is
   ≈ 94k fragments per frame — comfortably inside budget on a mid-range GPU.
3. **Spheres are sprites, not geometry.** One 256 × 256 grayscale master sprite,
   tinted per element at runtime, composited with a fixed specular layer and a
   fresnel rim mask. Apparent rotation comes from scrolling the interior caustic
   UV. Seven colours cost one texture.
4. **Bubbles are closed-form.** A fixed 256-particle point-sprite buffer whose
   position is an analytic function of time (sin/cos plus upward drift plus a
   per-particle seed). Evaluated in the vertex shader: no integration, no
   collisions, no CPU cost, and deterministic for clip export.
5. **Locks are uniforms.** Each settle injects one displacement pulse —
   `vec3(centreX, centreY, amplitude)` with exponential decay — into a
   `uniform vec3 pulses[8]`. Maximum seven concurrent. That single mechanism
   produces the ripple, the caustic kick and the chamber flex.
6. **A Canvas2D fallback lane.** If WebGL2 is unavailable, or a three-frame perf
   probe reports under 45 fps, the client swaps to Canvas2D: identical
   choreography and identical timing, spheres still sprites, and the fluid
   replaced by a pre-rendered 12-frame looping caustic sheet (512 × 512 WebP) at
   0.5 opacity over the static gradient. The downgrade is graceful and the round
   is *byte-identical in timing*, so audio sync and clip export are unaffected.
7. **Determinism.** Because the track is a pure function of the transcript, the
   same transcript replays frame-for-frame. That is what makes `REPLAY` real and
   what makes the shareable clip (§9) reproducible rather than re-recorded.

**Budget.** Sphere master 60 KB WebP · caustic sheet 180 KB WebP · subset fonts
90 KB WOFF2 · shaders 8 KB · JS ≈ 180 KB gzipped · audio 240 KB Opus.
Total ≈ 758 KB, leaving headroom under the 900 KB ceiling.

**What is explicitly not built:** SPH or grid fluid, soft-body spheres,
real-time refraction of the full scene, per-sphere 3D meshes, cloth, or any
runtime physics integration.

---

## 8. Sound direction

Everything is playable **muted** — audio never carries information the screen
does not. Mix bed at −18 LUFS with a −6 dB duck under any voice-over.

- **Chamber bed.** 42 Hz sub drone plus filtered pink noise, slow 0.1 Hz filter
  sweep. Present from IDLE, always.
- **Charge.** Impeller spin-up: a rising resonant filter on the noise bed, no
  new source. The chamber gets louder, not busier.
- **Agitate.** Granular water impacts, pitch-randomised ±2 semitones. The
  randomisation is **seeded from the transcript**, so a replay sounds identical
  and a clip is reproducible.
- **Locks.** A struck-glass tone per slot, drawn from a five-note (seven for
  SEVEN) pentatonic set, **ascending by slot index**. Slot 1 is the lowest.
  Every round therefore plays the same rising phrase regardless of outcome —
  which is the point: the audio must not dramatise a win before settlement, and
  it must not signal a loss early.
- **Win.** The pentatonic set blooms into a chord plus one sub drop. Scaled by
  tier, not by amount: a FLOW win and an ORDER win differ in *voicing*, not
  loudness, so a small win is not made to feel like a failure.
- **Loss.** Nothing. No sting, no descending tone, no negative cue. The bed
  simply returns. This is a hard rule (§9).
- **Haptics.** One 8 ms light impact per lock; one 24 ms medium on a win;
  nothing on a loss. Off by default on Android where implementations vary.

---

## 9. The signature moment: LOCK-OUT

**The mechanic.** A FULL ORDER ticket resolves one sphere early. Once `n−1`
spheres have settled in the ticket's order, only one sphere remains and only one
slot is open — the win is already certain while the last sphere is still in the
liquid.

**The production.** At the instant the `n−1`-th sphere locks and the ticket is
mathematically already won:

1. Audio ducks to the single 42 Hz sub tone. Everything else drops out.
2. The liquid desaturates toward monochrome over 400 ms; the settled spheres
   keep their colour and everything else goes grey.
3. The last sphere falls at **0.35× speed** — a 970 ms fall instead of 340 ms.
4. The tube's full-height gold rim ignites from the bottom up, tracking the
   fall.
5. On lock: full-frequency return, the pentatonic chord, and the multiplier
   stamps over the tube.

Total 3.4 s, portrait, and it ends on the number.

**Why it travels.** The tension resolves *before* the visual does. The viewer
knows the outcome and still has to watch it arrive — anticipation collapse
rather than surprise. That is a fundamentally more shareable shape than a reveal,
because the clip's emotional peak sits at second one, which is where a
vertical-feed viewer decides whether to keep watching.

**Why it is honest.** LOCK-OUT fires **if and only if the ticket wins.** It is
never a tease. Its trigger probability is exactly the FULL ORDER probability:
`1/120` in CLASSIC, `1/5040` in SEVEN.

**Hard rule — no manufactured near-miss.** The client must not add emphasis,
sound, colour, camera or slow-motion to partial progress on a **losing** ticket.
Three-of-five correct then wrong looks exactly like zero-of-five: same cadence,
same audio, same neutral lighting. Near-miss amplification is the single most
predatory technique in this genre and it is banned here at the render layer, not
just by policy. A losing round has no dramatic beats at all.

**Clip export.** `SHARE` produces a 1080 × 1920, ≤ 6 s, ≤ 4 MB MP4 rendered from
the transcript (not screen-recorded), with the round's commitment hash burned in
at the bottom in mono type. Anyone who receives the clip can paste that hash
into the verifier and confirm the round was real. The share artefact is
self-authenticating — which also means the studio cannot fake a marketing clip
without it being detectable.

---

## 10. Responsible design

These are build constraints. Violating one is a release blocker, not a
discussion.

**No loss-chasing mechanics.**
- No double-up, gamble ladder, or "risk your win" feature. Anywhere.
- No autoplay that continues through losses. If autoplay ships at all, it is
  count-bounded, stops on any single win above 20×, and is cancellable in one
  tap.
- No offer, bonus, prompt, or free round is ever triggered by a loss, a losing
  streak, or a balance drop. Triggers are time- and session-based only.
- `REBET` never pre-selects a stake higher than the previous round's. The
  stepper does not "helpfully" round up.
- Losing lines stay on screen, in place, at 40% opacity. They are not swept
  away, hidden, or animated out — the record of the round stays legible.
- No streak counters, no "hot colour", no recent-results frequency strip. Those
  displays manufacture the gambler's fallacy. History shows rounds and net
  position, nothing that implies a pattern.

**No misleading skill framing.**
- Banned in all copy, store listings and marketing: *predict, read, strategy,
  system, skill, beat, outsmart, edge, due, overdue, hot, cold, lucky streak.*
- Approved verbs: *choose, place, pick, watch, verify.*
- Every tier tab states volatility in plain language and never implies value.
- The paytable shows the exact probability beside every multiplier.
- The fairness sheet states, in one sentence, that all bets pay 96% and that no
  bet, seed, or pattern of play changes it. `MATH.md` §9 is the proof, linked
  from that sentence.

**No latency-sensitive money decisions.**
- Every money decision happens before COMMIT, with no countdown that can expire
  into a bet. If a shared-lobby timer ever ships, its expiry means **no bet**,
  never an auto-bet.
- COMMIT is idempotent and fenced by an idempotency key; a retry on a flaky
  connection cannot double-debit.
- A disconnect after COMMIT settles server-side and shows the completed result
  on reconnect. The player never loses value to their network.
- SKIP has no deadline and no effect on the outcome.

**Session tools, always available.**
- Session elapsed time and **net position in currency** are visible in S7 and in
  the reality-check card. Never "wins", never a streak.
- Reality check at 30 and 60 minutes, then hourly: a modal showing time played,
  total staked, and net, with `KEEP PLAYING` and `TAKE A BREAK`. Neither button
  is pre-focused or visually louder than the other.
- Session limit, loss limit and self-exclusion hand-off live in S9, reachable in
  two taps from anywhere.
- The fairness/verify screen is one tap from every result.

**Free play is the real game.** The free-play build uses the identical adapter,
identical paytable and identical derivation — no generous demo, no rigged
onboarding streak. A persistent `FREE PLAY` badge sits in the top rail. The test
suite covers a single shared paytable precisely so a divergent demo build cannot
exist.

---

## 11. Accessibility

- **Colour is never the only channel.** Glyph on every sphere, name in every
  ticket line, glyph repeated on every chip.
- **Contrast** (measured against `--void`): `--ink` 17.22:1, `--ink-dim` 7.81:1,
  `--gold` 8.40:1, `--win` 12.01:1. Every text token clears WCAG AAA for normal
  text (7:1); no token in the palette is allowed to ship below 4.5:1.
- **Reduced motion.** `prefers-reduced-motion` swaps agitation for a
  cross-dissolve and falls for fades, preserving total duration.
- **Muted play.** Complete. Audio is atmosphere and confirmation only.
- **Screen reader.** After settle, the tube announces the full order as a single
  live-region string: *"Settled order: amber, aqua, violet, ivory, coral."* Each
  ticket line announces its claim and its result. The fairness sheet is fully
  readable, hashes included.
- **Tap targets** ≥ 44 × 44 with 8 px minimum separation. No gesture is required
  anywhere; every drag has a tap equivalent.
- **Text scaling** to 200% without clipping; the chip rail reflows to two rows.

---

## 12. SEVEN — the high-volatility variant

Same chamber, two more spheres (INDIGO, ROSE), same bet catalogue, same 96.000%.
What changes is the shape of the ride: FORM lines go from 1-in-5 to 1-in-7,
OPENING from `19.20×` to `40.32×`, and FULL ORDER from `115.20×` to `4838.40×`
at 1-in-5040.

Production notes:
- Tube grows to seven slots at 58 px each; the chamber crops 40 px tighter.
- Settle stagger tightens to 360 ms so the round stays under 4.7 s.
- The pentatonic set extends to seven notes; the rising phrase gets longer,
  which is exactly the escalation the variant wants.
- SEVEN is a **toggle in the top rail, not a separate product**, and switching
  is free and instant. It is presented as *"more spheres, bigger prizes, same
  96%"* — because that is precisely true.
- Onboarding never starts a player in SEVEN. It is opt-in, always.

---

## 13. Open questions for the build

Deliberately unresolved; each needs a decision before content lock.

1. **Multiplayer lobby.** A shared-chamber mode where many players bet on one
   draw is compelling and cheap (one transcript, many tickets) — but it
   introduces a round timer, which §10 constrains hard. Decide the timer
   semantics (expiry = no bet) before building.
2. **Chamber skins.** Presentational only, but they must not encode any
   information. If skins ship, add a test asserting skin state is absent from
   the transcript input set.
3. **Slot labelling direction.** Slot 1 at the bottom matches the physical
   fiction (the tube fills upward) but reads top-down in the ticket strip. User
   test both before locking the picker.
4. **SEVEN colour separation.** ROSE and CORAL are the closest pair in the
   palette. Validate with a protanopia simulation on real hardware; if it fails,
   move ROSE toward `#FF6FB0` and re-check.
5. **Clip length.** 3.4 s LOCK-OUT versus a 6 s cut that includes the ticket
   build. Test retention on both.
