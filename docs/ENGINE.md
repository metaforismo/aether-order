# Reveal Engine — permutation lifecycle module

AETHER ORDER does not ship its own randomness, commitment scheme, or money
arithmetic. It consumes a Reveal Engine lifecycle module and supplies an
adapter. This document specifies the module the game expects, the exact adapter
surface it implements against, and the byte layouts both sides must agree on.

`tools/lib/` carries a runnable reference implementation of the module's
**derivation, commitment, verification, settlement, ticket-binding and receipt
core**, plus the packaged conformance runner, written in plain ESM so that the
enumerator, the tests and an independent verifier can execute it without a build
step. What remains specified-only is listed in §10, with a reason for each; the
list is short and nothing on it is a fairness surface.

The reference is normative: the TypeScript module inside Reveal Engine must
produce **byte-identical** commitments, ticket digests, receipt digests and
signatures, and `tests/fixtures/transcripts.json` freezes eight complete rounds —
transcript, ticket, settlement and signed receipt — that prove it.

**Those eight cover the shapes they are the oracle for.** Four per variant:
the three-line FORM/FLOW shape, the ORDER tier at the top of the liability
(`full` + `podium` + `opening`, all winning), an eight-line ticket across FLOW
and FORM with deliberate losers, and a twelve-line ticket at the line limit that
carries every one of the eleven codes and exercises the canonical line sort.
Between them every bet code appears **in each variant**, `full` appears both
winning and losing, and settlements with mixed `won` flags are frozen rather
than only clean sweeps. Round 4 froze eight vectors of one shape — always
`first`/`before`/`slot`, always 175 chips — so eight of eleven codes never
appeared and nothing froze the ticket, settlement or receipt encoding for the
game's highest-liability bet. `tests/derivation.test.mjs` now fails the build if
that coverage narrows again.

Every function signature in this document is machine-checked against the
reference implementation's real signature by `tests/design.test.mjs`. A
declaration here that has drifted from the code is a build failure, not a
documentation bug.

---

## 1. Why a new lifecycle module

Reveal Engine `0.2` ships one lifecycle: a *progressive information market*.
Its shape is a hidden `truth` among `outcomes`, a schedule of `EvidenceEvent`s
that shifts a Bayesian posterior, a `RoundBook` with price frames, and
open / sell / settle actions where a position is a rational contingent claim.
That is exactly right for BLACK SIGNAL and exactly wrong for AETHER ORDER:

| | Progressive market (`v0.2` core) | Permutation (this module) |
| --- | --- | --- |
| Hidden state | one outcome index | one permutation of `n` elements |
| Outcome space | 2–64 flat outcomes | `S_n`, `n!` ordered outcomes |
| Information over time | evidence events update a posterior | none; the settle animation is presentational |
| Player actions in-round | open, sell, re-enter | none — the ticket is atomic |
| Pricing | dynamic quote per frame | static published paytable |
| Frames | many, fenced by revision | exactly one |
| Payout shape | contingent claim × quote | Σ line stake × line multiplier |

Trying to express a permutation draw through the existing core would mean
declaring 5,040 flat outcomes with a degenerate evidence schedule and a
posterior that never moves — all the machinery, none of the meaning, and a
`STALE_FRAME` surface area the game does not need. A permutation module is
smaller, and its single-frame lifecycle removes a whole class of bugs.

**What is reused, unchanged:** `Rational` BigInt arithmetic, `encodeFields`
canonical framing, the `2^256` rejection sampler, `adapterFingerprint`
discipline, `payable` cap semantics, `RevealEngineError` codes and paths,
`ENGINE_LIMITS`, and the "adapters are constructed only through a validating
factory, then deep-frozen" rule.

---

## 2. Identity and versions

```ts
export const ENGINE_API_VERSION        = 'reveal-engine/api-v1';
export const PERMUTATION_MODULE_VERSION = 'reveal-engine/permutation-v1';
export const PERMUTATION_TRANSCRIPT_SCHEMA = 'reveal-engine/permutation-transcript-v1';
export const PERMUTATION_TICKET_SCHEMA     = 'reveal-engine/permutation-ticket-v1';
export const PERMUTATION_RECEIPT_SCHEMA    = 'reveal-engine/permutation-receipt-v1';
export const PERMUTATION_SNAPSHOT_SCHEMA   = 'reveal-engine/permutation-round-snapshot-v1';
```

Each of these names a structure that is specified in this document with a
normative byte layout (§7) and frozen in `tests/fixtures/transcripts.json`.
Naming a constant is not a specification, and a schema tag with no populated
structure behind it is worse than no tag at all — it reads as a commitment that
was never made.

Versioning follows the engine's existing rule: the module may add
backward-compatible fields; any change to derivation, commitment bytes, pricing,
rounding, cap or limits requires a new module version *and* a new
`adapterVersion`, and an integration must retain the exact adapter needed to
replay open liabilities.

---

## 3. Division of responsibility

**The engine module owns** — seed normalisation and hostile-input validation;
the uniform rejection sampler; the shuffle; commitment and transcript
construction; transcript verification by re-derivation; exact rational
settlement; cap application; idempotency and receipts; wire serialisation
bounded by `ENGINE_LIMITS`; adapter conformance checks.

**The adapter (this game) owns** — the element set; the bet catalogue as
`(instance enumeration, pure resolve predicate)` pairs; the published
multipliers; the target RTP, stake quantum and limits; the `adapterVersion`.

**Neither owns** — art, copy, audio, choreography, wallet, persistence,
sessions, or responsible-play controls. Those live in the client and the RGS.

---

## 4. Adapter surface (TypeScript sketch)

