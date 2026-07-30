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
4. **The FORM tier's chips, already open.** `4.80×`, `4.80×`, `4.80×`, `4.80×` —
   FIRST, LAST, SLOT, STACK, four different claims at one price.
5. **One line under the rail:** *"Every bet pays 96%. The tiers are how wild the
   ride is, not how good the deal is."*

**The opening screen does not lead with the biggest number.** `115.20×` is real,
it is the pitch, and it lives one tab away under `ORDER · rare, big`. It is not
in the first three seconds, for a reason that is the whole product: a first
impression built around a headline multiplier teaches the thing §10 bans
everywhere else — that one chip is the good one. Four identical multipliers on
four different-looking bets teach the opposite, in one glance, with no copy at
all. §14's first falsification criterion asks whether players leave a first
session able to say *"every bet pays the same"*; the opening screen is where
that is either taught or contradicted.

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

One round, start to credited, is between 3.6 and 4.8 seconds depending on
variant and outcome. The *cycle* — the interval in which a player can place
another bet — has a hard floor of 2.5 seconds, and the two are different things
on purpose (§2.2).

| # | Beat | Duration | What the player sees | What the system does |
| --- | --- | --- | --- | --- |
| 0 | **IDLE** | — | Spheres drift; tube empty; seed chip amber | Server seed drawn; the round context (variant, round id, nonce) and `seedCommitment` published and shown |
| 1 | **BUILD** | player-paced | Chips; running stake and best possible outcome | Nothing random; no timer that can expire into a bet |
| 2 | **COMMIT** | 120 ms | CTA collapses into the ticket strip | Wallet debited; ticket + client seed frozen; permutation derived; receipt issued |
| 3 | **CHARGE** | 260 ms | Impeller rings spin up; liquid tint deepens 8% | Choreography and resolution track built from the transcript (`resolutionTrack`) |
| 4 | **AGITATE** | 900 ms | Spheres orbit; bubble field; chamber hum rises | Nothing — purely presentational |
| 5 | **SETTLE** | 1,690 ms (CLASSIC) / 2,230 ms (SEVEN) | Locks 1 to `n−1`. Spheres fall bottom to top; a gold ring locks each; **every line resolves inside this window** | Emits `slotLocked` events from the transcript |
| 6 | **THE CLOSE** | 430 ms, or 1,060 ms when celebrated | The last sphere falls into the only slot left. It decides nothing (§2.1) | Settlement and the celebration gate were both known at lock `n−1` |
| 7 | **STAMP** | 220 ms | Result reported — celebrated *only* if the round returned more than it cost (§10) | Wallet credited |
| 8 | **REVEAL** | — | Seed chip turns gold: *verified locally* | Server seed revealed; client re-derives and checks both hashes |

| Round | CLASSIC | SEVEN |
| --- | --- | --- |
| Neutral close | 3.62 s | 4.16 s |
| Celebrated close | 4.25 s | 4.79 s |

SETTLE is `(n−2) × stagger + 340 ms fall + 90 ms rebound`, with the stagger from
§6.4. The close is one fall plus its rebound, at full speed when the round did
not win and at 0.35× when it did.

The settle order shown is the transcript's permutation, read bottom to top. A
player who screenshots the tube has screenshotted the outcome; nothing is hidden
behind the animation.

### 2.1 Lines resolve when they are decided — and the last fall decides nothing

The format's one natural tension engine is that a permutation reveals itself
prefix by prefix. Deferring every line to the end throws that away and leaves the
player watching a tube whose story they cannot read.

**The rule.** A line changes state at the first lock after which its verdict is
identical for *every* completion of the tube consistent with the locked prefix.
That is a pure function of the prefix, and the prefix is already on screen — so
this reveals nothing the player could not read off the tube themselves, which is
exactly why it is allowed.

**The rule has one sharp consequence, and this document states it rather than
letting a table quietly contradict it.** After `n−1` locks exactly one
arrangement of the remaining sphere is possible, so **every line is decided by
lock `n−1`**, in every round, on every ticket, without exception. The final fall
carries no information at all. Not "usually"; not "except in LOCK-OUT rounds";
never.

Round 2 of this specification published a table saying LAST resolved at lock
`n`. That is one lock too late, and one lock too late is exactly the
manufactured near-miss §9 bans: a LAST line that died at lock 1 would have
stayed lit until the tube was full so the player could be shown how close they
came. It survived review because the celebration gate is code with tests and
this rule was a paragraph. It is code now — `tools/lib/resolution.mjs`,
`decisiveLock` — and the table below is generated from it.

<!-- resolution:start -->
| Code | Chip · when it changes state | Latest lock, CLASSIC (`n = 5`) | Latest lock, SEVEN (`n = 7`) |
| --- | --- | --- | --- |
| `first` | FIRST — the moment the bottom sphere seats | 1 | 1 |
| `early` | EARLY — lock 1 if the colour lands first, else lock 2 | 2 | 2 |
| `opening` | OPENING — lock 1 if the bottom sphere is wrong, else lock 2 | 2 | 2 |
| `podium` | PODIUM — the first mismatched lock, else lock 3 | 3 | 3 |
| `late` | LATE — the lock the colour lands on, else lock `n−2` | 3 | 5 |
| `before` | BEFORE — whichever of the two colours lands first | 4 | 6 |
| `last` | LAST — the lock the colour lands on, else lock `n−1` | 4 | 6 |
| `slot` | SLOT `c @ k` — the lock `c` lands on, or lock `k`, whichever is first | 4 | 6 |
| `stack` | STACK — the lock after the lower colour lands, or the lock the upper colour lands on | 4 | 6 |
| `neighbours` | NEIGHBOURS — the lock after the first of the pair lands | 4 | 6 |
| `full` | FULL ORDER — the first mismatched lock, else lock `n−1` (§9) | 4 | 6 |
<!-- resolution:end -->

Every description above is capped by the rule: wherever a formula would give
lock `n` — SLOT on the top slot, LAST when the colour never lands early, STACK
when the lower colour is at the top — the answer is lock `n−1`, because by then
there is nothing left to find out. The two numeric columns are that cap made
explicit, and they are generated, not typed.

`tools/enumerate.mjs` §14 recomputes this table — exhaustively over all 35,400
(instance, outcome) pairs in CLASSIC, and over a fixed 40-outcome sample in
SEVEN, where the full sweep is 27.6M — and `tests/resolution.test.mjs` fails the
build if a single cell drifts from the document.

**THE CLOSE.** The design has to answer for the consequence rather than hide it,
so the last fall gets its own beat and its own rules:

- It is **never** framed as a reveal. No held breath, no rising pitch, no
  slow-down "to build tension", no camera move, no copy that asks a question.
- Its treatment is chosen by the *same* comparison as everything else,
  `creditedChips > totalStakeChips`, which is fully determined at lock `n−1`.
  A winning round's close is the anticipation-collapse set piece in §9. A losing
  round's close is a sphere falling into a slot at normal speed, and looks
  identical whether the ticket missed by one position or by five.
- Because the gate is evaluated one lock early, **there is no beat anywhere in
  the round whose job is to make an undecided line look close.** There are no
  undecided lines by then.

This is not a defect dressed as a feature. It is the same property the entire
production is built on: the round's job is to let the player *watch the outcome
arrive*, not to withhold it. §9 argues that anticipation collapse is a better
clip shape than surprise; §2.1 is where that becomes true of every round rather
than one in six hundred.

**This is the anti-near-miss mechanism, not a near-miss engine.** A FULL ORDER
line that dies at lock 4 dies *at lock 4*, visibly and immediately. Every state
change during SETTLE is rendered with identical weight — same 120 ms transition,
same easing, no sound of its own, no scale, no camera — whether the line
resolved won or lost. The only difference is colour and opacity, which is the
information itself. Drama is reserved for the round-level result, and gated
(§10).

### 2.2 The cycle floor, and what SKIP actually does

**SKIP** compresses beats 3 to 6 to ~1.2 s. It is remembered as a preference and it
changes nothing about the outcome, the settlement or the transcript. A skipped
round still resolves every line in prefix order — the information arrives in the
same sequence, faster.

**SKIP does not shorten the round cycle.** The COMMIT control stays disabled
until 2,500 ms have elapsed since the previous COMMIT, enforced by the RGS and
not merely by the client. A skipping player sees the result sooner and bets
again at the same rate; the compression buys impatience relief, not throughput.

Two things make this honest rather than annoying:

- The wait is *never* a countdown that can expire into a bet. It only unlocks.
  A thin hairline fills across the CTA and the label reads `COMMIT` the moment
  it completes. Nothing is lost by not looking at it.
- A skipped round runs COMMIT (120 ms) + compressed presentation (~1,200 ms) +
  STAMP (220 ms) ≈ 1.5 s, so the remaining wait is about a second — roughly the
  time it takes to read the result. In unskipped play the floor never binds at
  all: the shortest possible round is a neutral CLASSIC close at 3.62 s, which
  is already 1.1 s longer than the floor.

Speed of play is the single most consequential regulated property of a game this
short, and `docs/MATH.md` §10.1 does the arithmetic: at the published ceiling of
900 rounds per rolling hour, maximum hourly turnover is 180,000 credits and
expected loss 7,200. Without a floor, SKIP plus a one-tap REBET is a ~1.5 s
cycle — 2,400 rounds/hour and ~19,200 credits/hour of expected loss, a 2.7×
increase in maximum exposure bought purely by making an animation shorter. That
is what a slam stop is, and it is why there isn't one here.

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

The round-cycle floor (§2.2) is not a decision either, in either direction: it
takes nothing away from the player and offers nothing to optimise. It is the one
control the *house* gives up — a bound on how much turnover the product can
extract per hour — and it belongs in this table only to say that it is not a
lever anybody gets to pull.

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

Eleven bet types in three tiers. Every one pays a theoretical 96.000%. The tier
is **volatility**, never value — the client is required to say so on the tier
tab.

### FLOW — lands often

| Chip | You pick | Wins when | CLASSIC | SEVEN |
| --- | --- | --- | --- | --- |
| **BEFORE** | two colours, in order | the first settles below the second | `1.92×` | `1.92×` |
| **EARLY** | one colour | it is one of the first two to settle | `2.40×` | `3.36×` |
| **LATE** | one colour | it is one of the last two to settle | `2.40×` | `3.36×` |
| **NEIGHBOURS** | two colours | they settle side by side, in either order | `2.40×` | `3.36×` |

### FORM — the core game

| Chip | You pick | Wins when | CLASSIC | SEVEN |
| --- | --- | --- | --- | --- |
| **FIRST** | one colour | it settles first | `4.80×` | `6.72×` |
| **LAST** | one colour | it settles last | `4.80×` | `6.72×` |
| **SLOT** | one colour, one slot | it settles in exactly that slot | `4.80×` | `6.72×` |
| **STACK** | two colours, in order | the second settles directly above the first | `4.80×` | `6.72×` |

### ORDER — the reason to watch

| Chip | You pick | Wins when | CLASSIC | SEVEN |
| --- | --- | --- | --- | --- |
| **OPENING** | two colours, in order | they are the first two, in that order | `19.20×` | `40.32×` |
| **PODIUM** | three colours, in order | they are the first three, in that order | `57.60×` | `201.60×` |
| **FULL ORDER** | the whole column | every sphere lands exactly where you said | `115.20×` | `4838.40×` |

The ORDER tier is deliberately a ladder that resolves in sequence: OPENING is
decided by lock 2, PODIUM by lock 3, FULL ORDER by lock `n−1`. A player holding
all three watches their ticket resolve upward with the tube, which is the whole
reason this format is worth animating.

FIRST and LAST are one-tap presets of SLOT. They are priced identically — using
the convenience control never costs anything. The paytable sheet says this in
one line so nobody has to work it out.

**STACK and NEIGHBOURS were called LINK and LINK · EITHER, and the rename is a
product fix, not a copy pass.** They were the only two chips in the menu that
shared a word. They sit in different tiers, at exactly half the price of one
another, and they differ only by whether the stacking order is fixed. The rest
of this menu passes the 30-second comprehension test comfortably — five spheres,
a five-slot tube, *"They settle in a random order. Bet on the order."*, and four
chips all reading `4.80×` — and those two were the one genuine trap in it. The
chip rail is where the choice is made, and two chips one word apart at 2× the
price is precisely the confusion a product whose whole thesis is *no trap bets*
cannot afford: a player who taps the wrong one does not conclude they misread a
label, they conclude the cheaper chip **was** the trap.

The new names share nothing and each carries its own semantics. A *stack* is a
specific vertical arrangement, which is exactly what the bet claims and exactly
what the tube shows. *Neighbours* are next to each other with no order implied.
The wire codes moved with the names — `link`/`link-any` are now `stack` and
`neighbours` — because a receipt reading `code=link` beside a chip reading STACK
is the same auditability defect FULL ORDER had with `rank=37` (`MATH.md` §3),
and it is not one this document is going to reintroduce in the same round it
fixed. That is replay-visible, so `adapterVersion` moved too.

