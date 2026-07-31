/**
 * AETHER ORDER — the client.
 *
 * Screen flow is docs/DESIGN.md §5: S1 TABLE is the home screen and everything
 * needed to play sits in the thumb zone; S2 is the picker; S4 is the round with
 * the ticket strip pinned so lines resolve lock by lock; S5 reports the result
 * through the server's celebration gate and never through a comparison of its
 * own; S6 to S10 are sheets.
 *
 * The chamber is no longer placeholder art. It is the jewel instrument §6
 * describes, built from gradients, SVG and CSS with no downloaded asset of any
 * kind, and the sound is synthesised the same way; what is still a substitution
 * is the *renderer* rather than the look, and chamber.ts enumerates every
 * trade-off that lane makes against §7's WebGL2 one.
 *
 * The client computes no money. Stakes, payouts, the best-possible-outcome
 * figure and the win/lose verdict all arrive from the service, which gets them
 * from the engine.
 */

import './styles.css';
import { ApiFailure, api, type TicketLineInput } from './api.js';
import { haptics, sound, type WinVoicing } from './audio.js';
import { Chamber } from './chamber.js';
import { turbulence } from './choreo.js';
import { claimKey, claimSummary, elementName, type Params } from './claims.js';
import { UNIT, balanceDuringRound, credits, money, signedCredits } from './money.js';
import { openPicker, stakeLadder } from './picker.js';
import { draftRows, roundRows } from './rows.js';
import { mountOrbDefs, orbSvg } from './sphere.js';
import {
  openFairness,
  openHistory,
  openLimits,
  openPaytable,
  openRealityCheck,
  openTicketReview,
  openVariantSheet,
  statePanel,
} from './screens.js';
import type {
  Catalogue,
  LobbyState,
  RoundView,
  SessionState,
  TicketQuote,
  VariantInfo,
} from './types.js';
import {
  announce,
  closeAllSheets,
  delegate,
  esc,
  on,
  reducedMotion,
  sleep,
  toast,
} from './ui.js';

interface Line {
  code: string;
  params: Params;
  stakeChips: bigint;
}

interface Notice {
  message: string;
  detail: string;
  action: string;
  kind: 'edit' | 'limits' | 'dismiss';
}

const state = {
  catalogue: null as Catalogue | null,
  session: null as SessionState | null,
  tier: 'FORM' as 'FLOW' | 'FORM' | 'ORDER',
  lines: [] as Line[],
  quote: null as TicketQuote | null,
  round: null as RoundView | null,
  mode: 'build' as 'build' | 'round' | 'result',
  place: 'solo' as 'solo' | 'lobby',
  lobby: null as LobbyState | null,
  operatorKeyHex: null as string | null,
  lastStakeChips: 100n,
  verified: false,
  notice: null as Notice | null,
  skipRequested: false,
  /**
   * The order the player built the ticket in, as indices into the round's
   * canonical line list.
   *
   * `openTicket` sorts the lines into the engine's wire order (ENGINE.md §7.6),
   * so the record the player reads back on S4 and S5 would otherwise not be the
   * ticket they built. It is frozen once, at COMMIT, exactly as §5 S4 requires
   * of the pinned strip, and nothing reorders after that.
   */
  displayOrder: null as number[] | null,
  /**
   * The balance the rail shows while a round is playing, frozen for exactly the
   * same reason `displayOrder` is: the COMMIT response carries the fully settled
   * round, so anything rendered straight out of it is the result — printed before
   * the choreography whose job is to deliver it.
   *
   * It holds the post-debit figure (`money.ts`, `balanceDuringRound`) from COMMIT
   * until the close, and is cleared there. That is also what makes §10's balance
   * count-up reachable at all: the "before" value it interpolates from is now the
   * debited balance rather than the final one.
   */
  displayBalanceChips: null as bigint | null,
};

let chamber: Chamber;
let quoteTimer: number | undefined;
let floorTimer: number | undefined;
let lobbySource: EventSource | null = null;
let realityCheckShownAt = 0;
/** Set while a round is playing, so SKIP can compress the one on screen. */
let skipCurrentRound: (() => void) | null = null;

const app = (): HTMLElement => document.getElementById('app') as HTMLElement;
const variant = (): VariantInfo =>
  (state.catalogue as Catalogue).variants[(state.session as SessionState).variantId];

/* ------------------------------------------------------------------ boot -- */

async function boot(): Promise<void> {
  const [catalogue, created, key] = await Promise.all([
    api.catalogue(),
    api.createSession(),
    api.operatorKey().catch(() => null),
  ]);
  state.catalogue = catalogue;
  state.session = created.session;
  state.operatorKeyHex = key?.publicKeyHex ?? null;
  /*
   * Every variant's spheres, once, before anything draws one.
   *
   * The app renders spheres that do not belong to the variant in play — the
   * variant sheet shows both rows side by side, so CLASSIC draws INDIGO and ROSE
   * tokens — and a gradient that is not in the document paints nothing. Mounting
   * the union here is the whole fix (`sphere.ts`, `mountOrbDefs`); the set is
   * closed at seven, and this is the one place that knows all of them.
   */
  for (const info of Object.values(catalogue.variants)) mountOrbDefs(info.elements);

  app().innerHTML = `
    <header class="rail" data-rail></header>
    <div class="progress" data-progress-track><i data-progress></i></div>
    <div data-cadence></div>
    <main class="stage" id="stage">
      <div class="chamber-holder" id="chamber"></div>
      <!--
        The round's own caption, and it answers two of the rubric's four
        three-second questions inside the play area rather than at the foot of
        the screen.

        During the round the only figures on the frame were a 13 px stake and
        multiplier pinned to the extreme bottom edge, and the play area
        itself carried no number at all — so "what state is this?" was inferred
        from the spheres and "what is at stake?" was answered by squinting at the
        last 3% of the frame. Every reference states the round's state in words
        at the centre of the play area and keeps the stake on screen with its
        unit attached.

        It is deliberately QUIET. The rubric's in-round rule is that the brightest
        object is the thing the round is about, and here that is the settling
        column — so this is dim, small and tracked, and it must never compete
        with it. It changes only on a lock, which is a beat that already exists.

        It leaks nothing: the settled count is the number of spheres visibly in
        the tube, and the stake is what the player committed. Neither is a
        function of the outcome, and the caption is byte-identical on a round
        that will win and a round that will not.
      -->
      <div class="round-cap" data-round-cap hidden></div>
      <button class="skip" data-skip aria-label="Skip the animation">SKIP</button>
      <!--
        §9's mote fall lives here rather than inside the chamber, so it outlives a
        redraw: the shower is three seconds long and a variant switch or a rotation
        replaces the chamber's markup wholesale. Mode changes no longer redraw at
        all (chamber.ts), which is what deleted the original bug — the shower being
        wiped 220 ms into every celebration as the result deck mounted.
      -->
      <div class="motes" id="motes" aria-hidden="true"></div>
    </main>
    <section class="deck" id="deck"></section>`;

  chamber = new Chamber(
    document.getElementById('chamber') as HTMLElement,
    document.getElementById('motes'),
  );
  chamber.render(variant());

  /*
   * The sound layer arms itself on the first real touch and never before.
   *
   * Browsers refuse to start an `AudioContext` outside a user gesture, and that
   * refusal is the right default rather than an obstacle to work around: §8's
   * chamber bed is "present from IDLE, always", but a game that makes noise
   * before the player has touched the screen is a game they mute at the OS level
   * and never unmute. `once` because arming is idempotent and the listener has no
   * second job.
   */
  document.addEventListener('pointerdown', () => sound.arm(), { once: true });

  // Delegated, because the top rail is re-rendered: S10's rail carries `←` and
  // the room's name where S1's carries the menu, the balance and the variant.
  delegate(app(), '[data-menu]', 'click', () => openMenu());
  delegate(app(), '[data-variant]', 'click', () => {
    if (state.mode === 'round') return;
    openVariantSheet({
      catalogue: catalogue,
      current: (state.session as SessionState).variantId,
      onPick: (variantId) => void switchVariant(variantId),
    });
  });
  delegate(app(), '[data-fairness]', 'click', () => void openFairnessForLast());
  delegate(app(), '[data-back-solo]', 'click', () => void togglePlace());
  delegate(app(), '[data-skip]', 'click', () => {
    // Takes effect on the round being watched, and is remembered as a
    // preference for the next one (§2.2). It changes nothing about the outcome,
    // the settlement or the transcript.
    state.skipRequested = true;
    skipCurrentRound?.();
    void api.settings((state.session as SessionState).id, { skip: true });
  });
  // A resize event is not the only thing that changes the space the chamber
  // gets: OS or browser text scaling reflows the deck without one, and §11 asks
  // this layout to survive 200%. Observing the stage catches every cause — and
  // it is safe to run during a round now, because answering a smaller band is
  // three custom properties rather than a redraw.
  new ResizeObserver(() => fitChamber()).observe(document.getElementById('stage') as HTMLElement);

  await openRound();
  render();

  const splash = document.getElementById('splash');
  splash?.classList.add('splash--out');
  window.setTimeout(() => splash?.setAttribute('hidden', ''), 220);
  app().removeAttribute('hidden');
}

/* -------------------------------------------------------------- plumbing -- */

