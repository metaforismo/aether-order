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
import { credits, signedCredits } from './money.js';
import { openPicker, stakeLadder } from './picker.js';
import { draftRows, roundRows } from './rows.js';
import { orbSvg } from './sphere.js';
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

  app().innerHTML = `
    <header class="rail" data-rail></header>
    <div class="progress" data-progress-track><i data-progress></i></div>
    <div data-cadence></div>
    <main class="stage" id="stage">
      <div class="chamber-holder" id="chamber"></div>
      <button class="skip" data-skip aria-label="Skip the animation">SKIP</button>
      <!--
        §1's three-second test names five things a new player must see, in this
        order: five spheres, the numbered tube, THIS SENTENCE, the FORM chips,
        the 96% line. Round 1 shipped items 1, 2, 4 and 5 and left the
        explanation one level down inside the picker sheet — which is after the
        tap the criterion is about. It sits on the chamber rather than in the
        deck so that saying what the game is costs the chip rail no reach: §5
        keeps every control needed to play inside the thumb zone.
      -->
      <p class="stage__note">They settle in a random order. Bet on the order.</p>
      <!--
        §9's mote fall lives here rather than inside the chamber, because the
        chamber's markup is replaced whenever the layout gives it a different
        height — and one of those moments is 220 ms into the celebration.
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
  // this layout to survive 200%. Observing the stage catches every cause.
  new ResizeObserver(() => {
    if (state.mode !== 'round') fitChamber();
  }).observe(document.getElementById('stage') as HTMLElement);

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
      notes.push(`this line is at the ${credits(maxLine)} maximum`);
    }
    if (others + next > maxTicket) {
      next = maxTicket - others;
      notes.push(`ticket is at the ${credits(maxTicket)} maximum`);
    }
    line.stakeChips = next;
    toast(notes.length > 0 ? notes.join(' · ') : `${credits(next)} on this line`);
  } else {
    if (state.lines.length >= info.limits.maxLinesPerTicket) {
      toast(`${info.limits.maxLinesPerTicket} lines maximum`);
      return;
    }
    let stake = stakeChips;
    const others = totalStake();
    if (others + stake > maxTicket) stake = maxTicket - others;
    if (stake < minLine) {
      toast(`ticket is at the ${credits(maxTicket)} maximum`);
      return;
    }
    if (stake !== stakeChips) toast(`ticket is at the ${credits(maxTicket)} maximum`);
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
  return `
    <button class="icon-btn" data-menu aria-label="Menu">${ICON_HOME}</button>
    <span class="rail__balance"><b data-balance>${esc(
      credits(BigInt(session.balanceChips)),
    )}</b><span>balance</span></span>
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
 * S4 asks the chamber to go full-bleed. An SVG with a fixed viewBox in a taller
 * box letterboxes instead, so the chamber is redrawn to the height the layout
 * actually gives it. Never mid-round: a re-layout during SETTLE would restart
 * every transition in flight.
 */
function fitChamber(): void {
  const holder = document.getElementById('chamber');
  if (!holder || !state.session) return;
  const available = holder.clientHeight;
  if (available <= 0) return;
  // Hysteresis: the tight layout adds a line to the deck and so shrinks the
  // stage further. Without a gap between the two thresholds the two layouts
  // would flip each other back and forth forever.
  const tight = available < (app().dataset.tight === 'yes' ? 300 : 240);
  app().dataset.tight = tight ? 'yes' : 'no';
  if (Math.abs(available - chamber.height) < 8) return;
  chamber.render(variant(), available);
}