§14's first falsification test now checks the pair directly.

### Ticket rules

Up to 12 lines. Stake per line 0.25 – 50.00, in 0.25 steps. Ticket total
≤ 200.00.

**Distinct claims only.** Tapping the same chip with the same picks raises that
line's stake rather than adding a second row, which keeps the per-line ceiling
meaningful. Two chips that *mean* the same thing count as one claim: `FIRST
amber` and `SLOT amber @ slot 1` are the same bet, and the builder merges them
with a one-line explanation (*"same bet — stake combined"*) rather than silently
rejecting the tap. The client does not have to work out which pairs those are:
the adapter publishes the complete alias set in `docs/paytable.json` as
`claimAliases` (10 pairs in CLASSIC, 14 in SEVEN), generated by the same digest
settlement uses.

**When a merge would breach a ceiling** — the case that decides whether the
per-line ceiling is real:

| Situation | Behaviour |
| --- | --- |
| Merged stake would exceed 50.00 on the line | The line clamps to 50.00. The tap is not rejected and no second row is created; a one-line note reads *"this line is at the 50.00 maximum"*. Splitting into two rows is never offered — that is exactly the end-run the ceiling exists to stop. |
| Merged stake would exceed the 200.00 ticket total | The line clamps to whatever the remaining budget allows, down to no change at all, with *"ticket is at the 200.00 maximum"*. |
| A 13th distinct claim is tapped | Rejected with *"12 lines maximum"*, and the chip rail shows which lines are on the ticket so one can be removed. |

Clamping rather than rejecting is deliberate: a rejected tap on a game this fast
reads as a broken button, and a player who wanted more exposure than the ceiling
allows should be told the ceiling exists, not left guessing.

**The ticket strip** always shows, in tabular figures: lines · total stake ·
**best possible outcome**. That last figure is the largest credit *any single
settled order can produce* for this exact ticket — a maximum over the 120 (or
5,040) permutations, computed exactly, never rounded up, never framed as
expected.

It is emphatically **not** the sum of every line's return-if-hit. For any ticket
containing mutually exclusive lines — which is most interesting tickets, and all
hedged ones — no outcome makes every line hit, so that sum is an amount the game
cannot pay. Four FULL ORDER lines at 50.00 sum to 23,040.00 and can return at
most 5,760.00; three FIRST lines on different colours sum to 14.40 and can
return at most 4.80. `docs/MATH.md` §8.1 tabulates the gap and
`tools/lib/presentation.mjs` computes the real figure.

---

## 5. Mobile-first portrait UX

Reference device 390 × 844 **CSS** pixels (iPhone 14 / Pixel 8 class). Portrait
only. Every coordinate in this section is a CSS pixel; the device-pixel ratios
that matter to the renderer are in §7.1.

**Reach.** Every control needed to *play* — tier tabs, chips, picker, stake
stepper, COMMIT, REBET — sits below y = 552, inside the one-handed thumb zone.
The top rail carries exactly two controls, the `⌂` menu and the `◈` fairness
chip, and neither is on the critical path: the menu's contents are also reachable
from the result screen, and the fairness chip is duplicated as a full-width row
inside S5 so verification is never a stretch. Nothing above y = 552 is ever the
only way to do anything.

**Tap targets** are ≥ 44 × 44 everywhere, without exception, including controls
whose visible label is smaller than their hit area. The chamber is never a tap
target during a round.

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
    │  │FIRST ││ SLOT ││STACK ││ LAST │  →      │      (h-scroll)
692 │  │4.80× ││4.80× ││4.80× ││4.80× │         │
    ├───────────────────────────────────────────┤
700 │  3 lines · 3.00 · best 139.20             │  36  ticket strip
736 ├───────────────────────────────────────────┤
744 │  ▮▮▮▮▮▮▮▮  COMMIT  3.00  ▮▮▮▮▮▮▮▮         │  56  primary CTA
800 └───────────────────────────────────────────┘
810                  ▁▁▁▁▁▁                        home indicator
```

- **§1's one line of copy sits at the top of the deck, directly under the
  chamber and directly above the tier tabs** — the first row of the deck, not a
  caption on the instrument. The wireframe above predates it and shows the deck
  starting at the tabs; this bullet is the normative placement. Round 1 printed
  it *inside* the chamber's SVG, where it landed on the housing's bevel band with
  both bottom corner radii passing behind its first and last glyphs and the line
  itself wider than the housing, so it began and ended over the void. It was the
  only text in the app sitting on the art, and it collided with it. There is
  exactly one copy of the line on screen at every text scale.
- Tier tabs are **labelled with what they mean**: `FLOW · lands often`,
  `FORM · the core game`, `ORDER · rare, big`. Never "low/medium/high risk"
  without the plain-language gloss.
- **FORM is the default tab on a first run**, which is why the wireframe shows
  four chips all reading `4.80×`. Four different-looking bets at one price is
  the fastest way to teach the product's only real claim, and it is the reason
  §1 does not open on the biggest number in the game. On subsequent sessions the
  tab is remembered.
- Tapping a chip opens the picker sheet (S2). Chips already on the ticket show a
  gold count badge and a long-press removes them.
- The `◈` chip top-right is the fairness state: **amber** = committed,
  **gold** = verified locally after reveal. One tap opens S6. It is a 44 × 44
  hit area around a 20 px glyph, and it is duplicated inside S5.
- The ticket strip reads `3 lines · 3.00 · best 139.20`. The third figure is the
  **best possible outcome** (§4), long-pressable for the one-line explanation
  *"the most this exact ticket can return on any settled order"*. The wireframe
  ticket — FULL ORDER + OPENING + SLOT chosen compatibly — is one where every
  line genuinely can hit together, so 139.20 is both the sum and the maximum.
- While the cycle floor is running, the CTA reads `COMMIT` in a dimmed state
  with a hairline filling left to right beneath it. It unlocks; it never expires.

### S2 — PICKER SHEET (bottom sheet, drag to dismiss)

**One tap per thing you are claiming.** That is the rule the picker is built to,
and it is the honest version of the "never more than two taps" round 2 promised
while shipping two chips that cannot be expressed in two taps. A BEFORE line is
two claims and costs two taps; a FULL ORDER line is a claim about every sphere
and costs `n−1`. Nothing is ever more taps than it is decisions.

Five shapes. The first three fill 62% of the screen height; the last two are
full-height because they contain a tube.

**A. One colour** (EARLY, LATE, FIRST, LAST) — a row of colour tokens, 56 px,
each with its glyph and its name. One tap. Live sentence: *"AMBER settles
first."*

**B. One colour + one slot** (SLOT) — colour row, then a vertical slot strip
that mirrors the real tube: the player picks the slot **on a picture of the
tube**, not from a number list. Two taps. This is the single most important
affordance in the game and every other picker inherits from it.

**C. Two colours, ordered or unordered** (BEFORE, STACK, NEIGHBOURS, OPENING)
— two wells labelled `FIRST PICK` / `SECOND PICK` (or `EITHER ORDER` for
NEIGHBOURS, which shows one unordered well pair). Two taps. Live sentence:
*"AMBER settles before AQUA."* The sentence is the confirmation, not the icons.

**D. Three colours, ordered — PODIUM.** The sheet shows the bottom three slots
of the tube, labelled `1st` `2nd` `3rd`, above the colour row. Tapping a colour
drops it into the lowest empty slot; tapping a filled slot empties it and
returns that colour to the row. Three taps, in the order you mean. Live
sentence: *"AMBER, then AQUA, then VIOLET — the first three, in that order."*
No drag is required; the slots are also drag targets for players who prefer it,
per §11's "every drag has a tap equivalent".

**E. The whole column — FULL ORDER.** The same interaction as D, extended to the
full tube. The sheet is a full-height picture of the chamber's tube with `n`
empty slots and the colour row beneath it. Tap a colour, it falls into the
lowest empty slot with the same 340 ms expo-out the real game uses. Fill the
tube bottom-up.

- **The last sphere places itself.** When one colour and one slot remain, the
  client seats it automatically with a 200 ms fade and the caption *"only one
  left"*. This is the picker teaching the round's own defining property (§2.1):
  a permutation of `n` things is `n−1` free choices. It is a convenience, not a
  choice made for the player, and the caption says which.
- **`RANDOMISE` fills the tube for you.** One tap, drawn from
  `crypto.getRandomValues`, animated as `n` quick falls. Its label copy is fixed
  and is not marketing: *"a random order — no better or worse than the one you
  would have picked."* That is exactly true (`docs/MATH.md` §3.1: every order is
  `1/n!`), and it is the one place in the product where the fairness thesis and
  a convenience button are the same object. It carries no luck framing, no
  sparkle, no "your lucky order", per §10.
- **`CLEAR` empties the tube.** No confirm; nothing has been staked yet.
- Portrait-only constraint: at `n = 7` the tube plus the colour row plus the
  stake bar fit in 844 px with the slot pitch at 58 px (§12). At 200% text
  scaling the colour row reflows to two rows and the sheet scrolls; the tube
  never does.

**Why this matters commercially.** §14's second falsification criterion
pre-registers ORDER-tier attach rate ≥ 15% as the test of whether the format
works at all, and PODIUM and FULL ORDER are the ORDER tier. An unspecified
picker for the two chips the thesis rests on is not a detail deferred to build;
it is the thesis deferred to build.

Stake stepper is pinned to the sheet's bottom bar with the ladder as discrete
stops. **The stepper never pre-selects a value higher than the previous round's.**

### S3 — TICKET REVIEW (expanded ticket strip, tap to expand)

One row per line: chip name, the plain-language claim, stake, multiplier,
return-if-hit. A `CLEAR ALL` that requires a second confirm. Nothing here is
timed.

### S4 — ROUND

Chamber goes full-bleed: the rail dims to 20% and stops accepting input; the
ticket strip stays visible and pinned so the player can watch their lines
resolve lock by lock (§2.1). A thin progress hairline under the top rail tracks
the settle cadence. `SKIP` sits top-right: a 15 px uppercase label inside a
44 × 44 hit area, no confirm.

**Geometry, because §7.1.1 budgets it.** The pinned strip is one **390 × 28**
row per line, bottom-aligned, up to the 12-line ticket maximum (336 px, which
fits between the full-bleed chamber and the safe area with the CTA collapsed).
The hairline is **390 × 3**. Each row is its own promoted layer and changes
state with `opacity` and `color` only. Nothing here reflows during SETTLE: the
strip is laid out once at COMMIT, when the resolution track is built, and after
that it only fades.

The hairline reaches full width at lock `n−1`, not at lock `n`. That is honest —
it is a progress indicator for the *information*, and there is none left after
the penultimate lock — and it is also the cue that lets a player who has already
read their result look away during the close without missing anything.

### S5 — RESULT

Lines that won light gold; lines that lost step back from `--ink` to
`--ink-dim`, and their left rail steps back to `--chrome-dark`. Both stay in
place — nothing is removed, hidden, reordered or animated away, because the
record of the round has to stay legible (§10). Every line has already changed
state during SETTLE (§2.1); this screen is the record, not the reveal.

**A dead line is not dimmed with opacity, and that is a correction.** Rounds 1
to 4 of this document said *"fade to 40% opacity"*, and a build that did exactly
that put a dead line's stake and multiplier at **2.08:1** and — compounded with
the 0.8 the claim cell already carried — its claim text at **1.72:1**, measured
from rendered pixels against §11's published floor of 4.5:1 and a published
`--ink-dim` of 7.81:1. This is the primary money surface and the strip where
lines resolve lock by lock, so §11 wins outright: "dead" is carried by colour
and by the rail, which cost no legibility, and on this screen by the row's own
words — a dead row reads `1.00 × 4.80×` where a won row reads `returned 4.80`.
The transition is still §6.4's 120 ms and still identical for won and lost, so
§2.1's rule is untouched.

**The headline is gated on the round's net position, not on whether any line
won.** The rule is a single comparison, implemented in
`tools/lib/presentation.mjs` as `roundPresentation`:

| Round | Headline | Sound | Stamp | Balance | Haptic |
| --- | --- | --- | --- | --- | --- |
| credited **>** staked | `Won 3.80` | win chord + sub drop | yes | counts up | medium |
| 0 < credited **≤** staked | `Returned 1.92 of 12.00` | none | no | writes to its new value, no count-up | none |
| credited = 0 | `Returned 0.00 of 12.00` | none | no | no animation | none |

A 12-line, 12.00-credit ticket whose single BEFORE line returns 1.92 is a
10.08-credit loss and is reported as one. It gets the gold line light, because
which line won is information the player is owed — and nothing else. See §10.

Two buttons: `REBET` (same lines, same stakes) and `NEW TICKET`. Neither is
pre-focused, and both are disabled until the cycle floor elapses (§2.2). A
full-width `◈ VERIFY THIS ROUND` row sits below them, in the thumb zone.

### S6 — FAIRNESS

Full-screen sheet, mono type. Shows: seed commitment (published pre-round),
client seed (editable, with a `RANDOMISE` button), nonce, round id, revealed
server seed, the derived permutation, and both recomputed hashes with a green
`VERIFIED LOCALLY` state. A `COPY TRANSCRIPT` button and a `HOW THIS WORKS`
expander with the four-step explanation in plain language. **This screen is one
tap from the result at all times**; it is never buried in settings.

Below the transcript, a second card headed **YOUR BET** shows the signed receipt
(`docs/ENGINE.md` §6.1): ticket digest, settlement digest, receipt digest,
signer id, and the receipt state checked against the operator's published key.
That state has **three** values, not two, because the verifier does
(`docs/ENGINE.md` §7.8):

| Verifier result | Card state | Treatment |
| --- | --- | --- |
| `ok: true` | `SIGNATURE VERIFIED` | green, gold-eligible |
| `code: 'SIGNATURE_UNCHECKED'`, `bindingsVerified: true` | `SIGNATURE NOT CHECKED ON THIS DEVICE` | neutral `--ink-dim`, never green, with a one-tap *"check it elsewhere"* that copies the receipt |
| any other failure | `RECEIPT DOES NOT MATCH THIS ROUND` | error state, with the failing `path` shown verbatim |

The middle row is the one a build gets wrong: it is not a pass, it is not an
error, and drawing it in the same colour as either is the defect. The card
carries one sentence that must not be softened:
*"The transcript proves the draw was fair. This receipt is the operator's
signature on what you staked and what you were paid — a different kind of
guarantee, and one that depends on their key."* `COPY RECEIPT` sits beside
`COPY TRANSCRIPT`; a dispute needs both.

### S7 — HISTORY

Reverse-chronological rounds: permutation strip, ticket, net. Each row taps
through to S6 for that round. Header shows **session elapsed time** and
**session net position in currency** — never "wins" or a streak count.

### S8 — PAYTABLE · S9 — LIMITS & PLAY CONTROLS

S8 is the table from §4 with the exact probability shown next to every
multiplier, plus the alias list (*"these two chips are the same bet"*).

S9 holds session limit, loss limit, the reality-check control, and the
self-exclusion hand-off.

**The reality-check control is a tighten-only addition, and the screen says
so.** The operator schedule — 30 minutes, 60 minutes, then hourly — is shown
first, as a published fact with no toggle beside it, because §10 makes it a
floor the player cannot move. Beneath it sits one optional selector, `CHECK IN
MORE OFTEN`, offering `15 / 30 / 60 minutes` (the published
`playerRealityCheckIntervalOptions`) and an `OFF` that returns to the floor,
never below it. Its caption is fixed: *"these are extra checks on top of the
ones above — you cannot switch those off."* No control on this screen can
lengthen an interval, and the screen must not imply one exists.

It also states the pacing policy as plain fact —
*"minimum 2.5 seconds between bets; maximum 900 rounds per hour; no autoplay"* —
with rounds played in the trailing hour shown as a number, never as a bar
filling toward a goal. Both screens are reachable from the `⌂` menu in two taps.

### S10 — SHARED CHAMBER (the lobby; §13.2)

One transcript, many tickets. Same chamber, same choreography, same picker; the
only structural difference is that the round's clock belongs to the server.

```
 54 ┌───────────────────────────────────────────┐
    │  ←  SHARED CHAMBER        [FREE PLAY]  ◈  │  56  top rail
