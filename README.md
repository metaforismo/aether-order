# AETHER ORDER

**Five coloured spheres settle one by one into a glass tube. You bet on the
order.** AETHER ORDER is a premium permutation draw from Axiom Games, built on
Reveal Engine™. A round is one uniformly random permutation of five spheres —
120 possible orders, every one equally likely — and a bet menu that lets you
claim as little as *"amber settles before aqua"* (`1.92×`) or as much as the
entire column in exact order (`115.20×`). Every bet, from the safest to the
rarest, returns the same theoretical **96.000%**: there are no trap bets here.
Your lines resolve as the tube fills, not at the end. Four seconds a round, one
thumb, and a transcript you can verify yourself the moment it ends.

---

## Status

| | |
| --- | --- |
| [![CI](https://github.com/metaforismo/aether-order/actions/workflows/ci.yml/badge.svg)](https://github.com/metaforismo/aether-order/actions/workflows/ci.yml) | exhaustive enumeration + typecheck + full test suite on every push |
| ![stage](https://img.shields.io/badge/stage-playable%20graybox-blue) | design, mathematics and protocol are complete; the game is playable at placeholder-art fidelity |
| ![play](https://img.shields.io/badge/play-free%20only-informational) | free-play prototype work; no real-money integration |
| ![rtp](https://img.shields.io/badge/RTP-96.000%25%20exact-brightgreen) | identical on every bet type, proved as exact fractions |
| ![math](https://img.shields.io/badge/outcome%20space-fully%20enumerated-brightgreen) | 120 and 5,040 permutations; 27.6M instance × outcome pairs |
| ![arithmetic](https://img.shields.io/badge/arithmetic-exact%20BigInt-brightgreen) | no floating point on any money or probability path |
| ![certification](https://img.shields.io/badge/certification-none%20claimed-lightgrey) | engineering evidence, not a laboratory or regulatory approval |

**What is real today:** the complete game and art specification; the exact
mathematical model with an exhaustive machine proof; the Reveal Engine
permutation lifecycle specification; a runnable reference implementation of its
*derivation, commitment, verification, settlement, ticket-binding and receipt*
core, plus the packaged conformance runner, with frozen wire-format fixtures and
a test suite that asserts the published paytable against the enumeration on
every commit — **and a playable graybox**: a Node service that runs the round
lifecycle on the real engine and a portrait browser client that plays it.
`npm run dev`, then [Run the graybox](#run-the-graybox).

Four of the design document's load-bearing claims are code rather than prose,
because a rule with no implementation is a rule that can be contradicted by the
paragraph beneath it: the celebration gate (`tools/lib/presentation.mjs`), the
line-resolution track that keeps a dead bet from being kept alive to look close
(`tools/lib/resolution.mjs`), the renderer's frame budget for **both** layers of
the frame (`tools/lib/framebudget.mjs`), and the palette-separation bound behind
the accessibility argument (`tools/lib/palette.mjs`). All four are asserted
against the documents that quote them, and in every case the defect that put
them there was a table that looked like arithmetic and had never been run.

**What was specified but not implemented, and now is:** the validating
`definePermutationGame` factory ships in the packaged engine, and the
round-cycle floor and rolling-hour ceiling are enforced by the graybox service,
which is the session state this repository previously did not have.
`docs/ENGINE.md` §10 marks every surface as implemented, specified, or out of
scope, and says where the last two now live.

**What is not built at all yet:** the final art and the WebGL chamber (§7's two
render lanes — the graybox draws DOM and SVG), the audio, the clip export
(§9.1), and the RGS and wallet integration. The graybox's wallet is an in-memory
free-play float and its operator key is generated at process start: nothing here
is custody, persistence or an audit trail.

---

## How a round works

1. **Before you bet**, the server draws a secret 32-byte seed and publishes a
   `SHA-256` hash that locks in the seed *and* the whole round context — the
   variant, the round id and the nonce. You can see that hash on screen. None
   of it can be changed afterwards.
2. **You build a ticket** — up to 12 lines, 0.25 to 50.00 credits each. You may
   also type your own client seed, which is mixed into the draw.
3. **You commit.** The permutation is now fixed. Nothing you do from here can
   change it, and nothing after this point is a decision.
4. **The chamber agitates**, then the spheres settle into the tube one at a
   time, bottom to top, over about two and a half seconds. This is choreography
   playing back the result — it is not the draw.
5. **Each line resolves at the lock that decides it**, not at the end. FIRST is
   settled the moment the first sphere locks; PODIUM by the third; LAST the
   moment your colour lands somewhere else — and **never later than the
   second-to-last sphere**, because once one sphere is left there is only one
   slot it can go in. A line that can no longer win says so immediately instead
   of being kept alive to look close. The final fall is a finish, not a reveal:
   by then the round is already decided, and we show it that way rather than
   pretending otherwise.
6. **The result is reported.** If the round returned more than it cost, it is
   celebrated. If it returned less, it says so plainly — *"returned 1.92 of
   12.00"* — with no win sound and no balance counting upward. A losing round is
   never dressed as a win.
7. **The seed is revealed.** Your device re-derives the permutation from
   `(server seed, your seed, round id, nonce)`, recomputes both hashes, and
   shows a green *verified locally* chip. One tap shows the full transcript and
   your signed receipt.

Total: 3.6 to 4.8 seconds depending on variant and result, and at least 2.5
seconds before the next bet can be placed — a floor we enforce rather than a
pace we optimise. There is a skip button; it shortens the animation, changes
nothing about the outcome, and does not let you bet any faster.

## The bets

| Tier | Bet | You pick | Pays |
| --- | --- | --- | --- |
| **FLOW** — lands often | BEFORE | two colours, in order | `1.92×` |
| | EARLY / LATE | one colour, first two or last two | `2.40×` |
| | NEIGHBOURS | two colours, side by side, either order | `2.40×` |
| **FORM** — the core game | FIRST / LAST / SLOT | one colour, one position | `4.80×` |
| | STACK | two colours, one directly above the other | `4.80×` |
| **ORDER** — rare, big | OPENING | the first two, in order | `19.20×` |
| | PODIUM | the first three, in order | `57.60×` |
| | FULL ORDER | the whole column, exactly | `115.20×` |

Tiers are **volatility, not value**. A `115.20×` chip and a `1.92×` chip carry
the identical 4.00% house edge — the big one buys variance, not a worse deal.
Multipliers are total return, so a winning 1.00 BEFORE line returns 1.92.

**SEVEN** is an optional seven-sphere variant: same bets, same 96.000%, 5,040
possible orders. Every multiplier except BEFORE re-prices, because every
probability except BEFORE's one-in-two depends on how many spheres there are:
`2.40× → 3.36×`, `4.80× → 6.72×`, `19.20× → 40.32×`, `57.60× → 201.60×`, and
FULL ORDER `115.20× → 4838.40×`.

## Fairness model

Commit-reveal, verifiable by re-derivation: once a round is settled you can
check its outcome yourself instead of taking the operator's word for it. (Seed
generation and custody still sit with the operator — see the boundary below.)

- **Commit first, and commit everything.** The server publishes
  `SHA-256(domain ‖ serverSeed ‖ gameId ‖ variantId ‖ roundId ‖ nonce)` *before*
  your ticket exists. Every input to the draw except your own client seed is
  frozen by that hash, so an operator that has seen your ticket has nothing
  left to search.
- **You contribute entropy.** Your client seed enters every draw, so the
  operator cannot grind seeds against a known ticket. It changes *which* order
  comes up and never your odds — every seed gives the same uniform draw.
- **Unbiased by construction.** The shuffle is Fisher–Yates driven by a
  rejection sampler over a 256-bit range, so there is no modulo bias. The
  enumerator proves the shuffle is a bijection from draw vectors onto all `n!`
  permutations — exhaustively, for both variants.
- **Reveal and re-derive.** After settlement the seed is published. Anyone
  holding the transcript plus that revealed seed can recompute the permutation
  and both hashes independently.
- **Rounds are chained.** Each transcript binds the previous round's
  commitment, which makes a retroactive edit to a round's ancestry detectable
  to anyone who kept a later commitment. On its own a hash chain proves neither
  completeness nor chronology — that needs an external anchor such as an
  operator signature or a published chain head.
- **Behaviour is fingerprinted, not just declared.** The adapter fingerprint
  bound into every commitment includes a digest of how every bet actually
  resolves across the whole outcome space, so a silent change to a bet rule
  invalidates the round it would have re-settled.
- **Your bet is bound to the round too.** After settlement the operator issues a
  signed receipt binding the seed commitment, the round commitment, a digest of
  your ticket and a digest of the settlement. Keep it and nobody can later
  disagree about what you staked or what you were paid. It is written to be read:
  every parameter is an element index published in `docs/paytable.json`, and
  even the whole-column bet records the order you picked rather than an index
  into a ranking function. A receipt whose signature was never checked does not
  verify — it reports that its bindings held and that the signature was skipped,
  and those are different answers.
- **Exact money.** Stakes and payouts are integer chips with exact BigInt
  rational arithmetic. The stake quantum is chosen so every payout is an exact
  integer: rounding is provably a no-op, and realised RTP equals theoretical
  RTP with zero drift.

### Where the guarantee stops

Two different things are going on above, and they are not equally strong.

**Commit-reveal proves the draw.** It needs no trust in the operator at all
beyond seed custody: you re-derive the permutation and both hashes yourself.

**The receipt proves the bet — and it needs the operator's key.** This is worth
being blunt about, because it is the most common misunderstanding of
provably-fair systems: *a transcript alone says nothing about what you staked.*
It proves the order was honest. It does not prove you were on it. The receipt
closes that gap, but it does so by signature, which means it rests on the
operator's key being what it claims and on you keeping the receipt. It stops a
settled bet being denied or rewritten; it does not, by itself, stop a receipt
never being issued — that is a dispute process and a licence condition, not a
hash. `docs/ENGINE.md` §11 states the boundary in full.

## Run the graybox

```sh
npm install
npm run dev            # http://localhost:5173
```

That one command builds the client and starts the service. Open the URL in a
phone-sized window — the layout is portrait, 390 × 844 reference — and play. The
wallet starts at 500.00 free-play credits, the shared chamber runs a draw every
6 seconds, and nothing is persisted: restart the process and every session,
round and receipt is gone.

| | |
| --- | --- |
| `npm run dev` | build the client, serve it and the API on `PORT` (default 5173) |
| `npm run build` | build the client bundle only, into `dist/client` |
| `npm run typecheck` | `tsc --noEmit` over the service and the client |
| `npm test` | the whole suite, including the API-level playthrough |
| `AETHER_DEV=1 npm run dev` | additionally enables `POST /api/dev/skew`, a test hook that shifts *session elapsed time* so the reality-check schedule can be seen without waiting 30 minutes. It changes no policy and is off by default. |

**The engine is consumed as a package, not copied.** `dependencies` carries
`@axiom-games/reveal-engine` as a `file:` install of
`vendor/axiom-games-reveal-engine-0.4.0.tgz`, which is `npm pack` run against the
engine repository's `main`. There is no vendored source and no reimplementation:
the element set, the bet catalogue, the multipliers, the risk policy and the play
policy all come from the module's own AETHER ORDER adapter, which is why
`src/server/engine.ts` can refuse to start when the fingerprint the engine
computes differs from the one `docs/paytable.json` publishes. To refresh it,
build the engine, `npm pack` it into `vendor/`, and reinstall.

### What the service is

A Node/TypeScript RGS-shaped service (`src/server`) that owns exactly what
`docs/ENGINE.md` §3 says the engine does not: the wallet, session state, pacing,
and the responsible-play controls. Everything else — derivation, commitment,
settlement, receipts, snapshots, byte layouts — is the engine's, called and never
reimplemented. The round lifecycle is §5's, in §5's order:

| Route | What it does |
| --- | --- |
| `POST /api/session` | opens a free-play session |
| `POST /api/session/:id/round/open` | draws the seed, fixes `(variant, roundId, nonce)`, publishes `seedCommitment` — **before any ticket exists** |
| `POST /api/session/:id/ticket/quote` | validates a ticket through `openTicket` and returns the **best possible outcome**, a maximum over the `n!` settled orders |
| `POST /api/session/:id/round/commit` | debits, derives, settles, credits, signs a receipt, builds the resolution track. Idempotent under the engine-derived key: a retry returns the same round and never debits twice |
| `POST /api/session/:id/round/:roundId/reveal` | publishes the server seed, after re-verifying the transcript and the receipt server-side |
| `GET /api/session/:id/history`, `/api/catalogue`, `/api/operator-key` | the record, the published catalogue, the signing key |
| `GET /api/lobby/state`, `/api/lobby/stream`, `POST /api/session/:id/lobby/commit` | SHARED CHAMBER (§5 S10): one transcript, many tickets, an SSE stream, and `BETTING_CLOSED` on a late arrival |

Pacing is server-side and hard: a COMMIT inside the 2,500 ms floor is rejected
with `CYCLE_FLOOR` and the stake is unspent, never queued.

### What the client is

`src/client` — vanilla TypeScript, one esbuild call, no framework. It renders
§5's screens: S1 TABLE, S2's five picker shapes, S3 ticket review, S4 the round
with the ticket strip pinned so lines resolve lock by lock, S5 the gated result,
S6 fairness, S7 history, S8 paytable, S9 limits and play controls, S10 the
shared chamber.

Two things it deliberately does *not* do: it computes no money — the stake, the
payout, the best-outcome figure and the celebration gate all come from the
service, which gets them from the engine — and it does **not** ask the server
whether a round was fair. `src/client/verify.ts` re-derives the permutation from
`(server seed, your seed, round id, nonce)` with WebCrypto and recomputes both
hashes itself; `tests/verifier.test.ts` fails the build if that second
implementation and the engine ever disagree on a single digest.

**Graybox boundaries, stated rather than implied.** The chamber is DOM and SVG at
the geometry §6.9 specifies, not the WebGL lane §7 budgets: no fluid shader, no
bloom, no caustic, no bubble buffer, no sprite master, and therefore none of
§7.4's acceptance test has been run. There is no audio and no clip export. Glyph
areas are approximately, not provably, equal (§6.8), and §15's open question 4 —
the deuteranopia pass — remains open. `docs/paytable.json` supplies the palette,
the glyphs and every published probability, so none of that is retyped here.

## Run the proof yourself

```sh
npm install
npm run enumerate      # enumerates the full outcome space, prints exact fractions
npm test               # asserts the published paytable in docs/MATH.md matches
```

`npm run enumerate` walks all 120 (and 5,040) permutations, evaluates all 5,769
legal bet instances against every one of them, and prints each bet's exact
probability, multiplier, RTP and median rounds-to-first-hit as reduced fractions
and exact integers — plus the shuffle bijection proof, the sampler uniformity
proof, the cap-headroom proof, the zero-rounding proof, a commit-reveal round
trip, a signed-receipt round trip (including the check that a receipt nobody
signed does **not** verify), proof that the ticket strip's headline figure is a
real maximum, proof that no losing round can be celebrated, proof that no bet is
ever left undecided past the second-to-last sphere, and all twelve adapter
conformance checks. Add `--monte-carlo=200000` for a sanity
cross-check; it never sets a published number. `npm run bench` reproduces the
cost figures in `docs/ENGINE.md` §4 on your own hardware and fails if any of
them leaves its published band.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/DESIGN.md`](docs/DESIGN.md) | The full product spec: loop, every player decision and its exact effect, bet menu, portrait UX screen by screen, art direction with palette and materials, the no-fluid-sim rendering plan with a per-pass frame budget for *both* layers and the acceptance test that has to be run against it, sound, the signature clip moment, session and competitive positioning, responsible-design rules |
| [`docs/MATH.md`](docs/MATH.md) | The exact model: state space, unbiasedness proofs, every bet's probability and multiplier as fractions, RTP justification, volatility, the cap, the maximum a ticket can actually return, rounds-per-hour exposure, and the proof that no decision policy beats 96% |
| [`docs/ENGINE.md`](docs/ENGINE.md) | The Reveal Engine permutation lifecycle module, the adapter surface as TypeScript types, and the normative byte layouts for transcripts, tickets, settlements, receipts and snapshots |
| [`docs/paytable.json`](docs/paytable.json) | Machine-readable published paytable, play policy and claim-alias set, regenerated and diff-checked in CI |

## Responsible design, in one place

**No losing round is ever presented as a win.** If a round returns less than it
cost — including the very common case where one small line hits on a multi-line
ticket — there is no win sound, no stamp, no gold bloom, and the balance does not
count upward. It reads *"returned 1.92 of 12.00"*, because that is what happened.
The gate is one comparison, implemented once, in
[`tools/lib/presentation.mjs`](tools/lib/presentation.mjs).

**Speed of play is capped, not optimised.** Minimum 2.5 seconds between bets,
enforced server-side; maximum 900 rounds per rolling hour. The skip button
shortens the animation and never the cycle — it is not a slam stop.

**The reality check is a floor you cannot lower.** 30 minutes, 60 minutes, then
hourly, published as fields rather than promised in a sentence. The one control
in the app can only make the checks *more* frequent; there is no field a player
can write that removes one.

**No autoplay.** Not a bounded one, not a stop-on-win one — none. The published
play policy carries `autoplay: "none"` as a value the tests assert, because a
sentence about autoplay is exactly what the previous draft got wrong twice in
one paragraph. Its only function is unattended wagering, and one-tap rebet
against a 2.5-second floor already does everything else it is sold as.

No double-up or gamble feature. No jackpot, loyalty multiplier or mission with a
wagering requirement — all of them would break the uniform 96%. No offer, bonus
or prompt triggered by a loss or a losing streak. No streak counters or "hot
colour" displays. No manufactured near-misses — a losing round has no dramatic
beats at all, enforced at the render layer, and lines that can no longer win say
so immediately rather than being kept alive to look close. No skill or
prediction framing in any copy. Every money decision happens before commit, with
no countdown that can expire into a bet, so a slow connection never costs value.
Session time and net position are always visible; limits and the verifier are
two taps away. The full rules are in [`docs/DESIGN.md`](docs/DESIGN.md) §10.

---

*AETHER ORDER — Powered by Reveal Engine™ — An Axiom Games original.*

Reveal Engine™ is technology, AETHER ORDER is a title, Axiom Games is the
studio. The ™ symbol is not a registered-trademark claim. This repository is
private and unlicensed. Its tests, enumerations and fixtures are engineering
evidence — **not** an RNG certificate, a mathematical certification, a
laboratory report, a regulatory approval, or a certified RTP for any deployed
game. See [`docs/MATH.md`](docs/MATH.md) §11 and
[`docs/ENGINE.md`](docs/ENGINE.md) §11 for the full boundary.