```ts
import type { Rational, RevealEngineError } from '@axiom-games/reveal-engine/api';

export type ElementIndex = number;   // 0 .. n-1
export type SlotIndex    = number;   // 0 .. n-1, slot 0 settles first
export type Permutation  = readonly ElementIndex[];   // perm[slot] = element

/** A bet instance is a bet family plus the player's parameters. */
export interface BetInstance<P extends object = object> {
  readonly code: string;
  readonly params: Readonly<P>;
  /** Stable, printable, unique within the family for a given n. */
  readonly label: string;
}

/** Everything a resolve predicate may look at. All of it derives from `perm`. */
export interface OutcomeView {
  readonly n: number;
  readonly perm: Permutation;
  /** pos[element] = slot. */
  readonly pos: readonly SlotIndex[];
  /** Lexicographic rank of `perm`, in [0, n!). */
  readonly rank: number;
  /**
   * The printable identity of the settled order: element indices, bottom-up,
   * joined by `-`. This is what FULL ORDER is parameterised by, so that a
   * receipt records the order the player chose rather than an index into a
   * ranking function — see the note on `full` in §4's catalogue and §11.
   */
  readonly order: string;
}

export interface BetFamily<P extends object = object> {
  readonly code: string;
  readonly name: string;
  readonly tier: 'FLOW' | 'FORM' | 'ORDER';
  /** Player-facing description; never used in the fingerprint. */
  readonly picks: string;
  readonly rule: string;
  /** Complete, finite, deterministic, ordered. Must not depend on a seed. */
  enumerateInstances(n: number): readonly BetInstance<P>[];
  /** Pure: same (instance, view) must always yield the same boolean. */
  resolve(instance: BetInstance<P>, view: OutcomeView): boolean;
}

export interface PermutationPricingPolicy {
  /** Theoretical return per unit staked, identical for every bet family. */
  readonly targetRtp: Rational;
  /** Published multiplier per bet code. Must satisfy m * p === targetRtp. */
  readonly multipliers: Readonly<Record<string, Rational>>;
  readonly rounding: 'floor';
  /** Stakes must be a positive multiple of this, in minor units. */
  readonly stakeQuantum: bigint;
}

export interface PermutationRiskPolicy {
  /** Round credit ceiling as a multiple of the ticket's total stake. */
  readonly maxWinMultiple: bigint;
  readonly maxLinesPerTicket: number;
  readonly minLineStake: bigint;
  readonly maxLineStake: bigint;
  readonly maxTicketStake: bigint;
  /**
   * A ticket may not repeat a claim, where identity is BEHAVIOURAL: two lines
   * are the same claim exactly when they win on the same set of permutations.
   * `first {c:0}` and `slot {c:0,k:0}` are one claim. Without this the per-line
   * ceiling is meaningless — the budget could be piled onto copies of the
   * single best line, spelled differently — and the maximum-credit figure in
   * docs/MATH.md would be a lower bound rather than a maximum.
   */
  readonly requireDistinctLines: boolean;
}

/**
 * Speed of play and session controls. Deliberately NOT part of the adapter
 * fingerprint: pacing is a client and RGS obligation, and TIGHTENING it must not
 * invalidate an open liability. It is nonetheless adapter-published, so the
 * client and the server cannot hold different numbers.
 *
 * The two directions are not symmetric, and the asymmetry is handled rather
 * than left implicit — see `permutationPlayPolicyDigest` below.
 *
 * `minRoundCycleMs` is measured COMMIT to COMMIT and enforced server-side; a
 * COMMIT that arrives early is rejected, not queued. SKIP compresses the
 * presentation and can never shorten the cycle — see docs/DESIGN.md §2.
 */
export interface PermutationPlayPolicy {
  readonly minRoundCycleMs: number;
  readonly maxRoundsPerRollingHour: number;
  /** Fixed early checks, in minutes of elapsed session time. Operator floor. */
  readonly realityCheckMinutes: readonly number[];
  /**
   * The interval that repeats forever after the last fixed check. Required:
   * an array alone cannot express "then hourly", and a client reading only the
   * array would stop checking after the last entry.
   */
  readonly realityCheckRecurrenceMinutes: number;
  /**
   * Additional recurring intervals a player may switch on in docs/DESIGN.md
   * §5 S9. Every entry MUST be <= `realityCheckRecurrenceMinutes`.
   *
   * These two fields exist because the reality check was specified twice, in
   * two incompatible ways: S9 listed it as a player-facing control, §10 stated
   * it as fixed operator policy, and no field in this interface could hold a
   * player's value. An implementer could not tell whether the control existed —
   * and if it did, `playPolicyDigest` would have had to vary per player,
   * destroying its only purpose (a trace of the PUBLISHED policy), or else
   * misreport what the player actually received.
   *
   * The rule is therefore asymmetric, like the fingerprint rule above. The
   * operator schedule is a floor and always fires. A player selection only adds
   * instants, so the schedule a player receives is always a superset of the
   * published one; `realityCheckOverride: 'tighten-only'` states that as a
   * value rather than a sentence, and there is deliberately no field a player
   * can write that removes or delays a check.
   *
   * The option set is part of the published policy and IS digested — widening
   * it past the recurrence would be a loosening. The player's own selection is
   * session state and is NOT digested, so `playPolicyDigest` remains one value
   * per operator policy rather than one per player.
   */
  readonly playerRealityCheckIntervalOptions: readonly number[];
  readonly realityCheckOverride: 'tighten-only';
  /** Must be true. A skip control that shortens the cycle is a slam stop. */
  readonly skipShortensPresentationOnly: true;
  /**
   * Autoplay mode. `'none'` is the only value this specification defines, and
   * it is a value rather than a prose rule because prose is what shipped a
   * self-contradiction: a ban on autoplay-through-losses followed by a licence
   * for a count-bounded autoplay with no loss limit. A conforming autoplay
   * needs a player-set loss limit AND a single-win threshold AND stop-on-either
   * AND a one-tap cancel; that is a feature, not a field. See
   * docs/DESIGN.md §10.
   */
  readonly autoplay: 'none';
}

/**
 * A digest of the live play policy, stamped into every round snapshot.
 *
 * The fingerprint exclusion above covers only one direction. Tightening a limit
 * is safe to leave outside the fingerprint. LOOSENING one — raising
 * `maxRoundsPerRollingHour`, cutting `minRoundCycleMs`, dropping a reality
 * check — is the direction that costs the player, and a transcript can never
 * evidence it: nothing in a settled round says how fast the operator let
 * somebody bet. docs/MATH.md §10.1 argues that the number of rounds is the only
 * lever on expected loss at all, and that speed of play therefore belongs
 * beside the RTP; if it belongs beside the RTP it should leave a trace like the
 * RTP does.
 *
 * So the policy is digested into `RoundSnapshot.playPolicyDigest`. It touches
 * no commitment and invalidates no open liability, and a round settled under a
 * loosened policy is nonetheless distinguishable from one settled under the
 * published one. It is evidence, not enforcement: pacing enforcement is a
 * licence condition and no hash substitutes for it. What the digest removes is
 * the ability to loosen silently.
 */
export function permutationPlayPolicyDigest(policy: PermutationPlayPolicy): string;

export interface PermutationGameDefinition {
  readonly apiVersion: typeof ENGINE_API_VERSION;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  /** Immutable. Change whenever replay-visible behaviour changes. */
  readonly adapterVersion: string;
  readonly id: string;                       // 'aether-order'
  readonly variantId: string;                // 'classic' | 'seven'
  readonly n: number;                        // 2 .. 12
  readonly elements: readonly string[];      // unique printable ids, length n
  readonly bets: readonly BetFamily[];
  readonly pricing: PermutationPricingPolicy;
  readonly risk: PermutationRiskPolicy;
  readonly play: PermutationPlayPolicy;
}

/** The only supported construction path: validates, clones, deep-freezes. */
export function definePermutationGame(input: PermutationGameDefinition): PermutationGameDefinition;

/**
 * Behavioural digest of the catalogue: for every family, in canonical order,
 * every instance's label, its canonical parameter rendering (sorted
 * `key=value` pairs) and its complete win/lose bitmap over all n! permutations.
 * Declaring codes and multipliers is not enough — reversing a predicate would
 * leave a purely declarative fingerprint untouched while changing how an open
 * liability settles, and renaming a parameter key would leave labels and win
 * sets untouched while breaking how an open ticket's params are matched.
 */
export function permutationCatalogueDigest(game: PermutationGameDefinition): string;

/**
 * The behavioural identity of one claim: a digest of the outcomes it wins on,
 * plus its canonical parameter rendering. Settlement compares lines by this,
 * never by label, so two spellings of the same bet cannot both sit on a ticket.
 * Memoised per (variant, code, label).
 */
export function permutationClaimSignature(
  game: PermutationGameDefinition, code: string, instance: BetInstance,
): string;

/**
 * Binds every replay-visible field: the declarative configuration above AND
 * `permutationCatalogueDigest(game)`.
 *
 * `definePermutationGame` MUST compute and memoise this at construction, so the
 * cost is paid once at startup and never inside a round. See the measured cost
 * below the code block; it is a startup cost, not a round cost.
 */
export function permutationAdapterFingerprint(game: PermutationGameDefinition): string;
```