110 ├───────────────────────────────────────────┤
    │  NEXT DRAW  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯  4.2s    │  32  cadence bar
142 ├───────────────────────────────────────────┤
    │                 ╭─────╮                   │
    │        ●        │  5  │        ●          │  398  chamber + tube
    │    ●            │  3  │      ●            │      (crops 32px vs S1)
    │            ●    │  1  │                   │
    │                 ╰─────╯                   │
540 ├───────────────────────────────────────────┤
552 │  IN THIS DRAW  ·  41 tickets              │  36  presence row
588 ├───────────────────────────────────────────┤
    │  ▸ FIRST amber        ▸ STACK aqua>violet │  76  ticket ticker
    │  ▸ FULL ORDER ×3      ▸ BEFORE ivory<coral│      (2 rows, scrolls)
664 ├───────────────────────────────────────────┤
    │  FLOW · FORM · ORDER      3 lines · 3.00  │  44  tabs + strip
708 ├───────────────────────────────────────────┤
    │  ▮▮▮▮▮▮  COMMIT  3.00  (closes in 4.2s)   │  56  primary CTA
800 └───────────────────────────────────────────┘
```

- **The cadence bar is the only new control surface, and it never takes a bet.**
  When it empties, the betting window closes and an uncommitted ticket stays a
  ticket: it is not placed, not carried over, not auto-committed. The CTA
  disables and reads `BETTING CLOSED · next draw in 3s`. This is §10's
  latency rule, and the lobby is the one place it could plausibly be violated.

**The boundary rule, because a bar emptying is not a specification.** Round 4
said the window closes and stopped there: it did not say which clock decides,
whether there is any lead time before the settle, or what happens to a commit
that leaves the client inside the window and arrives after it. The dangerous
failure was already impossible — `roundId` is bound into `ticketDigest`, so a
late ticket cannot silently roll into the next draw — but with no specified
grace, every player on a slow connection systematically loses the draws they
commit to near the boundary, in the one place this document names as where the
rule could plausibly be broken. Four values, published in `docs/paytable.json`
as `sharedChamber` and frozen in `tools/lib/model.mjs`:

| Instant | Value | What happens |
| --- | --- | --- |
| `settleAtEpochMs − commitLeadMs − clientSafetyMs` | lead 750 ms, safety 250 ms | The client disables COMMIT. It closes **early on purpose**: a CTA that is live when a commit could not land is a button that lies. |
| `settleAtEpochMs − commitLeadMs` | | The window closes. The server stops accepting new tickets for this draw. |
| `+ commitGraceMs` | 250 ms | Last arrival the server accepts. This is the latency allowance: a commit that left the client inside the window and spent up to 250 ms in flight is still a bet. |
| `settleAtEpochMs` | | The draw settles. |

- **The server's clock is authoritative**, always. The client estimates the
  offset from `round.open` and uses it only to drive its own countdown; a client
  whose clock is wrong loses nothing but its own display accuracy, because
  acceptance is decided server-side on arrival.
- **A commit arriving after the grace is rejected with `BETTING_CLOSED`**
  (`docs/ENGINE.md` §9). The stake is unspent, the wallet is untouched, the
  ticket stays on screen unplaced, and the client shows *"that draw closed —
  your ticket is still here"*. It is never queued into the next draw: a queued
  bet is a latency-sensitive money decision by another name, and §10 bans those.
- **`commitGraceMs < commitLeadMs`**, so the last acceptable arrival is strictly
  before the settle. Nothing leaks inside the grace: the seed was committed at
  `round.open` and is revealed only after settlement, so a ticket accepted at the
  very edge is a ticket on an outcome nobody knows yet.
- **A closed window never reopens within its draw.** No retry, no "the server was
  slow, try again" — that is a countdown that can expire into a bet.
- **The presence row shows a count of tickets.** Not balances, not wins, not
  names, not a leaderboard. The ticker shows *what people bet*, never *how much*
  and never *how they did* — a leaderboard is a wagering incentive in a social
  costume, and stake sizes in a shared room are peer pressure with a number on.
- **`←` returns to solo play at any time**, mid-cadence, with no penalty and no
  confirmation. Solo is never the worse product.
- Everything below y = 552 is still in the thumb zone. The chamber crops 32 px
  to pay for the cadence bar; the tube keeps its slot pitch.

**Cadence, and how it interacts with the money controls.** The draw interval `T`
is a lobby-wide constant. Each player is still subject to the 2,500 ms cycle
floor and the 900-rounds rolling ceiling, so:

| Cadence `T` | Draws a player can bet on, per hour | Binding constraint |
| --- | --- | --- |
| 4 s | 900 | the rolling ceiling, exactly |
| 6 s | 600 | the cadence |
| 8 s | 450 | the cadence |
| 10 s | 360 | the cadence |

`T` may not go below 4 s, because at 4 s the rolling ceiling starts binding and
a player would spend part of every hour locked out of a room they are watching —
a worse experience than a slower room, and a worse one to be *nudged* by. The
open question in §15 is 6, 8 or 10, all of which are safely cadence-bound.

**Networking, and its budget.** One WebSocket per session, four message kinds,
all of them small:

| Message | Direction | Size | Cadence |
| --- | --- | --- | --- |
| `round.open` — round id, nonce, variant, `seedCommitment`, `settleAtEpochMs` | server → client | ~210 B | once per draw |
| `presence` — ticket count, up to 8 anonymised claim labels | server → client | ~180 B | 2 Hz while betting is open |
| `ticket.commit` — the ticket, idempotency key | client → server | ~120–400 B | once per player per draw, accepted until `settleAtEpochMs − commitLeadMs + commitGraceMs` on the **server's** clock, then `BETTING_CLOSED` |
| `round.reveal` — server seed, settlement, receipt | server → client | ~420 B | once per draw |

At `T = 6 s` that is under 1.5 kB/s down and a few hundred bytes up per player.
The lobby costs **9 KB gzipped** of client (§7.3), and it is a lane on the
existing transport, not a second stack.

**Latency, and what a slow connection may not cost.** The choreography is driven
by `settleAtEpochMs`, a server-published wall-clock instant, not by message
arrival. A client whose clock or connection is behind starts the choreography
late and *time-shifts* it — it never skips a lock, never fast-forwards past the
resolution of a line, and never truncates the close. If the socket drops after
COMMIT, the round settles server-side and the completed result is restored from
the round snapshot on reconnect (`docs/ENGINE.md` §7.9). If the socket drops
*before* COMMIT, nothing was staked. There is no state in which a network
condition changes what a player is paid.

---

## 6. Art direction

**One sentence:** laboratory-grade glass, abyssal water, seven colours of light,
one metal.

### 6.1 Palette

Environment — **the chamber** is neutral so the spheres are the only colour
inside it. That scope is the whole of the rule, and it is written as a scope
rather than as "the whole world" because the build proved the wider claim
unliveable: see the UI accents table below, which is the exception, is bounded,
and is published here rather than left to drift into a stylesheet.

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
| `--win` | `#4CE0A6` | a verified-true state: a round that won, and a signature that recomputed (§5 S6) |
| `--scrim` | `rgba(5,7,12,0.72)` | sheet backdrop |

UI accents — **the chrome layer only, and never inside the chamber rect.**

| Token | Hex | Use |
| --- | --- | --- |
| `--tier-flow` | `#2FE0C8` | FLOW: tab label and underline, chip numeral, ticket-row rail |
| `--tier-form` | `#F2F4F8` | FORM: the same three places |
| `--tier-order` | `#FF5A5F` | ORDER: the same three places |
| `--pending` | `#D9A441` | the fairness chip while a round is committed and not yet revealed (§6.8) |
| `--alert` | `#FF6B6B` | a destructive control, and an over-limit figure |
| `--edge` | `rgba(65,75,88,0.55)` | a 1 px divider on `--abyss` |
| `--edge-soft` | `rgba(65,75,88,0.32)` | the same divider where it separates rather than encloses |

**Why this table exists at all, given the sentence above it.** Round 1's art
pass shipped the three tier accents and shipped no change here, so the build
contradicted its own closed spec in the one place the spec is loudest. Reviewing
it, the *colouring* is right and the *silence* was the defect: §4's whole claim
is that a tier is "how wild the ride is, not how good the deal is", and three
tabs that differ only in weight teach that in a caption where three tabs that
differ in colour teach it in a glance. So the rule is scoped and the accents are
published, with four constraints that keep §6.1's first sentence true:

1. **Every tier hex is a hex this table already publishes for a sphere** —
   AQUA, IVORY, CORAL, cool to hot. No new colour enters the world.
2. **They appear as a hairline, a numeral and a rail — never as a fill.** A
   tinted *card* would read as being *about* the sphere of that colour; a 2 px
   rail beside a name that is already written in words does not. The semantic
   collision is real and it is bounded by this rule: an `amber < aqua` BEFORE
   line does carry an aqua rail, and it carries it as a 2 px edge next to the
   words `amber < aqua`, which are the channel (§11).
3. **They never enter the chamber.** Nothing in `chamber.ts` may reference
   them; the instrument stays `--void` through `--specular` plus the spheres.
4. **They are never gold and gold is never them.** §6.1's six gold uses are
   unchanged, and a tier accent may not appear in any of the six.

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

**Colour is never the only channel — and for this palette, the glyph is the
colour-blind channel, not a backup for it.** That is a stronger statement than
round 2 made, and it is forced by arithmetic rather than chosen:

Every sphere must clear 4.5:1 against `--void` (§11). A colour at that floor has
relative luminance ≥ 0.1845, and the brightest possible colour is white, so the
entire set lives inside a luminance-contrast span of `1.05 / (4.5 × 0.0521)` =
**4.48:1**. Spread seven colours across that span as evenly as possible and the
closest adjacent pair is `4.48^(1/6)` = **1.28:1** — and that best case is only
attained by a set containing pure white and sitting exactly on the floor, which
leaves no freedom for hue at all. **No seven-colour palette that clears the
contrast floor can separate its spheres by luminance.**

The shipped set's five closest pairs, generated by `tools/lib/palette.mjs` from
all 21 and asserted against this document by `tests/framebudget.test.mjs`:

<!-- palette:closest-pairs:start -->
| Rank | Pair | Ratio | Also in CLASSIC |
| --- | --- | --- | --- |
| 1 | AMBER↔AQUA | 1.10:1 | yes |
| 2 | CORAL↔VIOLET | 1.14:1 | yes |
| 3 | VIOLET↔INDIGO | 1.24:1 | no |
| 4 | AMBER↔ROSE | 1.25:1 | no |
| 5 | CORAL↔ROSE | 1.34:1 | no |
<!-- palette:closest-pairs:end -->

So the shipped set is within a factor of 1.2 of a bound nobody can beat.

**This table is generated because the hand-typed version of it was wrong in the
way that matters.** Round 4 listed AMBER↔AQUA, CORAL↔VIOLET, INDIGO↔VIOLET and
ROSE↔CORAL. Every one of those ratios is arithmetically correct and the *set* is
not the closest pairs: it omits **AMBER↔ROSE at 1.2470**, which is third —
effectively tied with VIOLET↔INDIGO at 1.2446, a gap of 0.002 — and publishes
the fifth-closest in its place. The test underneath it computed and sorted all
21 pairs and then asserted only the first one plus four substring matches, so it
checked every quoted number and never the property the sentence claimed.

That omission is the expensive kind. §15's open question 4 makes glyph
discriminability *"under protanopia/deuteranopia simulation"* the entire remedy
for this palette, and it takes this list as its input. AMBER `#FFB020` and ROSE
`#FF7FD1` both shift toward yellow/beige under red-green deficiency and are
arguably the most confusable pair in the set — and they were the pair the input
list left out. A validation plan is only as good as the list it is handed.

The two worst pairs are inside the CLASSIC five, so this was never a SEVEN
problem, and no hex substitution fixes it. What carries the information instead:
the glyph etched into every sphere body, repeated on every chip; the colour
named in text on every ticket line; and the settled order announced as a string
to the screen reader (§11). Those are required, not recommended.

**Gold means *settled and true*, and appears in exactly six places:**

1. the slot ring at the moment it locks;
2. the multiplier stamp;
3. the fairness chip once verified locally;
4. the count badge on a chip that is already on the ticket;
5. a line that has resolved *won* (§2.1);
6. the tube's full-height rim during a celebrated close (§9).

Nowhere else. The list is six rather than "three, ever" because the shorter rule
was contradicted three times inside this same document, and an art director
enforcing it literally would have hit all three in a day. Every entry is the
same semantic: something is settled, and it is true. Gold never appears on
anything speculative, pending, or merely available — never on an unplaced chip,
never on a balance, never on a call to action.

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

**Resolution, as a material decision.** The chamber's WebGL **backing store is
capped at DPR 2** even on a DPR 3 panel. This is written here rather than buried
in the renderer because it is a look decision: the chamber is deliberately
low-frequency — gradients, bloom, one sprite master, no thin high-contrast edges
— so at DPR 2 it is indistinguishable from native, and the cap buys back 55% of
the fill and bandwidth on the highest-density reference device (§7.1). Anything
that *does* have a hard edge is drawn outside the canvas at native DPR: all
text, the slot rings, the tube outline, and the 1 px specular line, which are
DOM and SVG. If a build ever renders type or a ring into the WebGL layer, the
cap becomes a visible softness and the decision has been broken.

### 6.3 Lighting

- **Key:** single, cool (≈6200 K), above-left at 35°, intensity 1.0.
- **Fill:** warm bounce (≈3000 K) off the base plate, intensity 0.12.
- **Rim:** **no external rim light on spheres.** Deliberate — they emit, they are
  not lit, and a rim would read as a lamp somewhere off-screen. What §7's third
  technique calls the fresnel mask is the opposite thing: an *interior* falloff that darkens the
  silhouette edge from within, the way a glowing body inside a translucent shell
  loses brightness toward its rim. It removes light at the edge; a rim light adds
  it. If a build ever shows a bright ring on a sphere's outer edge, the sign is
  wrong.
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
| Settle stagger | 420 ms (CLASSIC) / 360 ms (SEVEN) | — | interval between locks 1 … `n−1` |
| Fall | 340 ms | `cubic-bezier(.16,1,.3,1)` | expo-out; the sphere never overshoots its slot |
| Lock rebound | 90 ms | `cubic-bezier(.34,1.56,.64,1)` | 4% overshoot on the *ring*, chamber flexes 2 px |
| Line state change | 120 ms | `cubic-bezier(.2,.8,.2,1)` | identical for won and lost; fires at the deciding lock, never later |
| Close, neutral | 430 ms | same fall + rebound | the last sphere, at full speed, undramatised |
| Close, celebrated | 1,060 ms | fall at 0.35× | §9; fires only when `creditedChips > totalStakeChips` |
| Stamp | 220 ms | `cubic-bezier(0,.7,.2,1)` | multiplier scales 1.18 → 1.00 |

There is no "resolve" beat. Round 2 budgeted 600 ms for *"lines still undecided
at the final lock"*, a set §2.1's own rule makes permanently empty, and counted
that 600 ms inside the published round duration. Lines change state as they are
decided; the deleted beat is why a neutral round is now 3.62 s rather than 4.2 s.

Rules: nothing bounces except the lock ring. Nothing rotates on screen except
the impellers. No easing curve is linear. `prefers-reduced-motion` replaces
agitate with a 200 ms cross-dissolve and the falls with 120 ms fades, keeping
the same total duration so the audio phrase still lands.

**One more rule, and it is a performance rule with a visual consequence.** Rows
4 to 7 of that table animate the DOM/SVG chrome layer, not the canvas — §6.2
moved every hard edge out there deliberately — and that layer is composited at
native DPR beside the WebGL canvas on every frame. So: **during SETTLE, chrome
animates `transform` and `opacity` only, on pre-promoted layers.** The 4% ring
overshoot is a `scale` on a pre-rasterised ring, not a growing stroke. The 2 px
chamber flex is a `translate` on the tube group, not a new path. The per-line
change is `opacity` and `color`. Anything that invalidates raster —
`stroke-width`, `stroke-dashoffset`, filters, `box-shadow`, width/height — is
banned for the duration of the beat, and §7.1.1 does the arithmetic for what it
would cost. The lock rebound is 90 ms against a 360–420 ms stagger, so at most
one ring is ever in flight; that headroom is not an invitation to spend it.

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

### 6.7 Identity: the wordmark

§6.1 to §6.6 were production-ready for **the chamber** and silent on the rest of
the app: a title positioned as premium had no wordmark, no icon system beyond
seven sphere glyphs, no splash, and no state treatments. Those are not details
deferred to build — a wordmark is the first thing a store listing, a splash and
a share card all need, and "we will design it later" is how a premium title
ships a default typeface at 200% letter-spacing.

**Construction.** `AETHER ORDER`, set in Neue Haas Grotesk Display Pro 65
Medium, all caps, tracking `+0.14em`, on one line. The two words are separated
by **one em space plus a 2 px `--gold` lozenge**, 2 × 8 px, vertically centred
on the cap height — the only mark in the identity, and it is the same semantic
gold carries everywhere else (§6.1 use 2, the stamp): *this is the fixed thing*.
Colour is `--ink` on dark; on the single permitted light surface (a print or a
press sheet) it is `--void` on white with the lozenge unchanged.

| Rule | Value |
| --- | --- |
| Minimum width | 96 px. Below that the lozenge is dropped and the two words stack, tracking `+0.10em`, still one weight. |
| Clear space | The cap height of the `A`, on all four sides. Nothing enters it, including the safe-area inset. |
| Stacked lockup | Two lines, `AETHER` over `ORDER`, optically centred, leading 0.92. For square crops and app icons only. |
| Monogram | The lozenge alone, 1:1, centred in a `--void` field. App icon, favicon, share-card corner. It is not a letterform and never becomes one. |
| Never | No outline, no gradient, no bevel, no drop shadow, no italic, no second weight, no colour other than `--ink`/`--void`, no sphere used as a letter, no `O` replaced by a circle. |

**The SEVEN lockup** is the wordmark plus ` · SEVEN` at 0.62× the size, same
tracking, `--ink-dim`, on the same baseline. It is a suffix, never a second
wordmark, because §12 says SEVEN is a toggle and not a separate product and the
identity has to agree with that.

**What is deliberately not specified here** is a logotype drawn as custom
outlines. The mark is a typesetting instruction because that is what survives a
build: it renders correctly from the subset font already in the payload budget
(§7.3), at any size, with no asset and no export pipeline. If a custom drawing
is commissioned later it must reproduce this construction, not replace it.

### 6.8 The icon system

Two closed sets. Nothing outside them ships, and nothing in them is decorative.

**Sphere glyphs (7).** `disc`, `ring`, `triangle`, `square`, `diamond`,
`chevron`, `hexagon` — §6.1's table. They are the colour-blind channel, not a
backup for it, so they are drawn to one construction: a **24 × 24 grid, 2.5 px
stroke or solid fill, no stroke-and-fill mixing, no rounded joins**, sized so
that every glyph's *filled area* is within 15% of every other's. That last rule
is what stops `triangle` reading as lighter than `square` at 24 px, and it is
checked in §15's open question 4 alongside the deuteranopia pass. Glyphs are
etched into the sphere at 46% of its diameter in `--void` at 24% opacity — they
subtract light, exactly like the interior fresnel (§6.3), and never sit on top
as a bright mark.

**UI icons (6).** One stroke weight, 1.5 px on a 24 × 24 grid, square caps,
`--ink-dim` at rest and `--ink` when active. That is the whole set:

| Icon | Where | Form |
| --- | --- | --- |
| `⌂` menu | top rail left | A 14 × 12 house outline. Opens S8/S9 in two taps. |
| `◈` fairness | top rail right | A 14 × 14 rotated square with a 6 × 6 rotated square inside it. Amber when committed, gold when verified locally (§6.1 use 3). |
| `←` back | lobby, sheets | A 14 px chevron plus a 6 px tail. Never a chevron alone. |
| `×` close | every sheet | Two 14 px strokes at 45°. Always paired with drag-to-dismiss. |
| `⧉` copy | transcript, receipt | Two 12 × 12 offset squares, 3 px apart. |
| `↻` replay | result | A 270° arc, 14 px diameter, with a 5 px arrowhead. The **only** arc in the set. |

Six icons is a constraint, not a coincidence: every screen in §5 is reachable
with these, and an app that needs a seventh has grown a feature that §10 has not
been asked about. No icon is ever gold — gold has six uses (§6.1) and none of
them is a control.

### 6.9 Chamber geometry, and the impeller

S1's wireframe gives the tube 96 wide and slots 78 tall. The rest, so the
chamber can be built rather than approximated:

| Element | CLASSIC (`n = 5`) | SEVEN (`n = 7`) |
| --- | --- | --- |
| Chamber rect | 390 × 430 | 390 × 390 (§12 crops 40 px) |
| Glass body | 358 × 374, inset 16 px, corner radius 24 | 358 × 334 |
| Collar rings | 28 px tall, top and bottom, `--chrome` → `--chrome-dark` vertical | same |
| Tube, outer | 96 wide, centred at x = 195 | same |
| Tube wall | 6 px each side, `--glass-edge` at 40% | same |
| Slot pitch | 78 | 58 |
| Tube height | `n` × pitch + 24 (12 px rim top and bottom) = 414 | 430 |
| Sphere diameter | 64 (pitch − 14) | 44 (pitch − 14) |
| Specular line | 1 px `--specular`, x = 135, from the top collar to 60% depth | same |

**The frame budget sizes the sprite at 64 px for both variants** (§7.1), which
over-counts SEVEN by a factor of two in the sphere pass. That is deliberate and
it is stated rather than corrected: the published figure is then an upper bound
over both variants, and a budget that has to be recomputed per variant is a
budget somebody will quote the wrong half of.

**The impeller.** Two of them, one behind the tube at each end of the chamber,
visible only as silhouette and motion:

- A **96 px outer ring**, 5 px stroke, filled with a `--chrome` → `--chrome-mid`
  → `--chrome-dark` gradient running with §6.3's key (above-left lit, below-right
  in shadow), an inner `--chrome-dark` race, a shaded hub, and **five 18 px
  vanes** at 72°, drawn as quads that meet the hub and taper from 6 px there to
  2 px at the rim. Five, not seven, in both variants: it is machinery, not a
  counter, and a five-vane wheel at 3.2 Hz never appears to stand still under the
  settle cadence the way a seven-vane one does at 360 ms.
