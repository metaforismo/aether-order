# ADR 0001 — `permutationClaimSignature` is the win bitmap alone

- **Status:** accepted
- **Date:** 2026-07-29
- **Scope:** `docs/ENGINE.md` §4 only. No code, no fixture and no digest changed.

## Context

`docs/ENGINE.md` declares itself normative and is being ported into
`engine-permutation` as `src/modules/permutation/aether/`. The port reproduces
all eight frozen vectors in `tests/fixtures/transcripts.json` byte for byte.

While porting, one declaration in §4 was found to contradict both the reference
implementation and §4's own risk policy. The doc comment on
`permutationClaimSignature` read:

> The behavioural identity of one claim: a digest of the outcomes it wins on,
> **plus its canonical parameter rendering.** … Memoised per
> **(variant, code, label)**.

Both halves are wrong, and the first is wrong in a way that would break the
system if implemented as written.

**1. Adding the parameter rendering destroys the distinct-claim rule.**
`PermutationRiskPolicy.requireDistinctLines`, twenty lines above in the same
code block, says:

> two lines are the same claim exactly when they win on the same set of
> permutations. `first {c:0}` and `slot {c:0,k:0}` are one claim. Without this
> the per-line ceiling is meaningless — the budget could be piled onto copies of
> the single best line, spelled differently — and the maximum-credit figure in
> docs/MATH.md would be a lower bound rather than a maximum.

Those two instances render as `c=0` and `c=0,k=0`. A signature that digested the
rendering alongside the bitmap would give them different signatures, they would
both be admitted onto one ticket, and the ceiling `requireDistinctLines` exists
to protect would be defeated — by the very function that is supposed to enforce
it. The two sentences cannot both be satisfied.

**2. The memoisation key was misstated.** The reference keys on
`` `${variant.id}|${canonical.code}|${canonicalParams(canonicalInstance.params)}` ``
and carries a comment saying "never on the label, which is authored metadata".
Keying on the label would be a genuine defect: the label is adapter-authored and
does not determine the bitmap, so two instances sharing a label — a plausible
adapter bug — would silently share a signature.

`tools/lib/derive.mjs` has done the right thing since round 2: it builds the
win bitmap over all `n!` outcome views and returns `sha256Hex(bitmap)`, with
canonical parameters used only as the cache key. `docs/paytable.json`'s published
`claimAliases`, `tests/settlement.test.mjs` and the enumerator's aliasing report
all depend on that behaviour. **The prose drifted; the code did not.**

This is the second time a §4 declaration in this document has drifted from the
reference — `seedCommitment(serverSeedHex, roundId)` was the first, and it is why
`tests/design.test.mjs` machine-checks signatures. That test parses **signatures**
out of the fenced blocks and cannot see a doc comment, which is exactly the gap
this defect fell through.

## Decision

Correct the doc comment. The signature is the win bitmap and nothing else;
memoisation is per `(variant, code, canonical parameter rendering)`.

The corrected text also states **where canonical parameters are bound**, because
"and nothing else" invites the reasonable worry that renaming a parameter key
becomes invisible. It does not: `permutationCatalogueDigest` binds every
instance's canonical rendering, and `ticketDigest` and `settlementDigest` carry
it per line (§7.6). Renaming a key still moves the adapter fingerprint and still
breaks an open ticket's parameter matching. What canonical parameters must not do
is enter the identity a ticket is **deduplicated** by, because behavioural
identity is the whole point of that rule.

### Rejected: change the reference to match the prose

This was considered and is wrong in every dimension. It would break
`requireDistinctLines`, invalidate the published `claimAliases` in
`docs/paytable.json` and `docs/MATH.md` §3.3's alias analysis, make the
maximum-credit figure in `docs/MATH.md` §8 a lower bound rather than a maximum,
and reopen the per-line stake ceiling as an exploit. The prose was the mistake.

### Rejected: leave it and note the divergence in the port

The porting checklist in §10 tells an implementer to follow §7's layouts and run
the fixtures. A porter who followed §4's prose for `claimSignature` would still
pass every frozen vector — none of the eight tickets contains an aliased pair —
and would ship a ticket validator that admits duplicate claims. A normative
document that a conforming port can follow into a money bug is a defect in the
document.

## Consequences

- **No behaviour, code, fixture or digest changed.** `npm run verify`
  (`enumerate` + `vitest run`) is green on 704 tests, and
  `tests/fixtures/transcripts.json` is byte-unchanged.
- The engine-side port in `engine-permutation` implements the corrected
  behaviour — claim equality hashes the win bitmap — and its conformance check 12
  reproduces this repository's published `claimAliases`.
- `tests/design.test.mjs` machine-checks signatures but not the semantics the
  comments assert, which is the gap both drifts fell through. Rather than note
  that and move on, `tests/fingerprint.test.mjs` now asserts this ADR
  executably, per variant: `first {c:0}` aliases `slot {c:0,k:0}`, `last {c:0}`
  aliases `slot {c:0,k:n-1}`, and `first {c:0}` does **not** alias `last {c:0}`
  — the last of those being the case that fails if a future change made the
  signature depend on the parameter rendering instead of the bitmap, since those
  two share a rendering and differ in behaviour.
