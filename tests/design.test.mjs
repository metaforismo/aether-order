/**
 * The design documents are tested artefacts too.
 *
 * Three classes of defect motivated this file, all of them found by review
 * rather than by CI:
 *
 *   - a normative TypeScript signature in docs/ENGINE.md that had drifted from
 *     the code it describes, sitting next to the security argument it
 *     contradicted;
 *   - an accessibility claim ("no token ships below 4.5:1") that was false for
 *     six tokens, quoted beside four ratios that were exactly right;
 *   - player-protection rules stated only in prose, where a client is free to
 *     reimplement them slightly differently.
 *
 * Everything here recomputes rather than trusts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as derive from '../tools/lib/derive.mjs';
import * as conform from '../tools/lib/conform.mjs';
import { CHROME_CSS } from '../tools/lib/framebudget.mjs';
import {
  AUTOPLAY_MODES,
  ELEMENTS,
  PLAY_POLICY,
  REALITY_CHECK_OVERRIDE_MODES,
  SHARED_CHAMBER_POLICY,
  effectiveRealityChecks,
} from '../tools/lib/model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(ROOT, name), 'utf8');
const DESIGN = read('docs/DESIGN.md');
const ENGINE = read('docs/ENGINE.md');
const MATH = read('docs/MATH.md');
const README = read('README.md');
// Round 5 removed the impellers; these two are read so the gate below can
// assert no build quietly draws one back in.
const CHAMBER_TS = read('src/client/chamber.ts');
const CHAMBER_CSS = read('src/client/styles.css');

describe('RTP wording distinguishes expectation from realised samples', () => {
  it('quantifies rounding shortfall and states the uniform-draw assumption', () => {
    expect(README).toContain('payout rounding contributes exactly `0` chips of shortfall');
    expect(README).toContain('expected credited/staked is');
    expect(README).toContain('exactly `24/25 = 96%`');
    expect(README).toContain("a finite sample's realised RTP can differ");
    expect(README).not.toContain('realised RTP equals theoretical RTP with zero drift');
    expect(MATH).toMatch(/rounding\s+contributes exactly `0` chips of shortfall/u);
    expect(MATH).toContain('expected credited/staked');
    expect(MATH).toContain("a finite sample's realised RTP can differ");
    expect(MATH).not.toContain('The realised RTP equals the theoretical RTP');
  });
});

/* ------------------------------------------------------------------ *
 * 1. Contrast — recomputed, not quoted.                                *
 * ------------------------------------------------------------------ */

const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every `--token | #hex` row in the environment palette table. */
function paletteTokens() {
  const tokens = new Map();
  for (const match of DESIGN.matchAll(/\|\s*`(--[a-z-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|/gu)) {
    tokens.set(match[1], match[2]);
  }
  return tokens;
}

/** Tokens that can carry text, an icon, or a state the player must perceive. */
const FOREGROUND = ['--ink', '--ink-dim', '--gold', '--gold-hot', '--win', '--specular', '--chrome', '--glass-edge', '--chrome-mid'];
/** AAA-for-normal-text tokens: the four the document actually quotes. */
const AAA = ['--ink', '--ink-dim', '--gold', '--win'];

describe('docs/DESIGN.md palette and contrast', () => {
  const tokens = paletteTokens();
  const VOID = tokens.get('--void');

  it('parses a complete palette with a background token', () => {
    expect(VOID).toBe('#05070C');
    expect(tokens.size).toBeGreaterThanOrEqual(14);
  });

  it('every contrast ratio the document quotes is arithmetically correct', () => {
    // Matches "`--ink` 17.22:1" and "`--abyss` is 1.07:1" alike.
    const claims = [...DESIGN.matchAll(/`(--[a-z-]+)`(?: is)? (\d+\.\d{2}):1/gu)];
    expect(claims.length).toBeGreaterThanOrEqual(9);
    for (const [, token, quoted] of claims) {
      const hex = tokens.get(token);
      expect(hex, `${token} is quoted with a ratio but absent from the palette table`).toBeDefined();
      expect(contrast(hex, VOID).toFixed(2), `${token}`).toBe(quoted);
    }
  });

  it('every foreground token clears 4.5:1, and the AAA four clear 7:1', () => {
    for (const token of FOREGROUND) {
      expect(contrast(tokens.get(token), VOID), `${token}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const token of AAA) {
      expect(contrast(tokens.get(token), VOID), `${token}`).toBeGreaterThanOrEqual(7);
    }
  });

  it('scopes the contrast rule to foreground tokens rather than claiming it of all', () => {
    // The old blanket claim was false for six surface tokens.
    expect(DESIGN).not.toContain('no token in the palette is allowed to ship below 4.5:1');
    expect(DESIGN).toContain('no foreground token may ship below');
    expect(DESIGN).toContain('Surface tokens are explicitly exempt');
  });

  it('every sphere colour is legible against the void and matches the shipped model', () => {
    for (const element of ELEMENTS) {
      expect(contrast(element.hex, VOID), element.id).toBeGreaterThanOrEqual(4.5);
      expect(DESIGN, `${element.name} ${element.hex} missing from the sphere table`).toContain(element.hex);
    }
  });

  it('quotes every close-pair ratio correctly, including the two inside CLASSIC', () => {
    const byId = Object.fromEntries(ELEMENTS.map((element) => [element.id, element.hex]));
    // Round 2 named INDIGO/VIOLET as the weakest pair in the set. It is THIRD,
    // and round 4's list omitted AMBER↔ROSE, which is effectively tied with it.
    // tests/framebudget.test.mjs asserts the published SET; this asserts the
    // arithmetic behind the five ratios that set contains.
    expect(contrast(byId.amber, byId.aqua).toFixed(2)).toBe('1.10');
    expect(contrast(byId.coral, byId.violet).toFixed(2)).toBe('1.14');
    expect(contrast(byId.violet, byId.indigo).toFixed(2)).toBe('1.24');
    expect(contrast(byId.amber, byId.rose).toFixed(2)).toBe('1.25');
    expect(contrast(byId.coral, byId.rose).toFixed(2)).toBe('1.34');
  });
});