AETHER ORDER supplies two definitions, `classic` (`n = 5`) and `seven`
(`n = 7`), sharing one bet catalogue and one `targetRtp = 24/25`.

**Cost of the behavioural fingerprint.** Reproduce with `node tools/bench.mjs`,
which prints the machine it ran on so the figures are falsifiable rather than
folklore. The table below is the **median of 5** samples from
`node tools/bench.mjs --repeat=5` on an Apple M3 (8 cores, 16 GB, macOS,
Node 25.8.2), with the observed run-to-run range beside it:

| Measurement | Median | Range over 5 runs |
| --- | --- | --- |
| Catalogue digest, cold, `n = 5` (35,400 predicate evaluations) | 0.99 ms | 0.93 – 1.2 ms |
| Catalogue digest, cold, `n = 7` (27.6M predicate evaluations) | 277 ms | 274 – 282 ms |
| Transcript build, `n = 5`, warm | 33 µs | 33 – 40 µs |
| Transcript verify, `n = 5`, warm | 37 µs | 35 – 38 µs |
| Ticket settle, `n = 5`, three lines, warm | 6.4 µs | 5.7 – 7.7 µs |
| Transcript build, `n = 7`, warm | 45 µs | 44 – 47 µs |
| Transcript verify, `n = 7`, warm | 49 µs | 46 – 50 µs |
| Ticket settle, `n = 7`, three lines, warm | 6.7 µs | 6.0 – 7.3 µs |
| Resolution track, `n = 7`, 12 lines, **worst legal ticket** | 10.7 ms | 10.5 – 10.8 ms |
| Resolution track, `n = 7`, 12 lines, realistic ticket | 0.48 ms | 0.47 – 0.48 ms |

**Round 2 published this table with ticket settle at 85 µs.** It measures about
9 µs on the exact machine the document named — a factor of ten, on the one
number in this repository explicitly offered as falsifiable, and the one number
with no test behind it. CI ran the benchmark and labelled it *informational*.

That is fixed in both directions. The figures above come from a real run and
carry their spread rather than a single sample dressed as a constant, and
`tests/bench.test.mjs` now asserts **bands**, on whatever hardware runs it:

| Band | Value | Headroom on the reference machine |
| --- | --- | --- |
| Any warm per-round operation | < 2 ms | ~41× |
| Cold catalogue digest, `n = 5` | < 200 ms | ~200× |
| Cold catalogue digest, `n = 7` | < 20,000 ms | ~72× |
| Cold digest ÷ ticket settle | > 100 | ~42,000 |
| Resolution track, worst ticket | < 260 ms | ~24× |

The bands are deliberately loose because a shared CI runner is not a laptop and
a flaky performance assertion is how an unasserted benchmark gets rationalised
in the first place. What they catch is a regression of *kind* — a per-round path
that started touching the catalogue digest — which is exactly the claim the
table exists to support: the digest is paid once per process at adapter
construction, and nothing on a round path touches it.

**The resolution track is the exception that has to be measured**, because it is
the one per-round cost that is not microseconds and the only one paid inside a
named animation beat: docs/DESIGN.md §7 technique 1 builds it once inside the
260 ms CHARGE. Its band is that beat. The two rows are a *worst legal ticket* —
eleven maximal-rank FULL ORDER claims, each of which agrees "lose" across
thousands of completions before reaching its single winner — and a realistic
twelve-line one. Round 4 published 1.3 ms for "a hostile 12-line SEVEN ticket",
which is roughly the realistic figure and an order of magnitude under the
genuinely hostile one; both are now measured, banded and quoted.

---

## 5. Round lifecycle

```
        publishSeedCommitment
IDLE ─────────────────────────▶ COMMITTED ──── openTicket ────▶ TICKETED
                                                                   │
                                                        settleTicket (atomic)
                                                                   ▼
                                        SETTLED ──── makeReceipt ──▶ RECEIPTED
                                           │                            │
                        revealSeed ────────┴──── verifyTranscript       │
                                                 verifyReceipt ◀────────┘
```

There is exactly one frame. A round has no intra-round player action, therefore
no price frame revision, no `STALE_FRAME`, no sell path, and no re-entry
accounting. `openTicket` and `settleTicket` are each idempotent under an
action-bound idempotency key, exactly as in `RoundBook`.

**Pacing is part of the lifecycle.** The RGS must reject a COMMIT that arrives
less than `play.minRoundCycleMs` after the previous one for the same session,
and must refuse to open a round once the session has settled
`play.maxRoundsPerRollingHour` rounds in the trailing 60 minutes. Both are
server-side: a client-side floor is a suggestion. Rejection is a hard `no bet`
that returns the stake intent unspent — never a queued or delayed bet, because a
delayed bet is a latency-sensitive money decision by another name.

