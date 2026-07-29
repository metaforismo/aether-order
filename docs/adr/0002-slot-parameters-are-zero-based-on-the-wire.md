# ADR 0002 — the tube is numbered from one, the wire is indexed from zero

- **Status:** accepted
- **Date:** 2026-07-29
- **Scope:** `docs/MATH.md` §3 wording, and one card on S6. No behaviour, no
  digest, no fingerprint and no published figure changed.

## Context

A graybox review raised this, as a minor with a sharp point:

> The SLOT bet's `k` parameter is documented 1-based and implemented 0-based, and
> the signed receipt records the implementation. […] Verified end to end: clicking
> `[data-slot="2"]` yields the sentence 'AQUA settles in slot 3', and the
> resulting canonical params `c=3,k=2` are what enter `ticketDigest`,
> `settlementDigest` and therefore the signed receipt. A player auditing a
> receipt for the chip the UI calls 'slot 3' finds `k=2`.

Both halves of the mismatch are load-bearing and neither is a mistake on its own:

- **The tube is numbered from one, in the product.** `docs/MATH.md` §1 defines
  slot 1 as the first sphere to settle, `docs/DESIGN.md` §1 shows a tube with
  five numbered slots, and §5 S2 makes the slot picker "a picture of the tube".
  A picker that offers `slot 0` would be a specification violation and, worse, a
  screen nobody can read.
- **Every parameter on the wire is a zero-based index, in the protocol.**
  `docs/MATH.md` §3 already says so of colours: parameters are element indices
  into `variants[v].elements`, "the same index the transcript's `permutation`
  array carries". `docs/ENGINE.md` §4 and §7.6 spell the alias of `first {c:0}`
  as `slot {c:0,k:0}`, twice, in normative code blocks; the adapter enumerates
  the instance with label `0@0`; and `docs/paytable.json` publishes that label
  inside `claimAliases`.

What was genuinely missing is the sentence connecting the two. `docs/MATH.md` §3
said `first` and `last` are `slot` with "`k = 1`" and "`k = n`" — true of the
mathematical slot number, and not true of the parameter a receipt records — and
nothing anywhere told a player reading `k=2` that it meant the third slot.

## Decision

**Keep both conventions and publish the mapping.** The wire keeps zero-based
`k`; the tube keeps 1-based numbering; the client prints the wire form beside the
label on the one screen where the record is read (S6's *"what the signature
covers"* card), and `docs/MATH.md` §3 states the mapping `k = slot − 1` where it
already states the colour indexing.

### Rejected: renumber the wire to 1-based `k`

`k` is the adapter's parameter, not this repository's. Changing it changes
`permutationCatalogueDigest`, therefore the adapter fingerprint, therefore
`adapterVersion` — the exact chain `docs/MATH.md` §3 documents for FULL ORDER's
move off `rank` — and it invalidates the two published fingerprints in
`docs/paytable.json`, the frozen vectors in `tests/fixtures/transcripts.json`,
and the vendored engine package this game consumes rather than copies. It also
buys nothing at the boundary that matters: colours would still be zero-based, so
a receipt would still need the mapping explained, and it would now be explained
for four of five parameter kinds instead of five of five.

### Rejected: renumber the tube to 0-based

Contradicts `docs/DESIGN.md` §1 and §5 S2 and would put `SLOT 0` on a chip. Not
seriously considered; recorded because "make them agree" has two directions and
only one of them was refused for a reason worth writing down.

### Rejected: leave it as a code comment

The mismatch is only invisible until a dispute, which is the moment the receipt
exists for. `docs/ENGINE.md` §6.1 puts non-repudiation on the receipt's ticket
digest; a player who cannot map their chip onto the parameters that digest ate
cannot use it. The explanation has to be on the screen that shows the digest, and
the mapping has to be in the document that defines the parameters.

## Consequences

- `docs/MATH.md` §3 gains the mapping and §3.3's alias table gains the wire
  spelling in parentheses. No number, table cell or fenced block moved, so the
  machine-checked paytable tests are unaffected.
- `src/client/screens.ts` prints, per line, the chip name, the code, and the
  canonical parameters that entered `ticketDigest`, with one sentence saying that
  slots and colours are indexed from zero there and that `slot 3` is recorded as
  `k=2`. It is inside a closed `<details>`, because it is an audit trail and not
  something the ordinary result screen should carry.
- Nothing in the money path, the derivation, the digests or the paytable changed.
  `npm test` and `node tools/enumerate.mjs` are green.
