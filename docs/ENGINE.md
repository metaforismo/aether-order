# Reveal Engine — permutation lifecycle module

AETHER ORDER does not ship its own randomness, commitment scheme, or money
arithmetic. It consumes a Reveal Engine lifecycle module and supplies an
adapter. This document specifies the module the game expects, the exact adapter
surface it implements against, and the byte layouts both sides must agree on.

`tools/lib/` carries a runnable reference implementation of the module's
**derivation, commitment, verification and settlement core**, written in plain
ESM so that the enumerator, the tests and an independent verifier can execute it
without a build step. The protocol layer — receipts, idempotency, snapshots,
serialisation and the packaged conformance runner — is specified here but not
implemented in this repository; §10 marks each surface. Where the reference does
exist it is normative: the TypeScript module inside Reveal Engine must produce
**byte-identical** commitments, and `tests/fixtures/transcripts.json` freezes the
vectors that prove it.

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
```

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
   * A ticket may not repeat a claim. Without this the per-line ceiling is
   * meaningless — the budget could be piled onto copies of the single best
   * line — and the maximum-credit figure in docs/MATH.md would be a lower
   * bound rather than a maximum.
   */
  readonly requireDistinctLines: boolean;
}

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
}

/** The only supported construction path: validates, clones, deep-freezes. */
export function definePermutationGame(input: PermutationGameDefinition): PermutationGameDefinition;

/**
 * Behavioural digest of the catalogue: for every family, in canonical order,
 * every instance's complete win/lose bitmap over all n! permutations.
 * Declaring codes and multipliers is not enough — reversing a predicate would
 * leave a purely declarative fingerprint untouched while changing how an open
 * liability settles.
 */
export function permutationCatalogueDigest(game: PermutationGameDefinition): string;

/**
 * Binds every replay-visible field: the declarative configuration above AND
 * `permutationCatalogueDigest(game)`. Memoised; computing it costs one pass
 * over the outcome space per variant.
 */
export function permutationAdapterFingerprint(game: PermutationGameDefinition): string;
```

AETHER ORDER supplies two definitions, `classic` (`n = 5`) and `seven`
(`n = 7`), sharing one bet catalogue and one `targetRtp = 24/25`.

---

## 5. Round lifecycle

```
        publishSeedCommitment
IDLE ─────────────────────────▶ COMMITTED ──── openTicket ────▶ TICKETED
                                                                   │
                                                        settleTicket (atomic)
                                                                   ▼
        verifyTranscript ◀──── revealSeed ──────────────────── SETTLED
```

There is exactly one frame. A round has no intra-round player action, therefore
no price frame revision, no `STALE_FRAME`, no sell path, and no re-entry
accounting. `openTicket` and `settleTicket` are each idempotent under an
action-bound idempotency key, exactly as in `RoundBook`.

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
export interface RoundContext {
  readonly gameId: string;
  readonly variantId: string;
  readonly roundId: string;    // printable ASCII, <= 128 bytes
  readonly clientSeed: string; // printable ASCII, <= 64 bytes, may be empty
  readonly nonce: number;      // non-negative safe integer
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

export interface Ticket {
  readonly schema: typeof PERMUTATION_TICKET_SCHEMA;
  readonly lines: readonly TicketLine[];
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

export type VerificationResult =
  | { readonly ok: true;  readonly commitment: string }
  | { readonly ok: false; readonly code: PermutationErrorCode;
      readonly message: string; readonly path: string };

/* --- functions ---------------------------------------------------------- */

export function seedCommitment(serverSeedHex: string, roundId: string): string;

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

export function settleTicket(
  game: PermutationGameDefinition,
  transcript: PermutationTranscript,
  ticket: Ticket,
): Settlement;

export function serializeTranscript(t: PermutationTranscript): string;
export function deserializeTranscript(input: unknown): PermutationTranscript;
```

`verifyPermutationTranscript` returns a typed result instead of throwing so a
verifier UI can name the exact failure. `settleTicket` throws
`RevealEngineError` on hostile or malformed input — a bad ticket is a
programming or protocol error, not a game state.

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

Everything the derivation consumes except `clientSeed` appears here. Publishing
this hash together with `(variantId, roundId, nonce)` is what makes the round
non-grindable; see §5.

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

### 7.6 Verification

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
and a wrong revealed seed. `tests/derivation.test.mjs` extends that to mutated
`clientSeed`, `nonce`, `roundId`, `previousCommitment` and fingerprint.

---

## 8. Adapter conformance

The module must expose `assertPermutationAdapterConforms(game)` and run it in
CI. It is mechanical evidence, not certification. In this repository the checks
below are implemented as `tools/enumerate.mjs` plus the test suite rather than as
a packaged function; a port must fold them into the module. It checks:

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
11. **Behavioural fingerprint** — the catalogue digest is recomputed and must
    equal the one bound into the adapter fingerprint.

Checks 5–10 are enumerable in milliseconds for `n <= 8` and are exactly what
`tools/enumerate.mjs` performs today. For larger `n` the module must refuse to
run the exhaustive checks rather than silently sample: `ENGINE_LIMITS` caps
`n` at 12 for definition, and conformance at 8.

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
| `DUPLICATE_LINE` | the ticket repeats a claim; raise the stake instead |
| `INEXACT_PAYOUT` | `stake × multiplier` is not an integer — never rounds, always throws |
| `IDEMPOTENCY_CONFLICT` | same key, different payload or action |

Module additions to `ENGINE_LIMITS`:

```ts
export const PERMUTATION_LIMITS = Object.freeze({
  maxElements: 12,              // definition ceiling
  maxExhaustiveElements: 8,     // conformance and catalogue-digest ceiling
  maxLinesPerTicket: 32,        // protocol ceiling; the adapter sets 12
  maxClientSeedBytes: 64,
  maxRoundIdBytes: 128,
  maxLabelBytes: 128,           // sampler labels: printable ASCII, bounded
  maxTranscriptBytes: 64 * 1024,
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
| Frozen wire-format vectors | implemented | `tests/fixtures/transcripts.json` |
| Conformance checks 1–10 of §8 | implemented as the enumerator + test suite, **not** as a packaged `assertPermutationAdapterConforms` | `tools/enumerate.mjs`, `tests/` |
| `openTicket`, receipts, idempotency keys, snapshots | **specified only** | — |
| `serializeTranscript` / `deserializeTranscript` and size bounds | **specified only** (the reference uses `canonicalJson`) | — |
| `definePermutationGame` validating factory | **specified only** (the reference freezes literals in `model.mjs`) | — |

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
