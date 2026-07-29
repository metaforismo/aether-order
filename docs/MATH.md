# AETHER ORDER — mathematical model

Every number in this document is exact. Probabilities, multipliers, expected
values, RTP and variance are reduced fractions of BigInts; no IEEE-754 value
appears on any probability or money path. Decimal renderings are shown only
where they terminate exactly, and approximations are labelled as such.

The document is machine-checked. `tools/enumerate.mjs` enumerates the complete
outcome space and re-derives every figure below; `tests/paytable.test.mjs`
parses the paytable tables out of *this file* and fails if a single cell drifts
from the enumeration. If a table here disagrees with the code, CI is red.

```sh
node tools/enumerate.mjs                        # the proof, both variants
node tools/enumerate.mjs --monte-carlo=200000   # optional sanity cross-check
npm test                                        # asserts this document
```

---

## 1. Notation

| Symbol | Meaning |
| --- | --- |
| `n` | number of spheres: 5 (CLASSIC) or 7 (SEVEN) |
| `S_n` | the symmetric group on `n` elements; the outcome space |
| `N = n!` | size of the outcome space: 120 or 5040 |
| `Π` | the round's permutation, a uniform random element of `S_n` |
| `Π(k)` | the colour that settles into slot `k`, for `k = 1..n` |
| `pos(c)` | the slot colour `c` settles into; the inverse of `Π` |
| `ρ` | target return to player, `24/25` |
| `m_b` | the published multiplier of bet `b` |
| `p_b` | the exact win probability of bet `b` |
| `S` | total stake of a ticket, in chips |

Slot 1 is the first sphere to settle and sits at the bottom of the tube; slot
`n` is the last to settle and sits at the top. A *bet type* (or family) is a
rule; an *instance* is that rule with the player's parameters filled in.

---

## 2. State space

A round produces one permutation of the `n` coloured spheres. The outcome space
is exactly `S_n`, uniform:

- CLASSIC: `|S_5| = 120`, each permutation with probability `1/120`.
- SEVEN: `|S_7| = 5040`, each permutation with probability `1/5040`.

There is no other random variable in the game. The agitation, the bubble field,
the settle cadence and the audio are all presentational functions of the
permutation and of wall-clock time. Nothing about them enters the outcome.

### 2.1 Uniformity, proved in two parts

**Lemma A (the shuffle is a bijection).** The shipped shuffle is descending
Fisher–Yates: for `t = 0 .. n-2`, draw `j_t` uniformly from `[0, n-t)` and swap
index `n-1-t` with index `j_t`. The number of draw vectors is
`n · (n-1) · … · 2 = n!`, and the map from draw vectors to permutations is a
bijection. `tools/enumerate.mjs` proves this by enumerating **all** `n!` draw
vectors and checking that every permutation is produced **exactly once** — for
both `n = 5` and `n = 7`. This is an exhaustive proof, not a statistical test.

Consequently, if the draws are independent and uniform on their ranges, `Π` is
exactly uniform on `S_n`.

**Lemma B (the sampler is unbiased).** Each draw takes a 256-bit value `v` from
`HMAC-SHA256(serverSeed, canonical(context, label, counter, rejection, M))` and
rejects it unless `v < L` where `L = 2^256 - (2^256 mod M)`. `L` is divisible by
`M`, so every residue class owns exactly `L / M` accepted values: the accepted
distribution is exactly uniform on `[0, M)` with no modulo bias, for every `M`.
The argument does not depend on the domain size, so `tools/enumerate.mjs`
verifies it exhaustively on a scaled-down `2^10` domain for every modulus the
shuffle actually uses (`M = 2 .. n`), and prints the exact relative bias that
naive truncation would have introduced instead (up to `1/146 ≈ 0.685%` for
`M = 7` at that scale — small, but a real, exploitable, permanent skew).

**Assumption (stated, not proved).** Lemma B gives uniformity *given* that the
256-bit HMAC outputs are uniform and independent across `(label, counter,
rejection)` triples. That is the standard PRF assumption on HMAC-SHA256 keyed by
a uniformly drawn 32-byte server seed. It is a cryptographic assumption, not a
theorem, and this repository does not attempt to prove it. See §11.

---

## 3. The bet catalogue

Eleven bet types, in three volatility tiers. Every type is a claim about the
permutation, resolvable by inspection of the settled tube.

