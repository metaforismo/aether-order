# AETHER ORDER

**Five coloured spheres settle one by one into a glass tube. You bet on the
order.** AETHER ORDER is a premium permutation draw from Axiom Games, built on
Reveal Engine™. A round is one uniformly random permutation of five spheres —
120 possible orders, every one equally likely — and a bet menu that lets you
claim as little as *"amber settles before aqua"* (`1.92×`) or as much as the
entire column in exact order (`115.20×`). Every bet, from the safest to the
rarest, returns the same theoretical **96.000%**: there are no trap bets here.
Four seconds a round, one thumb, and a transcript you can verify yourself the
moment it ends.

---

## Status

| | |
| --- | --- |
| [![CI](https://github.com/metaforismo/aether-order/actions/workflows/ci.yml/badge.svg)](https://github.com/metaforismo/aether-order/actions/workflows/ci.yml) | exhaustive enumeration + full test suite on every push |
| ![stage](https://img.shields.io/badge/stage-specification-blue) | design, mathematics and protocol are complete; the client is not built |
| ![play](https://img.shields.io/badge/play-free%20only-informational) | free-play prototype work; no real-money integration |
| ![rtp](https://img.shields.io/badge/RTP-96.000%25%20exact-brightgreen) | identical on every bet type, proved as exact fractions |
| ![math](https://img.shields.io/badge/outcome%20space-fully%20enumerated-brightgreen) | 120 and 5,040 permutations; 26.6M instance × outcome pairs |
| ![arithmetic](https://img.shields.io/badge/arithmetic-exact%20BigInt-brightgreen) | no floating point on any money or probability path |
| ![certification](https://img.shields.io/badge/certification-none%20claimed-lightgrey) | engineering evidence, not a laboratory or regulatory approval |

**What is real today:** the complete game and art specification; the exact
mathematical model with an exhaustive machine proof; the Reveal Engine
permutation lifecycle specification; and a runnable reference implementation of
its *derivation, commitment, verification and settlement* core, with frozen
wire-format fixtures and a test suite that asserts the published paytable
against the enumeration on every commit.

**What is specified but not implemented here:** the protocol layer of the module
— ticket receipts, idempotency, snapshotting and the packaged conformance
runner. `docs/ENGINE.md` §10 marks each surface as implemented or specified.

**What is not built at all yet:** the client, the audio, and the RGS
integration.

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
5. **Winning lines light up** and pay at their published multiplier.
6. **The seed is revealed.** Your device re-derives the permutation from
   `(server seed, your seed, round id, nonce)`, recomputes both hashes, and
   shows a green *verified locally* chip. One tap shows the full transcript.

Total: about four seconds. There is a skip button; it changes nothing.

## The bets

| Tier | Bet | You pick | Pays |
| --- | --- | --- | --- |
| **FLOW** — lands often | BEFORE | two colours, in order | `1.92×` |
| | EARLY / LATE | one colour, first two or last two | `2.40×` |
| | LINK · EITHER | two colours, side by side | `2.40×` |
| **FORM** — the core game | FIRST / LAST / SLOT | one colour, one position | `4.80×` |
| | LINK | two colours, directly stacked | `4.80×` |
| **ORDER** — rare, big | OPENING | the first two, in order | `19.20×` |
| | FULL ORDER | the whole column, exactly | `115.20×` |

Tiers are **volatility, not value**. A `115.20×` chip and a `1.92×` chip carry
the identical 4.00% house edge — the big one buys variance, not a worse deal.
Multipliers are total return, so a winning 1.00 BEFORE line returns 1.92.

**SEVEN** is an optional seven-sphere variant: same bets, same 96.000%, 5,040
possible orders, and FULL ORDER at `4838.40×`.

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
- **Exact money.** Stakes and payouts are integer chips with exact BigInt
  rational arithmetic. The stake quantum is chosen so every payout is an exact
  integer: rounding is provably a no-op, and realised RTP equals theoretical
  RTP with zero drift.

## Run the proof yourself

```sh
npm install
npm run enumerate      # enumerates the full outcome space, prints exact fractions
npm test               # asserts the published paytable in docs/MATH.md matches
```

`npm run enumerate` walks all 120 (and 5,040) permutations, evaluates all 5,499
legal bet instances against every one of them, and prints each bet's exact
probability, multiplier and RTP as reduced fractions — plus the shuffle
bijection proof, the sampler uniformity proof, the cap-headroom proof, the
zero-rounding proof, and a commit-reveal round trip. Add
`--monte-carlo=200000` for a sanity cross-check; it never sets a published
number.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/DESIGN.md`](docs/DESIGN.md) | The full product spec: loop, every player decision and its exact effect, bet menu, portrait UX screen by screen, art direction with palette and materials, the no-fluid-sim rendering plan, sound, the signature clip moment, responsible-design rules |
| [`docs/MATH.md`](docs/MATH.md) | The exact model: state space, unbiasedness proofs, every bet's probability and multiplier as fractions, RTP justification, volatility, the cap, and the proof that no decision policy beats 96% |
| [`docs/ENGINE.md`](docs/ENGINE.md) | The Reveal Engine permutation lifecycle module, the adapter surface as TypeScript types, and the normative byte layouts |
| [`docs/paytable.json`](docs/paytable.json) | Machine-readable published paytable, regenerated and diff-checked in CI |

## Responsible design, in one place

No double-up or gamble feature. No autoplay through losses. No offer, bonus or
prompt triggered by a loss or a losing streak. No streak counters or
"hot colour" displays. No manufactured near-misses — a losing round has no
dramatic beats at all, enforced at the render layer. No skill or prediction
framing in any copy. Every money decision happens before commit, with no
countdown that can expire into a bet, so a slow connection never costs value.
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