/**
 * The reality check is due until it is acknowledged, and more than one call
 * lands inside a single round (commit, then reveal, then the next open). It is
 * one dialog per due check, never a stack the player has to dismiss twice.
 */
function setSession(session: SessionState): void {
  state.session = session;
  if (!session.realityCheck.due) {
    realityCheckShownAt = 0;
    return;
  }
  const key = session.realityCheck.elapsedMinutes;
  if (realityCheckShownAt === key) return;
  realityCheckShownAt = key;
  showRealityCheck();
}

async function openRound(): Promise<void> {
  if (state.place === 'lobby') return;
  const opened = await api.openRound((state.session as SessionState).id);
  setSession(opened.session);
}

async function switchVariant(variantId: 'classic' | 'seven'): Promise<void> {
  const updated = await api.settings((state.session as SessionState).id, { variantId });
  setSession(updated.session);
  state.lines = [];
  state.quote = null;
  state.round = null;
  state.displayOrder = null;
  state.displayBalanceChips = null;
  state.mode = 'build';
  state.verified = false;
  chamber.render(variant());
  chamber.reset();
  await openRound();
  render();
}

function lineInputs(): TicketLineInput[] {
  return state.lines.map((line) => ({
    code: line.code,
    params: line.params,
    stake: line.stakeChips.toString(10),
  }));
}

function refreshQuote(): void {
  window.clearTimeout(quoteTimer);
  if (state.lines.length === 0) {
    state.quote = null;
    render();
    return;
  }
  quoteTimer = window.setTimeout(() => {
    void api
      .quote((state.session as SessionState).id, lineInputs())
      .then((result) => {
        state.quote = result.quote;
        render();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiFailure) toast(error.message);
      });
  }, 60);
}

function totalStake(): bigint {
  return state.lines.reduce((sum, line) => sum + line.stakeChips, 0n);
}

/** docs/DESIGN.md §4: merge, clamp, and say which — never a silent rejection. */
function addLine(code: string, params: Params, stakeChips: bigint): void {
  const info = variant();
  const maxLine = BigInt(info.limits.maxLineStakeChips);
  const maxTicket = BigInt(info.limits.maxTicketStakeChips);
  const minLine = BigInt(info.limits.minLineStakeChips);
  const key = claimKey(info, code, params);
  const index = state.lines.findIndex(
    (line) => claimKey(info, line.code, line.params) === key,
  );

  if (index >= 0) {
    const line = state.lines[index] as Line;
    const others = totalStake() - line.stakeChips;
    let next = line.stakeChips + stakeChips;
    const notes: string[] = [];
    if (line.code !== code) notes.push('same bet — stake combined');
    if (next > maxLine) {
      next = maxLine;
      notes.push(`this line is at the ${money(maxLine)} maximum`);
    }
    if (others + next > maxTicket) {
      next = maxTicket - others;
      notes.push(`ticket is at the ${money(maxTicket)} maximum`);
    }
    line.stakeChips = next;
    toast(notes.length > 0 ? notes.join(' · ') : `${money(next)} on this line`);
  } else {
    if (state.lines.length >= info.limits.maxLinesPerTicket) {
      toast(`${info.limits.maxLinesPerTicket} lines maximum`);
      return;
    }
    let stake = stakeChips;
    const others = totalStake();
    if (others + stake > maxTicket) stake = maxTicket - others;
    if (stake < minLine) {
      toast(`ticket is at the ${money(maxTicket)} maximum`);
      return;
    }
    if (stake !== stakeChips) toast(`ticket is at the ${money(maxTicket)} maximum`);
    state.lines.push({ code, params, stakeChips: stake });
  }
  state.lastStakeChips = stakeChips;
  refreshQuote();
}

/* ---------------------------------------------------------------- render -- */

const ICON_HOME =
  '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11 12 5l8 6v8H4z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
/** §6.8: a 14 px chevron plus a 6 px tail. Never a chevron alone. */
const ICON_BACK =
  '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 4 12l7 7M4 12h16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>';
const ICON_FAIRNESS =
  '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 9l3 3-3 3-3-3z" fill="currentColor"/></svg>';

/**
 * The top rail. §5 S1 carries the menu, the balance, the variant toggle and the
 * fairness chip; §5 S10 replaces the first three with `←  SHARED CHAMBER`, so
 * leaving the room is one tap from anywhere in it and the screen says which room
 * the player is in.
 */
function railMarkup(): string {
  const session = state.session as SessionState;
  const fairnessState = state.verified ? 'verified' : session.openRound ? 'committed' : 'idle';
  const fairness = `<button class="icon-btn fairness-chip" data-fairness aria-label="Fairness" data-state="${fairnessState}">${ICON_FAIRNESS}</button>`;
  if (state.place === 'lobby')
    return `
      <button class="icon-btn" data-back-solo aria-label="Back to solo play">${ICON_BACK}</button>
      <span class="rail__title">SHARED CHAMBER</span>
      <span class="badge">free play</span>
      ${fairness}`;
  /*
   * The frozen figure wins while a round is playing (§2's beat order: the wallet
   * is debited at COMMIT and credited at STAMP). Rendering `session.balanceChips`
   * here unconditionally is what printed the outcome before the reveal.
   */
  const shown = state.displayBalanceChips ?? BigInt(session.balanceChips);
  return `
    <button class="icon-btn" data-menu aria-label="Menu">${ICON_HOME}</button>
    <!--
      The unit sits in its own node, NOT inside the data-balance element.
      countBalanceUp writes textContent on that node sixty times a second, so a
      unit inside it would be re-written with every frame of the climb — and the
      figure is tabular precisely so that nothing moves while it counts. Outside
      it, the unit is a fixed anchor the digits grow toward.
    -->
    <span class="rail__balance"><span class="rail__figure"><b data-balance>${esc(
      credits(shown),
    )}</b><i class="rail__unit">${UNIT}</i></span><span>balance</span></span>
    <button class="variant-toggle" data-variant>${esc(variant().label)}</button>
    <span class="badge">free play</span>
    ${fairness}`;
}

/**
 * The balance, counted up — and only when the server said the round won.
 *
 * §10: "Below the gate the balance **writes to its new value without animating
 * upward**. A rising balance is a celebration whatever the copy says." So this
 * runs behind `presentation.balanceCountsUp`, which is `roundPresentation`'s
 * output and not a comparison of this client's, and every other path simply
 * re-renders the rail with the new figure.
 *
 * The interpolation is in chips — integers — so the figure never shows a value
 * the wallet could not hold, and the type is tabular (§6.5) so nothing jitters
 * as it climbs.
 */
function countBalanceUp(fromChips: bigint, toChips: bigint): void {
  const node = app().querySelector<HTMLElement>('[data-balance]');
  if (!node || toChips <= fromChips) return;
  const span = Number(toChips - fromChips);
  const started = performance.now();
  const duration = 620;
  node.dataset.counting = 'yes';
  // Set synchronously as well as in the frame loop: the rail was just rendered
  // with the final figure, and starting the climb one frame later would show the
  // number drop before it rose.
  node.textContent = credits(fromChips);
  const step = (): void => {
    const t = Math.min(1, (performance.now() - started) / duration);
    // Ease-out, so the number decelerates onto its final value rather than
    // stopping dead on it.
    const eased = 1 - (1 - t) ** 3;
    node.textContent = credits(fromChips + BigInt(Math.round(span * eased)));
    if (t < 1) {
      requestAnimationFrame(step);
      return;
    }
    node.textContent = credits(toChips);
    window.setTimeout(() => node.removeAttribute('data-counting'), 500);
  };
  requestAnimationFrame(step);
}

/**
 * Tell the chamber how much room the layout is giving it.
 *
 * Two numbers, and the difference between them is the whole reason a mode change
 * no longer snaps:
 *
 * - **The reference box** is the tallest band the stage can ever show — the space
 *   between the progress hairline and the bottom of the app, minus one pinned
 *   ticket row. It depends on the viewport and on nothing else, so it does not
 *   move when the deck changes size, and the chamber is drawn for it exactly once.
 * - **The visible band** is the stage's current height. It changes at every mode
 *   change, and the chamber answers it with three transforms (`Chamber#fit`).
 *
 * Round 1 had only the second number and redrew the instrument from it, which is
 * how the largest element on screen came to jump inside one frame, twice a round.
 */
function fitChamber(): void {
  const stage = document.getElementById('stage');
  if (!stage || !state.session) return;
  const visible = stage.clientHeight;
  if (visible <= 0) return;
  const bounds = app().getBoundingClientRect();
  const style = window.getComputedStyle(app());
  const floor = bounds.bottom - Number.parseFloat(style.paddingBottom || '0');
  // One 28 px row plus the deck's own padding is the smallest deck there is: the
  // round screen with a single-line ticket.
  const box = Math.round(floor - stage.getBoundingClientRect().top - 48);
  // Never redrawn mid-round: a re-layout during SETTLE would restart every
  // transition in flight. The band still adapts, because `fit` is transforms.
  if (box > 0 && Math.abs(box - chamber.box) > 2 && state.mode !== 'round')
    chamber.render(variant(), box);
  chamber.fit(visible);
}