/* ------------------------------------------------------------------ *
 * 1b. The stylesheet's palette IS the document's palette.              *
 *                                                                      *
 * The gate above recomputes every ratio the document quotes and every   *
 * sphere hex the model publishes — and it could not see a colour the    *
 * build had invented, because a token absent from the tables is a token *
 * nothing checks. That is exactly how round 1's art pass shipped three  *
 * new accent colours driving the tier tabs, the chip numerals and the   *
 * ticket rails while §6.1 still read "the whole world is neutral": the  *
 * shipped art direction contradicted its own closed spec and every test *
 * passed. This block closes it in both directions.                      *
 * ------------------------------------------------------------------ */

describe('src/client/styles.css declares exactly the palette DESIGN.md publishes', () => {
  const CSS = read('src/client/styles.css');
  /** The `:root` block, which is where every palette token is declared. */
  const ROOT_BLOCK = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('\n}', CSS.indexOf(':root {')));

  /**
   * A *palette* token: one whose value is a colour. Everything else in `:root`
   * — the type scale, the tap floor, the font stacks, the one gradient — is
   * geometry or typography and is gated elsewhere (`tests/client.test.mjs`).
   */
  const cssPalette = () => {
    const found = new Map();
    for (const match of ROOT_BLOCK.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6}|rgba?\([^)]*\))\s*;/gu)) {
      found.set(match[1], match[2].replace(/\s+/gu, '').toLowerCase());
    }
    return found;
  };

  /** Every `--token | value` row in any palette table in the document. */
  const docPalette = () => {
    const found = new Map();
    for (const match of DESIGN.matchAll(
      /\|\s*`(--[a-z-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6}|rgba?\([^)]*\))`\s*\|/gu,
    )) {
      found.set(match[1], match[2].replace(/\s+/gu, '').toLowerCase());
    }
    return found;
  };

  it('publishes every colour the stylesheet declares, with the same value', () => {
    const css = cssPalette();
    const doc = docPalette();
    expect(css.size).toBeGreaterThanOrEqual(20);
    for (const [token, value] of css) {
      expect(
        doc.has(token),
        `${token} is declared in styles.css and published in no DESIGN.md palette table`,
      ).toBe(true);
      expect(doc.get(token), `${token} differs between the stylesheet and §6.1`).toBe(value);
    }
  });

  it('ships every colour it publishes, so the tables cannot describe a dead build', () => {
    const css = cssPalette();
    for (const token of docPalette().keys()) {
      expect(css.has(token), `${token} is published in §6.1 and declared nowhere in styles.css`).toBe(
        true,
      );
    }
  });

  it('holds the UI accents to §11’s foreground floor', () => {
    const doc = docPalette();
    const VOID_HEX = doc.get('--void');
    for (const token of ['--tier-flow', '--tier-form', '--tier-order', '--pending', '--alert']) {
      expect(contrast(doc.get(token), VOID_HEX), token).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('borrows the tier accents from the spheres rather than inventing colour', () => {
    // §6.1 constraint 1: "Every tier hex is a hex this table already publishes
    // for a sphere". If a future pass picks a fourth hue, this fails.
    const doc = docPalette();
    const spheres = new Set(ELEMENTS.map((element) => element.hex.toLowerCase()));
    for (const token of ['--tier-flow', '--tier-form', '--tier-order']) {
      expect(spheres.has(doc.get(token)), `${token} is not a published sphere colour`).toBe(true);
    }
  });

  it('keeps the tier accents out of the chamber', () => {
    // §6.1 constraint 3. The instrument is `--void` through `--specular` plus
    // the spheres, and the accents belong to the chrome layer only.
    const CHAMBER = read('src/client/chamber.ts');
    for (const token of ['--tier-flow', '--tier-form', '--tier-order', '--alert', '--pending']) {
      expect(CHAMBER.includes(token), `${token} appears inside chamber.ts`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. The player-protection rules are code, and the docs quote the code. *
 * ------------------------------------------------------------------ */

describe('the celebration gate is stated as the comparison it is', () => {
  it('docs/DESIGN.md §10 quotes the exact expression', () => {
    expect(DESIGN).toContain('`creditedChips > totalStakeChips`');
  });

  it('names the single implementation so a client cannot reimplement it', () => {
    expect(DESIGN).toContain('roundPresentation');
    expect(DESIGN).toContain('tools/lib/presentation.mjs');
    expect(README).toContain('tools/lib/presentation.mjs');
  });

  it('states that the balance does not animate upward below the gate', () => {
    expect(DESIGN).toMatch(/balance \*\*writes to its new value without animating\s+upward\*\*/u);
  });

  it('is mirrored in the README rather than left in the spec', () => {
    expect(README).toContain('No losing round is ever presented as a win');
  });
});

describe('the speed-of-play policy is quoted consistently everywhere', () => {
  it('the published policy is the one the documents state', () => {
    expect(PLAY_POLICY.minRoundCycleMs).toBe(2500);
    expect(PLAY_POLICY.maxRoundsPerRollingHour).toBe(900);
    expect(PLAY_POLICY.skipShortensPresentationOnly).toBe(true);
  });

  it('the reality-check recurrence is representable, not merely promised in prose', () => {
    // docs/DESIGN.md §10 says "then every 60 minutes". An array of fixed checks
    // cannot express that, and a client reading only the array would stop at 60.
    expect(PLAY_POLICY.realityCheckMinutes).toEqual([30, 60]);
    expect(PLAY_POLICY.realityCheckRecurrenceMinutes).toBe(60);
    const published = JSON.parse(read('docs/paytable.json')).playPolicy;
    expect(published.realityCheckRecurrenceMinutes).toBe(PLAY_POLICY.realityCheckRecurrenceMinutes);
    expect(DESIGN).toContain('realityCheckRecurrenceMinutes');
    expect(ENGINE).toContain('realityCheckRecurrenceMinutes');
  });

  /**
   * The reality check used to be specified twice and incompatibly: S9 called it
   * a player control, §10 called it fixed operator policy, and the published
   * policy had nowhere to hold a player's value. Either reading breaks
   * `playPolicyDigest` — per-player it stops being a trace of the published
   * policy; fixed it misreports what the player received.
   *
   * The resolution is tighten-only, and it is a property here, not a promise.
   */
  describe('the reality check is one control with one reading', () => {
    it('every player option is at most the operator recurrence', () => {
      expect(PLAY_POLICY.realityCheckOverride).toBe('tighten-only');
      expect(REALITY_CHECK_OVERRIDE_MODES).toEqual(['tighten-only']);
      expect(PLAY_POLICY.playerRealityCheckIntervalOptions.length).toBeGreaterThan(0);
      for (const option of PLAY_POLICY.playerRealityCheckIntervalOptions) {
        expect(option, `${option} minutes`).toBeLessThanOrEqual(PLAY_POLICY.realityCheckRecurrenceMinutes);
        expect(option).toBeGreaterThan(0);
      }
    });

    it('any player choice yields a SUPERSET of the published schedule', () => {
      for (const horizon of [30, 60, 90, 120, 240, 480]) {
        const floor = effectiveRealityChecks(PLAY_POLICY, horizon, null);
        // The floor itself always contains the operator's fixed checks.
        for (const fixed of PLAY_POLICY.realityCheckMinutes) {
          if (fixed <= horizon) expect(floor).toContain(fixed);
        }
        for (const option of PLAY_POLICY.playerRealityCheckIntervalOptions) {
          const chosen = effectiveRealityChecks(PLAY_POLICY, horizon, option);
          for (const instant of floor) {
            expect(chosen, `horizon ${horizon}, option ${option}`).toContain(instant);
          }
          expect(chosen.length).toBeGreaterThanOrEqual(floor.length);
        }
      }
    });

    it('the schedule really does keep going past the last fixed check', () => {
      // The defect an array alone would reintroduce: stopping at 60 minutes.
      expect(effectiveRealityChecks(PLAY_POLICY, 240, null)).toEqual([30, 60, 120, 180, 240]);
    });

    it('an unpublished interval is refused rather than honoured', () => {
      expect(() => effectiveRealityChecks(PLAY_POLICY, 120, 90)).toThrow(/not a published option/u);
      expect(() => effectiveRealityChecks(PLAY_POLICY, 120, 0)).toThrow(/not a published option/u);
    });

    it('the published policy carries both fields and the documents agree', () => {
      const published = JSON.parse(read('docs/paytable.json')).playPolicy;
      expect(published.playerRealityCheckIntervalOptions).toEqual([...PLAY_POLICY.playerRealityCheckIntervalOptions]);
      expect(published.realityCheckOverride).toBe('tighten-only');
      expect(ENGINE).toContain('playerRealityCheckIntervalOptions');
      expect(ENGINE).toContain("readonly realityCheckOverride: 'tighten-only';");
      expect(DESIGN).toContain('playerRealityCheckIntervalOptions');
      expect(DESIGN).toContain('tighten-only');
      // S9 must present it as an addition, never as an interval the player owns.
      const s9 = DESIGN.slice(DESIGN.indexOf('### S8 — PAYTABLE'), DESIGN.indexOf('### S10 — SHARED CHAMBER'));
      expect(s9).toMatch(/CHECK IN\s+MORE OFTEN/u);
      expect(s9).toMatch(/cannot switch those off/u);
      expect(s9).toMatch(/tighten-only/u);
    });

    it('widening the option set past the recurrence moves the digest', () => {
      const base = derive.playPolicyDigest();
      expect(derive.playPolicyDigest({ ...PLAY_POLICY, playerRealityCheckIntervalOptions: [15, 30, 60, 240] })).not.toBe(
        base,
      );
      expect(derive.playPolicyDigest({ ...PLAY_POLICY, realityCheckOverride: 'any' })).not.toBe(base);
    });
  });

  it('docs/DESIGN.md quotes both numbers', () => {
    expect(DESIGN).toContain(`${PLAY_POLICY.minRoundCycleMs.toLocaleString('en-US')} ms`);
    expect(DESIGN).toContain(`${PLAY_POLICY.maxRoundsPerRollingHour} rounds per rolling 60 minutes`);
  });

  it('docs/MATH.md does the exposure arithmetic from the same numbers', () => {
    expect(MATH).toContain('2,500 ms minimum round cycle');
    expect(MATH).toContain('900 rounds');
    // 900 rounds x 200.00 credits x 4% edge.
    expect(MATH).toContain('180,000 credits/hour');
    expect(MATH).toContain('7,200 credits/hour');
  });

  it('the README states the floor and that SKIP cannot shorten it', () => {
    expect(README).toContain('2.5 seconds');
    expect(README).toContain('900 rounds per rolling hour');
    expect(README).toMatch(/does\s+not let you bet any faster/u);
  });

  it('docs/paytable.json publishes the policy for the client and the RGS', () => {
    const published = JSON.parse(read('docs/paytable.json')).playPolicy;
    expect(published.minRoundCycleMs).toBe(PLAY_POLICY.minRoundCycleMs);
    expect(published.maxRoundsPerRollingHour).toBe(PLAY_POLICY.maxRoundsPerRollingHour);
    expect(published.skipShortensPresentationOnly).toBe(true);
  });
});

/**
 * The lobby's betting window.
 *
 * §13.2 claims the shared chamber is "specified rather than gestured at" and
 * lists "the latency rule" among what is covered; §10 makes latency-sensitive
 * money decisions a release blocker. But the protocol table specified
 * `ticket.commit` with no rule for a commit that leaves the client inside the
 * window and arrives after it — no authoritative clock, no lead time, no grace,
 * and no error code in ENGINE §9. The dangerous case was already impossible
 * (roundId is bound into ticketDigest, so a late ticket cannot roll into the
 * next draw); what was missing is the part that costs a real player on 4G.
 */
describe('the shared-chamber betting window is a rule, not a bar emptying', () => {
  it('the four instants are ordered so the last acceptance precedes the settle', () => {
    const p = SHARED_CHAMBER_POLICY;
    expect(p.clockAuthority).toBe('server');
    // The grace must fit inside the lead, or a ticket could be accepted at or
    // after the settle — which is the one thing the lead time exists to prevent.
    expect(p.commitGraceMs).toBeGreaterThan(0);
    expect(p.commitGraceMs).toBeLessThan(p.commitLeadMs);
    // The client closes strictly earlier than the server does, so the CTA is
    // never live at a moment when a commit could not land.
    expect(p.clientSafetyMs).toBeGreaterThan(0);
    // And the whole window fits inside the shortest legal cadence.
    expect(p.commitLeadMs + p.clientSafetyMs).toBeLessThan(p.minCadenceMs);
    expect(p.reopensWithinDraw).toBe(false);
  });

  it('the cadence floor is the one §5 S10 argues for from the rolling ceiling', () => {
    // T >= 4 s, because below it the 900-round ceiling starts binding and a
    // player would spend part of every hour locked out of a room they watch.
    const drawsPerHour = 3_600_000 / SHARED_CHAMBER_POLICY.minCadenceMs;
    expect(drawsPerHour).toBe(PLAY_POLICY.maxRoundsPerRollingHour);
    expect(DESIGN).toContain('| 4 s | 900 | the rolling ceiling, exactly |');
  });

  it('a late commit has an error code of its own, and it means no bet', () => {
    const errors = ENGINE.slice(ENGINE.indexOf('## 9. Errors and limits'));
    expect(errors).toContain('`BETTING_CLOSED`');
    expect(errors).toMatch(/never queued into the next draw/u);
    // CYCLE_FLOOR is a different thing and must not be reused for this.
    expect(errors).toContain('`CYCLE_FLOOR`');
  });

  it('docs/DESIGN.md publishes every value and names the authoritative clock', () => {
    const s10 = DESIGN.slice(DESIGN.indexOf('### S10 — SHARED CHAMBER'), DESIGN.indexOf('## 6. Art direction'));
    expect(s10).toContain('lead 750 ms, safety 250 ms');
    expect(s10).toContain('250 ms');
    expect(s10).toMatch(/server's clock is authoritative/u);
    expect(s10).toContain('`BETTING_CLOSED`');
    expect(s10).toMatch(/closed window never reopens/u);
  });

  it('docs/paytable.json publishes it for the lobby implementer', () => {
    const published = JSON.parse(read('docs/paytable.json')).sharedChamber;
    expect(published.clockAuthority).toBe(SHARED_CHAMBER_POLICY.clockAuthority);
    expect(published.commitLeadMs).toBe(SHARED_CHAMBER_POLICY.commitLeadMs);
    expect(published.commitGraceMs).toBe(SHARED_CHAMBER_POLICY.commitGraceMs);
    expect(published.clientSafetyMs).toBe(SHARED_CHAMBER_POLICY.clientSafetyMs);
    expect(published.minCadenceMs).toBe(SHARED_CHAMBER_POLICY.minCadenceMs);
    expect(published.lateCommitErrorCode).toBe('BETTING_CLOSED');
  });
});

describe('autoplay is a published value, not a paragraph', () => {
  it('the policy says none, in the model and in the published paytable', () => {
    expect(PLAY_POLICY.autoplay).toBe('none');
    expect(AUTOPLAY_MODES).toEqual(['none']);
    expect(JSON.parse(read('docs/paytable.json')).playPolicy.autoplay).toBe('none');
  });

  it('the two documents agree that the feature does not exist', () => {
    // The exact regression: DESIGN.md permitted a count-bounded autoplay in the
    // sentence after banning autoplay through losses, while README.md stated an
    // outright ban. Two published documents, opposite answers, one paragraph.
    expect(DESIGN).toContain('**No autoplay. At all.**');
    expect(README).toContain('**No autoplay.**');
    expect(DESIGN).not.toMatch(/count-bounded, stops on any single win/u);
    expect(DESIGN).not.toMatch(/If autoplay ships at all/u);
  });

  it('states what a conforming autoplay would have required, rather than half of it', () => {
    // A stop-on-big-win rule without a loss limit is not a partial control; it
    // is the wrong control. If the ban is ever lifted, this is the checklist.
    expect(DESIGN).toMatch(/loss limit/u);
    expect(DESIGN).toMatch(/single-win\s+threshold/u);
    expect(ENGINE).toContain("readonly autoplay: 'none';");
  });
});

describe('the play policy leaves a per-round trace when it is loosened', () => {
  it('a snapshot carries the digest of the policy it ran under', () => {
    const digest = derive.playPolicyDigest();
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    const snapshot = derive.makeRoundSnapshot({
      phase: 'COMMITTED',
      seedContext: { variantId: 'classic', roundId: 'policy-trace', nonce: 0 },
      seedCommitment: derive.seedCommitment('11'.repeat(32), {
        variantId: 'classic',
        roundId: 'policy-trace',
        nonce: 0,
      }),
    });
    expect(snapshot.playPolicyDigest).toBe(digest);
  });

  it('loosening any published limit changes the digest', () => {
    const base = derive.playPolicyDigest();
    const looser = [
      { ...PLAY_POLICY, minRoundCycleMs: 1000 },
      { ...PLAY_POLICY, maxRoundsPerRollingHour: 3600 },
      { ...PLAY_POLICY, realityCheckMinutes: [30] },
      { ...PLAY_POLICY, realityCheckRecurrenceMinutes: 240 },
      { ...PLAY_POLICY, autoplay: 'bounded' },
    ];
    for (const policy of looser) expect(derive.playPolicyDigest(policy)).not.toBe(base);
  });

  it('a snapshot with no policy digest is rejected rather than defaulted', () => {
    const snapshot = derive.makeRoundSnapshot({
      phase: 'COMMITTED',
      seedContext: { variantId: 'classic', roundId: 'policy-trace', nonce: 0 },
      seedCommitment: derive.seedCommitment('11'.repeat(32), {
        variantId: 'classic',
        roundId: 'policy-trace',
        nonce: 0,
      }),
    });
    const stripped = JSON.parse(derive.serializeRoundSnapshot(snapshot));
    delete stripped.playPolicyDigest;
    expect(() => derive.deserializeRoundSnapshot(stripped)).toThrow(/play-policy digest/u);
  });

  it('docs/ENGINE.md justifies the direction it used to ignore', () => {
    const section = ENGINE.slice(ENGINE.indexOf('export interface PermutationPlayPolicy'));
    expect(section).toContain('LOOSENING');
    expect(section).toContain('a transcript can never');
    expect(section).toContain('playPolicyDigest');
  });
});

describe('the ticket-strip figure is described as a maximum over outcomes', () => {
  it('docs/DESIGN.md calls it the best possible outcome', () => {
    expect(DESIGN).toContain('best possible outcome');
    expect(DESIGN).toContain('best 139.20');
  });

  it('explicitly rejects the sum-of-every-line figure', () => {
    expect(DESIGN).toContain('not** the sum of every line');
    expect(MATH).toContain('The figure the player sees before committing');
  });
});

describe('the repudiation boundary is stated wherever fairness is claimed', () => {
  it.each([
    ['README.md', README],
    ['docs/ENGINE.md', ENGINE],
    ['docs/MATH.md', MATH],
  ])('%s says commit-reveal does not cover the bet', (_name, text) => {
    expect(text).toMatch(/proves? the \*{0,2}draw/iu);
    expect(text.toLowerCase()).toContain('receipt');
  });

  it('the README does not overstate the receipt as verification from first principles', () => {
    expect(README).toContain('needs the operator');
  });

  it('the verifier fails closed with no key, in the code and in the document', () => {
    // The reference and the spec must agree that "no key supplied" is not a
    // pass. Round 4 shipped ok:true here, which made the one fail-open path in
    // the module the one shaped like success.
    const ENGINE_TABLE = ENGINE.slice(ENGINE.indexOf('## 9. Errors and limits'));
    expect(ENGINE_TABLE).toContain('`SIGNATURE_UNCHECKED`');
    expect(ENGINE).toContain('bindingsVerified');
    expect(ENGINE).toMatch(/A verifier given no public key must return `ok: false`/u);
  });
});

/* ------------------------------------------------------------------ *
 * 2b. The art direction covers the app, not only the chamber.          *
 *                                                                      *
 * §6.1–§6.6 were exact about glass, light, motion and type and silent   *
 * about everything outside the chamber: no wordmark for a title         *
 * positioned as premium, no icon system beyond seven sphere glyphs, no  *
 * splash, no chamber geometry past the S1 wireframe, no impeller, and   *
 * no state treatments — including the at-the-ceiling lockout §10        *
 * REQUIRES the UI to present. A required screen with no design is a     *
 * requirement that does not ship.                                       *
 * ------------------------------------------------------------------ */

describe('the identity, icon and state specifications exist and stay closed', () => {
  const art = DESIGN.slice(DESIGN.indexOf('### 6.7 Identity'), DESIGN.indexOf('## 7. Rendering'));

  it('specifies a wordmark as a construction rather than an unbuilt asset', () => {
    expect(art).toContain('### 6.7 Identity: the wordmark');
    // The things a store listing, a splash and a share card each need.
    for (const rule of ['Minimum width', 'Clear space', 'Stacked lockup', 'Monogram', 'Never']) {
      expect(art, rule).toContain(rule);
    }
    // It must render from a font already in the payload budget, not from an
    // asset nobody has drawn.
    expect(art).toMatch(/Neue Haas Grotesk Display Pro 65\s+Medium/u);
    expect(DESIGN.slice(DESIGN.indexOf('### 7.3 Payload budget'))).toContain('Subset fonts');
  });

  it('the SEVEN lockup agrees with §12 that SEVEN is a toggle, not a product', () => {
    expect(art).toMatch(/It is a suffix, never a second\s+wordmark/u);
    expect(DESIGN).toContain('**toggle in the top rail, not a separate product**');
  });

  it('the sphere glyph set is the model’s, and every glyph is distinct', () => {
    const glyphs = ELEMENTS.map((element) => element.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    for (const glyph of glyphs) expect(art, glyph).toContain(`\`${glyph}\``);
    // One construction, so a glyph cannot read as lighter than its neighbour.
    expect(art).toMatch(/24 × 24 grid/u);
    expect(art).toMatch(/within 15% of every other/u);
  });

  it('the UI icon set is closed and carries no gold', () => {
    const iconRows = art
      .split('\n')
      .filter((line) => /^\| `[⌂◈←×⧉↻]/u.test(line));
    expect(iconRows).toHaveLength(6);
    expect(art).toMatch(/No icon is ever gold/u);
    // And gold is still exactly the four uses §6.1 enumerates: the new sections
    // must not have quietly added a fifth. The list shrank from six in round 3
    // of the art pass — the slot ring at lock and the tube's full-height rim
    // were both withdrawn, and §6.1 records why — and the gate moves with it so
    // that the count stays a closed set rather than a soft target.
    const goldList = DESIGN.slice(DESIGN.indexOf('appears in exactly four places'), DESIGN.indexOf('Nowhere else.'));
    expect(goldList.match(/^\d\. /gmu)).toHaveLength(4);
  });

  it('the chamber geometry is stated in the same numbers the budget uses', () => {
    const geometry = DESIGN.slice(DESIGN.indexOf('### 6.9 Chamber geometry'), DESIGN.indexOf('### 6.10 First run'));
    expect(geometry).toContain(`${CHROME_CSS.tube.width} wide`);
    expect(geometry).toContain(`| Slot pitch | ${CHROME_CSS.slotHeight.classic} | ${CHROME_CSS.slotHeight.seven} |`);
    /*
     * Round 5 removed the impellers, so this gate now asserts the *opposite*
     * invariant to the one it used to: nothing in the chamber rotates, and both
     * §6.4 and §6.9 have to keep saying so. It is deliberately stated in two
     * places and checked in both, because "no rotating element" is the kind of
     * rule a later art pass re-introduces by accident.
     */
    expect(geometry).toMatch(/There is no impeller/u);
    expect(DESIGN).toContain('**Nothing rotates on screen at\nall**');
    // And nothing in the client may draw one back.
    expect(CHAMBER_TS).not.toMatch(/impeller/iu);
    expect(CHAMBER_CSS).not.toMatch(/\.impeller/u);
  });

  it('specifies the states §10 requires, and none of them sells anything', () => {
    const states = DESIGN.slice(DESIGN.indexOf('### 6.10 First run'), DESIGN.indexOf('## 7. Rendering'));
    for (const state of ['Network lost, pre-commit', 'Network lost, post-commit', 'Wallet declined', 'At the rolling ceiling']) {
      expect(states, state).toContain(state);
    }
    // §10 bans a prompt triggered by a money event, so a declined wallet may
    // not become a deposit funnel, and the ceiling may not become a countdown.
    expect(states).toMatch(/Never \*"add funds"\*, never a deposit link/u);
    expect(states).toMatch(/absolute time, never a countdown/u);
    expect(states).toContain(`${PLAY_POLICY.maxRoundsPerRollingHour} rounds this hour`);
    // A player is never told their device is worse than someone else's.
    expect(states).toMatch(/never told their device is worse/u);
  });

  it('the splash is a load screen, and nothing rotates in it', () => {
    const states = DESIGN.slice(DESIGN.indexOf('### 6.10 First run'), DESIGN.indexOf('## 7. Rendering'));
    expect(states).toMatch(/skipped entirely rather than held for effect/u);
    expect(states).toMatch(/Loading, in-app\*\*, is never a spinner/u);
    expect(states).toMatch(/that includes throbbers/u);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The normative TypeScript surface matches the reference.           *
 * ------------------------------------------------------------------ */

/** Split a parameter list on top-level commas, ignoring object-type braces. */
function splitParams(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '{' || character === '[' || character === '(') depth += 1;
    if (character === '}' || character === ']' || character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part.length > 0);
}

const objectKeys = (text) => {
  const open = text.indexOf('{');
  if (open === -1) return null;
  const body = text.slice(open + 1, text.lastIndexOf('}'));
  return body
    .split(/[;,]/u)
    .map((entry) => entry.split(':')[0].trim().replace(/\?$/u, ''))
    .filter((entry) => /^[A-Za-z_$][\w$]*$/u.test(entry))
    .sort();
};

/** Parse `export function name(params): type;` out of the document's ts blocks. */
function documentedSignatures() {
  const signatures = new Map();
  for (const match of ENGINE.matchAll(/export function (\w+)\(([\s\S]*?)\)\s*:/gu)) {
    signatures.set(match[1], splitParams(match[2]));
  }
  return signatures;
}

/** Parse the reference implementation's real parameter list from its source. */
function referenceParams(fn) {
  const source = fn.toString();
  const open = source.indexOf('(');
  let depth = 0;
  let close = open;
  for (let i = open; i < source.length; i += 1) {
    if ('([{'.includes(source[i])) depth += 1;
    if (')]}'.includes(source[i])) {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  return splitParams(source.slice(open + 1, close)).map((part) => part.split('=')[0].trim());
}

/**
 * doc name -> [reference function, reference name].
 *
 * The reference is game-specific, so wherever the module surface takes a
 * `game` the reference takes `variantId` or nothing at all. That is the ONLY
 * permitted difference; every other parameter must match by name and position.
 */
const SURFACE = [
  ['seedCommitment', derive.seedCommitment],
  ['uniformBelow', derive.uniformBelow],
  ['derivePermutation', derive.derivePermutation],
  ['makePermutationTranscript', derive.makeTranscript],
  ['verifyPermutationTranscript', derive.verifyTranscript],
  ['openTicket', derive.openTicket],
  ['settleTicket', derive.settleTicket],
  ['ticketDigest', derive.ticketDigest],
  ['settlementDigest', derive.settlementDigest],
  ['idempotencyKeyFor', derive.idempotencyKeyFor],
  ['makeReceipt', derive.makeReceipt],
  ['signReceipt', derive.signReceipt],
  ['verifyReceipt', derive.verifyReceipt],
  ['serializeTranscript', derive.serializeTranscript],
  ['deserializeTranscript', derive.deserializeTranscript],
  ['serializeRoundSnapshot', derive.serializeRoundSnapshot],
  ['deserializeRoundSnapshot', derive.deserializeRoundSnapshot],
  ['permutationPlayPolicyDigest', derive.playPolicyDigest],
  ['assertPermutationAdapterConforms', conform.assertAdapterConforms],
];

describe('docs/ENGINE.md declares the surface the reference actually implements', () => {
  const documented = documentedSignatures();

  it('declares every function the reference exposes on the module surface', () => {
    for (const [name] of SURFACE) {
      expect(documented.has(name), `docs/ENGINE.md does not declare ${name}`).toBe(true);
    }
  });

  it.each(SURFACE)('%s matches the reference signature parameter for parameter', (name, fn) => {
    const docParams = documented.get(name);
    const refParams = referenceParams(fn);

    let refIndex = 0;
    for (const declared of docParams) {
      const declaredName = declared.split(':')[0].trim().replace(/\?$/u, '');
      const refParam = refParams[refIndex];

      if (declaredName === 'game') {
        // The module carries the game definition; the reference either takes a
        // variantId in its place, or is bound to a variant and takes neither.
        if (refParam === 'variantId') refIndex += 1;
        continue;
      }

      expect(refParam, `${name}: doc declares "${declaredName}" and the reference has no parameter there`).toBeDefined();

      if (refParam.startsWith('{')) {
        // Destructured in the reference: compare the object's key sets, which
        // is a stronger check than comparing a positional name.
        expect(objectKeys(refParam), `${name}.${declaredName} keys`).toEqual(objectKeys(declared));
      } else {
        expect(refParam, `${name}: parameter ${refIndex + 1}`).toBe(declaredName);
      }
      refIndex += 1;
    }
    expect(refParams.slice(refIndex), `${name}: reference has undeclared trailing parameters`).toEqual([]);
  });

  it('the seed commitment binds the whole context, in the declaration as well as the prose', () => {
    // The exact regression this file exists for: `seedCommitment(seed, roundId)`
    // survived in the normative interface while the prose two sections away
    // argued that binding only the round id is the grindable construction.
    expect(documented.get('seedCommitment')).toEqual(['serverSeedHex: string', 'context: SeedContext']);
    expect(ENGINE).not.toContain('seedCommitment(serverSeedHex: string, roundId: string)');
  });
});

describe('docs/ENGINE.md §10 no longer promises unbuilt surfaces', () => {
  const map = ENGINE.slice(ENGINE.indexOf('## 10. Reference implementation map'), ENGINE.indexOf('## 11. Boundary'));

  it.each(['openTicket', 'Receipts', 'serializeTranscript', 'Round snapshots'])(
    '%s is marked implemented',
    (surface) => {
      const row = map.split('\n').find((line) => line.includes(surface));
      expect(row, `no status row for ${surface}`).toBeDefined();
      expect(row).toContain('implemented');
    },
  );

  it('every remaining "specified only" row carries a reason', () => {
    const rows = map.split('\n').filter((line) => line.includes('specified only'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(/—|\(/u);
  });
});
