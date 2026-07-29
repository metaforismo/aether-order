/**
 * AETHER ORDER — the client.
 *
 * Screen flow is docs/DESIGN.md §5: S1 TABLE is the home screen and everything
 * needed to play sits in the thumb zone; S2 is the picker; S4 is the round with
 * the ticket strip pinned so lines resolve lock by lock; S5 reports the result
 * through the server's celebration gate and never through a comparison of its
 * own; S6 to S10 are sheets. The chamber is placeholder art (see chamber.ts);
 * the information architecture is not.
 *
 * The client computes no money. Stakes, payouts, the best-possible-outcome
 * figure and the win/lose verdict all arrive from the service, which gets them
 * from the engine.
 */

import './styles.css';
import { ApiFailure, api, type TicketLineInput } from './api.js';
import { Chamber } from './chamber.js';
import { claimKey, claimSummary, elementName, type Params } from './claims.js';
import { glyphSvg } from './glyphs.js';
import { credits, signedCredits } from './money.js';
import { openPicker, stakeLadder } from './picker.js';
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
import { announce, closeAllSheets, esc, on, reducedMotion, sleep, toast } from './ui.js';

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
};

let chamber: Chamber;
let quoteTimer: number | undefined;
let floorTimer: number | undefined;
let lobbySource: EventSource | null = null;

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
    <header class="rail">
      <button class="icon-btn" data-menu aria-label="Menu">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11 12 5l8 6v8H4z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
      <span class="rail__balance"><b data-balance>—</b><span>balance</span></span>
      <button class="variant-toggle" data-variant>CLASSIC</button>
      <span class="badge">free play</span>
      <button class="icon-btn fairness-chip" data-fairness aria-label="Fairness" data-state="idle">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 9l3 3-3 3-3-3z" fill="currentColor"/></svg>
      </button>
    </header>
    <div data-cadence></div>
    <main class="stage" id="stage"></main>
    <section class="deck" id="deck"></section>`;

  chamber = new Chamber(document.getElementById('stage') as HTMLElement);
  chamber.render(variant());

  on(app(), '[data-menu]', 'click', () => openMenu());
  on(app(), '[data-variant]', 'click', () => {
    if (state.mode === 'round') return;
    openVariantSheet({
      catalogue: catalogue,
      current: (state.session as SessionState).variantId,
      onPick: (variantId) => void switchVariant(variantId),
    });
  });
  on(app(), '[data-fairness]', 'click', () => void openFairnessForLast());

  await openRound();
  render();

  const splash = document.getElementById('splash');
  splash?.classList.add('splash--out');
  window.setTimeout(() => splash?.setAttribute('hidden', ''), 220);
  app().removeAttribute('hidden');
}

/* -------------------------------------------------------------- plumbing -- */

function setSession(session: SessionState): void {
  state.session = session;
  if (session.realityCheck.due) showRealityCheck();
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

function render(): void {
  const session = state.session;
  if (!session) return;
  const info = variant();
  app().dataset.mode = state.mode;

  const balance = app().querySelector('[data-balance]') as HTMLElement;
  balance.textContent = credits(BigInt(session.balanceChips));
  const toggle = app().querySelector('[data-variant]') as HTMLElement;
  toggle.textContent = info.label;
  const chip = app().querySelector('[data-fairness]') as HTMLElement;
  chip.dataset.state = state.verified ? 'verified' : session.openRound ? 'committed' : 'idle';

  const cadence = app().querySelector('[data-cadence]') as HTMLElement;
  cadence.innerHTML = state.place === 'lobby' ? cadenceMarkup() : '';

  const deck = document.getElementById('deck') as HTMLElement;
  deck.innerHTML =
    state.mode === 'round' ? roundDeck() : state.mode === 'result' ? resultDeck() : buildDeck();
  wireDeck(deck);
  if (state.mode === 'build') startFloorTicker();
}

/**
 * The pinned ticket strip.
 *
 * `live` renders every line undecided and lets the choreography change each one
 * at the lock that decided it; `final` is the record on S5, where the states are
 * already known. Won and lost lines carry identical weight — the difference is
 * colour and opacity, which is the information itself, and losing lines are
 * never swept away (§10).
 */
function pinnedLines(phase: 'live' | 'final'): string {
  const info = variant();
  const round = state.round;
  const rows = round
    ? round.lines.map((line) => ({
        name: line.name,
        summary: claimSummary(info, line.code, line.params),
        right: `${credits(BigInt(line.stakeChips))} × ${line.multiplierDecimal}`,
        state: phase === 'live' ? 'pending' : line.won === true ? 'won' : 'lost',
        returned: line.won === true && line.grossChips ? credits(BigInt(line.grossChips)) : null,
      }))
    : state.lines.map((line) => {
        const bet = info.bets.find((candidate) => candidate.code === line.code);
        return {
          name: bet?.name ?? line.code,
          summary: claimSummary(info, line.code, line.params),
          right: `${credits(line.stakeChips)} × ${bet?.multiplierDecimal ?? ''}`,
          state: 'pending',
          returned: null as string | null,
        };
      });

  return `<div class="lines">${rows
    .map(
      (row, index) =>
        `<div class="line" data-line="${index}" data-state="${row.state}">
          <b>${esc(row.name)}</b><span>${esc(row.summary)}</span><u>${esc(
            row.returned ? `returned ${row.returned}` : row.right,
          )}</u>
        </div>`,
    )
    .join('')}</div>`;
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

function chipRail(): string {
  const info = variant();
  const counts = new Map<string, number>();
  for (const line of state.lines) counts.set(line.code, (counts.get(line.code) ?? 0) + 1);
  return `<div class="rail-scroll">${info.bets
    .filter((bet) => bet.tier === state.tier)
    .map((bet) => {
      const count = counts.get(bet.code) ?? 0;
      return `<button class="chip" data-chip="${bet.code}" aria-label="${esc(
        `${bet.name}, ${bet.picks}, pays ${bet.multiplierDecimal}`,
      )}">
        ${count > 0 ? `<span class="chip__count">${count}</span>` : ''}
        <b>${esc(bet.name)}</b>
        <em>${esc(bet.picks)}</em>
        <u>${esc(bet.multiplierDecimal)}</u>
      </button>`;
    })
    .join('')}</div>`;
}

function ticketStrip(): string {
  const total = totalStake();
  const best = state.quote ? BigInt(state.quote.bestOutcomeChips) : 0n;
  return `<button class="strip" data-review title="best possible outcome: the most this exact ticket can return on any settled order">
    <b>${state.lines.length}</b> line${state.lines.length === 1 ? '' : 's'} ·
    <b>${esc(credits(total))}</b>
    <span class="strip__best">best <b>${esc(state.quote ? credits(best) : '—')}</b></span>
  </button>`;
}

function commitButton(): string {
  const session = state.session as SessionState;
  const total = totalStake();
  const waiting = session.commitAvailableInMs > 0;
  const lobbyClosed =
    state.place === 'lobby' &&
    state.lobby?.clientClosesAt !== undefined &&
    Date.now() >= state.lobby.clientClosesAt;
  const disabled = state.lines.length === 0 || waiting || lobbyClosed;
  const label = lobbyClosed ? 'BETTING CLOSED' : `COMMIT ${credits(total)}`;
  return `<button class="cta" data-commit ${disabled ? 'disabled' : ''}>
    ${esc(label)}
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
  return `
    ${state.place === 'lobby' ? presenceMarkup() : ''}
    ${tierTabs()}
    ${chipRail()}
    ${ticketStrip()}
    ${noticeMarkup()}
    ${commitButton()}
    <p class="footnote">Every bet pays 96%. The tiers are how wild the ride is, not how good the deal is.</p>`;
}