- **Opacity 0.30 at rest, 0.62 while it turns**, and this is a correction to the
  flat 30% earlier rounds published. At 26–42% on a flat 3 px stroke the wheel
  read as a wireframe — an Illustrator guide or a loading spinner, not a machined
  part — and its rotation was imperceptible in a frame dump, because a five-fold
  rotationally symmetric outline at that weight has almost no silhouette to
  turn. The number that changed is not the one that fixed it: what makes it
  machinery is the shading and the hub-to-rim taper above, and what makes the
  rotation legible is the *shaded* silhouette. The wheel is still subordinate to
  the spheres at both values — it is never the brightest object in the frame,
  and if it ever is, the value is wrong in the other direction.
- Centred at `(72, 88)` and `(318, 342)` relative to the chamber rect —
  diagonally opposed, off the tube's axis, so neither ever sits behind a sphere
  at rest.
- It is the **only thing on screen that rotates** (§6.4). It spins up over the
  260 ms CHARGE, holds through AGITATE, and decelerates to a stop across the
  first two locks. It never reverses, never pulses, and never reacts to the
  outcome — a reacting impeller is agency the player does not have (§3).
- It is drawn **in the WebGL layer**, behind the liquid, because it has no hard
  edge that matters at DPR 2 and because putting a rotating element in the
  chrome layer would break §7.1.1's transform-only rule for the settle.

### 6.10 First run, and the states nothing else specifies

**Splash.** 900 ms maximum, and it is a load screen rather than a title card:
the `--void` field, the monogram (§6.7) centred, and a 1 px `--ink-dim` hairline
that fills to the monogram's width as the payload arrives. No animation on the
mark itself, no sound, no tagline. If the payload is already cached the splash
is skipped entirely rather than held for effect — a splash that waits when it
does not have to is a loading screen pretending to be branding.

**Loading, in-app**, is never a spinner. Three cases, three treatments: a sheet
that is fetching shows its own layout with `--chrome-dark` blocks at the text
positions; the chamber shows the idle drift with the tube empty; the verifier
shows the hash it is checking, greyed, with the check mark absent. Nothing
rotates except the impeller (§6.4), and that includes throbbers.

**State treatments** are specified because §10 *requires* the UI to present at
least one of them, and a required screen with no design is a requirement that
does not ship. All four share one shape — a 1.5 px `--chrome-dark` rule, the
message in `--ink` at 17 px, the detail in `--ink-dim` at 15 px, one full-width
action — and none of them uses `--win`, gold, or a face:

| State | Message | Action | Rule |
| --- | --- | --- | --- |
| Network lost, pre-commit | *"No connection. Nothing has been staked."* | `TRY AGAIN` | The ticket stays on screen exactly as built. |
| Network lost, post-commit | *"Your round is settling on the server. It will be here when you reconnect."* | `RETRY` (auto every 3 s) | The result is restored from the round snapshot (§7.9); it is never re-derived on the client. |
| Wallet declined | *"That bet was not placed — your balance did not cover it."* | `EDIT TICKET` | Never *"add funds"*, never a deposit link. §10 bans a prompt triggered by a money event. |
| At the rolling ceiling | *"You have played 900 rounds this hour. Betting opens again at 14:32."* | `SEE MY LIMITS` → S9 | An absolute time, never a countdown — a countdown is a thing to wait out. No *"come back soon"*, no notification offer. |
| WebGL unavailable | not a state | — | The Canvas2D lane takes over silently (§7 technique 6). A player is never told their device is worse. |

The rolling-ceiling copy is the one to get right, and the rule behind it is: the
screen states a fact and offers the limits tool. It does not apologise, does not
promise, and does not give the player anything to do until the window frees.

---

## 7. Rendering: premium fluid, no fluid simulation

**Target:** 60 fps on iPhone SE 2, Pixel 6a and Galaxy A54; hard floor 30 fps;
≤ 900 KB initial payload; battery-safe for 20-minute sessions. A real-time fluid
solver is off the table. None is needed.

**"Target", not "constraint", and the word is doing work.** No client exists, so
60 fps here is a *budget plus an acceptance test*, never a measurement, and this
document is not going to spell it like one. §7.1 budgets the two layers that
cost anything — the WebGL canvas and the DOM/SVG chrome the canvas deliberately
pushes every hard edge into — and shows both fit the reference class with
headroom. §7.4 states the rule that keeps the chrome layer cheap, the
acceptance test that has to be run on real hardware before content lock, and the
runtime ladder that makes a miss graceful instead of silent. A budget is
evidence that a target is *reachable*; only the acceptance test can say it was
reached.

**Principle:** the transcript is known the instant the round commits, so the
entire round is a *precomputed choreography track*. Nothing is solved at
runtime; everything is evaluated.

**Seven concrete techniques:**

1. **Choreography from the transcript.** At COMMIT the client builds a keyframe
   track: for each sphere, one cubic Bézier from its chamber position to its
   slot, plus a phase offset. The Béziers come from a build-time bake of
   `n × n` canonical paths in normalised tube space; the runtime picks
   `template[startLane][targetSlot]` and time-shifts it. No physics, no solver,
   no collision. The line-resolution track (§2.1) is baked at the same moment,
   by `resolutionTrack` in `tools/lib/resolution.mjs`: bounded by 5,914 predicate
   evaluations per line at `n = 7`, and measured at **0.48 ms** for a realistic
   twelve-line SEVEN ticket and **10.7 ms** for the worst one the risk policy
   permits — eleven maximal-rank FULL ORDER claims, each of which agrees "lose"
   across thousands of completions before it reaches its single winner. Both are
   paid once, inside the 260 ms CHARGE beat, and `tools/bench.mjs` asserts the
   worst case against that beat as a published band (`docs/ENGINE.md` §4).
   Round 4 quoted 1.3 ms for "a hostile" ticket, which is roughly the realistic
   figure with a hostile label on it. Nothing about which lines are alive is
   searched during SETTLE.
2. **The "fluid" is one fragment shader, not a sim.** A single pass over the
   chamber rect does: a two-octave value-noise domain warp for caustics, a
   refraction offset that resamples the sphere layer, and a vertical depth
   gradient. It reads the sphere layer, so the spheres are rendered to an
   offscreen target first — see the pass table below, where that second pass is
   accounted for rather than assumed away.
3. **Spheres are sprites, not geometry.** One 256 × 256 grayscale master sprite,
   tinted per element at runtime, composited with a fixed specular layer and an
   interior fresnel mask (an absorption falloff, *not* a rim light — see §6.3).
   Apparent rotation comes from scrolling the interior caustic UV. Seven colours
   cost one texture.
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
   choreography, spheres still sprites, bloom dropped entirely, and the fluid
   replaced by a pre-rendered 12-frame looping caustic sheet (512 × 512 WebP) at
   0.5 opacity over the static gradient.
7. **Determinism.** Because the track is a pure function of the transcript, the
   same transcript replays identically. That is what makes `REPLAY` real and
   what makes the shareable clip (§9) reproducible rather than re-recorded.

### 7.1 The frame budget, in device pixels

**GPUs shade device pixels, not CSS pixels.** Round 2 computed this table at
"390 × 430 logical" and concluded 20.6 Mfrag/s, which understated the real load
by a factor of four to nine across the three reference devices — whose
**device-pixel ratios** are 2 (iPhone SE 2), 2.6 (Pixel 6a) and ~2.75
(Galaxy A54). The conclusion survived; the arithmetic did not, and this is a
document whose whole claim is that it states its arithmetic. The table is now
generated by `tools/lib/framebudget.mjs` and `tests/framebudget.test.mjs` fails
the build if the document and the module disagree.

**The assumption, stated:** the chamber's WebGL backing store is **capped at
DPR 2** (§6.2). Every reference device therefore renders the same 780 × 860
backing store for a 390 × 430 CSS chamber. UI chrome is not in this canvas —
it is DOM and SVG at native DPR — so the composite pass below composites fluid
and bloom only. **That chrome is not free, and this table is therefore not the
whole frame: §7.1.1 budgets the layer it excludes.**

| # | Pass | Resolution (device px) | Shaded fragments | Note |
| --- | --- | --- | --- | --- |
| 1 | Sphere layer → offscreen RT | 0.5× · 390 × 430 | 28,672 (+167,700 cleared) | 7 sprites at 64 CSS px; the refraction source only needs low frequency |
| 2 | Fluid: caustics + refraction + depth | 0.75× · 585 × 645 | 377,325 | samples pass 1 with a refraction offset |
| 3 | Bright-pass + downsample | 0.25× · 195 × 215 | 41,925 | bloom threshold 0.78 |
| 4 | Two separable blurs | 0.25× · 195 × 215 | 83,850 | 9-tap Gaussian each direction, 12 px radius at 390 px width |
| 5 | Composite: fluid + bloom add | 1.0× · 780 × 860 | 670,800 | the only full-resolution pass; UI chrome is DOM, not this canvas |
| | **Total** | | **1,202,572 shaded + 167,700 cleared** | **72.2 Mfrag/s** at 60 fps |

Bandwidth, at 4 bytes per pixel: **329 MB/s** of render-target writes and about
708 MB/s of texture reads, **1,037 MB/s** in total. The read figure is an upper
bound that assumes every tap misses cache, which a 9-tap separable blur
emphatically does not.

Against the reference class — an A13, Mali-G78, Mali-G68 or Adreno 619 does
1–4 Gfrag/s against 10–25 GB/s of memory bandwidth — that is 2–7% of fill and
4–10% of bandwidth for the canvas.

**What the cap buys.** Uncapped on the Galaxy A54's ~2.75 ratio the same frame
is **136.5 Mfrag/s** and 1.96 GB/s: still feasible, and 89% more work for a
difference no one can see on content with no hard edges in it. The cap is worth
roughly a watt on a 20-minute session, which is the actual reason for it.

### 7.1.1 The other layer, which the table above does not contain

**The canvas is not the frame.** §6.2 caps the backing store at DPR 2 and pays
for it by moving *every hard edge out of the canvas*: all text, the slot rings,
the tube outline and the 1 px specular line are DOM and SVG at native DPR. §6.4
then animates precisely that layer for the whole of SETTLE — a gold ring lock
per slot with a 90 ms rebound at 4% ring overshoot, a 2 px chamber flex, and a
per-line state change at 120 ms. Round 4 published the five-pass table above as
the frame budget and never counted that layer at all, which meant the budget
proved the cheap half of the frame and was silent on the expensive half.
Concurrent SVG animation beside a WebGL canvas is the standard 60 fps failure on
exactly this device class.

Two costs, and they fail for different reasons.

**Composite — unavoidable, and affordable once counted.** The system compositor
blends the chrome layer and the upscaled canvas into the framebuffer at *native*
density every frame, whether or not anything moved. Generated by
`tools/lib/framebudget.mjs`, at 12 pinned ticket rows and `n = 7`:

<!-- chrome-budget:start -->
| Device | DPR | Chrome layer (device px) | Composite | Canvas + composite | Total traffic |
| --- | --- | --- | --- | --- | --- |
| iPhone SE (2nd gen) | 2 | 780 × 1688 | 79.0 Mfrag/s | 151.2 Mfrag/s | 1,830 MB/s |
| Pixel 6a | 2.6 | 1014 × 2194 | 133.5 Mfrag/s | 205.6 Mfrag/s | 2,377 MB/s |
| Galaxy A54 | 2.75 | 1073 × 2321 | 149.4 Mfrag/s | 221.6 Mfrag/s | 2,537 MB/s |
<!-- chrome-budget:end -->

Against the same 1–4 Gfrag/s and 10–25 GB/s, the *whole* frame is **6–22% of
fill and 10–25% of bandwidth** — roughly three times the canvas-only figure, and
still comfortable. That is the honest number, and it is the one this section
publishes.

**Raster — avoidable, and the thing that actually breaks.** A fragment count
cannot see the real risk. If an animation touches any property that invalidates
a layer's raster — stroke geometry, `stroke-dashoffset`, filters, `box-shadow`,
width/height, anything that triggers layout or paint — that layer is
re-rasterised on the compositor thread and re-uploaded *every frame*. On the
A54 the tube outline group alone is 264 × 1183 device pixels; animating the ring
by stroke geometry and the flex by editing the tube path costs **21.3 Mpx/s of
raster and 85 MB/s of texture upload** for content that has not changed shape.

So it is a rule, not a hope:

> **During SETTLE the chrome layer animates `transform` and `opacity` only, on
> pre-promoted layers.** The ring rebound is a `scale` on a pre-rasterised ring.
> The chamber flex is a `translate` on the tube group, never a new path. The
> per-line state change is `opacity` and `color`. Any property that invalidates
> raster is banned for the duration of the beat. A build that animates
> `stroke-width` during SETTLE has broken the frame budget, not decorated it.

Under that rule the layer costs **21 promoted layers, 1,608,028 device pixels,
6.43 MB of layer memory, and 0 pixels of raster per frame** on the A54. The
rings are also serialised for free: the 90 ms rebound is shorter than the
360 ms settle stagger, so **at most one ring is ever in flight**.

