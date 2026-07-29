/**
 * The headline fairness property, under test.
 *
 * README and docs/MATH.md §11 both lean hard on this sentence: *"a silent change
 * to a bet rule invalidates the round it would have re-settled."* That claim is
 * only worth anything if something notices when it stops being true, and until
 * now nothing did — the only fingerprint assertion in the suite compared the
 * production fingerprint to itself.
 *
 * Every test here drives a TAMPERED configuration through the PRODUCTION code
 * path — `digestCatalogue(variantId, families)` and `fingerprintFields(variantId,
 * overrides)` — rather than reimplementing the digest locally. A local
 * reimplementation would pass even if `adapterFingerprint` ignored behaviour
 * entirely, which is precisely the failure being guarded against.
 */

import { describe, expect, it } from 'vitest';

import { encodeFields, sha256Hex } from '../tools/lib/canonical.mjs';
import { BET_FAMILIES } from '../tools/lib/bets.mjs';
import {
  adapterFingerprint,
  catalogueDigest,
  claimSignature,
  digestCatalogue,
  fingerprintFields,
} from '../tools/lib/derive.mjs';
import { enumerateVariant } from '../tools/lib/analysis.mjs';
import { LIMITS, STAKE_QUANTUM, TARGET_RTP, VARIANT_IDS, getVariant } from '../tools/lib/model.mjs';
import { rational } from '../tools/lib/rational.mjs';

const fingerprintWith = (variantId, overrides) => sha256Hex(encodeFields(fingerprintFields(variantId, overrides)));

/** Replace one family in the shipped catalogue, leaving the rest untouched. */
const withFamily = (code, patch) =>
  BET_FAMILIES.map((family) => (family.code === code ? Object.freeze({ ...family, ...patch }) : family));

describe.each(VARIANT_IDS)('behavioural catalogue digest — %s', (variantId) => {
  const { n } = getVariant(variantId);
  const shipped = catalogueDigest(variantId);

  it('the shipped digest is reproducible through the uncached path', () => {
    expect(digestCatalogue(variantId)).toBe(shipped);
    expect(digestCatalogue(variantId, BET_FAMILIES)).toBe(shipped);
  });

  it('reversing a predicate moves the digest, though nothing declarative changed', () => {
    // STACK a>b wins when b is immediately ABOVE a. Reverse it: same code, same
    // tier, same labels, same params, same instance count, same win COUNT — and
    // a completely different set of winning outcomes.
    const reversed = withFamily('stack', {
      resolve: (i, { pos }) => pos[i.params.a] === pos[i.params.b] + 1,
    });
    const tampered = digestCatalogue(variantId, reversed);
    expect(tampered).not.toBe(shipped);
    expect(fingerprintWith(variantId, { catalogueDigest: tampered })).not.toBe(adapterFingerprint(variantId));
  });

  it('renaming a parameter key moves the digest, though the win sets are identical', () => {
    // `first {c}` -> `first {colour}`. Identical labels, identical behaviour on
    // every outcome — but an open ticket's params would no longer match, so the
    // digest MUST move. This is the case a win-set-only digest would miss.
    const renamed = withFamily('first', {
      instances: (size) =>
        Array.from({ length: size }, (_, colour) =>
          Object.freeze({ code: 'first', params: Object.freeze({ colour }), label: `f${colour}` }),
        ),
      resolve: (i, { pos }) => pos[i.params.colour] === 0,
    });
    const tampered = digestCatalogue(variantId, renamed);
    expect(tampered).not.toBe(shipped);
    expect(fingerprintWith(variantId, { catalogueDigest: tampered })).not.toBe(adapterFingerprint(variantId));
  });

  it('dropping a whole family moves the digest', () => {
    const fewer = BET_FAMILIES.filter((family) => family.code !== 'podium');
    expect(digestCatalogue(variantId, fewer)).not.toBe(shipped);
  });

  it('re-ordering families moves the digest — instance order is part of the contract', () => {
    const swapped = [...BET_FAMILIES].reverse();
    expect(digestCatalogue(variantId, swapped)).not.toBe(shipped);
  });

  it('the two variants have different behaviour digests', () => {
    const other = VARIANT_IDS.find((id) => id !== variantId);
    expect(catalogueDigest(other)).not.toBe(shipped);
  });

  it('the enumerator and the settlement path compute the same win-set signature', () => {
    // `analysis.claimAliases` groups instances by a digest built inside
    // enumerateVariant; settlement dedupes lines by `claimSignature`. If those
    // two ever diverged, the alias report published to the ticket builder would
    // describe a different notion of "same bet" from the one that rejects a
    // duplicate line. Same layout, same bytes, asserted.
    const analysis = enumerateVariant(variantId);
    const group = analysis.claimAliases[0];
    expect(group).toBeDefined();
    for (const spelling of group.spellings) {
      expect(claimSignature(variantId, spelling.code, { params: spelling.params })).toBe(group.signature);
    }
    // And a claim that is NOT in the group has a different signature.
    expect(claimSignature(variantId, 'before', { params: { a: 0, b: 1 } })).not.toBe(group.signature);
    expect(n).toBeGreaterThan(2);
  });

  it('is the win bitmap alone, so the pair docs/ENGINE.md names as one claim aliases', () => {
    // docs/ENGINE.md §4 said the signature digested "the outcomes it wins on,
    // plus its canonical parameter rendering" until docs/adr/0001. Those two
    // renderings are `c=0` and `c=0,k=0`, so including them would separate the
    // exact pair `requireDistinctLines` names as one claim — and the per-line
    // stake ceiling would be defeated by spelling the best line two ways.
    //
    // The reference has always hashed the bitmap alone; the prose was wrong.
    // This asserts the behaviour so the next drift is a build failure rather
    // than something a porter reads and implements.
    expect(claimSignature(variantId, 'first', { params: { c: 0 } })).toBe(
      claimSignature(variantId, 'slot', { params: { c: 0, k: 0 } }),
    );
    expect(claimSignature(variantId, 'last', { params: { c: 0 } })).toBe(
      claimSignature(variantId, 'slot', { params: { c: 0, k: n - 1 } }),
    );
    // Two claims with the SAME parameter rendering and different win sets stay
    // distinct, so the bitmap is doing the work rather than the rendering.
    expect(claimSignature(variantId, 'first', { params: { c: 0 } })).not.toBe(
      claimSignature(variantId, 'last', { params: { c: 0 } }),
    );
  });
});