| Code | Name | Tier | Player picks | Wins when |
| --- | --- | --- | --- | --- |
| `before` | BEFORE | FLOW | two colours, in order | the first colour settles in a lower slot than the second |
| `early` | EARLY | FLOW | one colour | that colour is one of the first two to settle (slots 1–2) |
| `late` | LATE | FLOW | one colour | that colour is one of the last two to settle (slots `n-1`, `n`) |
| `link-any` | LINK · EITHER | FLOW | two colours | the two colours settle in adjacent slots, in either order |
| `first` | FIRST | FORM | one colour | that colour settles first (slot 1) |
| `last` | LAST | FORM | one colour | that colour settles last (slot `n`) |
| `slot` | SLOT | FORM | one colour and one slot | that colour settles in exactly that slot |
| `link` | LINK | FORM | two colours, in order | the second colour settles in the slot immediately above the first |
| `opening` | OPENING | ORDER | two colours, in order | those two are the first two to settle, in exactly that order |
| `podium` | PODIUM | ORDER | three colours, in order | those three are the first three to settle, in exactly that order |
| `full` | FULL ORDER | ORDER | the complete order | every sphere settles in exactly the chosen slot |

`first` and `last` are the same mathematical object as `slot` with `k = 1` and
`k = n`. They are separate codes because they are separate one-tap chips in the
client, and the paytable prices them identically — there is no hidden penalty
for using the convenience control.

### 3.1 Counting

For a permutation drawn uniformly from `S_n`:

| Code | Winning permutations per instance | Probability |
| --- | --- | --- |
| `before` | `n! / 2` | `1/2` |
| `early` | `2 · (n-1)!` | `2/n` |
| `late` | `2 · (n-1)!` | `2/n` |
| `link-any` | `2 · (n-1)!` | `2/n` |
| `first` | `(n-1)!` | `1/n` |
| `last` | `(n-1)!` | `1/n` |
| `slot` | `(n-1)!` | `1/n` |
| `link` | `(n-1)!` | `1/n` |
| `opening` | `(n-2)!` | `1 / (n(n-1))` |
| `podium` | `(n-3)!` | `1 / (n(n-1)(n-2))` |
| `full` | `1` | `1 / n!` |

`link-any` counts the two colours as a glued block: `(n-1)!` block orderings
times 2 internal orders. `link` fixes the internal order, halving it. `opening`
and `podium` pin the first two and first three slots respectively and leave the
rest free. These closed forms are *not* what the paytable is built from — the
enumerator counts every instance against every permutation and would fail if a
formula were wrong.

### 3.2 Family homogeneity

Every instance inside a family has the same win count. That is what makes a
single published multiplier per family honest: there is no "cheap" corner of a
bet type and no trap instance. The enumerator asserts homogeneity instance by
instance and throws if a family ever splits — `5,769` distinct instances checked
across the two variants (295 in CLASSIC, 5,474 in SEVEN), every one evaluated
against every outcome: `35,400` and `27,588,960` instance × outcome pairs.

### 3.3 Distinct instances are not distinct claims

Two instances that win on exactly the same set of permutations are the **same
bet spelled two ways**. `FIRST amber` and `SLOT amber @ slot 1` are one claim;
so are `LAST amber` and `SLOT amber @ slot n`. The enumerator digests every
instance's win/lose bitmap as it computes it and reports the collisions, so the
aliasing set is emitted rather than described:

| Variant | Instances | Distinct claims | Alias groups |
| --- | --- | --- | --- |
| CLASSIC | 295 | 285 | 10 (5 × `first ≡ slot @ 1`, 5 × `last ≡ slot @ 5`) |
| SEVEN | 5,474 | 5,460 | 14 (7 × `first ≡ slot @ 1`, 7 × `last ≡ slot @ 7`) |

This matters twice. The client needs it to merge two chips that mean the same
thing instead of silently rejecting a tap (`docs/DESIGN.md` §4), and settlement
needs it because the distinct-claim rule — the thing that makes the per-line
stake ceiling bite, and §8's maximum a maximum — compares behaviour, not labels.
The report is published in `docs/paytable.json` as `claimAliases` and is
conformance check 12 in `docs/ENGINE.md` §8.

---

## 4. Pricing

Every bet is priced at the same theoretical return:

```
m_b = ρ / p_b        with        ρ = 24/25 = 96.000%
```

so that

```
E[return per unit staked] = p_b · m_b = ρ        for every bet type b.
```

This is a design commitment, not an outcome: the multipliers are *declared* in
`tools/lib/model.mjs` and the enumerator independently proves `p_b · m_b = ρ`
for each of them. A change to a multiplier that broke the identity would fail CI
rather than quietly ship a mispriced chip.

### 4.1 CLASSIC — 5 spheres, 120 outcomes