function render(): void {
  const session = state.session;
  if (!session) return;
  app().dataset.mode = state.mode;
  app().dataset.place = state.place;
  /*
   * The bench catches the instrument's light, and it only catches it when there
   * is extra light to catch.
   *
   * The result deck is a third of the win frame and it was sitting at the same
   * luminance it sits at while the player is deciding, which is a third of the
   * frame telling the player nothing happened. A bench under an instrument that
   * has just ignited is lit by it; the lift is cool, because the light doing it
   * is the chamber's cool key and a warm overlay would cost the frame the
   * saturation §9 spends its whole budget building.
   *
   * It is gated on `presentation.celebrate` — the same single comparison the
   * chamber, the plaque and the chord are gated on (§10) — so a losing round and
   * a net-losing partial return are byte-identical to a plain result screen, and
   * nothing here can dress a loss as a win.
   */
  const celebrating = state.mode === 'result' && state.round?.presentation?.celebrate === true;
  app().dataset.won = celebrating ? 'yes' : 'no';
  /*
   * And the bench is on the same volume ladder the instrument is — one number,
   * `Chamber.volumeOf`, read off the server's own realised return multiple and
   * off nothing else. §9's three-step ladder was published and not measurable:
   * a 115.20x round and a 4.80x round differed by 2.3% of mean luminance because
   * every channel that carried the ladder was inside the chamber and the deck —
   * a third of the frame — held still. It moves now, in the same three steps.
   */
  app().style.setProperty(
    '--win-vol',
    String(celebrating ? Chamber.volumeOf(state.round?.presentation?.stampMultipleDecimal ?? '') : 2),
  );

  (app().querySelector('[data-rail]') as HTMLElement).innerHTML = railMarkup();

  const cadence = app().querySelector('[data-cadence]') as HTMLElement;
  cadence.innerHTML = state.place === 'lobby' ? cadenceMarkup() : '';

  const deck = document.getElementById('deck') as HTMLElement;
  deck.innerHTML =
    state.mode === 'round' ? roundDeck() : state.mode === 'result' ? resultDeck() : buildDeck();
  wireDeck(deck);
  /*
   * The cycle floor unlocks on the result screen too.
   *
   * §5 S5: "Neither is pre-focused, and both are disabled until the cycle floor
   * elapses (§2.2)" — and §2.2's whole point is that the wait *unlocks*, it never
   * expires. Round 1 started the ticker in build mode only, so after a SKIPped
   * round — which finishes in about 1.5 s against a 2,500 ms floor — `REBET` and
   * `NEW TICKET` were rendered disabled and nothing ever re-enabled them: the
   * player had to open a sheet to force a re-render. A control that never unlocks
   * is exactly the broken button §4 says a rejected tap reads as.
   */
  if (state.mode !== 'round') startFloorTicker();
  // Belt and braces: the caption is raised and stepped by the choreography, and
  // cleared here for every path that leaves the round without finishing it —
  // a failed COMMIT, a reconnect, REBET, NEW TICKET.
  if (state.mode !== 'round') setRoundCap(null);
  fitChamber();
}

/**
 * The pinned ticket strip.
 *
 * `live` renders every line undecided and lets the choreography change each one
 * at the lock that decided it; `final` is the record on S5, where the states are
 * already known. Won and lost lines carry identical weight — the difference is
 * colour and opacity, which is the information itself, and losing lines are
 * never swept away (§10).
 *
 * **The verdict is not in this markup during a round, and that is the point.**
 * The whole settlement arrives at COMMIT — it has to, because the choreography
 * is a function of the transcript — so it would be trivial for the strip to
 * print `returned 4.80` on a winning line from the first frame. It did, in
 * round 1, and that made §2.1's entire mechanism decorative: the exact credit
 * was readable with the tube still empty. So the live row carries the stake and
 * the multiplier the player already knew, and the *only* thing that changes at
 * the deciding lock is `data-state`, which drives colour and opacity and nothing
 * else. The returned figure appears once, on S5, where it is the record.
 */
function pinnedLines(phase: 'live' | 'final'): string {
  const info = variant();
  const round = state.round;
  const rows = round
    ? roundRows(info, round, state.displayOrder, phase)
    : draftRows(info, state.lines);

  /*
   * The round's net outcome travels with the strip, and it gates the gold.
   *
   * §6.1 use 5 lets a line that resolved *won* carry gold, and on a net-losing
   * multi-line ticket that produced a panel whose dominant colour was gold: a
   * capture of an 8-line ticket returning 7.20 of 8.00 — a loss — showed three
   * rows reading `returned 2.40` in gold with the neutral headline the only
   * signal of the net result. Nothing about it breaks §10 (no plate, no rim, no
   * burst, no count-up, and the headline states the fact), but the colour
   * weighting argued against the headline, and "a loss must be presented as one"
   * is about what the frame *reads* as, not only about which effects fired.
   *
   * So on a net-losing ticket the won rows keep every other channel — the rail,
   * the `returned` wording, the state, the announcement — and lose only the
   * gold, stepping to `--ink`. Which lines won is still fully legible, which is
   * §10's explicit "what is not suppressed".
   */
  const net =
    phase === 'final' && round?.presentation ? round.presentation.outcome : 'pending';
  return `<div class="lines" data-net="${esc(net)}">${rows
    .map(
      (row) =>
        `<div class="line" data-line="${row.index}" data-state="${row.state}">
          <b>${esc(row.name)}</b><span>${esc(row.summary)}</span><u>${esc(row.right)}</u>
        </div>`,
    )
    .join('')}</div>`;
}

/**
 * The order the player built the ticket in, mapped onto the engine's canonical
 * line list. Frozen at COMMIT (§5 S4) and used for nothing but the reading
 * order of the strip — every index in the resolution track still addresses the
 * canonical line it belongs to.
 */
function freezeDisplayOrder(round: RoundView): void {
  const info = variant();
  const remaining = round.lines.map((line, index) => ({
    index,
    key: claimKey(info, line.code, line.params),
  }));
  const order: number[] = [];
  for (const built of state.lines) {
    const key = claimKey(info, built.code, built.params);
    const at = remaining.findIndex((candidate) => candidate.key === key);
    if (at < 0) {
      state.displayOrder = null;
      return;
    }
    order.push((remaining[at] as { index: number }).index);
    remaining.splice(at, 1);
  }
  state.displayOrder = remaining.length === 0 ? order : null;
}

/*
 * The tier tabs, and the sub-captions are gone.
 *
 * §6.1's own argument for publishing the three tier accents was that "three tabs
 * that differ only in weight teach [volatility] in a caption where three tabs
 * that differ in colour teach it in a glance" — so once the colours shipped, the
 * captions were teaching the same thing twice, in body copy, on the play
 * surface. Measured against the reference library that is the expensive half:
 * no reference puts prose on a game screen, and the bottom 45% of our idle frame
 * was three tabs with sub-captions, four cards of three text lines each and a
 * two-sentence paragraph. The colour-blind channel is unaffected — the tier is
 * still named in words on the tab, still spelled out on every chip's
 * `aria-label`, and still glossed in full in the picker sheet.
 */