Ordering is load-bearing and must be enforced by the RGS:

1. Draw a 32-byte server seed from a CSPRNG. Fix the **seed context** —
   `(variantId, roundId, nonce)` — and publish it together with
   `seedCommitment`, which binds the seed *and* that whole context.
2. Accept the player's client seed and ticket. Debit the wallet.
3. Derive the permutation. Settle. Credit the wallet.
4. Reveal the server seed. The transcript plus that seed becomes independently
   verifiable.
5. Chain: the next round's transcript binds this round's `commitment`.

**Why the context, not just the seed.** The permutation is a function of
`(serverSeed, variantId, roundId, clientSeed, nonce)`. A commitment over the
seed alone would leave `nonce` and `variantId` free: an operator that had
already seen the ticket could search them for a favourable permutation and
still open the published hash honestly. Binding the full seed context means the
only degree of freedom left after publication belongs to the player. The client
must check that the settled transcript's context is the one that was published.

**What the chain does and does not prove.** Binding `previousCommitment` makes a
retroactive edit to a round's ancestry detectable to anyone holding a later
commitment. It is tamper-evidence, not proof of completeness or chronology: the
format carries no sequence number, timestamp or signature, so a dropped tail or
a chain built after the fact is not detectable from the chain alone. Production
deployments must anchor the chain head externally — an operator signature over
`(chain head, sequence, time)`, or publication to a medium the operator cannot
rewrite.

Revealing the seed *per round* (rather than per seed-pair rotation) is
deliberate: it gives immediate one-tap verification and removes the class of bug
where a revealed chain seed makes subsequent nonces in the same chain
predictable. The cost is one commitment publication per round.

---

## 6. Engine module surface (TypeScript sketch)

```ts
/** Everything frozen and published BEFORE the player commits a ticket. */
export interface SeedContext {
  readonly variantId: string;
  readonly roundId: string;    // printable ASCII, <= 128 bytes
  readonly nonce: number;      // non-negative safe integer
}

/** The seed context plus the one input the player supplies afterwards. */
export interface RoundContext extends SeedContext {
  readonly gameId: string;
  readonly clientSeed: string; // printable ASCII, <= 64 bytes, may be empty
}

export interface ConformanceCheck {
  readonly id: number;         // 1 .. 12, matching §8
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly variantId: string;
  readonly ok: boolean;
  readonly checks: readonly ConformanceCheck[];
}

export interface PermutationTranscript {
  readonly schema: typeof PERMUTATION_TRANSCRIPT_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly adapterVersion: string;
  readonly adapterFingerprint: string;
  readonly variantId: string;
  readonly roundId: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly n: number;
  readonly permutation: Permutation;
  /** Previous round's commitment, or 64 zeros to open a chain. */
  readonly previousCommitment: string;
  readonly seedCommitment: string;
  readonly commitment: string;
}

export interface TicketLine {
  readonly code: string;
  readonly params: Readonly<object>;
  readonly stake: bigint;      // minor units, multiple of stakeQuantum
}

/**
 * The result of `openTicket`. `lines` are in CANONICAL order — sorted by
 * `(code, canonical params)` — so a retry that reorders the same lines produces
 * the same `ticketDigest` and therefore the same `idempotencyKey` and cannot
 * double-debit. The distinct-claim rule makes that order total.
 */
export interface Ticket {
  readonly schema: typeof PERMUTATION_TICKET_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly variantId: string;
  readonly roundId: string;
  readonly nonce: number;
  readonly lines: readonly TicketLine[];
  readonly totalStake: bigint;
  readonly ticketDigest: string;
  /** Derived, never caller-chosen: see §7.7. */
  readonly idempotencyKey: string;
}

export interface SettledLine extends TicketLine {
  readonly won: boolean;
  readonly gross: bigint;
}

export interface Settlement {
  readonly lines: readonly SettledLine[];
  readonly totalStake: bigint;
  readonly gross: bigint;
  readonly credited: bigint;   // min(gross, totalStake * maxWinMultiple)
  readonly capped: boolean;
  readonly net: bigint;
}

/**
 * The signed binding between a round and a bet. See §6.1.
 */
export interface PermutationReceipt {
  readonly schema: typeof PERMUTATION_RECEIPT_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly adapterVersion: string;
  readonly adapterFingerprint: string;
  readonly variantId: string;
  readonly roundId: string;
  readonly nonce: number;
  /** The pre-round publication, copied from the transcript. */
  readonly seedCommitment: string;
  /** The round commitment, copied from the transcript. */
  readonly commitment: string;
  readonly ticketDigest: string;
  readonly settlementDigest: string;
  readonly totalStake: bigint;
  readonly credited: bigint;
  /** Printable ASCII identifier of the operator key that signed this. */
  readonly signerId: string;
  /** SHA-256 of the receipt core bytes (§7.8). For display and anchoring. */
  readonly digest: string;
  /** Ed25519 over the core bytes, hex. `null` until signed. */
  readonly signature: string | null;
}

/** A resumable round. Every phase carries exactly what that phase produced. */
export interface RoundSnapshot {
  readonly schema: typeof PERMUTATION_SNAPSHOT_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly phase: 'COMMITTED' | 'TICKETED' | 'SETTLED';
  readonly variantId: string;
  readonly roundId: string;
  readonly nonce: number;
  readonly seedCommitment: string;
  readonly transcript: PermutationTranscript | null;
  readonly ticket: Ticket | null;
  readonly settlement: Settlement | null;
  readonly receipt: PermutationReceipt | null;
}

export type VerificationResult =
  | { readonly ok: true;  readonly commitment: string }
  | { readonly ok: false; readonly code: PermutationErrorCode;
      readonly message: string; readonly path: string };

/**
 * A receipt verification is a TRI-state, and only one of the three is `ok`.
 *
 * `ok: true` requires the signature to have been checked and to have verified.
 * A verifier given no public key returns `ok: false` with
 * `code: 'SIGNATURE_UNCHECKED'` and `bindingsVerified: true`, because the
 * receipt's whole purpose is the signature: without it the object is a
 * self-consistent bundle the operator produced, and `.ok` — the field every
 * other path answers with — must not say otherwise. `bindingsVerified` is the
 * separate field a device with no Ed25519 implementation reads to show
 * docs/DESIGN.md §7.3's "signature not checked on this device" state.
 */
export type ReceiptVerificationResult =
  | { readonly ok: true;  readonly digest: string;
      readonly signatureChecked: true; readonly signatureValid: true;
      readonly bindingsVerified: true }
  | { readonly ok: false; readonly code: 'SIGNATURE_UNCHECKED';
      readonly message: string; readonly path: string; readonly digest: string;
      readonly signatureChecked: false; readonly signatureValid: null;
      readonly bindingsVerified: true }
  | { readonly ok: false; readonly code: PermutationErrorCode;
      readonly message: string; readonly path: string;
      readonly signatureChecked: boolean; readonly signatureValid: boolean | null;
      readonly bindingsVerified: boolean };

/* --- functions ---------------------------------------------------------- */

/**
 * Binds the seed AND the whole seed context. A commitment over
 * `(serverSeed, roundId)` alone would leave `variantId` and `nonce` free for an
 * operator that has already seen the ticket to search; see §5 and §7.2.
 */
export function seedCommitment(serverSeedHex: string, context: SeedContext): string;

export function uniformBelow(
  serverSeedHex: string, context: RoundContext,
  label: string, counter: number, modulus: bigint,
): bigint;

export function derivePermutation(
  serverSeedHex: string, game: PermutationGameDefinition, context: RoundContext,
): Permutation;

export function makePermutationTranscript(
  serverSeedHex: string, game: PermutationGameDefinition,
  context: RoundContext, previousCommitment?: string,
): PermutationTranscript;

export function verifyPermutationTranscript(
  serverSeedHex: string, game: PermutationGameDefinition, input: unknown,
): VerificationResult;

/** Validate against the risk policy, fix canonical order, derive the digest. */
export function openTicket(
  game: PermutationGameDefinition, context: SeedContext, ticket: unknown,
): Ticket;

export function settleTicket(
  game: PermutationGameDefinition,
  transcript: PermutationTranscript,
  ticket: Ticket,
): Settlement;

export function ticketDigest(
  game: PermutationGameDefinition, context: SeedContext, ticket: unknown,
): string;

export function settlementDigest(
  game: PermutationGameDefinition, settlement: Settlement,
): string;

export function idempotencyKeyFor(action: 'open' | 'settle', ticketDigest: string): string;

export function makeReceipt(input: {
  transcript: PermutationTranscript; ticket: unknown;
  settlement: Settlement; signerId: string;
}): PermutationReceipt;

export function signReceipt(receipt: PermutationReceipt, privateKey: KeyObject): PermutationReceipt;

export function verifyReceipt(
  receipt: unknown,
  context: { transcript: PermutationTranscript; ticket: unknown;
             settlement: Settlement; publicKey?: KeyObject },
): ReceiptVerificationResult;

export function serializeTranscript(transcript: PermutationTranscript): string;
export function deserializeTranscript(input: unknown): PermutationTranscript;
export function serializeRoundSnapshot(snapshot: RoundSnapshot): string;
export function deserializeRoundSnapshot(input: unknown): RoundSnapshot;

/** Adapter conformance, §8, checks 1 to 12, as one callable function. */
export function assertPermutationAdapterConforms(
  game: PermutationGameDefinition,
): ConformanceReport;
```