<!-- paytable:classic:start -->
| Code | Tier | Instances | Wins | Probability | Multiplier | Decimal | RTP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `before` | FLOW | 20 | 60 | 1/2 | 48/25 | 1.92× | 24/25 |
| `early` | FLOW | 5 | 48 | 2/5 | 12/5 | 2.40× | 24/25 |
| `late` | FLOW | 5 | 48 | 2/5 | 12/5 | 2.40× | 24/25 |
| `link-any` | FLOW | 10 | 48 | 2/5 | 12/5 | 2.40× | 24/25 |
| `first` | FORM | 5 | 24 | 1/5 | 24/5 | 4.80× | 24/25 |
| `last` | FORM | 5 | 24 | 1/5 | 24/5 | 4.80× | 24/25 |
| `slot` | FORM | 25 | 24 | 1/5 | 24/5 | 4.80× | 24/25 |
| `link` | FORM | 20 | 24 | 1/5 | 24/5 | 4.80× | 24/25 |
| `opening` | ORDER | 20 | 6 | 1/20 | 96/5 | 19.20× | 24/25 |
| `podium` | ORDER | 60 | 2 | 1/60 | 288/5 | 57.60× | 24/25 |
| `full` | ORDER | 120 | 1 | 1/120 | 576/5 | 115.20× | 24/25 |
<!-- paytable:classic:end -->

### 4.2 SEVEN — 7 spheres, 5040 outcomes

<!-- paytable:seven:start -->
| Code | Tier | Instances | Wins | Probability | Multiplier | Decimal | RTP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `before` | FLOW | 42 | 2520 | 1/2 | 48/25 | 1.92× | 24/25 |
| `early` | FLOW | 7 | 1440 | 2/7 | 84/25 | 3.36× | 24/25 |
| `late` | FLOW | 7 | 1440 | 2/7 | 84/25 | 3.36× | 24/25 |
| `link-any` | FLOW | 21 | 1440 | 2/7 | 84/25 | 3.36× | 24/25 |
| `first` | FORM | 7 | 720 | 1/7 | 168/25 | 6.72× | 24/25 |
| `last` | FORM | 7 | 720 | 1/7 | 168/25 | 6.72× | 24/25 |
| `slot` | FORM | 49 | 720 | 1/7 | 168/25 | 6.72× | 24/25 |
| `link` | FORM | 42 | 720 | 1/7 | 168/25 | 6.72× | 24/25 |
| `opening` | ORDER | 42 | 120 | 1/42 | 1008/25 | 40.32× | 24/25 |
| `podium` | ORDER | 210 | 24 | 1/210 | 1008/5 | 201.60× | 24/25 |
| `full` | ORDER | 5040 | 1 | 1/5040 | 24192/5 | 4838.40× | 24/25 |
<!-- paytable:seven:end -->

Multipliers are quoted *total return*, not profit: a winning 1.00-credit BEFORE
line returns 1.92 credits, of which 0.92 is profit.

---

## 5. Target RTP: 96.000%, and why

`ρ = 24/25` exactly. House edge `1/25 = 4.000%` of turnover, flat.

**Why inside the 94–97% band at all.** Below 94% the product stops being
competitive against the online table and instant-game category and starts to
look extractive to an informed player; above 97% a 3% margin no longer covers
premium production, a liability reserve and platform revenue share for a title
whose entire commercial argument is that it does not claw margin back through
trap bets. 96% is the modal published figure for the category, so it is the
number players can calibrate against without doing arithmetic.

*(This is a margin argument, not a prize-size argument. The top multipliers here
are `115.20×` and `4,838.40×`; see §8.2 for why the format cannot honestly
advertise a bigger headline number and why we would rather have the smaller one.)*

**Why exactly 96% and not 95.5% or 96.3%.** Three concrete reasons:

1. **Exactness — and 24/25 is uniquely good here.** Pricing every bet at
   `ρ / p` makes the least common denominator of the multipliers the *required
   stake quantum*: a stake must clear every denominator for payouts to stay
   exact integers (§6). It also fixes how many decimals the paytable needs.
   Computed over the eleven distinct probabilities across both variants
   (`tools/enumerate.mjs` prints this table):

   | Candidate ρ | Stake quantum | Display decimals |
   | --- | --- | --- |
   | 94.000% = 47/50 | 100 chips (1.00 credits) | 2 |
   | 95.000% = 19/20 | 40 chips (0.40 credits) | 3 |
   | 95.500% = 191/200 | 400 chips (4.00 credits) | 4 |
   | **96.000% = 24/25** | **25 chips (0.25 credits)** | **2** |
   | 97.000% = 97/100 | 200 chips (2.00 credits) | 3 |

   (A reduced denominator `2^a · 5^b` terminates at `max(a, b)` places.)

   `24/25` gives the smallest stake step in the band by a factor of at least
   1.6 — 0.25 credits, an ordinary casino chip — while every multiplier
   terminates at two decimals (`1.92`, `2.40`, `3.36`, `4.80`, `6.72`, `19.20`,
   `40.32`, `57.60`, `115.20`, `201.60`, `4838.40`). Nothing needs rounding to display, and §6
   shows nothing needs rounding to *pay*. Only 94% matches it on decimals, and
   it would force a 1.00-credit minimum bet at the bottom of the band; 95.5%
   would force a 4.00-credit minimum and chips reading `2.3875×`.