`tests/framebudget.test.mjs` recomputes all of it and fails the build if the
document and the module disagree.

### 7.1.2 What happens if it misses anyway

Bloom is the first thing cut: below 50 fps on the rolling average the client
drops passes 3–4 and composites the emissive layer additively at full
resolution. That is a visible downgrade and an acceptable one. Below 45 fps the
Canvas2D lane takes over entirely (technique 6).

The ladder is a mitigation, not a substitute for the target, and the honest way
to say that is: **the budget shows 60 fps is reachable on the reference devices;
it does not show it was reached.** That is §7.4's job.

### 7.2 What "the same round" means across the two lanes

The choreography is a function of **elapsed time**, not of frame index. Both
lanes therefore hit every beat at the same wall-clock offset from COMMIT, and
audio stays in sync, even though a device that just failed a perf probe will
plainly not draw the same frames at the same moments.

The earlier claim that a round is "byte-identical in timing" across lanes was
overstated and is withdrawn. The defensible and sufficient statement is: **the
same transcript produces the same beats at the same times on any device**, and
the clip export (§9) does not screen-record either lane — it renders from the
transcript at a fixed 30 fps, so the exported file is identical regardless of
which lane the player watched.

### 7.3 Payload budget

| Asset | Size |
| --- | --- |
| Sphere master, 256 × 256 | 60 KB WebP |
| Caustic sheet, 12 frames, 512 × 512 | 180 KB WebP |
| Subset fonts (display + mono, Latin) | 90 KB WOFF2 |
| Shaders | 8 KB |
| JavaScript, gzipped | 180 KB — broken out below |
| Audio | 240 KB Opus |
| **Total** | **≈ 758 KB**, under the 900 KB ceiling |

The JS line is the one that needs showing, because it has to hold two renderers,
ten screens, an audio engine, a verifier, a lobby and a video encoder:

| Module | KB gz |
| --- | --- |
| Core, state, router | 18 |
| Ten screens and shared components | 38 |
| WebGL2 renderer + shader loader | 26 |
| Ticket builder, paytable and alias data | 14 |
| Audio engine | 12 |
| Canvas2D fallback renderer | 11 |
| Choreography + resolution track builder | 9 |
| Verifier: canonical encoder, re-derivation, receipt check | 9 |
| Shared chamber: lobby screen, socket transport, cadence clock | 9 |
| Clip export: fMP4 muxer + orchestration | 13 |
| i18n runtime + one locale | 8 |
| Session governor (cycle floor, rolling ceiling, reality checks) | 7 |
| Polyfills and misc | 6 |
| **Total** | **180** |

The lobby's 9 KB and the extra 4 KB of screen budget are the whole client cost
of §13.2. It is a lane on the existing transport, one screen, and a clock.

The verifier is small because SHA-256 and HMAC come from `crypto.subtle`; only
the canonical field encoder, the Fisher–Yates re-derivation and the receipt
comparison are ours. Ed25519 verification also comes from WebCrypto where
available. Where it is not, the client shows an honest *"signature not checked
on this device"* — and it reaches that state by reading `bindingsVerified` on
the verification result, **never** by reading `ok`, which is `false` in that
case (`docs/ENGINE.md` §7.8). A receipt whose signature nobody checked is not a
verified receipt, and the UI may not draw it as one.

**What is explicitly not built:** SPH or grid fluid, soft-body spheres,
real-time refraction of the full scene, per-sphere 3D meshes, cloth, or any
runtime physics integration.

### 7.4 The acceptance test for the frame rate

A budget shows a target is reachable. Only a measurement shows it was reached,
and this is the measurement — run before content lock, on all three reference
devices, on battery, at 50% screen brightness, after five minutes of continuous
play:

1. **Frame time.** 200 consecutive SETTLE frames captured from the browser's own
   timeline, on a 12-line SEVEN ticket, which is the worst chrome load the game
   can produce. 95th-percentile frame time ≤ 16.7 ms is a pass; ≤ 22 ms with the
   bloom passes dropped is a conditional pass that ships with the ladder's
   threshold raised; anything worse fails and the chamber loses a pass.
2. **Zero raster during SETTLE.** The compositor trace must show no raster task
   attributable to the chrome layer between lock 1 and lock `n−1`. That is
   §7.1.1's rule, checked rather than trusted, and it is what fails first when
   somebody reaches for a `stroke-width` transition to make a ring feel nicer.
3. **Layer count and memory** within §7.1.1's published figures. A build that
   promotes each of twelve ticket rows *and* something else is how 6 MB becomes
   60 and a mid-range phone starts evicting layers mid-settle.
4. **Thermals.** Frame time at minute 20 within 15% of frame time at minute 1,
   because a 20-minute session is the published battery target and a chamber
   that throttles at minute 12 has not met the target on any device.

**None of it has been run, because there is no client.** Nothing in §7 implies
otherwise, and the word "target" in the opening line is there for this reason.

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
- **Win — and only a win.** The pentatonic set blooms into a chord plus one sub
  drop. The trigger is `creditedChips > totalStakeChips` for the *round*, never
  "a line hit": a round that returns less than it cost gets no chord, no sub
  drop and no haptic, whatever happened on any individual line. Within genuine
  wins the treatment is scaled by tier, not by amount — a FLOW win and an ORDER
  win differ in *voicing*, not loudness — so a small win is not made to feel
  like a failure. §10 states the gate; `roundPresentation` implements it.
- **Loss, and any round that returns less than it cost.** Nothing. No sting, no
  descending tone, no negative cue — and equally no chord. The bed simply
  returns. Both halves of that are hard rules (§10).
- **Line resolution during settle.** No sound at all. Lines change state as the
  tube fills (§2.1) and a per-line audio cue would turn honest early
  information into eleven little drum rolls.
- **Haptics.** One 8 ms light impact per lock; one 24 ms medium on a win;
  nothing on a loss. Off by default on Android where implementations vary.

---

## 9. The close, and its signature case: LOCK-OUT

**Every round ends the same way.** By lock `n−1` the settlement is fully
determined (§2.1), so the last sphere always falls into a foregone conclusion.
The design does not fight that; it is the format. What varies is the treatment,
and it varies on exactly one comparison — the same one that gates everything
else in §10:

| At lock `n−1` | The close |
| --- | --- |
| `creditedChips > totalStakeChips` | Celebrated: audio ducks, the fall slows to 0.35×, the tube rim ignites, the chord lands on the lock. 1,060 ms. |
| anything else | Neutral: one fall at full speed, one lock, no audio event, no colour change. 430 ms. |

A losing round's close is byte-for-byte the same 430 ms whether the ticket
missed by one sphere or by five. That is the no-near-miss rule doing its work at
the only moment it could plausibly be broken.

**LOCK-OUT is the maximal celebrated close:** a FULL ORDER ticket already won
with a sphere still in the liquid.

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

The set piece itself is 1,280 ms — the 1,060 ms celebrated close plus the
220 ms stamp — and it ends on the number. The shareable cut is longer: 3.4 s,
portrait, starting one lock earlier so the viewer sees the penultimate sphere
seat and understands *why* the outcome is already known. §15 leaves the choice
between that and a 6 s cut open.

**Why it travels.** The tension resolves *before* the visual does. The viewer
knows the outcome and still has to watch it arrive — anticipation collapse
rather than surprise. That is a fundamentally more shareable shape than a reveal,
because the clip's emotional peak sits at second one, which is where a
vertical-feed viewer decides whether to keep watching.

**Why it is honest.** The celebrated close fires **if and only if the round
returned more than it cost**, and LOCK-OUT is the ORDER-tier voicing of it. It
is never a tease, because there is nothing left to tease: the outcome was
determined one lock earlier.

**How often it actually fires.** Conditional on the ticket carrying a FULL ORDER
line, exactly `1/120` in CLASSIC and `1/5040` in SEVEN. *Unconditionally* it is
rarer by the attach rate of that chip, and that is the number that matters when
judging LOCK-OUT as the game's signature moment: at a plausible 20% attach rate
it is roughly one round in 600 in CLASSIC, and a player who never buys the chip
never sees it at all.

That is a real limitation of resting a production on one mechanic, and it is why
LOCK-OUT is now framed as the top of a ladder rather than as the whole show.
Every winning round gets the slow close — a FLOW win at 1.92× gets it too, in a
quieter voicing (§8) — so the anticipation-collapse shape lands on one single-
line BEFORE round in two and one single-line FORM round in five, rather than one
round in six hundred. §13 does the rest: OPENING resolves by lock 2 and PODIUM
by lock 3, with the same shape at a fraction of the rarity.

**Hard rule — no manufactured near-miss.** The client must not add emphasis,
sound, colour, camera or slow-motion to partial progress on a **losing** ticket.
Three-of-five correct then wrong looks exactly like zero-of-five: same cadence,
same audio, same neutral lighting. Near-miss amplification is the single most
predatory technique in this genre and it is banned here at the render layer, not
just by policy. A losing round has no dramatic beats at all.

### 9.1 Clip export, specified

`SHARE` produces a 1080 × 1920, ≤ 6 s MP4 **rendered from the transcript, not
screen-recorded**, with the round's commitment hash burned in at the bottom in
mono type. Anyone who receives the clip can paste that hash into the verifier and
confirm the round was real. The artefact is self-authenticating, which also
means the studio cannot fake a marketing clip without it being detectable.

That is a load-bearing distribution claim, so here is what it costs.

| Concern | Decision |
| --- | --- |
| Encoder | `VideoEncoder` (WebCodecs), H.264 baseline, level 4.2, 30 fps, 5 Mbps CBR. Platform API: 0 KB of payload. |
| Muxer | Inline fragmented-MP4 writer, ~7 KB gzipped. No external library, no WASM. |
| Audio | `AudioEncoder` → AAC-LC 96 kbps, muxed alongside. If unavailable, the clip ships silent rather than failing. |
| Frames | 180 (6 s × 30 fps), rendered offscreen at 1080 × 1920 through the same choreography track. |
| Render cost | **5.76 Mfrag/frame** × 180 ≈ **1,036 Mfrag** — every chamber pass at export resolution (3.68 Mfrag) **plus the overlay composite** (2.07 Mfrag: the burned-in hash, the stamp and the tube outline, blended over the chamber at 1080 × 1920 on every frame). Round 3 counted only the composite pass (2.07); round 4 counted every chamber pass and still omitted the overlay, which is the same omission §7.1.1 fixes on device. Tenths of a second of GPU time; ~2–4 s wall clock on the reference devices including readback. |
| Encode cost | Hardware encoder, 3–8× realtime on A13 / SD 6-series → ~1–2 s. |
| Total time | ≤ 6 s behind a progress sheet with a cancel button. |
| File size | ≈ 3.75 MB video + ~70 KB audio, inside the 4 MB target. |
| Battery | One export ≈ 8 s of gameplay rendering plus one hardware encode. Negligible against a 20-minute session, and strictly user-initiated — nothing is ever encoded speculatively. |
| Payload cost | +13 KB gzipped total (muxer + orchestration + progress UI). |

**Fallback ladder**, because `VideoEncoder` is not universal:

1. `VideoEncoder.isConfigSupported` passes → encode on device, as above.
2. It does not → offer a server render: `POST /clip` with the transcript and the
   receipt digest returns the identical MP4, because the render is a
   deterministic function of the transcript. Opt-in per share, and the request
   carries no account identifier.
3. Offline, or the player declines the server → a 1080 × 1920 PNG result card
   from the same renderer, ≤ 300 KB, carrying the same burned-in hash. It is a
   worse share and it is still verifiable.

The clip is never rendered from the Canvas2D lane and never from the screen: it
always comes from the transcript at a fixed 30 fps, so two players sharing the
same round share byte-identical files.

---

## 10. Responsible design

These are build constraints. Violating one is a release blocker, not a
discussion.

**No loss disguised as a win.**

A round that returns less than it cost is a losing round and must be presented as
one. This is the exact mirror image of the manufactured near-miss banned below,
and it is the mechanism that sustains play through net-losing sessions: a
12-line, 12.00-credit ticket whose single BEFORE line returns 1.92 is a
10.08-credit loss, and a win chord, a gold bloom, a multiplier stamp and a
balance counting upward would make it feel like a 1.92-credit win.

- **The gate is one comparison:** `creditedChips > totalStakeChips`, evaluated on
  the round, never on a line. It is implemented once, in
  `roundPresentation` (`tools/lib/presentation.mjs`), and the client must not
  reimplement it.
- Below the gate: no win chord, no sub drop, no haptic, no multiplier stamp, no
  gold bloom, no confetti of any kind.
- Below the gate the balance **writes to its new value without animating
  upward**. A rising balance is a celebration whatever the copy says.
- Below the gate the headline is a neutral statement of fact:
  *"Returned 1.92 of 12.00"*. Never "You won 1.92", never a bare "1.92 ×".