`verifyPermutationTranscript` and `verifyReceipt` return typed results instead
of throwing so a verifier UI can name the exact failure. `settleTicket`,
`openTicket` and the digest functions throw `RevealEngineError` on hostile or
malformed input — a bad ticket is a programming or protocol error, not a game
state.

**The reference implementation is game-specific and therefore omits the `game`
parameter**, taking the variant from the context or the transcript instead.
Every other parameter matches this surface in name and order, and
`tests/design.test.mjs` parses the declarations out of this document and
compares them against the reference's real signatures — which is how the stale
`seedCommitment(serverSeedHex, roundId)` above was caught the second time.

### 6.1 The receipt, and what it is for

Commit-reveal proves the **draw**. It proves the permutation was fixed before
the ticket existed, that the revealed seed opens the published hash, and that
the adapter that settled it is the adapter that was fingerprinted. It proves
nothing whatsoever about the **bet**: a player holding a transcript can show the
order was honest and cannot show they were on it, for how much, or that the
operator ever acknowledged the stake. This is the most common misunderstanding
of provably-fair systems and it is not fixable by hashing harder — nothing the
player holds is bound to the round unless somebody binds it.

The receipt is that binding. It is a single object containing the pre-round
publication, the round commitment, a digest of the ticket, a digest of the
settlement and the two money totals, hashed and signed by a named operator key.
Given a receipt and the round's transcript, anyone can recompute all four
digests and check the signature, and no party can later disagree about what was
staked or what was paid.

**It is a weaker guarantee than the commitment, and must always be described as
one.** Commit-reveal is verification from first principles: it needs no trust
in the operator at all beyond seed custody. The receipt is *non-repudiation
against a named signer* — it rests on the operator's key being the operator's
key and on the player having kept the receipt. It stops an operator denying or
rewriting a settled bet. It does not, on its own, stop an operator refusing to
issue a receipt in the first place, which is a dispute-process problem and not a
cryptographic one. §11 and the README repeat this boundary in those terms.

---

## 7. Derivation, normatively

### 7.1 Canonical encoding

Identical to the engine's `encodeFields`: a uint32 big-endian field count,
then, per field, a uint32 big-endian byte length followed by the bytes.
`bigint` and `number` fields encode as their base-10 ASCII decimal; `number`
must be a safe integer.

The property this provides is **recoverable field boundaries**: no field can
smuggle a separator, and `['ab','c']` can never collide with `['a','bc']`. It is
deliberately *not* type-tagged — `7`, `7n` and `'7'` share an encoding. That is
safe here only because every field position in every payload below has a fixed
declared type, so a value cannot migrate between types at the same position. A
future payload that needs two types at one position must add an explicit type
tag; do not assume typed injectivity.

### 7.2 Seed commitment (published before the ticket)

```
seedCommitment = SHA-256( encodeFields([
  'aether-order/seed-commit-v1',
  serverSeed as 32 raw bytes,
  gameId, variantId, roundId, nonce,
]) )
```

Committed fields, in order: `serverSeed ‖ gameId ‖ variantId ‖ roundId ‖ nonce`. That is everything the derivation consumes
except `clientSeed`. Publishing this hash together with the plaintext
`(variantId, roundId, nonce)` is what makes the round non-grindable; see §5.