2. **Legibility.** "96%, on every bet" is a single sentence a player can hold.
3. **Uniformity is a player-protection property.** Craps, Sic Bo and American
   roulette all pay a materially worse edge on their most attractive-looking
   bets — the classic trap. Here the 115.20× chip and the 1.92× chip carry the
   *identical* 4.00% edge. A player who chases the big multiplier is buying
   variance, not a worse deal. §7 quantifies exactly what they are buying.

**Comparators, for calibration** (published theoretical figures for the standard
rule sets, not measurements of this game): European roulette 97.30%, French
roulette with *la partage* 98.65%, American roulette 94.74%, Sic Bo small/big
97.22% with individual bets ranging down past 70%, typical online video slot
94–96.5%. AETHER ORDER's 96.000% sits inside that band with the distinguishing
property that it does not vary by bet.

---

## 6. Money representation and rounding

Stakes and credits are integer **chips**. One display credit is 100 chips.

| Parameter | Value |
| --- | --- |
| Stake quantum | 25 chips (0.25 credits) |
| Distinct claims per ticket | required — identity is the set of outcomes a line wins on, not how it is spelled |
| Minimum line stake | 25 chips (0.25 credits) |
| Maximum line stake | 5,000 chips (50.00 credits) |
| Maximum ticket stake | 20,000 chips (200.00 credits) |
| Maximum lines per ticket | 12 |
| Published stake ladder (credits) | 0.25, 0.50, 1.00, 2.50, 5.00, 10.00, 25.00, 50.00 |

**Theorem (zero rounding drift).** Every published multiplier has a denominator
dividing 25, and every legal stake is a multiple of 25 chips. Therefore
`stake × multiplier` is an exact integer number of chips for every legal line,
and the floor applied at the credit boundary is a no-op.

*Consequence.* The realised RTP equals the theoretical RTP with no truncation
deficit whatsoever. This is stronger than the usual "floors lose at most one
minor unit per payout" — there is nothing to lose. The enumerator verifies it
for every multiplier against every legal stake, and the settlement path
(`settleTicket`) throws `INEXACT_PAYOUT` rather than round, so a future
multiplier that broke the property would fail loudly instead of silently
shaving the player.

---

## 7. Volatility profile

For a single line, the return per unit staked is `m_b` with probability `p_b`
and `0` otherwise, so

```
Var = p_b · m_b² − ρ²  =  ρ² · (1/p_b − 1)
```

with `ρ² = 576/625`. Exact variances, and standard deviations as truncated
BigInt approximations:

**CLASSIC**

| Code | Tier | Probability | Variance (exact) | SD (approx) |
| --- | --- | --- | --- | --- |
| `before` | FLOW | 1/2 | 576/625 | 0.9600 |
| `early`, `late`, `link-any` | FLOW | 2/5 | 864/625 | 1.1757 |
| `first`, `last`, `slot`, `link` | FORM | 1/5 | 2304/625 | 1.9200 |
| `opening` | ORDER | 1/20 | 10944/625 | 4.1845 |
| `podium` | ORDER | 1/60 | 33984/625 | 7.3738 |
| `full` | ORDER | 1/120 | 68544/625 | 10.4723 |

**SEVEN**

| Code | Tier | Probability | Variance (exact) | SD (approx) |
| --- | --- | --- | --- | --- |
| `before` | FLOW | 1/2 | 576/625 | 0.9600 |
| `early`, `late`, `link-any` | FLOW | 2/7 | 288/125 | 1.5178 |
| `first`, `last`, `slot`, `link` | FORM | 1/7 | 3456/625 | 2.3515 |
| `opening` | ORDER | 1/42 | 23616/625 | 6.1469 |
| `podium` | ORDER | 1/210 | 120384/625 | 13.8785 |
| `full` | ORDER | 1/5040 | 2902464/625 | 68.1464 |

Tier labels are machine-checked to be monotone in variance: a chip in a higher
tier is never less volatile than one in a lower tier. The tiers therefore mean
what they say.

**Tier hit rates**, as exact fractions rather than a rounded range — a hit rate
rounded in the house's favour is exactly the kind of small dishonesty this
document exists to avoid:

| Tier | CLASSIC | SEVEN | Across both |
| --- | --- | --- | --- |
| FLOW | `2/5 … 1/2` = 40% … 50% | `2/7 … 1/2` ≈ 28.571% … 50% | ≥ `2/7` ≈ 28.571% |
| FORM | `1/5` = 20% | `1/7` ≈ 14.286% | `1/7 … 1/5` |
| ORDER | `1/120 … 1/20` ≈ 0.833% … 5% | `1/5040 … 1/42` ≈ 0.0198% … 2.381% | `1/5040 … 1/20` |