- Break-even is below the gate. Returning exactly what you staked is not a win.
- **What is not suppressed:** which lines won. Line lighting is information the
  player is owed and can read off the tube anyway. Won and lost lines change
  state with identical weight and no audio; only the round-level celebration is
  gated.
- The gate has no bonus, feature, jackpot or promotional exception, because
  every exception anyone has ever written for this rule has been the whole
  problem.

**Speed of play is capped, and SKIP is not a slam stop.**

Round duration is a presentation choice; round *cycle* is a money control. On a
four-second game they are the most consequential regulated property in the
product, and `docs/MATH.md` §10.1 does the arithmetic.

- **Minimum cycle: 2,500 ms**, measured COMMIT to COMMIT, enforced server-side.
  A COMMIT that arrives early is refused, not queued.
- **Ceiling: 900 rounds per rolling 60 minutes.** At the ceiling, COMMIT is
  disabled and S9 shows the time until the window frees. The 2,500 ms floor
  alone would permit 1,440; the rolling ceiling binds first, on purpose.
- **SKIP compresses the presentation and never the cycle.** It is the one
  control most likely to become a slam stop by accident, so the constraint is
  stated as an invariant: `skipShortensPresentationOnly` is `true` in the
  published play policy and a build that violates it does not ship.
- The wait **unlocks, it never expires.** It is not a countdown that can turn
  into a bet, and nothing is lost by ignoring it.
- No mechanic anywhere may shorten the cycle — not a setting, not a VIP tier,
  not a "fast mode", not a promotion.
- At the ceiling, maximum turnover is 180,000 credits/hour and maximum expected
  loss 7,200 credits/hour. Those numbers are published in `docs/MATH.md` §10.1
  rather than left for someone else to compute.

**No autoplay. At all.**

`PLAY_POLICY.autoplay` is the string `'none'`, it is published in
`docs/paytable.json`, and `tests/design.test.mjs` asserts it. It is a value
rather than a sentence because a sentence is what went wrong: round 2 of this
document banned "autoplay that continues through losses" and then, in the next
clause, permitted a count-bounded autoplay that stops only on a single win above
20×. A count-bounded autoplay with no loss limit *is* an autoplay that continues
through losses. Two clauses, one paragraph, opposite meanings — under a heading
declaring that violating any of them is a release blocker.

Why banned outright rather than specified properly:

- A compliant autoplay is not one control. The UKGC RTS pattern this section is
  modelled on requires the player to set **both** a loss limit and a single-win
  threshold before a run starts, requires the run to stop at **either**, requires
  a one-tap cancel, requires the running total to stay visible, and requires the
  settings not to persist silently across sessions. That is a feature with its
  own screen, its own state machine and its own test surface.
- Its only function is unattended wagering. Everything else it is sold as —
  fewer taps, less waiting — is already handled by one-tap `REBET` against a
  2,500 ms cycle floor that autoplay cannot go faster than anyway. Autoplay
  cannot increase this product's throughput; it can only remove the human from
  it.
- A game whose stated retention model is *frequency of short sessions* (§13.7)
  has no coherent reason to ship the one control designed for long unattended
  ones.

If a jurisdiction or an operator later requires autoplay, it is a new
specification with the full RTS control set, a policy value other than `'none'`,
and its own review. It is not a paragraph.

**No other loss-chasing mechanics.**
- No double-up, gamble ladder, or "risk your win" feature. Anywhere.
- No offer, bonus, prompt, or free round is ever triggered by a loss, a losing
  streak, or a balance drop. Triggers are time- and session-based only.
- `REBET` never pre-selects a stake higher than the previous round's. The
  stepper does not "helpfully" round up.
- Losing lines stay on screen, in place, at 40% opacity. They are not swept
  away, hidden, or animated out — the record of the round stays legible.
- No streak counters, no "hot colour", no recent-results frequency strip. Those
  displays manufacture the gambler's fallacy. History shows rounds and net
  position, nothing that implies a pattern.
- No jackpot, no loyalty or level multiplier, no mission with a wagering
  requirement, no randomised reward priced off stake. Every one of them would
  make "96% on every bet, for everybody" untrue; §13.6 gives the reasoning for
  each and it is not a close call.

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
  on reconnect, restored from the round snapshot (`docs/ENGINE.md` §7.9). The
  player never loses value to their network.
- SKIP has no deadline, no effect on the outcome, and no effect on the cycle
  floor.

**Session tools, always available.**
- Session elapsed time and **net position in currency** are visible in S7 and in
  the reality-check card. Never "wins", never a streak.
- Reality check at 30 and 60 minutes, then every 60 minutes for as long as the
  session lasts: a modal showing time played, total staked, and net, with
  `KEEP PLAYING` and `TAKE A BREAK`. Neither button is pre-focused or visually
  louder than the other. The recurrence is a published field, not a sentence:
  `realityCheckMinutes: [30, 60]` **plus** `realityCheckRecurrenceMinutes: 60`.
  An array alone cannot express "then hourly", and a client reading only the
  array — which is what `docs/paytable.json` publishes for exactly this reason —
  would have stopped checking at 60 minutes while this paragraph promised
  otherwise.
- **That schedule is a floor, and the player-facing control in S9 can only
  tighten it.** Round 4 of this document specified the reality check twice and
  incompatibly: S9 listed "reality-check interval" among the player's controls
  while this section stated it as fixed operator policy, and
  `PermutationPlayPolicy` had no field a player's value could live in. An
  implementer could not tell whether the control existed. Worse, if it did, the
  `playPolicyDigest` stamped into every round snapshot would have had to vary
  per player — destroying the one thing it is for, a trace of the *published*
  policy — or else misreport what the player actually received. A
  responsible-gaming control with two readings is exactly the defect this
  section claims to have eliminated for autoplay.

  The rule, as values rather than prose:
  `playerRealityCheckIntervalOptions: [15, 30, 60]` and
  `realityCheckOverride: 'tighten-only'`. Every option is at most the operator
  recurrence, and the operator's own checks fire regardless, so **the schedule a
  player receives is always a superset of the published one**. There is no field
  a player can write that removes a check, delays one, or turns the feature off.
  `effectiveRealityChecks` in `tools/lib/model.mjs` computes the schedule and
  `tests/design.test.mjs` asserts the superset property over every option.

  The option set is published policy and is digested; the player's selection is
  session state and is not, so `playPolicyDigest` stays one value per operator
  policy rather than one per player. That is the only arrangement in which the
  digest means anything.
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

- **Colour is never the only channel, and here it is not even the primary one.**
  §6.1 proves that seven colours clearing the 4.5:1 floor against `--void`
  cannot be separated by luminance — the best achievable closest pair is
  1.28:1 — so the glyph carries the load: etched on every sphere, repeated on
  every chip, with the colour named in text on every ticket line and the settled
  order announced as a string. A build that drops a glyph has dropped the
  channel, not a decoration.
- **Contrast.** The rule applies to **foreground tokens** — anything that can
  carry text, an icon or a state indicator — and is measured against `--void`:
  `--ink` 17.22:1, `--ink-dim` 7.81:1, `--gold` 8.40:1, `--win` 12.01:1. All four
  clear WCAG AAA for normal text (7:1), and no foreground token may ship below
  4.5:1. §6.1's UI accents are foreground tokens and are held to the same floor:
  `--tier-flow` 12.11:1, `--tier-form` 18.30:1, `--tier-order` 6.60:1,
  `--pending` 8.96:1, `--alert` 7.26:1. `--tier-order` is the one that clears AA
  and not AAA, and it is allowed to because it never carries a sentence — it is a
  tab label, a numeral and a 2 px rail, each of which is repeated in `--ink` text
  beside it.

  **The floor is unconditional, which means it also binds the states a UI
  usually exempts.** Two of them shipped under it in round 1 and are named here
  so they cannot come back: a *dead* ticket line may not be dimmed below the
  floor (§5 S5), and a *disabled* control dims its fill and its border, never its
  label. WCAG exempts a disabled control; this document does not, because the
  disabled `COMMIT` carries the stake the player is about to place.

  **Surface tokens are explicitly exempt and must be**, because they are the
  dark world the spheres glow inside: `--abyss` is 1.07:1, `--brine-deep` 1.19:1,
  `--brine` 1.34:1, `--brine-lit` 1.85:1, `--chrome-dark` 2.28:1. Requiring 4.5:1
  of a chamber back plate against the page background would mean a grey game. The
  earlier blanket claim that *no* token ships below 4.5:1 was simply false, and
  saying it undermined the four numbers above that are exactly right.

  What surfaces must do instead: any surface that carries a *boundary the player
  needs to perceive* — a sheet edge over the page, a slot division inside the
  tube — clears 3:1 against the surface it sits on, achieved with the
  `--glass-edge` and `--chrome` tokens rather than with the fill. A test parses
  this palette table and recomputes every ratio quoted here, so a wrong number is
  a build failure rather than a claim.
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
What changes is the shape of the ride. **Every multiplier except BEFORE
re-prices**, because every probability except BEFORE's `1/2` depends on `n`:

| Chip | CLASSIC | SEVEN |
| --- | --- | --- |
| BEFORE | `1.92×` | `1.92×` — the only one that does not move |
| EARLY · LATE · NEIGHBOURS | `2.40×` | `3.36×` |
| FIRST · LAST · SLOT · STACK | `4.80×` | `6.72×` |
| OPENING | `19.20×` | `40.32×` |
| PODIUM | `57.60×` | `201.60×` |
| FULL ORDER | `115.20×` | `4838.40×` at 1-in-5040 |

Production notes:
- Tube grows to seven slots at 58 px each; the chamber crops 40 px tighter.
- Settle stagger tightens to 360 ms so a celebrated round stays under 4.8 s
  (§2): 4.16 s neutral, 4.79 s celebrated.
- The pentatonic set extends to seven notes; the rising phrase gets longer,
  which is exactly the escalation the variant wants.
- SEVEN is a **toggle in the top rail, not a separate product**, and switching
  is free and instant. It is presented as *"more spheres, bigger prizes, same
  96%"* — because that is precisely true.
- Onboarding never starts a player in SEVEN. It is opt-in, always.

---

## 13. Session-level design

**The problem, stated plainly.** Every round is the same four-second
choreography with the same rising phrase. LOCK-OUT (§9) fires at `1/120`
*conditional on the player holding a FULL ORDER chip* — roughly one round in six
hundred at a plausible attach rate, and never at all for a player who does not
buy that chip. A game with one set piece that rare and no layer above the round
is a very pretty lottery, and pretending otherwise would be the same kind of
dishonesty this document spends §10 avoiding.

**And the watch-value comparison is not flattering.** Evolution's Marble Race is
ninety seconds of hosted physical draw with lanes, bonuses, a presenter and an
audience. AETHER ORDER is roughly two seconds of falls whose final beat is, by
construction, informationally dead (§2.1). No amount of glass and bloom closes
that gap, and this document is not going to claim it does.

What the format actually has instead is a **different axis**: eleven distinct
claim shapes at one uniform price, resolving in an order the player chose. A
lottery draw is the same event for everyone holding a ticket. Here the round's
shape is a consequence of the ticket — that is 13.1, it is real, it is specified,
and it is the strongest idea in this document. The bet is that *ticket-dependent
round shape at four seconds* beats *identical round shape at ninety*, for a
player deciding whether to play once more. It is a bet, not a finding, and §14
pre-registers what would falsify it.

Four layers answer the problem. Each is constrained by §10, which rules out most
of what the category reaches for first, and each is honestly rated:

| Layer | Status | Carries how much |
| --- | --- | --- |
| 13.1 round shape varies with the ticket | specified, costs nothing, provably RTP-neutral | most of it |
| 13.2 SHARED CHAMBER | specified: screen S10, protocol, cadence arithmetic, 9 KB | second most |
| 13.3 THE LEDGER | specified; a retention bet with no evidence behind it, and labelled as one | unknown |
| 13.4 THE ALMANAC | default **no** | none unless research says otherwise |

**13.1 The round's shape varies with the ticket, not with a trigger.**
Early resolution (§2.1) is the cheapest variety in the product and it costs
nothing mathematically. What varies is not *whether* a round resolves early —
every round is fully decided by lock `n−1` — but **where in the tube it
happens**, and that is a consequence of which chips are on the ticket.

Here is the whole of it, in CLASSIC, computed exhaustively over all 295
instances × 120 outcomes by `tools/lib/resolution.mjs` rather than described:

<!-- shape:start -->
| Code | Chip | Tier | Can resolve as early as | Decided no later than |
| --- | --- | --- | --- | --- |
| `first` | FIRST | FORM | 1 | 1 |
| `early` | EARLY | FLOW | 1 | 2 |
| `opening` | OPENING | ORDER | 1 | 2 |
| `late` | LATE | FLOW | 1 | 3 |
| `podium` | PODIUM | ORDER | 1 | 3 |
| `before` | BEFORE | FLOW | 1 | 4 |
| `last` | LAST | FORM | 1 | 4 |
| `slot` | SLOT | FORM | 1 | 4 |
| `stack` | STACK | FORM | 1 | 4 |
| `full` | FULL ORDER | ORDER | 1 | 4 |
| `neighbours` | NEIGHBOURS | FLOW | 2 | 4 |
<!-- shape:end -->