function render(): void {
  const session = state.session;
  if (!session) return;
  app().dataset.mode = state.mode;
  app().dataset.place = state.place;

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

  return `<div class="lines">${rows
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

function tierTabs(): string {
  const tiers: [typeof state.tier, string][] = [
    ['FLOW', 'lands often'],
    ['FORM', 'the core game'],
    ['ORDER', 'rare, big'],
  ];
  return `<div class="tabs" role="tablist">${tiers
    .map(
      ([tier, gloss]) =>
        `<button class="tab" role="tab" data-tier="${tier}" aria-selected="${
          state.tier === tier
        }"><b>${tier}</b><span>${gloss}</span></button>`,
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
  return `<div class="rail-scroll">${info.bets
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
    .join('')}</div>`;
}

function ticketStrip(): string {
  const total = totalStake();
  const best = state.quote ? BigInt(state.quote.bestOutcomeChips) : 0n;
  return `<button class="strip" data-review>
    <b>${state.lines.length}</b> line${state.lines.length === 1 ? '' : 's'} ·
    <b>${esc(credits(total))}</b>
    <span class="strip__best" data-best>best <b>${esc(state.quote ? credits(best) : '—')}</b></span>
  </button>`;
}

/** How long the CTA still accepts a bet, and when the next one opens (§5 S10). */
function lobbySeconds(at: number | undefined): string {
  if (at === undefined) return '';
  return `${Math.max(0, (at - Date.now()) / 1000).toFixed(1)}s`;
}

function commitLabel(): string {
  const total = totalStake();
  if (state.place !== 'lobby') return `COMMIT ${credits(total)}`;
  const lobby = state.lobby;
  if (lobby?.clientClosesAt !== undefined && Date.now() >= lobby.clientClosesAt)
    return `BETTING CLOSED · next draw in ${lobbySeconds(lobby.settleAtEpochMs)}`;
  return `COMMIT ${credits(total)} (closes in ${lobbySeconds(lobby?.clientClosesAt)})`;
}

function commitButton(): string {
  const session = state.session as SessionState;
  const waiting = session.commitAvailableInMs > 0;
  const lobbyClosed =
    state.place === 'lobby' &&
    state.lobby?.clientClosesAt !== undefined &&
    Date.now() >= state.lobby.clientClosesAt;
  const disabled = state.lines.length === 0 || waiting || lobbyClosed;
  return `<button class="cta" data-commit ${disabled ? 'disabled' : ''}>
    <span data-commit-label>${esc(commitLabel())}</span>
    ${waiting ? '<span class="cta__sub">unlocks — it never expires</span>' : ''}
    <i class="cta__hairline" data-hairline></i>
  </button>`;
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
      ${chipRail()}
      <p class="footnote">Every bet pays 96%. The tiers are how wild the ride is, not how good the deal is.</p>
    </div>
    ${ticketStrip()}
    ${noticeMarkup()}
    ${commitButton()}`;
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
    <div class="result-head" data-outcome="${esc(presentation?.outcome ?? '')}">
      <b>${esc(presentation?.headline ?? '')}</b>
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
  on(deck, '[data-tier]', 'click', (_event, node) => {
    state.tier = node.dataset.tier as typeof state.tier;
    render();
  });
  on(deck, '[data-chip]', 'click', (_event, node) => {
    const info = variant();
    const bet = info.bets.find((candidate) => candidate.code === node.dataset.chip);
    if (!bet) return;
    openPicker({
      variant: info,
      bet,
      // "The stepper never pre-selects a value higher than the previous round's."
      stakeChips: state.lastStakeChips,
      ladder: stakeLadder(info),
      onAdd: (params, stakeChips) => addLine(bet.code, params, stakeChips),
    });
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
  on(deck, '[data-commit]', 'click', () => void commit());
  on(deck, '[data-rebet]', 'click', () => void rebet());
  on(deck, '[data-new]', 'click', () => {
    state.lines = [];
    state.quote = null;
    state.mode = 'build';
    state.round = null;
    state.displayOrder = null;
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
  const balanceBefore = BigInt((state.session as SessionState).balanceChips);

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
    [32, 23],
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
    if (bar) bar.style.width = `${Math.min(100, fraction * 100)}%`;
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
  sound.lock(info.n, info.n);
  resolveLinesAt(info.n);

  // §9 step 5: the multiplier stamps over the tube. The figure is the round's
  // realised return multiple, computed on the server in chips because it is
  // arithmetic on money and this client does none.
  if (round.presentation?.multiplierStamp && round.presentation.stampMultipleDecimal)
    chamber.setStamp(round.presentation.stampMultipleDecimal, true);
  if (celebrate) {
    // The desaturation lifts as the burst blooms — the picture's version of §8's
    // "full-frequency return" on the closing lock. Leaving it down would make the
    // record screen, which is the round's receipt, read as switched off.
    chamber.desaturate(false);
    chamber.celebrate(voicing);
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
      round.presentation?.headline ?? ''
    }`,
  );

  state.mode = 'result';
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
  if (round.presentation?.balanceCountsUp)
    countBalanceUp(balanceBefore, BigInt((state.session as SessionState).balanceChips));
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
        )} min · net ${esc(signedCredits(BigInt(session.netChips)))}</p>`,
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
    const cta = app().querySelector<HTMLButtonElement>('.cta');
    const closed =
      state.lobby?.clientClosesAt !== undefined && Date.now() >= state.lobby.clientClosesAt;
    if (cta) cta.disabled = closed || state.lines.length === 0;
  }, 200);
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<pre style="padding:24px;color:#ff6b6b;font-family:monospace">${esc(
    message,
  )}</pre>`;
});