Expected rounds between hits on the two rarest chips, with the **median** beside
it — the honest figure for what a chip feels like, since the mean of a geometric
distribution is dragged upward by its own tail:

| Chip | CLASSIC | SEVEN |
| --- | --- | --- |
| PODIUM | mean 60 rounds, median 42 | mean 210 rounds, median 146 |
| FULL ORDER | mean 120 rounds, median 83 | mean 5,040 rounds, median 3,494 |

**These medians are exact, not rounded.** The median is defined as the smallest
`R` with `P(at least one hit in R rounds) ≥ 1/2`, which is the smallest `R`
satisfying

```
((N-1)/N)^R ≤ 1/2        ⟺        2 · (N-1)^R ≤ N^R
```

— one BigInt comparison per step, computed by `medianRoundsToFirstHit` in
`tools/lib/analysis.mjs` and published per bet in `docs/paytable.json`. The
earlier draft quoted `ln 2 / ln(N/(N-1))` under no consistent rounding rule:
three figures were rounded to nearest and one was not, and two of the four came
out *below* the true median, making a rare chip look less rare than it is. This
document's stated standard is that a hit rate rounded in the house's favour is
exactly the kind of small dishonesty it exists to avoid, so the approximation is
gone rather than repaired.

---

## 8. Maximum win and the cap

**Cap.** A round credits at most `5,000 × (total ticket stake)`.

**Theorem (the cap cannot bind).** A ticket's return per unit staked is

```
C(ω)/S = Σ_b (s_b / S) · m_b · 1[b wins under ω]
```

a convex combination of the line multipliers, hence bounded above by
`max_b m_b` for every allocation and every outcome. The supremum of `max_b m_b`
is `115.20×` in CLASSIC and `4,838.40×` in SEVEN, both strictly below the
`5,000×` cap. The cap is therefore inert: it never reduces a payout and never
silently degrades the advertised RTP.

**Rationale for keeping an inert cap.** It is a liability guard, not a pricing
lever. It bounds worst-case single-round exposure for the operator and for the
wallet integration under *any* future paytable edit or adapter bug. CI asserts
`sup multiplier < cap`; any change that would make the cap start biting fails
the build and forces an explicit decision instead of an invisible RTP cut.
Headroom today: `4,884.80×` (CLASSIC), `161.60×` (SEVEN).

**Largest credit a round can actually produce.** A ticket carries *distinct*
claims: repeating a line is rejected, and the client merges repeats by raising
that line's stake. Identity is **behavioural** — two lines are the same claim
exactly when they win on the same set of permutations, so `FIRST amber` and
`SLOT amber @ 1` are one claim and cannot both appear. Comparing labels instead
would hand the per-line ceiling straight back. That rule is what makes the per-line ceiling bite — without
it the whole 200.00 budget could be piled onto four copies of the same winning
FULL ORDER line, and the maximum would simply be
`maxTicketStake × max multiplier` (23,040.00 credits in CLASSIC, 967,680.00 in
SEVEN). With it, the maximum is found by taking the best *distinct* winning
instances, and is computed by settling that ticket through the production
settlement path:

| Variant | Best ticket | Stake | Credit | Ticket multiple |
| --- | --- | --- | --- | --- |
| CLASSIC | 4 lines (`full`, `podium`, `opening`, `slot`) at 50.00 each | 200.00 credits | 9,840.00 credits | 49.20× |
| SEVEN | 4 lines (`full`, `podium`, `opening`, `slot`) at 50.00 each | 200.00 credits | 254,352.00 credits | 1,271.76× |

**Why that is a maximum, in four steps rather than two.** The first two are the
easy ones and were the only two the earlier draft stated; the last two are what
make the argument close.

1. **Linearity and exchange.** The objective is linear in the stakes under a
   budget plus a per-line ceiling, and lines must be distinct, so
   greedy-by-multiplier is optimal *among the claims considered*: any other
   selection improves by exchanging a chosen line for an unchosen one with a
   larger multiplier.
2. **Nothing left to buy.** Every chosen line sits at the 50.00 per-line ceiling
   and the 200.00 budget is exactly spent, so no reallocation improves it
   either.
3. **Co-satisfiability.** Greedy over *all* distinct claims could select
   mutually exclusive lines — four FULL ORDER claims, say — and for such a set
   the maximum over outcomes is strictly lower than the sum, because no single
   permutation satisfies them all. The construction avoids this by fixing one
   outcome `ω` first and selecting only among the claims that win under it, so
   co-satisfiability holds *by construction*. `proveMaxRoundCredit` settles the
   resulting ticket through the production settlement path and the witness
   requires every line to have won; `tests/enumeration.test.mjs` feeds it four
   mutually exclusive FULL ORDER lines and requires it to refuse them.