describe.each(VARIANT_IDS)('adapter fingerprint binds every priced field — %s', (variantId) => {
  const shipped = adapterFingerprint(variantId);
  const variant = getVariant(variantId);

  it('rebuilding it from the production field list reproduces it exactly', () => {
    expect(fingerprintWith(variantId, {})).toBe(shipped);
  });

  it('a decoy catalogue digest moves it — the binding is live, not decorative', () => {
    expect(fingerprintWith(variantId, { catalogueDigest: '0'.repeat(64) })).not.toBe(shipped);
  });

  it('changing one multiplier moves it', () => {
    const multipliers = { ...variant.multipliers, before: rational(49n, 25n) };
    expect(fingerprintWith(variantId, { multipliers })).not.toBe(shipped);
  });

  it('changing the target RTP moves it', () => {
    expect(fingerprintWith(variantId, { targetRtp: rational(19n, 20n) })).not.toBe(shipped);
  });

  it('changing the stake quantum moves it', () => {
    expect(fingerprintWith(variantId, { stakeQuantum: STAKE_QUANTUM * 2n })).not.toBe(shipped);
  });

  it.each([
    ['maxWinMultiple', { maxWinMultiple: 4000n }],
    ['maxLinesPerTicket', { maxLinesPerTicket: 24 }],
    ['minLineStakeChips', { minLineStakeChips: 50n }],
    ['maxLineStakeChips', { maxLineStakeChips: 10000n }],
    ['maxTicketStakeChips', { maxTicketStakeChips: 40000n }],
    ['maxClientSeedBytes', { maxClientSeedBytes: 128 }],
    ['maxRoundIdBytes', { maxRoundIdBytes: 256 }],
    ['maxLabelBytes', { maxLabelBytes: 256 }],
    ['requireDistinctLines', { requireDistinctLines: false }],
  ])('changing the published limit %s moves it', (_label, patch) => {
    expect(fingerprintWith(variantId, { limits: { ...LIMITS, ...patch } })).not.toBe(shipped);
  });

  it('leaves the target RTP where the document says it is', () => {
    expect(TARGET_RTP).toEqual(rational(24n, 25n));
  });
});