Read off it, rather than asserted beside it:

- **FIRST is the only chip in the game with a fixed lock.** It always resolves
  as the bottom sphere seats — first row, and the only row where the two numbers
  are equal. A FIRST-only ticket is a one-beat round and the other four falls
  are scenery.
- **NEIGHBOURS is the only chip that can never resolve at lock 1.**
  Adjacency needs two spheres seated before it can be settled either way, so its
  earliest is 2. Every other chip can die — or win — on the very first fall.
- **The ORDER tier is a ladder in time, not just in price.** OPENING is decided
  by lock 2, PODIUM by lock 3, FULL ORDER by lock `n−1`: three separate moments
  at `1/20`, `1/60` and `1/120` rather than one at `1/120`. A player holding all
  three watches their ticket resolve upward with the tube.
- **A LATE-heavy ticket finishes early, not late.** LATE is decided by lock
  `n−2` at the latest — once `n−2` spheres are down, whether a colour is in the
  top two is already settled — so the last two falls of such a round carry
  nothing at all. The chip's name describes where it looks, not when it lands.
- **Six of the eleven chips can run to lock `n−1`**: BEFORE, LAST, SLOT, STACK,
  NEIGHBOURS and FULL ORDER. A ticket carrying any of them can be live until
  the last informative fall.

The round the player watches is a consequence of the ticket they built, which is
the only kind of variety a game with no post-commit decisions can honestly have.

**The claim this replaces was false, and it was false in the flattering
direction.** Round 4 wrote: *"A FLOW-only ticket is decided in the first two
locks and the rest of the settle is scenery."* Only EARLY is decided by lock 2.
LATE runs to lock `n−2`, and BEFORE and NEIGHBOURS run to lock `n−1` — the
last informative lock — so three of the tier's four chips resolve later than the
sentence claimed, and the tier the sentence used as its example is the one whose
chips resolve *latest* on average. It was the section's only concrete
illustration, under a table rating 13.1 as carrying "most of" the answer to this
document's own "pretty lottery" problem, and it made round-shape variety look
sharper than it is inside the argument the watch-value case rests on. Nothing
caught it because it was prose. The table above is generated, and
`tests/resolution.test.mjs` fails the build if a single cell drifts from the
enumeration — including the tier claims read off it.

**13.2 SHARED CHAMBER — the social layer.** One transcript, many tickets: the
cheapest multiplayer in gambling, because the draw is already a pure function of
a committed seed. A lobby shows a live chamber on a fixed cadence; everyone
watching bets on the same settle, sees the same tube, and verifies the same
transcript.

It is specified rather than gestured at: **§5 S10** gives the screen and its
wireframe, the cadence arithmetic against the cycle floor and the rolling
ceiling, the four-message protocol with byte sizes, the latency rule, and the
reconnect path. **§7.3** carries its 9 KB in the payload budget alongside the
extra 4 KB of screen. Round 2 answered the "pretty lottery" problem with one
paragraph and five constraints, which is not an answer; a layer with no screen,
no protocol and no payload line is a hope.

Constraints, all of which fall straight out of §10:

- The lobby timer's expiry means **no bet**, never an auto-bet, never a
  carried-over ticket. The CTA disables; the ticket stays on screen, unplaced.
- The draw cadence is bounded below by the money controls, not by taste: below
  4 s the rolling ceiling starts binding and a player would spend part of every
  hour locked out of a room they are watching. §15 chooses between 6, 8 and 10.
- The presence row shows a **count of tickets** and a ticker of **what** people
  bet — never balances, never stakes, never wins, never a leaderboard. A visible
  leaderboard is a wagering incentive wearing a social costume, and a visible
  stake is peer pressure with a number on it.
- No chat in v1. A chat channel in a gambling lobby is a tipping and
  loss-chasing surface, and moderating it is a product in itself.
- Solo play is never worse: identical paytable, identical derivation, identical
  everything, and `←` leaves mid-cadence with no penalty. The lobby is company,
  not an edge.

**13.3 THE LEDGER — the session layer, and the retention bet.** The retained
ritual is *verification*, not accumulation. At any point the player can run one
action that re-derives **every round of the session at once** — each seed against
each commitment, each ticket against each receipt — and get one line back:
`48 rounds · all verified · net −6.40`. It is the game's actual differentiator
made into a habit, it costs the player nothing, and it is the opposite of a
streak counter: it shows net position and cannot be read as a pattern.

The ledger is also the honest place for session state: rounds played, time
elapsed, net in currency, rounds remaining in the rolling hour. Never wins,
never streaks, never a "best round".

**13.4 THE ALMANAC — proposed, and deliberately gated.** An opt-in log of which
of the 120 (or 5,040) orders a player has seen, as a quiet grid that fills in
over months.

The risk is obvious and should be named rather than buried: **completion
mechanics create a reason to keep playing that has nothing to do with wanting
to play**. The constraints that make it defensible, all of which are load-bearing:
no reward of any kind for filling it, no completion bonus, no notification, no
progress bar, no percentage, no surfacing during a round or on the result screen,
and it lives two taps deep behind the `⌂` menu. It records; it does not ask.

Even so, this is the one feature in the document that could be cut on principle
and lose the product very little. It ships only if user research shows players
read it as a record rather than a target. If that test is ambiguous, it does not
ship.

**13.5 Time-based cadence.** A featured SEVEN draw in the shared chamber at the
top of each hour. Triggered by the clock and nothing else — never by a loss, a
losing streak, a balance drop, or a period of inactivity, per §10.

### 13.6 What is refused, and why

| Mechanic | Why not |
| --- | --- |
| Progressive jackpot | It has to be funded from the edge, which makes the published RTP a *range* that depends on the jackpot's state and makes one bet type structurally different from the others. That is precisely the asymmetry the whole product is built against. |
| Loyalty or level multipliers | Same defect: two players would face different RTPs, and "96% on every bet" would stop being true. |
| Missions with wagering requirements | A mission that requires turnover is a loss-chasing mechanic with a checklist. |
| Loot boxes, XP tied to stake, spin-the-wheel bonuses | Randomised rewards priced off stake are a second, unpriced game hiding inside the first, and this repository could not enumerate it. |
| Daily login streaks | Time-triggered rewards are permitted by §10; *streaks* are not, because breaking one is engineered as a loss. |

### 13.7 The retention model, honestly

The bet is **frequency of short sessions**, not session length. The pacing floor
and the rolling ceiling are explicit commitments *against* long sessions, so the
commercial model cannot be "time on device" without contradicting §10.

That is commercially weaker than the category norm and is chosen deliberately.
The metrics the studio commits to watching are **rounds per session**, **sessions
per week**, and **net position at session end** — not minutes. A rising minutes
figure with a falling sessions figure is a failure here, not a success.

---

## 14. Competitive position

This section is an argument, not evidence. **No user research has been run and
none of the numbers below are measurements of this product.** It exists because
"premium" and "the reason to watch" are claims, and a claim with no competitive
frame is marketing.

**The field, and where the format actually sits.**

| Competitor class | Their hook | Where they beat us | Where we beat them |
| --- | --- | --- | --- |
| Live game shows (Marble Race, wheel formats) | A long, watchable physical draw with a presenter, bonus lanes and a live audience | Production spectacle, hosted personality, genuine event feel, minutes of tension per round | Four seconds instead of ninety; no studio cost; every bet priced identically; instant self-verification |
| Lottery-style instant draws | An enormous nominal prize as the entire proposition | Headline number, by orders of magnitude (§8.2) | RTP that is not 50-something percent, and a draw the player can verify |
| Online roulette | Familiarity, instant pace, 97.30% on European rules | Higher RTP, universal comprehension, no explanation needed | No trap bets at all — roulette's are mild, but Sic Bo's and craps' are not — and verifiability |
| Crypto-casino provably-fair instants (dice, limbo, plinko) | Verifiable draws, 99% RTP, instant | RTP, and an audience already fluent in commit-reveal | Production value, a draw worth watching, exhaustive proof rather than a hash formula in a help page, and a receipt that binds the *bet* |

**The honest summary.** AETHER ORDER has the production values of the first
class, the verifiability of the fourth, the pace of the third, and a top prize
below all of them. Its differentiator is integrity made legible: a uniform
96.000% on every one of eleven bet types, exhaustively proved rather than
asserted; no trap bet anywhere; a signed receipt covering what you staked; and a
result you can check in one tap.

**Who that is for.** A thin audience — the player who has already noticed that
in most games the attractive-looking bet is the worse deal. It is thin on
purpose, and it is the only audience this product can honestly serve better than
the incumbents. The bet is that this audience is growing, that the crypto-casino
generation demonstrated verifiability sells, and that nobody has yet paired it
with production values.

**What would falsify the thesis.** Pre-registered, so it cannot be quietly
rationalised later:

1. If unprompted first-session players cannot state *"every bet pays the same"*
   after five rounds, the central differentiator is not legible and the UX has
   failed regardless of how true it is.

   **The same test carries a second question, on the one pair that has ever
   looked like a trap.** Show the rail and ask what the difference between
   STACK and NEIGHBOURS is. A player who cannot say *"one fixes which colour is
   on top"* has met a comprehension trap, and the fact that the two chips are
   priced 2× apart makes it the expensive kind — the wrong tap looks like a
   penalty for choosing badly. They were LINK and LINK · EITHER until round 5
   (§4); if the new names still fail here, the fix is another name, not another
   tooltip.
2. If the ORDER-tier attach rate sits below ~15%, the ladder is not carrying the
   watch-value and §13.1's variety argument is wrong.
3. If the verifier is opened by fewer than ~5% of players in their first
   session, integrity is a stated preference and not a revealed one, and the
   positioning needs rebuilding around something else.

Each has a measurement plan and none has been run. That is the current state of
the evidence, and this document will not imply otherwise.

---

## 15. Open questions for the build

Deliberately unresolved; each needs a decision before content lock.

1. **Shared chamber cadence.** §5 S10 and §13.2 settle the semantics, the
   screen, the protocol and the bound (`T ≥ 4 s`, or the rolling ceiling starts
   binding). What is open is the number: 6 s, 8 s or 10 s between draws, which
   trades lobby energy against how much of the hour a watching player can spend
   betting. Decide by testing, not by argument.
2. **Chamber skins.** Presentational only, but they must not encode any
   information. If skins ship, add a test asserting skin state is absent from
   the transcript input set.
3. **Slot labelling direction.** Slot 1 at the bottom matches the physical
   fiction (the tube fills upward) but reads top-down in the ticket strip. User
   test both — and note that the FULL ORDER picker (§5 S2 E) now fills
   bottom-up, so the two must agree or one of them must change.
4. **SEVEN colour separation — the colour remedy is withdrawn, and the reason is
   arithmetic.** Round 2 prescribed moving ROSE toward `#FF6FB0` and INDIGO
   toward `#3D8BFF`. Both substitutions make the pair they were meant to repair
   *worse*: `#3D8BFF` against VIOLET is 1.05:1 (down from 1.24) and `#FF6FB0`
   against CORAL is 1.19:1 (down from 1.34). More importantly the whole approach
   was wrong — §6.1 shows that seven colours clearing 4.5:1 against `--void`
   cannot be separated by more than 1.28:1 in the best case anyone can
   construct, so luminance is not an available channel here at all and no hex
   substitution makes it one. The palette stays. **What is open is the glyph
   channel, not the colour one:** validate glyph discriminability at 24 px, at
   200% text scale, and under protanopia/deuteranopia simulation on real
   hardware. If a glyph pair fails, change a glyph.

   **Test the five pairs in §6.1's generated table, in that order, and start
   with AMBER↔ROSE.** It is third-closest by luminance (1.2470, a hair inside
   VIOLET↔INDIGO at 1.2446) and it is the pair a hand-typed list omitted, so it
   has never been looked at. `#FFB020` and `#FF7FD1` both shift toward
   yellow/beige under deuteranopia, which makes disc-versus-hexagon the only
   channel left between them; AMBER is also the palette's most-used colour in
   copy examples, so a failure there is a failure the player meets first.
5. **Clip length.** 3.4 s LOCK-OUT versus a 6 s cut that includes the ticket
   build. Test retention on both.
6. **Whether THE ALMANAC ships at all** (§13.4). The default is no.
7. **Server-render endpoint for clip export** (§9.1 fallback 2). It is a real
   backend with a real cost, and the alternative — a still result card — may be
   enough. Decide before committing to the infrastructure.
8. **`RANDOMISE` in the FULL ORDER picker** (§5 S2 E). It is specified and it is
   honest, but it is untested against the comprehension goal: a player who taps
   it every time never internalises that they are claiming a specific order.
   Watch for it in the first-session test and consider a first-run gate.