4. **Fixing `ω` is without loss of generality.** The catalogue is symmetric
   under relabelling of the colours — every family's instance set is closed
   under relabelling and the alias structure (`first ≡ slot @ 1`,
   `last ≡ slot @ n`) is too — so the best ticket for any settled order is the
   relabelling of the best ticket for any other. Rather than assert that,
   `proveMaxIsOutcomeInvariant` recomputes the entire maximum — winning claims,
   behavioural dedup, greedy selection, production settlement — under other
   outcomes and requires an identical credit: **exhaustively over all 120
   outcomes in CLASSIC**, and over a fixed 24-outcome sample in SEVEN, where
   each outcome costs a sweep of all 5,474 instances.

The identity permutation is the `ω` the code fixes, for no better reason than
that it is the easiest to read in a failure message.

### 8.1 The figure the player sees before committing

The operator-facing maximum above is rigorous. The player-facing one has to be
too, and it is a different quantity.

The ticket strip shows one headline number while a ticket is being built. The
obvious implementation — sum every line's return-if-hit — is **not a maximum**.
It is an upper bound that is attained only if some single permutation satisfies
every line at once, and mutually exclusive lines are precisely what a hedged
ticket is made of. §9.3 sells perfect hedges as the sharpest proof that there is
no edge here; a headline figure that overstates exactly those tickets would be
advertising an outcome the game cannot produce.

The published figure is therefore

```
bestOutcome(T) = max over ω in S_n of C(ω, T)
```

computed by settling the ticket against all `n!` permutations. That is at most
`5,040 × 12` predicate evaluations, so it is recomputed on the device on every
ticket edit. It is labelled **"best possible outcome"** and never "maximum
return if every line hits", because in general no such outcome exists.

How far apart the two get, from `tools/enumerate.mjs` §11:

| Ticket | Sum of every line | True best outcome | Overstatement |
| --- | --- | --- | --- |
| CLASSIC · 4 × FULL ORDER at 50.00 | 23,040.00 | 5,760.00 | 4× |
| CLASSIC · 3 × FIRST, different colours, at 1.00 | 14.40 | 4.80 | 3× |
| SEVEN · 4 × FULL ORDER at 50.00 | 967,680.00 | 241,920.00 | 4× |
| SEVEN · 3 × FIRST, different colours, at 1.00 | 20.16 | 6.72 | 3× |
| Either · FULL ORDER + OPENING + SLOT, compatible | equal | equal | none |

`tools/lib/presentation.mjs` computes both and returns the naive sum only so the
test suite can assert they differ; the client renders `bestOutcomeChips` and has
no access to the other number.

### 8.2 On the size of the top prize

The largest multiplier a permutation draw can offer is `ρ · n!`, because the
rarest claim expressible about a permutation is the permutation itself. That
gives `115.20×` at `n = 5` and `4,838.40×` at `n = 7`. Both are modest next to
the six- and seven-figure nominal prizes that lottery-style draws advertise, and
this document will not dress them up.

Raising the ceiling means raising `n`. `n = 9` would put FULL ORDER at
`348,364.80×` — a genuinely large number — and it is rejected, deliberately:
verifying it the way this repository verifies everything else would mean
evaluating 362,880 FULL ORDER instances against 362,880 outcomes, about `1.3 ×
10^11` predicate evaluations for the catalogue digest alone. That is not
enumerable in CI, so a NINE variant could only ever be *sampled*. A headline
number that cannot be exhaustively proved is worth less to this product than a
smaller one that can, and `ENGINE_LIMITS.maxExhaustiveElements = 8` encodes that
choice rather than leaving it to judgement.

So the honest positioning is: **`4,838.40×` is the largest prize we can prove**,
and every chip beneath it carries the identical 4.000% edge. `docs/DESIGN.md`
§14 makes the competitive argument that follows from that constraint.

---

## 9. Strategy analysis: no decision policy beats 96%

### 9.1 The complete decision set

AETHER ORDER has exactly five player decisions. Four are pre-commit; the fifth
is presentational and provably outcome-free.

| # | Decision | Timing | Effect on the distribution |
| --- | --- | --- | --- |
| D0 | Client seed (optional string) | before commit | changes *which* permutation, never its distribution |
| D1 | Variant (CLASSIC / SEVEN) | before commit | changes `n`, the outcome space and the variance; not the RTP |
| D2 | Bet lines (which types, which parameters, up to 12) | before commit | changes the variance; not the RTP |
| D3 | Stake per line | before commit | scales EV and SD linearly, variance by the square; not the RTP |
| D4 | Commit | the moment of commitment | none; the permutation is already determined by the committed seed |
| — | SKIP / MUTE / REPLAY | after commit | none; not inputs to the derivation |
| — | Round pacing (cycle floor, rolling ceiling) | between rounds | none per round; it bounds `R`, the number of rounds, which is the only lever on expected loss at all (§10) |