### 7.3 Uniform sampler

```
uniformBelow(seed, ctx, label, counter, M):
  require 0 < M < 2^256
  L = 2^256 - (2^256 mod M)
  for rejection = 0, 1, 2, ...:
    payload = encodeFields([
      'sampler', 'reveal-engine/permutation-v1',
      ctx.gameId, ctx.variantId, ctx.roundId, ctx.clientSeed, ctx.nonce,
      label, counter, rejection, M,
    ])
    v = BigInt(HMAC-SHA256(key = serverSeed bytes, payload))   // 256 bits
    if v < L: return v mod M
```

`L` is divisible by `M`, so every residue is equally likely: no modulo bias.
Expected iterations are below `1 + M / 2^256`, i.e. one, for every modulus this
game uses. The loop is unbounded in principle and terminates with probability 1;
implementations must not cap it, because a cap would reintroduce bias.

### 7.4 Shuffle

```
derivePermutation(seed, game, ctx):
  a = [0, 1, ..., n-1]
  for t = 0 .. n-2:
    i = n - 1 - t
    j = uniformBelow(seed, ctx, 'shuffle', t, BigInt(n - t))    // j in [0, i]
    swap a[i], a[j]
  return a          // a[slot] = element that settles into that slot
```

The label/counter split (`'shuffle'`, `t`) domain-separates every draw, so two
steps with the same modulus never reuse a sampler output.

`docs/MATH.md` §2.1 proves this is a bijection from draw vectors onto `S_n` by
exhaustive enumeration for `n = 5` and `n = 7`; combined with §7.3 the resulting
permutation is exactly uniform.

### 7.5 Transcript commitment

```
transcriptBytes = encodeFields([
  'AETHER ORDER permutation transcript',
  'reveal-engine/permutation-transcript-v1',
  'reveal-engine/permutation-v1',
  gameId, adapterVersion, adapterFingerprint, variantId,
  roundId, clientSeed, nonce, n, permutation.length,
  slot_0, element_0, slot_1, element_1, ... ,
  previousCommitment,
])

commitment = SHA-256( encodeFields([
  'commitment', 'reveal-engine/permutation-v1',
  serverSeed as 32 raw bytes,
  transcriptBytes,
]) )
```

Binding `adapterFingerprint` means a commitment is only valid under the exact
paytable, cap, quantum and limits that were live when the round ran. Binding
`previousCommitment` chains rounds, so an operator cannot reorder, drop or
back-date a round after the fact.

### 7.6 Ticket and settlement digests

Lines are sorted into **canonical order** — ascending by `code`, then by the
canonical parameter rendering (`key=value` pairs, keys sorted, joined by `,`) —
before either digest is taken. Two lines can never share both a code and a
parameter rendering, because the distinct-claim rule rejects that ticket, so the
order is total. Sorting is what makes a retry that reorders the same lines
produce the same digest, and therefore the same idempotency key.

```
ticketDigest = SHA-256( encodeFields([
  'aether-order/ticket-digest-v1',
  'reveal-engine/permutation-ticket-v1',
  'reveal-engine/permutation-v1',
  gameId, variantId, roundId, nonce,
  lineCount,
  code_0, canonicalParams_0, stake_0,
  code_1, canonicalParams_1, stake_1, ... ,
  totalStake,
]) )

settlementDigest = SHA-256( encodeFields([
  'aether-order/settlement-digest-v1',
  'reveal-engine/permutation-v1',
  gameId, variantId,
  totalStake, gross, credited, capped ? 1 : 0, net,
  lineCount,
  code_0, canonicalParams_0, stake_0, won_0 ? 1 : 0, gross_0, ... ,
]) )
```

### 7.7 Idempotency key

Derived, never caller-chosen. A caller-chosen key lets a buggy client reuse one
key for two different tickets; deriving it from the ticket means the key *is*
the intent.

```
idempotencyKey(action, ticketDigest) = SHA-256( encodeFields([
  'aether-order/idempotency-v1',
  'reveal-engine/permutation-v1',
  gameId,
  action,            // 'open' | 'settle'
  ticketDigest,
]) )
```

`action` separates the two writes so a settle can never be mistaken for a
replayed open. Presenting the same key with a different payload is
`IDEMPOTENCY_CONFLICT`.

### 7.8 Receipt

```
receiptCore = encodeFields([
  'aether-order/receipt-v1',
  'reveal-engine/permutation-receipt-v1',
  'reveal-engine/permutation-v1',
  gameId, adapterVersion, adapterFingerprint, variantId, roundId, nonce,
  seedCommitment,      // the pre-round publication
  commitment,          // the transcript commitment
  ticketDigest,
  settlementDigest,
  totalStake, credited,
  signerId,
])

receiptDigest = SHA-256(receiptCore)
signature     = Ed25519(operator private key, receiptCore)     // RFC 8032
```

The signature covers the **core bytes**, not the digest, so there is no
hash-then-sign ambiguity; `receiptDigest` exists for display, for anchoring and
for the burned-in hash on a shared clip. Ed25519 signatures are deterministic,
so a signed receipt is a stable byte-for-byte fixture — `tests/fixtures/
transcripts.json` freezes eight of them under a published test key.

A verifier holding `(receipt, transcript, ticket, settlement)` must recompute
`ticketDigest`, `settlementDigest` and `receiptDigest`, compare the receipt's
`seedCommitment` and `commitment` against the transcript's, compare the money
totals against the settlement, and only then check the signature.

**A verifier given no public key must return `ok: false`.** Round 4 of this
document said it "must report `signatureChecked: false` rather than an
unqualified pass" and the reference implemented that as `ok: true` beside
`signatureChecked: false` — which *is* the unqualified pass, qualified only by a
sibling field a caller has to know to read. `.ok` is the branch every other
failure path uses, so the fail-open case was the one shaped like success. The
required result is `ok: false`, `code: 'SIGNATURE_UNCHECKED'`,
`bindingsVerified: true`: the bindings were all checked and they all held, and
the guarantee the receipt exists to provide was not obtained. A client with no
Ed25519 implementation branches on `bindingsVerified`, never on `ok`.

This is the same rule as §7.10 point 5, applied to the other half of the
fairness model: absent evidence is a rejection, never a skipped check.

### 7.9 Round snapshot