function tierTabs(): string {
  const tiers: (typeof state.tier)[] = ['FLOW', 'FORM', 'ORDER'];
  return `<div class="tabs" role="tablist">${tiers
    .map(
      (tier) =>
        `<button class="tab" role="tab" data-tier="${tier}" aria-selected="${
          state.tier === tier
        }"><b>${tier}</b></button>`,
    )
    .join('')}</div>`;
}

/**
 * The payout ramp — the whole ladder, on screen at once, cool to hot.
 *
 * The chips print a price and the tabs switch which three you can see, so the
 * scale the game is actually played on — 1.92× through 115.20× — was split
 * across three tabs with one tier visible at a time. Measured against the
 * reference bar that is criterion 11, a comprehension-core criterion: every
 * reference in the category prints its entire ramp simultaneously and colour-
 * codes it by band, because "the player learns the payout scale by looking,
 * never by reading". Ours could only be learned by tapping.
 *
 * So the ramp is one row of the real multipliers, in ascending order, each in
 * its own tier's accent. It is **information, not a control**: tapping it would
 * put a seventh, eighth and ninth 44 px target on the deck for something the
 * tabs already do, and §11's separation floor is not free. It is derived from
 * the catalogue rather than typed, so a variant that changes a price changes the
 * ramp, and SEVEN's own ladder appears the moment SEVEN is selected.
 *
 * It is never gold and never a fill: §6.1's accents are "a hairline, a numeral
 * and a rail", and this is a numeral over a rail on a machined plate.
 */
function payoutRamp(): string {
  const info = variant();
  const seen = new Set<string>();
  const rungs: { tier: string; label: string; value: number }[] = [];
  for (const bet of info.bets) {
    if (seen.has(bet.multiplierDecimal)) continue;
    seen.add(bet.multiplierDecimal);
    rungs.push({
      tier: bet.tier,
      label: bet.multiplierDecimal,
      value: Number.parseFloat(bet.multiplierDecimal),
    });
  }
  rungs.sort((a, b) => a.value - b.value);
  if (rungs.length < 2) return '';
  const first = rungs[0]!.label;
  const last = rungs[rungs.length - 1]!.label;
  return `<div class="ramp" role="img" aria-label="Payout scale: ${esc(first)} to ${esc(
    last,
  )}, lowest to highest">${rungs
    .map(
      (rung) =>
        `<span class="ramp__rung" data-tier="${esc(rung.tier)}" data-here="${
          rung.tier === state.tier
        }">${esc(rung.label)}</span>`,
    )
    .join('')}</div>`;
}

/**
 * The chip rail — tiered cards, volatility as colour, the price set loud.
 *
 * Two length flags, and both are §11's no-clipping rule rather than typography
 * taste:
 *
 * - **The name.** §6.5 sets bet names uppercase at +0.06em, and at the 13 px step
 *   `NEIGHBOURS` is 103 px wide inside a 96 px chip: it overhung its own border
 *   at 100% text and was cut off by the right edge of the screen at 200%. A word
 *   longer than the ~8 characters the chip holds drops to 11 px — the *next step
 *   down on §6.5's own scale*, not an arbitrary size. `FULL ORDER` is unaffected:
 *   its longest word is five characters and it wraps at the space.
 * - **The multiplier.** The price is now set at the 22 px step, because four
 *   different-looking bets all reading `4.80×` is the product's whole claim (§1)
 *   and it should be the loudest thing on the card. Seven characters is where it
 *   stops fitting — `115.20×` measured 88 px inside an 82 px content box, and
 *   SEVEN's `201.60×` and `4838.40×` are worse — so anything longer than six
 *   takes the next step down. That threshold is measured, not guessed: the first
 *   draft cut at eight characters and let both ORDER-tier prices overhang their
 *   own cards by 6 px. Nothing is clipped and nothing leaves the published scale.
 *
 * The tier travels as `data-tier`, which drives the hairline across the top of
 * the card and the colour of the numeral — cool for FLOW, neutral for FORM, hot
 * for ORDER. It is volatility, never value (§10), the tier's plain-language
 * gloss is on the tab immediately above, and the 96% line is immediately below.
 */
function chipRail(): string {
  const info = variant();
  const counts = new Map<string, number>();
  for (const line of state.lines) counts.set(line.code, (counts.get(line.code) ?? 0) + 1);
  const longestWord = (name: string): number =>
    name.split(/\s+/u).reduce((longest, word) => Math.max(longest, word.length), 0);
  return `<div class="rail-row"><div class="rail-scroll">${info.bets
    .filter((bet) => bet.tier === state.tier)
    .map((bet) => {
      const count = counts.get(bet.code) ?? 0;
      return `<button class="chip" data-chip="${bet.code}" data-tier="${esc(
        bet.tier,
      )}" aria-label="${esc(`${bet.name}, ${bet.picks}, pays ${bet.multiplierDecimal}`)}">
        ${count > 0 ? `<span class="chip__count">${count}</span>` : ''}
        <b${longestWord(bet.name) > 8 ? ' data-long="yes"' : ''}>${esc(bet.name)}</b>
        <em>${esc(bet.picks)}</em>
        <u${bet.multiplierDecimal.length > 6 ? ' data-long="yes"' : ''}>${esc(
          bet.multiplierDecimal,
        )}</u>
      </button>`;
    })
    .join('')}</div>
    <!--
      §5 S1's wireframe puts an explicit arrow **after** the last visible chip —
      in the gutter beside the rail, not over it. It is a sibling of the scroller
      in a flex row rather than an absolutely positioned overlay, which is the
      whole fix: an overlay sat on top of the fourth chip's own text and tap
      area, so the affordance that says "there is more" was printed across the
      thing it was pointing at. It is an affordance and never a control — the
      scroll is the interaction.
    -->
    <span class="rail-arrow" aria-hidden="true">→</span></div>`;
}

function ticketStrip(): string {
  const total = totalStake();
  const best = state.quote ? BigInt(state.quote.bestOutcomeChips) : 0n;
  return `<button class="strip" data-review>
    <b>${state.lines.length}</b> line${state.lines.length === 1 ? '' : 's'} ·
    <b>${esc(money(total))}</b>
    <span class="strip__best" data-best>best <b>${esc(
      state.quote ? money(best) : '—',
    )}</b></span>
  </button>`;
}

/** How long the CTA still accepts a bet, and when the next one opens (§5 S10). */
function lobbySeconds(at: number | undefined): string {
  if (at === undefined) return '';
  return `${Math.max(0, (at - Date.now()) / 1000).toFixed(1)}s`;
}

function commitLabel(): string {
  const total = totalStake();
  // The empty-ticket label names the action that IS available. See `commitButton`.
  if (state.lines.length === 0) return 'PICK A BET';
  if (state.place !== 'lobby') return `COMMIT ${money(total)}`;
  const lobby = state.lobby;
  if (lobby?.clientClosesAt !== undefined && Date.now() >= lobby.clientClosesAt)
    return `BETTING CLOSED · next draw in ${lobbySeconds(lobby.settleAtEpochMs)}`;
  return `COMMIT ${money(total)} (closes in ${lobbySeconds(lobby?.clientClosesAt)})`;
}

/*
 * The one control, and it is **lit on the first frame**.
 *
 * Round 1 shipped the cold-start screen with `COMMIT 0.00` disabled and dim, so
 * the frame a new player opens the game on had no call to action at all: the
 * brightest, most saturated region measured 0.7% of the frame at a centroid of
 * y = 0.33 — a sliver of light off a sphere, in the middle of the instrument.
 * Every reference in the category makes the round-starting button the brightest
 * saturated object in the idle frame, sitting under the thumb at y = 0.88–0.94.
 * Ours had one and hid it until the player had already navigated a picker they
 * had no prompt to open.
 *
 * With an empty ticket the button is therefore enabled and reads `PICK A BET`,
 * and pressing it opens the picker for the first chip of the open tier. That is
 * a real action rather than a lit no-op, and it is not a nudge to spend: it
 * commits nothing, names no amount, and the press that *does* spend money is the
 * second one — which names the amount, as it always did. A dim button is not a
 * safeguard; it is just a screen with no way in.
 */
function commitButton(): string {
  const session = state.session as SessionState;
  const waiting = session.commitAvailableInMs > 0;
  const lobbyClosed =
    state.place === 'lobby' &&
    state.lobby?.clientClosesAt !== undefined &&
    Date.now() >= state.lobby.clientClosesAt;
  const empty = state.lines.length === 0;
  const disabled = waiting || lobbyClosed;
  return `<button class="cta" data-commit ${disabled ? 'disabled' : ''} ${
    empty ? 'data-empty' : ''
  }>
    <span data-commit-label>${esc(commitLabel())}</span>
    ${waiting ? '<span class="cta__sub">unlocks — it never expires</span>' : ''}
    <i class="cta__hairline" data-hairline></i>
  </button>`;
}

/** Open the stake picker for one bet code. The chip and the CTA share it. */
function pickBet(code: string): void {
  const info = variant();
  const bet = info.bets.find((candidate) => candidate.code === code);
  if (!bet) return;
  openPicker({
    variant: info,
    bet,
    // "The stepper never pre-selects a value higher than the previous round's."
    stakeChips: state.lastStakeChips,
    ladder: stakeLadder(info),
    onAdd: (params, stakeChips) => addLine(bet.code, params, stakeChips),
  });
}

/** What `PICK A BET` opens: the first chip of the tier already on screen. */
function openFirstChip(): void {
  const first = variant().bets.find((bet) => bet.tier === state.tier);
  if (first) pickBet(first.code);
}

function noticeMarkup(): string {
  if (!state.notice) return '';
  const attr =
    state.notice.kind === 'edit'
      ? 'data-notice-edit'
      : state.notice.kind === 'limits'
        ? 'data-notice-limits'
        : 'data-notice-dismiss';
  return statePanel(state.notice.message, state.notice.detail, state.notice.action, attr);
}

function buildDeck(): string {
  // §1 item 5 is "one line UNDER THE RAIL", and the rail it means is the chip
  // rail it follows in that list — not the foot of the screen. Putting it there
  // is also what keeps the tier tabs inside §5's thumb zone.
  return `
    ${state.place === 'lobby' ? presenceMarkup() : ''}
    <p class="premise">They settle in a random order. Bet on the order.</p>
    ${tierTabs()}
    <div class="rail-block">
      ${payoutRamp()}
      ${chipRail()}
      <!--
        §1 item 5, and it is one clause now rather than two sentences. The
        second sentence — "the tiers are how wild the ride is, not how good the
        deal is" — is exactly what the three tier colours teach at a glance
        (§6.1), so on the play surface it was prose restating the art. The
        honesty it carries is not reduced: the 96% is still here, still on every
        chip in the picker sheet, still on the fairness screen and still in the
        seed sheet. §10 requires the disclosure, not the paragraph.
      -->
      <p class="footnote">Every bet pays 96%.</p>
    </div>
    ${ticketStrip()}
    ${noticeMarkup()}
    ${commitButton()}`;
}

/**
 * Write the round caption. Called at COMMIT and on every lock; cleared on exit.
 *
 * `settled` is how many slots are filled, which is what the tube already shows.
 */
function setRoundCap(settled: number | null): void {
  const node = app().querySelector<HTMLElement>('[data-round-cap]');
  if (!node) return;
  if (settled === null) {
    /*
     * **The idle state has a name, and it is the largest text on the screen.**
     *
     * Criterion 2 is one of the four gating comprehension criteria, and round 2
     * failed it on exactly this frame: the caption existed for the round and for
     * the result, but the state the player sits in longest — the one where they
     * are deciding — carried no statement of what the round was doing anywhere
     * in the play area. The rule copy under the instrument states the *rule*,
     * not the state, and the largest text on the whole screen was a chip's
     * multiplier. Every reference in the category announces the state in words
     * at the centre of the play area, at the largest size on the frame, whenever
     * the round is not running.
     *
     * Two words and a figure: what the machine is doing, and what it will cost.
     * It leaks nothing — both are properties of the ticket the player built —
     * and it is replaced in place by the round's own caption at COMMIT, so no
     * layout moves.
     */
    if (state.mode !== 'build') {
      // The result screen is the record of a round that has already happened,
      // and it carries its own headline: a second state statement over it would
      // be two answers to one question.
      node.hidden = true;
      node.textContent = '';
      return;
    }
    /*
     * One word, and no second line. The first draft carried
     * `n LINES · 0.00 CR` under it, which is the same sentence the ticket strip
     * prints two hundred pixels below — and the plate's height is paid for by
     * the tube, whose topmost slot index it covers. The subtraction test
     * settles it: removing the duplicate makes the frame better and gives the
     * instrument back a slot. What is at stake stays on screen twice over, in
     * the rail's balance and in the strip (criterion 3).
     */
    node.hidden = false;
    node.dataset.state = 'ready';
    node.innerHTML = `<b>READY</b>`;
    return;
  }
  const info = variant();
  node.hidden = false;
  node.dataset.state = 'round';
  node.innerHTML = `<b>SETTLING ${settled} OF ${info.n}</b><span>STAKE ${esc(
    money(totalStakeCommitted()),
  )}</span>`;
}

/**
 * The stake the open round was committed with.
 *
 * Read off the round rather than off the draft ticket: `state.lines` is cleared
 * and rebuilt by REBET and NEW TICKET, and the caption must keep naming the
 * money that is actually at risk for as long as the round is running.
 */
function totalStakeCommitted(): bigint {
  const round = state.round;
  if (!round) return totalStake();
  return round.lines.reduce((sum, line) => sum + BigInt(line.stakeChips), 0n);
}

/** S4: the pinned strip and nothing else. SKIP and the hairline live in the shell. */
function roundDeck(): string {
  return pinnedLines('live');
}

/**
 * The settled order, as the objects that settled.
 *
 * A strip of the actual spheres, bottom-of-tube first, with the names in words
 * underneath. The strip is the premium read and the words are the channel: §6.1
 * proves seven colours clearing the contrast floor cannot be separated by
 * luminance, so the glyph rides on every orb and the colour is *also* named in
 * text — a build that shows only the dots has dropped the channel (§11).
 */
function settledStrip(round: RoundView): string {
  const info = variant();
  const permutation = round.transcript?.permutation;
  if (!permutation) return '';
  const orbs = permutation
    .map((element) => {
      const sphere = info.elements[element];
      return sphere ? orbSvg(sphere, 16) : '';
    })
    .join('');
  return `<span class="perm">${orbs}</span>`;
}

function resultDeck(): string {
  const round = state.round as RoundView;
  const presentation = round.presentation;
  const session = state.session as SessionState;
  const waiting = session.commitAvailableInMs > 0;
  return `
    <!--
      The headline is the SERVER's sentence, and the unit is appended to it
      rather than folded into it: roundPresentation is the one place a round's
      wording is decided, and a client that rewrites that string is a client
      that can disagree with the receipt. What it may do — and criterion 17
      requires — is attach the unit the figure is denominated in, which is
      constant for the whole product.
    -->
    <div class="result-head" data-outcome="${esc(presentation?.outcome ?? '')}">
      <b>${esc(presentation?.headline ?? '')} <i>${UNIT}</i></b>
      <span class="result-head__order">${settledStrip(round)}${esc(
        round.transcript
          ? round.transcript.permutation
              .map((element) => elementName(variant(), element).toLowerCase())
              .join(' · ')
          : '',
      )}</span>
    </div>
    ${pinnedLines('final')}
    ${noticeMarkup()}
    <div class="row">
      <button class="btn" data-rebet ${waiting ? 'disabled' : ''}>↻ REBET</button>
      <button class="btn" data-new ${waiting ? 'disabled' : ''}>NEW TICKET</button>
    </div>
    <button class="btn btn--wide" data-verify>◈ VERIFY THIS ROUND</button>`;
}

function cadenceMarkup(): string {
  const lobby = state.lobby;
  if (!lobby?.running || lobby.settleAtEpochMs === undefined) return '';
  const total = lobby.cadenceMs ?? 6000;
  const remaining = Math.max(0, lobby.settleAtEpochMs - Date.now());
  return `<div class="cadence">
    <span>next draw</span>
    <span class="cadence__bar"><i style="width:${Math.round((remaining / total) * 100)}%"></i></span>
    <span class="cadence__time">${(remaining / 1000).toFixed(1)}s</span>
  </div>`;
}

function presenceMarkup(): string {
  const presence = state.lobby?.presence;
  const info = variant();
  if (!presence) return '';
  return `<div class="ticker">
    <b>IN THIS DRAW · ${presence.tickets} ticket${presence.tickets === 1 ? '' : 's'}</b>
    ${presence.claims
      .map((claim) => {
        const bet = info.bets.find((candidate) => candidate.code === claim.code);
        return `<span>▸ ${esc(bet?.name ?? claim.code)} ${esc(
          claimSummary(info, claim.code, claim.params),
        )}</span>`;
      })
      .join('')}
  </div>`;
}

function wireDeck(deck: HTMLElement): void {
  /*
   * `.tab[data-tier]`, not `[data-tier]`.
   *
   * The chips carry `data-tier` too — it drives the volatility hairline and the
   * numeral's colour — so an unscoped selector matched them as well, and every
   * chip tap ran `state.tier = …; render()` *before* the picker opened. That
   * rebuilt `.rail-scroll` and destroyed its scroll position: measured
   * `scrollLeft` 42 → 0. On FLOW and FORM the fourth chip (NEIGHBOURS, STACK) is
   * off-screen, so the player scrolled right, tapped it, and found the rail back
   * at the start when the sheet closed — once per line added.
   */
  on(deck, '.tab[data-tier]', 'click', (_event, node) => {
    state.tier = node.dataset.tier as typeof state.tier;
    render();
  });
  on(deck, '[data-chip]', 'click', (_event, node) => {
    pickBet(node.dataset.chip ?? '');
  });
  /*
   * §5 S1: the third figure is "long-pressable for the one-line explanation".
   * Round 1 implemented that as a `title=` attribute, which is a desktop hover
   * tooltip and fires on no touch gesture at all — on the 390 x 844 reference
   * device the explanation could not be surfaced from S1. This is a real press,
   * and the press swallows the click so it never falls through into S3.
   */
  let pressTimer: number | undefined;
  let pressed = false;
  const strip = deck.querySelector('.strip');
  if (strip) {
    const start = (event: Event): void => {
      if (!(event.target as HTMLElement).closest('[data-best]')) return;
      pressed = false;
      window.clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => {
        pressed = true;
        toast('the most this exact ticket can return on any settled order');
      }, 450);
    };
    const stop = (): void => window.clearTimeout(pressTimer);
    strip.addEventListener('pointerdown', start);
    strip.addEventListener('pointerup', stop);
    strip.addEventListener('pointercancel', stop);
    strip.addEventListener('pointerleave', stop);
    strip.addEventListener(
      'click',
      (event) => {
        if (!pressed) return;
        pressed = false;
        event.stopImmediatePropagation();
        event.preventDefault();
      },
      true,
    );
  }
  on(deck, '[data-review]', 'click', () => {
    if (state.lines.length === 0) return;
    openTicketReview({
      variant: variant(),
      lines: state.lines,
      bestOutcomeChips: state.quote ? BigInt(state.quote.bestOutcomeChips) : 0n,
      everyLineCanHitTogether: state.quote?.everyLineCanHitTogether ?? true,
      onRemove: (index) => {
        state.lines.splice(index, 1);
        refreshQuote();
      },
      onClearAll: () => {
        state.lines = [];
        refreshQuote();
      },
    });
  });
  on(deck, '[data-commit]', 'click', () => {
    // An empty ticket has nothing to commit, so the control opens the choice
    // instead of spending. See `commitButton`.
    if (state.lines.length === 0) {
      openFirstChip();
      return;
    }
    void commit();
  });
  on(deck, '[data-rebet]', 'click', () => void rebet());
  on(deck, '[data-new]', 'click', () => {
    state.lines = [];
    state.quote = null;
    state.mode = 'build';
    state.round = null;
    state.displayOrder = null;
    state.displayBalanceChips = null;
    chamber.reset();
    void openRound().then(render);
  });
  on(deck, '[data-verify]', 'click', () => void openFairnessForLast());
  on(deck, '[data-notice-edit]', 'click', () => {
    state.notice = null;
    render();
  });
  on(deck, '[data-notice-dismiss]', 'click', () => {
    state.notice = null;
    render();
  });
  on(deck, '[data-notice-limits]', 'click', () => {
    state.notice = null;
    openLimitsSheet();
  });
}

/** The hairline under the CTA. It unlocks; it never counts down into a bet. */
function startFloorTicker(): void {
  window.clearInterval(floorTimer);
  const session = state.session as SessionState;
  if (session.commitAvailableInMs <= 0) return;
  const started = Date.now();
  const total = session.commitAvailableInMs;
  floorTimer = window.setInterval(() => {
    const elapsed = Date.now() - started;
    const hairline = document.querySelector('[data-hairline]') as HTMLElement | null;
    if (hairline) hairline.style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
    if (elapsed >= total) {
      window.clearInterval(floorTimer);
      void api.session(session.id).then((result) => {
        setSession(result.session);
        render();
      });
    }
  }, 80);
}

/* ---------------------------------------------------------------- commit -- */

async function commit(): Promise<void> {
  const session = state.session as SessionState;
  state.notice = null;
  // A confirmation, not an outcome cue: the one tap in the product that spends
  // money answers immediately, in sound as well as in the button's own press.
  sound.tick();
  try {
    if (state.place === 'lobby') {
      const roundId = state.lobby?.roundId;
      if (!roundId) return;
      const result = await api.lobbyCommit(session.id, roundId, lineInputs());
      setSession(result.session);
      state.round = result.round;
      freezeDisplayOrder(result.round);
      state.mode = 'round';
      render();
      toast('Ticket in. The draw settles on the room’s clock.');
      return;
    }
    const roundId = session.openRound?.roundId;
    if (!roundId) {
      await openRound();
      return;
    }
    const result = await api.commit(session.id, roundId, session.clientSeed, lineInputs());
    setSession(result.session);
    state.round = result.round;
    freezeDisplayOrder(result.round);
    state.verified = false;
    // The round is settled and credited server-side from here. A presentation
    // failure must never leave the player without their result.
    await playRound(result.round).catch(() => {
      state.mode = 'result';
      state.displayBalanceChips = null;
      render();
    });
  } catch (error) {
    handleCommitFailure(error);
  }
}

function handleCommitFailure(error: unknown): void {
  if (!(error instanceof ApiFailure)) {
    state.notice = {
      message: 'No connection. Nothing has been staked.',
      detail: 'Your ticket is exactly as you built it.',
      action: 'TRY AGAIN',
      kind: 'dismiss',
    };
    render();
    return;
  }
  if (error.code === 'WALLET_DECLINED')
    state.notice = {
      message: 'That bet was not placed — your balance did not cover it.',
      detail: 'Lower a stake or remove a line.',
      action: 'EDIT TICKET',
      kind: 'edit',
    };
  else if (error.code === 'CYCLE_FLOOR')
    state.notice = {
      message: error.details?.atCeiling
        ? `You have played ${String(error.details.roundsInRollingHour)} rounds this hour.`
        : 'Not yet — there is a minimum time between bets.',
      detail: error.details?.atCeiling
        ? `Betting opens again at ${new Date(Number(error.details.availableAt)).toLocaleTimeString()}.`
        : 'The wait unlocks; it never expires into a bet.',
      action: 'SEE MY LIMITS',
      kind: 'limits',
    };
  else if (error.code === 'LIMIT_REACHED')
    state.notice = {
      message: error.message,
      detail: 'You set this limit. It can be reviewed in limits and play controls.',
      action: 'SEE MY LIMITS',
      kind: 'limits',
    };
  else if (error.code === 'BETTING_CLOSED')
    state.notice = {
      message: 'That draw closed — your ticket is still here.',
      detail: 'It was not placed and nothing was staked. The next draw is already open.',
      action: 'OK',
      kind: 'dismiss',
    };
  else
    state.notice = {
      message: error.message,
      detail: `${error.code} · ${error.path}`,
      action: 'OK',
      kind: 'dismiss',
    };
  render();
}

async function rebet(): Promise<void> {
  const round = state.round;
  if (!round) return;
  // Same lines, same stakes — and the same reading order. REBET rebuilds the
  // ticket from the engine's canonical list, so without this the record would
  // silently resort itself between one round and its repeat.
  const order =
    state.displayOrder && state.displayOrder.length === round.lines.length
      ? state.displayOrder
      : round.lines.map((_line, index) => index);
  state.lines = order.map((index) => {
    const line = round.lines[index] as (typeof round.lines)[number];
    return {
      code: line.code,
      params: line.params as Params,
      stakeChips: BigInt(line.stakeChips),
    };
  });
  state.mode = 'build';
  state.round = null;
  chamber.reset();
  await openRound();
  refreshQuote();
  render();
  await commit();
}

/* --------------------------------------------------------- choreography -- */

/**
 * The tier the celebration is voiced at: the highest tier among the lines that
 * won.
 *
 * §9 frames LOCK-OUT as "the top of a ladder rather than … the whole show" and
 * §8 scales a win by **voicing, not loudness** — "a FLOW win and an ORDER win
 * differ in *voicing*, not loudness — so a small win is not made to feel like a
 * failure". This is that scale, read off the settled lines the server sent. It
 * is not a second gate: whether to celebrate at all is `presentation.celebrate`
 * and nothing here can change it.
 */
function winVoicing(round: RoundView): WinVoicing {
  let voicing: WinVoicing = 'FLOW';
  for (const line of round.lines) {
    if (line.won !== true) continue;
    if (line.tier === 'ORDER') return 'ORDER';
    if (line.tier === 'FORM') voicing = 'FORM';
  }
  return voicing;
}

async function playRound(round: RoundView): Promise<void> {
  const info = variant();
  const beats = (state.catalogue as Catalogue).choreography;
  const track = round.resolution;
  const permutation = round.transcript?.permutation ?? [];
  const celebrate = round.presentation?.celebrate === true;
  const voicing = celebrate ? winVoicing(round) : 'FLOW';
  const reduced = reducedMotion();
  const stagger = info.staggerMs;
  const fall = reduced ? 120 : beats.fallMs;
  /*
   * The balance the rail carries for the whole of beats 3 to 6: the wallet after
   * the debit and before the credit (§2, and `money.ts`'s `balanceDuringRound`).
   *
   * It is derived from the round rather than captured from the session, because by
   * the time this runs the session has already been replaced by the settled one —
   * in solo play by `commit`, in the shared chamber by the reveal event. Deriving
   * it means both places get the same freeze from one line.
   */
  const settledChips = BigInt(round.balanceAfterChips ?? (state.session as SessionState).balanceChips);
  const creditedChips = BigInt(round.settlement?.creditedChips ?? '0');
  const balanceBefore = balanceDuringRound(settledChips, creditedChips);
  state.displayBalanceChips = balanceBefore;

  /*
   * The agitation track, built once, from the transcript.
   *
   * §7's principle is that the whole round is a precomputed choreography track
   * because the transcript is known the instant the round commits. The seed is
   * the round's own commitment, so every round tumbles differently and the same
   * round tumbles identically on replay — and the turbulence is *seeded* by the
   * commitment rather than *arranged* by the permutation, so nothing about the
   * order can be read out of the shake before the tube shows it (§3).
   */
  const turbulenceTrack = turbulence(
    round.transcript?.commitment ?? round.seedCommitment,
    info.n,
    // Raised from [32, 23]. At the old amplitude, with §6.4's envelope and damping
    // on top, a frame dump across the whole 1,150 ms of CHARGE plus AGITATE showed
    // sub-10 px of travel in fixed columns — the beat read as nothing happening. The
    // vertical figure is the larger one because the chamber is tall, and both are
    // still clamped per sphere so nothing crosses the machinery.
    [34, 42],
  );

  state.mode = 'round';
  state.skipRequested = (state.session as SessionState).skip;
  render();
  chamber.reset();

  const settleMs = (info.n - 2) * stagger + beats.fallMs + beats.reboundMs;
  const closeMs = celebrate ? beats.closeCelebratedMs : beats.closeNeutralMs;
  const naturalMs = beats.chargeMs + beats.agitateMs + settleMs + closeMs;
  // SKIP compresses beats 3-6 and nothing else. It never shortens the cycle
  // (§2.2), and it never removes a beat: a skipped round still resolves every
  // line in prefix order, in the same sequence, faster.
  const skipScale = beats.skipCompressedMs / naturalMs;
  let scale = state.skipRequested ? skipScale : 1;

  const setProgress = (fraction: number): void => {
    const bar = document.querySelector('[data-progress]') as HTMLElement | null;
    if (bar) bar.style.setProperty('--progress', Math.min(1, fraction).toFixed(4));
  };
  setProgress(0);

  const resolveLinesAt = (lock: number): void => {
    if (!track) return;
    for (const line of track.lines) {
      if (line.lock !== lock) continue;
      const node = document.querySelector(`[data-line="${line.index}"]`) as HTMLElement | null;
      if (node) node.dataset.state = line.verdict ? 'won' : 'lost';
    }
  };

  /*
   * docs/DESIGN.md §7.2: the choreography is a function of ELAPSED TIME, not of
   * frame index or of a chain of delays. Every beat has an absolute offset on a
   * natural timeline, so a device that stalls — a backgrounded tab, a slow lane
   * — time-shifts and catches up. It never skips a lock and never truncates the
   * close.
   *
   * `scale` maps that natural timeline onto the wall clock, and SKIP may change
   * it *during* the round: the control is on screen throughout S4, and a control
   * that only takes effect next time is a control that looks broken. Changing it
   * re-anchors rather than rescaling from zero, so the beats already played keep
   * the time they took and only what is left compresses.
   */
  let anchorNatural = 0;
  let anchorWall = performance.now();
  const wallFor = (natural: number): number => anchorWall + (natural - anchorNatural) * scale;
  const compress = (): void => {
    if (scale <= skipScale) return;
    const now = performance.now();
    anchorNatural += (now - anchorWall) / scale;
    anchorWall = now;
    scale = skipScale;
  };
  skipCurrentRound = compress;

  const at = async (natural: number): Promise<void> => {
    // Sliced, so a SKIP arriving mid-wait is honoured within a frame or two
    // rather than at the end of a beat it was pressed to shorten.
    for (;;) {
      const delay = wallFor(natural) - performance.now();
      if (delay <= 0) return;
      await sleep(Math.min(delay, 60));
    }
  };

  setRoundCap(0);
  chamber.setBeat('charge');
  sound.charge(beats.chargeMs * scale);
  await at(beats.chargeMs);
  chamber.setBeat('agitate');
  chamber.agitate(turbulenceTrack);
  sound.agitate(beats.agitateMs * scale, turbulenceTrack.seed);
  await at(beats.chargeMs + beats.agitateMs);
  chamber.setBeat('settle');

  const settleStart = beats.chargeMs + beats.agitateMs;
  for (let lock = 1; lock <= info.n - 1; lock += 1) {
    await at(settleStart + (lock - 1) * stagger);
    chamber.seat(lock, permutation[lock - 1] as number, fall * scale);
    await at(settleStart + (lock - 1) * stagger + fall);
    chamber.lock(lock);
    setRoundCap(lock);
    // §8: a struck-glass tone per slot, ascending by slot index, identical in
    // every round whatever the outcome. There is deliberately no per-line cue.
    sound.lock(lock, info.n);
    haptics.lock();
    resolveLinesAt(lock);
    // The hairline reaches full width at lock n-1: there is no information left.
    setProgress(lock / (info.n - 1));
  }

  const closeStart = settleStart + (info.n - 2) * stagger + beats.fallMs + beats.reboundMs;
  await at(closeStart);
  chamber.setBeat('close');
  /*
   * §9's close, and the one comparison that chooses between its two forms.
   *
   * `celebrate` is `roundPresentation`'s answer to `creditedChips >
   * totalStakeChips`, fully determined at lock n−1 and shipped by the server.
   * Above it: the audio ducks to the sub, the liquid desaturates, the fall slows
   * to 0.35×, the tube rim ignites from the bottom up. Below it: one fall at full
   * speed, no colour change, no audio event — and identically so whether the
   * ticket missed by one sphere or by five (§9's no-near-miss rule).
   */
  if (celebrate) {
    chamber.igniteRim(true);
    chamber.desaturate(true);
    sound.duck(400);
  }
  const closeFall = celebrate ? beats.fallMs / 0.35 : beats.fallMs;
  chamber.seat(info.n, permutation[info.n - 1] as number, (reduced ? 120 : closeFall) * scale);
  await at(closeStart + closeFall);
  chamber.lock(info.n);
  setRoundCap(null);
  sound.lock(info.n, info.n);
  resolveLinesAt(info.n);

  /*
   * §9 step 5: the plate lands over the tube. Both figures are the server's —
   * the credit in `presentation.netChips` and the realised return multiple in
   * `stampMultipleDecimal` — because this is arithmetic on money and the client
   * does none of it.
   *
   * The amount leads and the multiple is the caption, which is the one change of
   * emphasis this pass makes to the beat: a payout surface whose only figure is
   * `4.80×` asks the player to convert before they know what happened, and §8's
   * standing test is that a win reads as a win with the sound off.
   * `presentation.multiplierStamp` is `celebrate`, so the plate exists on no
   * other outcome — a losing or partially-returning round builds no surface at
   * all (§10).
   */
  if (round.presentation?.multiplierStamp && round.presentation.stampMultipleDecimal)
    /*
     * **The plate now shows its own arithmetic, and that is a comprehension fix
     * rather than a decoration.**
     *
     * Round 2's plate paired `4.80×` with `3.80` against a visible 1.00 stake,
     * so a player doing the obvious multiplication got 4.80 and read 3.80: the
     * plate carried the NET while the multiple described the RETURN. Both
     * figures were correct and the surface was incoherent, which is worse than
     * either being wrong — the celebration surface is the one thing the player
     * actually looks at.
     *
     * The house rule stays: the headline figure is the net, because
     * `roundPresentation` deliberately never states a gross as if it were a
     * gain. What changes is that the plate now shows the two operands beside
     * the result — `1.00 CR AT 4.80×` over `+3.80 CR` — so every figure on the
     * surface reconciles, and the sign says which kind of figure the big one is.
     * All three come from the server: the stake, the realised multiple and the
     * net. The client still computes no money.
     */
    chamber.setStamp(
      {
        amount: credits(BigInt(round.presentation.netChips)),
        multiple: round.presentation.stampMultipleDecimal,
        stake: credits(BigInt(round.presentation.stakedChips)),
      },
      true,
    );
  if (celebrate) {
    // The desaturation lifts as the burst blooms — the picture's version of §8's
    // "full-frequency return" on the closing lock. Leaving it down would make the
    // record screen, which is the round's receipt, read as switched off.
    chamber.desaturate(false);
    chamber.celebrate(voicing, Chamber.volumeOf(round.presentation?.stampMultipleDecimal ?? ''));
    sound.win(voicing);
    haptics.win();
  } else {
    sound.rest();
  }
  await at(closeStart + closeFall + beats.stampMs);
  chamber.setBeat('done');
  skipCurrentRound = null;

  announce(
    `Settled order: ${permutation.map((element) => elementName(info, element)).join(', ')}. ${
      round.presentation?.headline ? `${round.presentation.headline} ${UNIT}` : ''
    }`,
  );

  state.mode = 'result';
  /*
   * The close is over, so the wallet may speak — but *when* the freeze lifts
   * depends on whether §10's gate lets the figure climb.
   *
   * Below the gate the freeze lifts here and the rail simply renders the new
   * number. Above it the freeze has to survive both renders below, because
   * `openRound()` is awaited between them: lifting it here painted the settled
   * figure for at least one frame, and then `countBalanceUp` wrote the *pre*-
   * credit figure back and climbed from it. Measured at 50 ms resolution:
   * 501.40 → 499.51 → 499.88 → … → 501.40. The player saw the answer, saw it
   * taken away, and watched it be re-earned.
   */
  const counts = round.presentation?.balanceCountsUp === true;
  if (!counts) state.displayBalanceChips = null;
  render();
  await openRound();
  render();
  // §10 again, and this is the last channel the gate governs: the balance counts
  // up only above it. Below the gate the rail has simply been re-rendered with
  // the new figure and nothing animates, because a rising balance is a
  // celebration whatever the copy says.
  //
  // It runs *after* the final render on purpose. The rail is re-rendered as
  // markup, so a count-up started before it would have its node replaced
  // mid-flight and stop halfway up.
  if (counts) countBalanceUp(balanceBefore, BigInt((state.session as SessionState).balanceChips));
  // And the freeze lifts only now, so any later render — a tab switch, a sheet,
  // the next round's build screen — shows the settled figure the climb landed on.
  state.displayBalanceChips = null;
}

/* ----------------------------------------------------------------- menus -- */

function openMenu(): void {
  const session = state.session as SessionState;
  const info = variant();
  void import('./ui.js').then(({ openSheet }) => {
    openSheet({
      title: 'Menu',
      body: `
        <button class="btn btn--wide" data-go="paytable">PAYTABLE</button>
        <button class="btn btn--wide" data-go="limits">LIMITS &amp; PLAY CONTROLS</button>
        <button class="btn btn--wide" data-go="history">HISTORY</button>
        <button class="btn btn--wide" data-go="seed">CLIENT SEED</button>
        <button class="btn btn--wide" data-go="place">${
          state.place === 'solo' ? 'ENTER SHARED CHAMBER' : 'BACK TO SOLO PLAY'
        }</button>
        <!--
          §5 gives the top rail exactly two controls, the menu and the fairness
          chip, so the presentation preferences live here rather than adding a
          third. §3's own table lists MUTE and haptics among the controls that
          change nothing about the outcome, the settlement or the transcript, and
          the sheet says so.
        -->
        <div class="card">
          <h3>Presentation</h3>
          <div class="row">
            <button class="btn" data-sound aria-pressed="${!sound.muted}">SOUND ${
              sound.muted ? 'OFF' : 'ON'
            }</button>
            <button class="btn" data-haptics aria-pressed="${haptics.enabled}">HAPTICS ${
              haptics.enabled ? 'ON' : 'OFF'
            }</button>
          </div>
          <p class="note">Everything is playable muted — the sound is atmosphere and confirmation, and never carries anything the screen does not. Neither control is an input to the draw.</p>
        </div>
        <p class="note">${esc(info.displayName)} · adapter ${esc(
          (state.catalogue as Catalogue).adapterVersion,
        )} · ${esc(info.adapterFingerprint.slice(0, 12))}… · session ${Math.floor(
          session.elapsedMs / 60_000,
        )} min · net ${esc(signedCredits(BigInt(session.netChips)))} ${UNIT}</p>`,
      onMount(root, close) {
        on(root, '[data-go]', 'click', (_event, node) => {
          close();
          const target = node.dataset.go;
          if (target === 'paytable') openPaytable(info);
          if (target === 'limits') openLimitsSheet();
          if (target === 'history') void openHistorySheet();
          if (target === 'seed') openSeedSheet();
          if (target === 'place') void togglePlace();
        });
        on(root, '[data-sound]', 'click', (_event, node) => {
          const muted = sound.toggleMute();
          node.textContent = `SOUND ${muted ? 'OFF' : 'ON'}`;
          node.setAttribute('aria-pressed', String(!muted));
          if (!muted) sound.tick();
        });
        on(root, '[data-haptics]', 'click', (_event, node) => {
          haptics.enabled = !haptics.enabled;
          node.textContent = `HAPTICS ${haptics.enabled ? 'ON' : 'OFF'}`;
          node.setAttribute('aria-pressed', String(haptics.enabled));
          haptics.lock();
        });
      },
    });
  });
}

function openLimitsSheet(): void {
  openLimits({
    catalogue: state.catalogue as Catalogue,
    session: state.session as SessionState,
    onChange: (patch) => {
      void api.settings((state.session as SessionState).id, patch).then((result) => {
        setSession(result.session);
        render();
        toast('Saved.');
      });
    },
  });
}

async function openHistorySheet(): Promise<void> {
  const result = await api.history((state.session as SessionState).id);
  openHistory({
    variant: variant(),
    catalogue: state.catalogue as Catalogue,
    rounds: result.rounds,
    session: result.session,
    onOpenRound: (roundId) => {
      void api.round((state.session as SessionState).id, roundId).then((loaded) =>
        openFairness({
          sessionId: (state.session as SessionState).id,
          round: loaded.round,
          operatorKeyHex: state.operatorKeyHex,
          adapter: expectedAdapter(loaded.round.variantId),
        }),
      );
    },
  });
}

function openSeedSheet(): void {
  const session = state.session as SessionState;
  void import('./ui.js').then(({ openSheet }) => {
    openSheet({
      title: 'Client seed',
      body: `
        <p class="note">Your seed changes which order comes up. It cannot change your odds — every seed gives the same 96%.</p>
        <input id="seed-input" class="btn btn--wide input" maxlength="64" value="${esc(
          session.clientSeed,
        )}" placeholder="type anything, or leave it empty" />
        <p class="note">Up to 64 characters of ordinary keyboard text; anything else is dropped, because the transcript has to re-derive byte for byte on a verifier that shares no keyboard with you.</p>
        <p class="note">It is mixed into the draw together with the round id and the nonce, all of which were frozen by the hash published before you bet.</p>`,
      foot: '<button class="cta" data-save>USE THIS SEED</button>',
      onMount(root, close) {
        on(root, '[data-save]', 'click', () => {
          const input = root.querySelector('#seed-input') as HTMLInputElement;
          // Printable ASCII, bounded — the adapter's own rule for a client seed.
          (state.session as SessionState).clientSeed = input.value
            .replace(/[^\x20-\x7e]/gu, '')
            .slice(0, 64);
          close();
          toast('Your seed will be mixed into the next round.');
        });
      },
    });
  });
}

/**
 * The adapter this client holds, taken from the published catalogue.
 *
 * docs/ENGINE.md §7.10 step 2: a verifier rejects a transcript belonging to
 * another game, adapter version or fingerprint. Without it a transcript can open
 * its own commitment honestly while describing a round under a different
 * paytable.
 */
function expectedAdapter(variantId: 'classic' | 'seven'): {
  gameId: string;
  adapterVersion: string;
  adapterFingerprint: string;
  n: number;
} {
  const catalogue = state.catalogue as Catalogue;
  const info = catalogue.variants[variantId];
  return {
    gameId: catalogue.gameId,
    adapterVersion: catalogue.adapterVersion,
    adapterFingerprint: info.adapterFingerprint,
    n: info.n,
  };
}

async function openFairnessForLast(): Promise<void> {
  const session = state.session as SessionState;
  const round = state.round;
  if (!round) {
    void import('./ui.js').then(({ openSheet }) =>
      openSheet({
        title: 'Fairness',
        subtitle: 'committed — nothing settled yet',
        body: `<div class="card">
            <h3>Published before you bet</h3>
            <dl class="kv">
              <dt>seed commitment</dt><dd>${esc(session.openRound?.seedCommitment ?? '—')}</dd>
              <dt>round id</dt><dd>${esc(session.openRound?.roundId ?? '—')}</dd>
              <dt>nonce</dt><dd>${esc(String(session.openRound?.nonce ?? '—'))}</dd>
              <dt>previous</dt><dd>${esc(session.openRound?.previousCommitment ?? '—')}</dd>
            </dl>
            <p class="note">The hash above locks the secret seed together with the variant, the round id and the nonce — everything the draw consumes except your own seed. It was published before your ticket existed.</p>
          </div>`,
      }),
    );
    return;
  }
  await openFairness({
    sessionId: session.id,
    round,
    operatorKeyHex: state.operatorKeyHex,
    adapter: expectedAdapter(round.variantId),
    onVerified: () => {
      state.verified = true;
      const chip = app().querySelector('[data-fairness]') as HTMLElement;
      chip.dataset.state = 'verified';
    },
  });
}

function showRealityCheck(): void {
  openRealityCheck({
    session: state.session as SessionState,
    onKeepPlaying: () => {
      void api.ackRealityCheck((state.session as SessionState).id).then((result) => {
        state.session = result.session;
      });
    },
    onTakeABreak: () => {
      void api.ackRealityCheck((state.session as SessionState).id).then((result) => {
        state.session = result.session;
        closeAllSheets();
        openLimitsSheet();
      });
    },
  });
}

/* --------------------------------------------------------- shared chamber - */

async function togglePlace(): Promise<void> {
  if (state.place === 'solo') {
    const lobby = await api.lobby();
    if (!lobby.running) {
      toast('The shared chamber is not running.');
      return;
    }
    if ((state.session as SessionState).variantId !== lobby.variantId)
      await switchVariant(lobby.variantId as 'classic' | 'seven');
    state.place = 'lobby';
    state.lobby = lobby;
    state.mode = 'build';
    state.round = null;
    state.displayOrder = null;
    state.displayBalanceChips = null;
    chamber.reset();
    connectLobby();
  } else {
    // §13.2: mid-cadence, no penalty, no confirmation.
    state.place = 'solo';
    lobbySource?.close();
    lobbySource = null;
    state.mode = 'build';
    state.round = null;
    state.displayOrder = null;
    state.displayBalanceChips = null;
    chamber.reset();
    await openRound();
  }
  render();
}

function connectLobby(): void {
  lobbySource?.close();
  const session = state.session as SessionState;
  lobbySource = new EventSource(`/api/lobby/stream?session=${encodeURIComponent(session.id)}`);
  /*
   * `event.data` is guarded because `open` is EventSource's own native
   * connection event as well as a plausible name for a server-sent one. The
   * server's draw-opened event is called `draw` for that reason — naming it
   * `open` made the native event, which carries no data, run this handler and
   * throw out of it on every single connect, so the reset below never ran.
   */
  const onState = (event: MessageEvent): void => {
    if (typeof event.data !== 'string') return;
    state.lobby = JSON.parse(event.data) as LobbyState;
    if (state.place === 'lobby' && state.mode === 'build') render();
  };
  lobbySource.addEventListener('state', onState as EventListener);
  lobbySource.addEventListener('presence', onState as EventListener);
  lobbySource.addEventListener('draw', (event) => {
    onState(event as MessageEvent);
    if (state.place === 'lobby' && state.mode !== 'round') {
      state.mode = 'build';
      state.round = null;
      state.displayOrder = null;
      state.displayBalanceChips = null;
      chamber.reset();
      render();
    }
  });
  lobbySource.addEventListener('reveal', (event) => {
    const payload = JSON.parse((event as MessageEvent).data as string) as {
      round: RoundView | null;
      session: SessionState | null;
    };
    if (!payload.round || !payload.session) return;
    setSession(payload.session);
    state.round = payload.round;
    state.verified = false;
    void playRound(payload.round);
  });
  window.setInterval(() => {
    if (state.place !== 'lobby' || state.mode !== 'build') return;
    const cadence = app().querySelector('[data-cadence]') as HTMLElement;
    cadence.innerHTML = cadenceMarkup();
    const label = app().querySelector('[data-commit-label]');
    if (label) label.textContent = commitLabel();
    // The CTA closes early on purpose: a button that is live when a commit
    // could not land is a button that lies (§5 S10).
    //
    // An EMPTY ticket is not that case, and this ticker used to re-disable it
    // every 200 ms — which would have silently undone the cold-start entry point
    // (see `commitButton`) on the one screen where the lobby's own cadence makes
    // an unlabelled dead button worst. With nothing on the ticket the control
    // reads `PICK A BET` and opens the picker; it spends nothing, so a closed
    // betting window has nothing to protect the player from.
    const cta = app().querySelector<HTMLButtonElement>('.cta');
    const closed =
      state.lobby?.clientClosesAt !== undefined && Date.now() >= state.lobby.clientClosesAt;
    if (cta) cta.disabled = closed && state.lines.length > 0;
  }, 200);
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<pre style="padding:24px;color:#ff6b6b;font-family:monospace">${esc(
    message,
  )}</pre>`;
});