After D4 there is **no decision of any kind**. There is no cash-out, no
double-up, no gamble ladder, no "stop the shake", no mid-fall pick, no side
bet, no insurance. This is deliberate: a post-commit control whose value depends
on partial information is exactly where fake agency and latency-sensitive money
decisions get introduced.

### 9.2 Single-round invariance

**Theorem 1.** For any ticket chosen before the server seed is revealed, with
lines `(b, s_b)` and total stake `S > 0`, the expected credit is exactly `ρS`.

*Proof.* By the paytable (verified exhaustively for every instance),
`E[m_b · 1[b wins]] = m_b p_b = ρ` for every line. By linearity of expectation —
which requires no independence, and so holds for arbitrarily correlated lines —
`E[Σ_b s_b m_b 1[b wins]] = Σ_b s_b ρ = ρS`. The cap is inert by §8 and the
floor is a no-op by §6, so the credited amount equals the gross payout. ∎

The enumerator does not rely on this argument: it recomputes the expectation the
brute-force way, summing the exact payout over all `n!` outcomes, for a suite of
structured tickets (perfect hedges, correlated stacks, barbells, 12-line
maximum tickets) plus 40 deterministically generated pseudo-random tickets per
variant. All 45 return exactly `24/25`.

### 9.3 No hedge, no arbitrage

**Theorem 2.** No ticket has a guaranteed return above `ρS`, and the best
possible guaranteed return is exactly `ρS`.

*Proof.* `min_ω C(ω) ≤ E[C] = ρS`. If `min_ω C(ω) = ρS` then, since `C ≥ min`
pointwise and `E[C] = ρS`, `C` is constant. So the only zero-risk tickets return
exactly `0.96 S`, and nothing returns more with certainty. ∎

Concretely, the enumerator exhibits the constant tickets:

- 5 lines of FIRST, one per colour, 0.25 each: stake 1.25 credits, **certain**
  return 1.20 credits. Exactly `24/25`, zero variance.
- 7 lines of SLOT on one colour, one per slot: stake 1.75, certain return 1.68.
- BEFORE `A<B` plus BEFORE `B<A`: exactly one always wins, ratio `24/25`.
- All 60 PODIUM instances in CLASSIC: stake 15.00, certain return 14.40.
- All 120 FULL ORDER instances: stake 30.00, certain return 28.80. (The last two
  are above the 12-line ticket limit; shown as mathematical bounds, not
  purchasable tickets.)

Perfect hedging converts the game into a deterministic 4% fee. That is the
sharpest possible statement that there is no edge to find.

### 9.4 Sequential play, staking systems and stopping rules

**Theorem 3.** Let `(Π_t)` be the permutations of successive rounds. Each round
draws a fresh server seed independently of every earlier round, so `(Π_t)` is
i.i.d. uniform on `S_n` and `Π_{t+1}` is independent of `F_t`, the sigma-algebra
of everything the player can observe through the end of round `t` (including any
private randomisation of their own). Let the round-`t+1` ticket be
`F_t`-measurable — which it is, because the ticket is committed before that
round's seed exists in the player's view. Then for any stopping time `τ` with
`E[Σ_{u≤τ} S_u] < ∞`,

```
E[ Σ_{u≤τ} C_u ] = ρ · E[ Σ_{u≤τ} S_u ].
```

*Proof.* `E[C_{t+1} | F_t] = ρ S_{t+1}` by Theorem 1 applied conditionally.
Hence `M_t = Σ_{u≤t} (C_u − ρ S_u)` is a martingale with `M_0 = 0`, and optional
stopping under the stated integrability gives `E[M_τ] = 0`. ∎

*Corollary.* Every staking system — martingale doubling, d'Alembert, Fibonacci,
flat, Kelly-flavoured, stop-loss, stop-win, "only bet after three losses",
switching between CLASSIC and SEVEN, switching between tiers — returns exactly
96% of whatever total it turns over. Expected net result is
`−(1/25) × turnover`. The **only** lever a player has on expected loss is how
much they stake in total. That is why the client shows cumulative net position
and elapsed time rather than a streak counter (`docs/DESIGN.md` §10), and why
the number of rounds per hour is capped rather than optimised (§10.1).

### 9.5 Why information cannot help

The seed commitment
`SHA-256(domain ‖ serverSeed ‖ gameId ‖ variantId ‖ roundId ‖ nonce)` is
published, together with the context it binds, before the player commits. For a
computationally bounded player a commitment reveals nothing about the seed, so
the ticket is chosen independently of `Π` — and Theorem 1 holds *pointwise for
every fixed ticket* regardless, so only knowledge of `Π` itself could help.