`RoundSnapshot` serialises as canonical JSON: object keys sorted, two-space
indent, trailing newline, chip amounts as base-10 strings (JSON has no integer
type that can hold them safely). `deserializeRoundSnapshot` revives every money
field — `stake`, `totalStake`, `gross`, `credited`, `net` — back to `bigint` and
rejects anything that is not an integer string, so a snapshot cannot smuggle a
float onto a money path. Size is bounded by
`PERMUTATION_LIMITS.maxSnapshotBytes`.

Phase invariants, enforced on construction and on parse: a `TICKETED` or
`SETTLED` snapshot must carry its ticket; a `SETTLED` snapshot must carry its
transcript. A half-written snapshot is rejected rather than restored, because a
restored round missing its transcript is a round that cannot be verified.

Every snapshot also carries **`playPolicyDigest`**, the digest of the pacing and
session policy that was live when the round ran (§4). It is required on parse
and fails closed: a snapshot without one is rejected rather than defaulted,
because stamping the *current* policy onto a snapshot that never carried one
would manufacture exactly the evidence the field exists to provide.

### 7.10 Verification

A verifier holding `(serverSeed, transcript)` and the adapter must:

1. reject unknown `schema` / `moduleVersion` (fail closed);
2. reject a mismatched `gameId`, `adapterVersion` or `adapterFingerprint`;
3. validate `permutation` is a genuine permutation of `[0, n)`;
4. re-derive the permutation and compare element by element;
5. **require** `seedCommitment`, validate it as 64 lowercase hex characters,
   recompute it and compare in constant time. A missing or wrongly-typed field
   is a rejection, never a skipped check — treating "absent" as "nothing to
   verify" would let a round that was never committed to in advance verify as
   honest;
6. recompute `commitment` and compare in constant time.

`tools/enumerate.mjs` §9 exercises the happy path plus a tampered permutation
and a wrong revealed seed; §10 does the same for the receipt, including a ticket
whose stake was edited after signing. `tests/derivation.test.mjs` extends
transcript verification to mutated `clientSeed`, `nonce`, `roundId`,
`previousCommitment` and fingerprint; `tests/receipt.test.mjs` extends receipt
verification to every field of the binding.

---

## 8. Adapter conformance

The module must expose `assertPermutationAdapterConforms(game)` and run it in
CI. It is mechanical evidence, not certification. In this repository it is
`assertAdapterConforms(variantId)` in `tools/lib/conform.mjs`, called by
`tools/enumerate.mjs` §13 and by `tests/conformance.test.mjs`; a port renames it
and takes the game definition instead of a variant id. It checks:

1. **Structure** — `apiVersion` / `moduleVersion` are current; `id`, `variantId`
   and `adapterVersion` are non-empty printable ASCII within
   `ENGINE_LIMITS.maxIdentifierBytes`; `elements` are unique and `length === n`;
   `2 <= n <= 12`; the definition is deep-frozen.
2. **Catalogue completeness** — every family has a multiplier and vice versa;
   family codes are unique; instance labels are unique within a family.
3. **Determinism** — `enumerateInstances(n)` returns the identical sequence on
   two calls; `resolve` returns the identical boolean on two calls for every
   `(instance, permutation)` pair.
4. **Purity** — `resolve` must not mutate its arguments; both are passed frozen.
5. **Non-degeneracy** — every family wins on at least one and not all outcomes.
6. **Homogeneity** — all instances of a family share one win count, so a single
   published multiplier is honest for the whole family.
7. **Pricing identity** — `multiplier × probability === targetRtp` exactly, for
   every family, with probability counted over the full `n!` space.
8. **Quantum** — every multiplier denominator divides `stakeQuantum`, so
   `stake × multiplier` is always an exact integer and `floor` is a no-op.
9. **Cap headroom** — `max multiplier < maxWinMultiple`, so the cap is inert.
10. **Shuffle bijection** — all `n!` draw vectors map onto `S_n` exactly once.
11. **Behavioural fingerprint** — the catalogue digest is recomputed from
    scratch and the fingerprint is rebuilt through the production field builder;
    it must equal the shipped fingerprint. The check also substitutes a decoy
    digest and requires the fingerprint to *move*, so it proves the binding is
    live rather than merely consistent.
12. **Claim aliasing** — instances that share a win set are reported, so the
    adapter author knows which chips are the same bet under a different name
    and the client can merge them in the ticket builder. The report is published
    in `docs/paytable.json` as `claimAliases`.

Checks 5–10 are enumerable in milliseconds for `n <= 8` and are exactly what
`tools/enumerate.mjs` performs today. For larger `n` the module must refuse to
run the exhaustive checks rather than silently sample: `ENGINE_LIMITS` caps
`n` at 12 for definition, and conformance at 8.

**One honest caveat about checks 3 and 4.** Determinism and purity are the only
checks that need a *second* full pass over the instance × outcome space, which
at `n = 7` is 27.6M evaluations the enumerator has already made once. They
therefore run exhaustively for `n <= 6` (up to 720 outcomes) and over a
deterministic 128-outcome stride sample above that, and the report string says
which — CLASSIC is exhaustive, SEVEN is sampled. A port may run them
exhaustively if it can afford to; what it must not do is report a sampled check
as an exhaustive one.

---

## 9. Errors and limits

Reuses `RevealEngineError` with a stable `code`, `path` and optional details.
Integrations branch on `code`, never on message text.

| Code | Raised when |
| --- | --- |
| `INVALID_ADAPTER` | definition fails structural or conformance checks |
| `INVALID_SEED` | server seed is not 32 bytes of hex |
| `INVALID_CONTEXT` | round id, client seed, nonce, label or modulus is malformed or oversized |
| `INVALID_TRANSCRIPT` | transcript is malformed, oversized, or not a permutation |
| `UNSUPPORTED_VERSION` | unknown schema or module version — fail closed |
| `ADAPTER_MISMATCH` | transcript belongs to another adapter or fingerprint |
| `TRANSCRIPT_MISMATCH` | re-derivation disagrees with the transcript |
| `COMMITMENT_MISMATCH` | commitment does not open to the revealed seed |
| `INVALID_TICKET` | line count, stake, quantum, total or line shape breaches the risk policy |
| `UNKNOWN_BET` | ticket references a bet code the adapter does not define |
| `UNKNOWN_INSTANCE` | ticket parameters are not a legal instance of the family |
| `DUPLICATE_LINE` | the ticket repeats a claim (same win set, any spelling); raise the stake instead |
| `INEXACT_PAYOUT` | `stake × multiplier` is not an integer — never rounds, always throws |
| `IDEMPOTENCY_CONFLICT` | same key, different payload or action; or an unknown action |
| `CYCLE_FLOOR` | COMMIT arrived before `play.minRoundCycleMs` elapsed, or the rolling round ceiling is reached — RGS-raised, never a client state |
| `BETTING_CLOSED` | a shared-chamber `ticket.commit` reached the server after `settleAtEpochMs − commitLeadMs + commitGraceMs` on the server's clock. Hard `no bet`: the stake is unspent and the ticket is never queued into the next draw — docs/DESIGN.md §5 S10 |