function roundDeck(): string {
  return `
    <div class="progress"><i data-progress></i></div>
    ${pinnedLines('live')}
    <div class="row">
      <button class="btn btn--quiet" data-skip>SKIP</button>
    </div>`;
}

function resultDeck(): string {
  const round = state.round as RoundView;
  const presentation = round.presentation;
  const session = state.session as SessionState;
  const waiting = session.commitAvailableInMs > 0;
  return `
    <div class="result-head" data-outcome="${esc(presentation?.outcome ?? '')}">
      <b>${esc(presentation?.headline ?? '')}</b>
      <span>${esc(
        round.transcript
          ? `settled order: ${round.transcript.permutation
              .map((element) => elementName(variant(), element).toLowerCase())
              .join(', ')}`
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
    <span>${(remaining / 1000).toFixed(1)}s</span>
  </div>`;
}

function presenceMarkup(): string {
  const presence = state.lobby?.presence;
  const info = variant();
  if (!presence) return '';
  return `<div class="ticker">
    <span style="width:100%;color:var(--ink)">IN THIS DRAW · ${presence.tickets} ticket${
      presence.tickets === 1 ? '' : 's'
    }</span>
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
  on(deck, '[data-skip]', 'click', () => {
    state.skipRequested = true;
    void api.settings((state.session as SessionState).id, { skip: true });
  });
  on(deck, '[data-rebet]', 'click', () => void rebet());
  on(deck, '[data-new]', 'click', () => {
    state.lines = [];
    state.quote = null;
    state.mode = 'build';
    state.round = null;
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
  try {
    if (state.place === 'lobby') {
      const roundId = state.lobby?.roundId;
      if (!roundId) return;
      const result = await api.lobbyCommit(session.id, roundId, lineInputs());
      setSession(result.session);
      state.round = result.round;
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
  state.lines = round.lines.map((line) => ({
    code: line.code,
    params: line.params as Params,
    stakeChips: BigInt(line.stakeChips),
  }));
  state.mode = 'build';
  state.round = null;
  chamber.reset();
  await openRound();
  refreshQuote();
  render();
  await commit();
}

/* --------------------------------------------------------- choreography -- */

async function playRound(round: RoundView): Promise<void> {
  const info = variant();
  const beats = (state.catalogue as Catalogue).choreography;
  const track = round.resolution;
  const permutation = round.transcript?.permutation ?? [];
  const celebrate = round.presentation?.celebrate === true;
  const reduced = reducedMotion();
  const stagger = info.staggerMs;
  const fall = reduced ? 120 : beats.fallMs;

  state.mode = 'round';
  state.skipRequested = (state.session as SessionState).skip;
  render();
  chamber.reset();

  const settleMs = (info.n - 2) * stagger + beats.fallMs + beats.reboundMs;
  const closeMs = celebrate ? beats.closeCelebratedMs : beats.closeNeutralMs;
  const naturalMs = beats.chargeMs + beats.agitateMs + settleMs + closeMs;
  // SKIP compresses beats 3-6 and nothing else. It never shortens the cycle.
  const scale = state.skipRequested ? beats.skipCompressedMs / naturalMs : 1;

  const setProgress = (fraction: number): void => {
    const bar = document.querySelector('[data-progress]') as HTMLElement | null;
    if (bar) bar.style.width = `${Math.min(100, fraction * 100)}%`;
  };

  const resolveLinesAt = (lock: number): void => {
    if (!track) return;
    for (const line of track.lines) {
      if (line.lock !== lock) continue;
      const node = document.querySelector(`[data-line="${line.index}"]`) as HTMLElement | null;
      if (node) node.dataset.state = line.verdict ? 'won' : 'lost';
    }
  };

  // docs/DESIGN.md §7.2: the choreography is a function of ELAPSED TIME, not of
  // frame index or of a chain of delays. Every beat has an absolute offset from
  // COMMIT, so a device that stalls — a backgrounded tab, a slow lane — time-
  // shifts and catches up. It never skips a lock and never truncates the close.
  const started = performance.now();
  const at = async (offset: number): Promise<void> => {
    const delay = started + offset - performance.now();
    if (delay > 0) await sleep(delay);
  };

  chamber.setBeat('charge');
  await at(beats.chargeMs * scale);
  chamber.setBeat('agitate');
  await at((beats.chargeMs + beats.agitateMs) * scale);
  chamber.setBeat('settle');

  const settleStart = (beats.chargeMs + beats.agitateMs) * scale;
  for (let lock = 1; lock <= info.n - 1; lock += 1) {
    await at(settleStart + (lock - 1) * stagger * scale);
    chamber.seat(lock, permutation[lock - 1] as number, fall * scale);
    await at(settleStart + ((lock - 1) * stagger + fall) * scale);
    chamber.lock(lock);
    resolveLinesAt(lock);
    // The hairline reaches full width at lock n-1: there is no information left.
    setProgress(lock / (info.n - 1));
  }

  const closeStart = settleStart + ((info.n - 2) * stagger + beats.fallMs + beats.reboundMs) * scale;
  await at(closeStart);
  chamber.setBeat('close');
  if (celebrate) chamber.igniteRim(true);
  const closeFall = celebrate ? beats.fallMs / 0.35 : beats.fallMs;
  chamber.seat(info.n, permutation[info.n - 1] as number, (reduced ? 120 : closeFall) * scale);
  await at(closeStart + closeFall * scale);
  chamber.lock(info.n);
  resolveLinesAt(info.n);

  if (round.presentation?.multiplierStamp && round.settlement)
    chamber.setStamp(credits(BigInt(round.settlement.creditedChips)), true);
  await at(closeStart + (closeFall + beats.stampMs) * scale);
  chamber.setBeat('done');

  announce(
    `Settled order: ${permutation.map((element) => elementName(info, element)).join(', ')}. ${
      round.presentation?.headline ?? ''
    }`,
  );

  state.mode = 'result';
  render();
  await openRound();
  render();
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
        <input id="seed-input" class="btn btn--wide" style="padding:0 10px" maxlength="64" value="${esc(
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
    chamber.reset();
    connectLobby();
  } else {
    state.place = 'solo';
    lobbySource?.close();
    lobbySource = null;
    state.mode = 'build';
    state.round = null;
    chamber.reset();
    await openRound();
  }
  render();
}

function connectLobby(): void {
  lobbySource?.close();
  const session = state.session as SessionState;
  lobbySource = new EventSource(`/api/lobby/stream?session=${encodeURIComponent(session.id)}`);
  const onState = (event: MessageEvent): void => {
    state.lobby = JSON.parse(event.data as string) as LobbyState;
    if (state.place === 'lobby' && state.mode === 'build') render();
  };
  lobbySource.addEventListener('state', onState as EventListener);
  lobbySource.addEventListener('presence', onState as EventListener);
  lobbySource.addEventListener('open', (event) => {
    onState(event as MessageEvent);
    if (state.place === 'lobby' && state.mode !== 'round') {
      state.mode = 'build';
      state.round = null;
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
    if (state.place === 'lobby' && state.mode === 'build') {
      const cadence = app().querySelector('[data-cadence]') as HTMLElement;
      cadence.innerHTML = cadenceMarkup();
    }
  }, 200);
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<pre style="padding:24px;color:#ff6b6b;font-family:monospace">${esc(
    message,
  )}</pre>`;
});