The commitment covers the whole derivation input set except the client seed.
That matters in the other direction too: with the nonce and variant frozen by
the published hash, an operator that has already seen the ticket has no free
parameter left to search for a favourable permutation. Committing to the seed
alone would have left that door open.

The client seed (D0) deserves a specific statement, because "you can choose the
seed" invites a strategy fallacy. For each fixed client seed, the permutation is
a deterministic function of the server seed, which is uniform and unknown at
choice time. So every client seed yields the same uniform distribution over
`S_n`. Choosing a client seed protects the player (it stops an operator from
grinding seeds against a known ticket); it does not and cannot create an edge.

The presentational controls are excluded by construction: the transcript's input
set is exactly `(serverSeed, clientSeed, roundId, nonce, variant)`. SKIP, MUTE,
device, latency, screen size and animation state are not among them and cannot
be, since the transcript must re-derive byte-identically on a verifier that has
none of that context.

---

## 10. Session-level expectations

For a player staking a constant `S` per round over `R` rounds:

| Quantity | Exact value |
| --- | --- |
| Expected total returned | `(24/25) · R · S` |
| Expected net | `−(1/25) · R · S` |
| SD of net over `R` rounds (single line, per unit stake) | `sqrt(R) · SD_b` from §7 |

A concrete calibration for honest copy: 100 rounds at 1.00 credit on a single
FLOW `before` line has expected net `−4.00` credits with a standard deviation of
`9.60` credits; the same 100 rounds on a single `full` line in CLASSIC has the
same expected net `−4.00` and a standard deviation of `104.72` credits. Same
price, radically different ride. That framing — identical cost, purchased
variance — is the only accurate way to describe the tier choice, and the client
copy is required to use it.

### 10.1 Rounds per hour is the whole exposure argument

`R` is the only variable in `−(1/25) · R · S` that a game design controls. Speed
of play is therefore not a UX preference; it is the design's only lever on how
much a player can lose per hour, and it belongs in this document beside the RTP
rather than in a UX appendix.

The published policy (`PLAY_POLICY` in `tools/lib/model.mjs`,
`docs/DESIGN.md` §10) sets a **2,500 ms minimum round cycle** measured
COMMIT to COMMIT and enforced server-side, plus a hard ceiling of **900 rounds
per rolling 60 minutes**. The consequences are arithmetic:

| Quantity | Value |
| --- | --- |
| Arithmetic ceiling from the 2,500 ms cycle floor alone | 1,440 rounds/hour |
| Published rolling ceiling (binds first) | 900 rounds/hour |
| Turnover at the ceiling and the 200.00 maximum ticket | 180,000 credits/hour |
| Expected loss at that turnover | 7,200 credits/hour |
| Turnover at the ceiling and a 1.00 ticket | 900 credits/hour |
| Expected loss at that turnover | 36 credits/hour |

Without a floor, a SKIP-compressed round plus a one-tap REBET is a ~1.5 s cycle:
2,400 rounds/hour, 480,000 credits/hour of turnover and ~19,200 credits/hour of
expected loss — a 2.7× increase in maximum hourly exposure obtained purely by
making the animation shorter. That is the number the floor exists to delete.

---

## 11. What this document does not claim

This repository contains a specification, an exhaustive enumeration, a reference
derivation and deterministic fixtures. It is engineering evidence.

It is **not** an RNG certificate, a mathematical certification, a laboratory
report, a regulatory approval, a penetration-test attestation, or a certified
RTP for any deployed game. The uniformity result in §2 is conditional on the
stated PRF assumption on HMAC-SHA256 and on the operator drawing server seeds
from a properly seeded CSPRNG with reviewed custody — neither of which this
repository can establish.

**Commit-reveal proves the draw, not the bet.** Everything in §2 and §9.5 is
about the permutation. None of it says anything about what the player staked: a
transcript plus a revealed seed lets anyone confirm the order was honest and
lets nobody confirm who was on it, or for how much. That gap is closed by the
signed receipt in `docs/ENGINE.md` §6.1, which binds the seed commitment, the
round commitment, a digest of the ticket and a digest of the settlement into one
object an operator signs. It is a genuinely weaker guarantee than the
commitment — non-repudiation against a named signer, resting on key custody,
rather than verification from first principles — and it is stated as such
wherever it is claimed. A deployment requires its own frozen configuration,
independently reviewed seed custody, operator and wallet integration audit,
jurisdictional analysis, liability and reserve modelling, production load
evidence, and any laboratory or regulatory process the target market requires.

Changes to the paytable, the stake quantum, the cap, the limits, or the
derivation invalidate the figures above. They are bound into the adapter
fingerprint precisely so that such a change cannot pass unnoticed — and the
fingerprint includes a digest of the catalogue's *behaviour*, every instance's
win/lose bitmap over the whole outcome space, so reversing a bet rule without
touching its declaration still invalidates every commitment it would have
re-settled.