The receipt path reuses the table above rather than adding a parallel one:
a receipt that does not bind the supplied ticket or settlement is
`TRANSCRIPT_MISMATCH`, one whose digest or signature does not open is
`COMMITMENT_MISMATCH`, and one carrying an unknown schema is
`UNSUPPORTED_VERSION`. Integrations branch on `code`, so a new code would be a
breaking change where a reused one is not.

It gains exactly one code of its own, because no existing code says the right
thing and reusing one that means "this receipt is wrong" for a case where the
receipt may be perfectly good would be worse than adding a code:

| Code | Raised when |
| --- | --- |
| `SIGNATURE_UNCHECKED` | `verifyReceipt` was given no operator public key. Every binding was recomputed and held (`bindingsVerified: true`); the signature was not checked, so the result is not a pass — §7.8 |

Module additions to `ENGINE_LIMITS`:

```ts
export const PERMUTATION_LIMITS = Object.freeze({
  maxElements: 12,              // definition ceiling
  maxExhaustiveElements: 8,     // conformance and catalogue-digest ceiling
  maxLinesPerTicket: 32,        // protocol ceiling; the adapter sets 12
  maxClientSeedBytes: 64,
  maxRoundIdBytes: 128,
  maxLabelBytes: 128,           // sampler labels: printable ASCII, bounded
  maxSignerIdBytes: 128,
  maxTranscriptBytes: 64 * 1024,
  maxSnapshotBytes: 256 * 1024,
});
```

---

## 10. Reference implementation map

| Surface | Status | Where |
| --- | --- | --- |
| Exact BigInt rationals | implemented | `tools/lib/rational.mjs` |
| Canonical encoding, SHA-256, HMAC, canonical JSON | implemented | `tools/lib/canonical.mjs` |
| Permutation enumeration, rank, Fisher–Yates, draw vectors | implemented | `tools/lib/permutations.mjs` |
| Bet families: instances and pure resolve predicates | implemented | `tools/lib/bets.mjs` |
| Elements, multipliers, limits, quantum, target RTP | implemented | `tools/lib/model.mjs` |
| Sampler, shuffle, seed commitment, transcript, verification, settlement | implemented | `tools/lib/derive.mjs` |
| Catalogue digest and adapter fingerprint | implemented | `tools/lib/derive.mjs` |
| Exhaustive proofs used by the CLI and the tests | implemented | `tools/lib/analysis.mjs` |
| Frozen wire-format vectors: transcripts, tickets, settlements, signed receipts | implemented | `tests/fixtures/transcripts.json` |
| Conformance checks 1–12 of §8, as one packaged function | implemented | `tools/lib/conform.mjs` |
| `openTicket`, ticket digest, derived idempotency keys | implemented | `tools/lib/derive.mjs` |
| Receipts: build, sign (Ed25519), verify | implemented | `tools/lib/derive.mjs` |
| `serializeTranscript` / `deserializeTranscript` and size bounds | implemented | `tools/lib/derive.mjs` |
| Round snapshots: build, serialise, parse, revive money fields | implemented | `tools/lib/derive.mjs` |
| Celebration gate and best-possible-outcome figure | implemented | `tools/lib/presentation.mjs` |
| Play-policy digest stamped into every round snapshot | implemented | `tools/lib/derive.mjs` |
| Line resolution track: `decisiveLock`, `resolutionTrack` | implemented | `tools/lib/resolution.mjs` |
| Per-pass frame budget, chrome-layer composite and raster budget behind docs/DESIGN.md §7.1–§7.1.2 | implemented | `tools/lib/framebudget.mjs` |
| Palette separation and the closest-pair list behind docs/DESIGN.md §6.1 | implemented | `tools/lib/palette.mjs` |
| Reproducible cost measurements for §4, with asserted bands | implemented | `tools/bench.mjs` |
| `definePermutationGame` validating factory | **specified only** (the reference freezes literals in `model.mjs` and validates them through `assertAdapterConforms`) | — |
| Operator key custody, rotation and publication | **out of scope** — operator responsibility, §11 | — |
| Round-cycle floor and rolling ceiling enforcement | **specified only** — RGS/session state, which this repository has none of | — |

**Naming.** The module types above are generic over minor units and use
`stake` / `gross` / `credited`. The reference, being game-specific, names the
unit: `stakeChips` / `grossChips` / `creditedChips`. Same fields, same
semantics; a port should use the module names.

Porting checklist for the TypeScript module: reproduce `encodeFields` byte for
byte, keep the domain tags and field order in §7 identical, then run
`tests/derivation.test.mjs` against the frozen fixtures. If a single commitment
digest differs, the port is wrong.

---

## 11. Boundary

This is a specification and a reference implementation. It is not an RNG
certificate, a security audit, a regulatory approval or a production
integration. Server-seed generation and custody, wallet atomicity, persistence,
authenticated storage and idempotency-under-transaction remain the operator's
responsibility, exactly as stated in the engine's own certification boundary.

**Two different guarantees, and they should never be conflated.**

*Commit-reveal (§5, §7.2, §7.5) is verification from first principles.* Anyone
holding a transcript and the revealed seed can re-derive the permutation and
both hashes with no trust in the operator beyond the assumption that server
seeds are drawn from a properly seeded CSPRNG under reviewed custody. It answers
"was the draw honest?".

*The receipt (§6.1, §7.8) is non-repudiation against a named signer.* It answers
"what did I stake, and what was I paid?" — a question commit-reveal cannot
touch, because nothing in a transcript mentions a ticket. It rests on the
operator's signing key being what it claims to be, on that key being published
and rotated responsibly, and on the player retaining the receipt. It stops a
settled bet being denied or rewritten. It does not stop a receipt never being
issued: that is a dispute process, a regulator and a licence condition, not a
hash. This repository implements the cryptography and specifies the format; it
does not and cannot supply the process.

Key custody, publication and rotation are entirely the operator's. The Ed25519
key in `tests/fixtures/transcripts.json` is derived from a fixed public seed so
that signed receipts are reproducible fixtures. It is not a secret and must
never become one.
