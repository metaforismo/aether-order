/**
 * S3, S6, S7, S8, S9 and the reality-check modal.
 *
 * The two screens with rules rather than layout are S6 and S9:
 *
 *  - S6 draws the receipt in **three** states, because the verifier has three
 *    (docs/ENGINE.md §7.8). The middle one — bindings intact, signature not
 *    checked on this device — is neither a pass nor an error, and drawing it in
 *    the colour of either is the defect. It is reached by reading
 *    `bindingsVerified`, never `ok`.
 *  - S9 shows the operator's reality-check schedule first, as a published fact
 *    with no toggle beside it, and the player's control below it can only make
 *    the checks more frequent (docs/DESIGN.md §10, `tighten-only`).
 */

import { api } from './api.js';
import { claimSummary, elementHex, type Params } from './claims.js';
import { glyphSvg } from './glyphs.js';
import { credits, signedCredits } from './money.js';
import type { Catalogue, HistoryRow, RoundView, SessionState, VariantInfo } from './types.js';
import { esc, html, on, openModal, openSheet, toast } from './ui.js';
import {
  verifyReceiptLocally,
  verifyTranscriptLocally,
  type ExpectedAdapter,
} from './verify.js';

const short = (hash: string, keep = 16): string =>
  hash.length <= keep ? hash : `${hash.slice(0, keep / 2)}…${hash.slice(-keep / 2)}`;

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast(`Could not copy ${what.toLowerCase()}`);
  }
}

/* ------------------------------------------------------------------ S3 ---- */

export interface TicketLine {
  code: string;
  params: Params;
  stakeChips: bigint;
}

export function openTicketReview(options: {
  variant: VariantInfo;
  lines: TicketLine[];
  bestOutcomeChips: bigint;
  everyLineCanHitTogether: boolean;
  onRemove: (index: number) => void;
  onClearAll: () => void;
}): void {
  const { variant } = options;
  const rows = options.lines
    .map((line, index) => {
      const bet = variant.bets.find((candidate) => candidate.code === line.code);
      const multiplier = bet?.multiplierDecimal ?? '';
      const returnIfHit =
        (line.stakeChips * BigInt((bet?.multiplier ?? '0/1').split('/')[0] ?? '0')) /
        BigInt((bet?.multiplier ?? '0/1').split('/')[1] ?? '1');
      return `<div class="history-row">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <b style="letter-spacing:.06em">${esc(bet?.name ?? line.code)}</b>
          <span style="color:var(--ink-dim)">${esc(claimSummary(variant, line.code, line.params))}</span>
        </div>
        <div class="net" style="text-align:right">
          <div>${esc(credits(line.stakeChips))} × ${esc(multiplier)}</div>
          <div style="color:var(--ink-dim)">returns ${esc(credits(returnIfHit))}</div>
        </div>
        <button class="btn btn--quiet" data-remove="${index}" style="flex:none;width:44px;height:44px">×</button>
      </div>`;
    })
    .join('');

  openSheet({
    title: 'Ticket',
    subtitle: `${options.lines.length} line${options.lines.length === 1 ? '' : 's'}`,
    body: `${rows || '<p class="note">No lines yet.</p>'}
      <div class="card">
        <h3>Best possible outcome</h3>
        <b style="font-size:var(--t-lg)">${esc(credits(options.bestOutcomeChips))}</b>
        <p class="note">The most this exact ticket can return on any settled order — a maximum over the ${
          variant.permutationCount
        } orders, not the sum of every line's return-if-hit.${
          options.everyLineCanHitTogether
            ? ' On this ticket every line can hit together, so the two happen to agree.'
            : ' Some of these lines cannot hit together, so their sum is an amount the game cannot pay.'
        }</p>
      </div>`,
    foot: '<button class="btn btn--wide" data-clear-all>CLEAR ALL</button>',
    onMount(root, close) {
      on(root, '[data-remove]', 'click', (_event, node) => {
        options.onRemove(Number(node.dataset.remove));
        close();
      });
      on(root, '[data-clear-all]', 'click', (_event, node) => {
        if (node.dataset.confirm !== 'yes') {
          node.dataset.confirm = 'yes';
          node.textContent = 'TAP AGAIN TO CLEAR ALL';
          return;
        }
        options.onClearAll();
        close();
      });
    },
  });
}

/* ------------------------------------------------------------------ S6 ---- */

export async function openFairness(options: {
  sessionId: string;
  round: RoundView;
  operatorKeyHex: string | null;
  /** The adapter this client holds, so a transcript from another one fails. */
  adapter: ExpectedAdapter;
  onVerified?: () => void;
}): Promise<void> {
  let round = options.round;
  let serverVerification: { ok: boolean; code?: string; path?: string } | null = null;
  let snapshot = '';

  if (round.phase === 'SETTLED' && !round.serverSeed) {
    const revealed = await api.reveal(options.sessionId, round.roundId);
    round = revealed.round;
    serverVerification = revealed.verification;
    snapshot = revealed.snapshot;
  }

  const transcript = round.transcript;
  const local = transcript && round.serverSeed
    ? await verifyTranscriptLocally(round.serverSeed, transcript, options.adapter)
    : null;
  // The receipt is checked against the ticket and the settlement THIS SCREEN is
  // showing, not merely against itself (docs/ENGINE.md §7.8).
  const receiptResult =
    round.receipt && transcript
      ? await verifyReceiptLocally(
          round.receipt,
          transcript,
          options.operatorKeyHex,
          round.settlement
            ? { lines: round.lines, settlement: round.settlement }
            : undefined,
        )
      : null;

  if (local?.ok) options.onVerified?.();

  const transcriptState = !local
    ? '<span class="state state--neutral">SEED NOT REVEALED YET</span>'
    : local.ok
      ? '<span class="state state--gold">◈ VERIFIED LOCALLY</span>'
      : `<span class="state state--error">${esc(local.code ?? 'FAILED')} · ${esc(local.detail)}</span>`;

  const receiptState = !receiptResult
    ? '<span class="state state--neutral">NO RECEIPT</span>'
    : receiptResult.state === 'verified'
      ? '<span class="state state--ok">SIGNATURE VERIFIED</span>'
      : receiptResult.state === 'unchecked'
        ? '<span class="state state--neutral">SIGNATURE NOT CHECKED ON THIS DEVICE</span>'
        : `<span class="state state--error">RECEIPT DOES NOT MATCH THIS ROUND · ${esc(receiptResult.path)}</span>`;

  const kv = (rows: [string, string][]): string =>
    `<dl class="kv">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;

  openSheet({
    title: 'Fairness',
    subtitle: round.roundId,
    full: true,
    body: `
      <div class="card">
        <h3>The draw</h3>
        ${transcriptState}
        ${kv([
          ['seed commitment', short(round.seedCommitment, 24)],
          ['round id', round.roundId],
          ['nonce', String(round.nonce)],
          ['client seed', round.clientSeed === '' ? '(empty)' : round.clientSeed],
          ['server seed', round.serverSeed ? short(round.serverSeed, 24) : 'not revealed'],
          ['permutation', transcript ? transcript.permutation.join(' · ') : '—'],
          ['commitment', short(round.transcript?.commitment ?? '', 24)],
          ['previous', short(round.previousCommitment, 24)],
          ['adapter', `${round.transcript?.adapterVersion ?? ''} · ${short(round.transcript?.adapterFingerprint ?? '', 16)}`],
        ])}
        <p class="note">Your device re-derived the permutation from (server seed, your seed, round id, nonce) and recomputed both hashes. It did not ask the server whether the round was fair.${
          serverVerification ? ` The server's own check: ${serverVerification.ok ? 'ok' : esc(serverVerification.code ?? 'failed')}.` : ''
        }</p>
        <div class="row">
          <button class="btn" data-copy-transcript>⧉ COPY TRANSCRIPT</button>
        </div>
      </div>

      <div class="card">
        <h3>Your bet</h3>
        ${receiptState}
        ${kv([
          ['ticket digest', short(round.receipt?.ticketDigest ?? '', 24)],
          ['settlement digest', short(round.receipt?.settlementDigest ?? '', 24)],
          ['receipt digest', short(round.receipt?.digest ?? '', 24)],
          ['signer', round.receipt?.signerId ?? '—'],
          ['staked', round.settlement ? credits(BigInt(round.settlement.totalStakeChips)) : '—'],
          ['credited', round.settlement ? credits(BigInt(round.settlement.creditedChips)) : '—'],
        ])}
        <p class="note">The transcript proves the draw was fair. This receipt is the operator's signature on what you staked and what you were paid — a different kind of guarantee, and one that depends on their key.</p>
        <div class="row">
          <button class="btn" data-copy-receipt>⧉ COPY RECEIPT</button>
        </div>
      </div>

      <details class="card">
        <summary style="cursor:pointer;color:var(--ink-dim);font-size:var(--t-xs);letter-spacing:.08em;text-transform:uppercase">How this works</summary>
        <ol class="note" style="padding-left:18px;display:flex;flex-direction:column;gap:6px">
          <li>Before you bet, the server drew a secret seed and published a hash of it together with the variant, the round id and the nonce. None of it can change afterwards.</li>
          <li>You added your own seed. It changes <em>which</em> order comes up and never your odds — every seed gives the same uniform draw.</li>
          <li>At commit the permutation was fixed. Nothing after that point was a decision.</li>
          <li>After settlement the seed was published, and your device recomputed the order and both hashes itself.</li>
        </ol>
        <p class="note">All bets pay a theoretical 96%. No bet, seed, or pattern of play changes that.</p>
      </details>
      ${snapshot ? `<p class="note">Round snapshot: ${snapshot.length} bytes, canonical JSON, money as integer strings.</p>` : ''}`,
    onMount(root) {
      on(root, '[data-copy-transcript]', 'click', () => {
        void copy(round.transcriptJson ?? JSON.stringify(transcript, null, 2), 'Transcript');
      });
      on(root, '[data-copy-receipt]', 'click', () => {
        void copy(JSON.stringify(round.receipt, null, 2), 'Receipt');
      });
    },
  });
}

/* ------------------------------------------------------------------ S7 ---- */

export function openHistory(options: {
  variant: VariantInfo;
  catalogue: Catalogue;
  rounds: HistoryRow[];
  session: SessionState;
  onOpenRound: (roundId: string) => void;
}): void {
  const minutes = Math.floor(options.session.elapsedMs / 60_000);
  const rows = options.rounds
    .map((row) => {
      const variant = options.catalogue.variants[row.variantId];
      const dots = (row.permutation ?? [])
        .map(
          (element) =>
            `<i style="background:${esc(variant.elements[element]?.hex ?? '#fff')}"></i>`,
        )
        .join('');
      const net = row.netChips === null ? 0n : BigInt(row.netChips);
      return `<button class="history-row" data-round="${esc(row.roundId)}">
        <span class="perm">${dots}</span>
        <span style="color:var(--ink-dim)">${row.lineCount} line${row.lineCount === 1 ? '' : 's'} · ${esc(
          row.source === 'lobby' ? 'shared' : 'solo',
        )}</span>
        <span class="net ${net > 0n ? 'net--up' : ''}">${esc(signedCredits(net))}</span>
      </button>`;
    })
    .join('');

  openSheet({
    title: 'History',
    subtitle: `${minutes} min played · net ${signedCredits(BigInt(options.session.netChips))}`,
    full: true,
    body: `
      <div class="card">
        <h3>This session</h3>
        <dl class="kv">
          <dt>elapsed</dt><dd>${minutes} min</dd>
          <dt>rounds</dt><dd>${options.session.roundsPlayed}</dd>
          <dt>staked</dt><dd>${esc(credits(BigInt(options.session.stakedChips)))}</dd>
          <dt>returned</dt><dd>${esc(credits(BigInt(options.session.creditedChips)))}</dd>
          <dt>net</dt><dd>${esc(signedCredits(BigInt(options.session.netChips)))}</dd>
        </dl>
        <p class="note">Rounds and net position. Never wins, never a streak — a frequency display manufactures a pattern that is not there.</p>
      </div>
      ${rows || '<p class="note">No rounds yet.</p>'}`,
    onMount(root, close) {
      on(root, '[data-round]', 'click', (_event, node) => {
        close();
        options.onOpenRound(node.dataset.round as string);
      });
    },
  });
}

/* ------------------------------------------------------------------ S8 ---- */

export function openPaytable(variant: VariantInfo): void {
  const rows = variant.bets
    .map(
      (bet) => `<tr>
        <td><b style="letter-spacing:.06em">${esc(bet.name)}</b></td>
        <td style="color:var(--ink-dim)">${esc(bet.tier)}</td>
        <td class="num">${esc(bet.probability ?? '')}</td>
        <td class="num">${esc(bet.multiplierDecimal)}</td>
        <td class="num" style="color:var(--ink-dim)">${esc(bet.rtp ?? '')}</td>
      </tr>`,
    )
    .join('');

  const spellingName = (code: string): string =>
    variant.bets.find((bet) => bet.code === code)?.name ?? code;
  const aliases = variant.claimAliases
    .slice(0, 4)
    .map((group) =>
      esc(
        group.spellings
          .map((spelling) =>
            spelling.params
              ? `${spellingName(spelling.code)} ${claimSummary(variant, spelling.code, spelling.params as Params)}`
              : spelling.label,
          )
          .join('  ≡  '),
      ),
    )
    .join('<br>');

  openSheet({
    title: 'Paytable',
    subtitle: `${variant.displayName} · ${variant.permutationCount} possible orders`,
    full: true,
    body: `
      <p class="note">Every bet pays a theoretical <b style="color:var(--ink)">96.000%</b>. The tiers are how wild the ride is, not how good the deal is.</p>
      <table class="paytable">
        <thead><tr><th>Chip</th><th>Tier</th><th>Probability</th><th>Pays</th><th>RTP</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="card">
        <h3>These two chips are the same bet</h3>
        <p class="note" style="font-family:var(--mono)">${aliases}</p>
        <p class="note">${variant.claimAliases.length} pairs in ${esc(variant.displayName)}. Tapping the second one raises the first line's stake instead of adding a row — using the convenience control never costs anything.</p>
      </div>
      <div class="card">
        <h3>The most a ticket can return</h3>
        <b style="font-size:var(--t-lg)">${esc(String(variant.roundCredit.maxTicketReturnMultipleDecimal))}</b>
        <p class="note">The largest credit any legal ticket can produce: ${esc(
          credits(BigInt(String(variant.roundCredit.maxTicketReturnCreditChips))),
        )} on a ${esc(credits(BigInt(String(variant.roundCredit.maxTicketReturnStakeChips))))} ticket of ${esc(
          String(variant.roundCredit.maxTicketReturnLines),
        )} lines. The ${esc(String(variant.roundCredit.liabilityCapMultipleOfTicketStake))}× round cap is a liability guard, is inert, and is not a prize.</p>
      </div>`,
  });
}

/* ------------------------------------------------------------------ S9 ---- */

export function openLimits(options: {
  catalogue: Catalogue;
  session: SessionState;
  onChange: (patch: Record<string, unknown>) => void;
}): void {
  const policy = options.catalogue.playPolicy;
  const session = options.session;
  const optionButtons = policy.playerRealityCheckIntervalOptions
    .map(
      (minutes) =>
        `<button class="btn" data-rc="${minutes}" aria-pressed="${
          session.playerRealityCheckMinutes === minutes
        }">${minutes} min</button>`,
    )
    .join('');

  openSheet({
    title: 'Limits & play controls',
    full: true,
    body: `
      <div class="card">
        <h3>Pacing, as published</h3>
        <p class="note">Minimum ${policy.minRoundCycleMs / 1000} seconds between bets; maximum ${
          policy.maxRoundsPerRollingHour
        } rounds per hour; no autoplay.</p>
        <dl class="kv">
          <dt>rounds this hour</dt><dd>${session.roundsInRollingHour}</dd>
          <dt>remaining</dt><dd>${session.roundsRemainingInHour}</dd>
          <dt>autoplay</dt><dd>${esc(policy.autoplay)}</dd>
          <dt>skip</dt><dd>presentation only</dd>
        </dl>
        <p class="note">SKIP shortens the animation and never the cycle. The wait unlocks; it never expires into a bet.</p>
      </div>

      <div class="card">
        <h3>Reality checks</h3>
        <p class="note">Operator schedule: <b style="color:var(--ink)">${policy.realityCheckMinutes.join(
          ' and ',
        )} minutes, then every ${policy.realityCheckRecurrenceMinutes} minutes</b>, for as long as the session lasts.</p>
        <p class="note">Check in more often:</p>
        <div class="row">${optionButtons}<button class="btn" data-rc="off" aria-pressed="${
          session.playerRealityCheckMinutes === null
        }">OFF</button></div>
        <p class="note">These are extra checks on top of the ones above — you cannot switch those off.</p>
      </div>

      <div class="card">
        <h3>Session limit</h3>
        <p class="note">Stop me betting after a number of minutes. Currently ${
          session.limits.sessionMinutes === null ? 'not set' : `${session.limits.sessionMinutes} min`
        }.</p>
        <div class="row">
          ${[15, 30, 60]
            .map((minutes) => `<button class="btn" data-session-limit="${minutes}">${minutes} min</button>`)
            .join('')}
          <button class="btn btn--quiet" data-session-limit="off">CLEAR</button>
        </div>
      </div>

      <div class="card">
        <h3>Loss limit</h3>
        <p class="note">Stop me betting once this session is down by this much. Currently ${
          session.limits.lossChips === null ? 'not set' : credits(BigInt(session.limits.lossChips))
        }.</p>
        <div class="row">
          ${['2500', '5000', '10000']
            .map(
              (chips) =>
                `<button class="btn" data-loss-limit="${chips}">${esc(credits(BigInt(chips)))}</button>`,
            )
            .join('')}
          <button class="btn btn--quiet" data-loss-limit="off">CLEAR</button>
        </div>
      </div>

      <div class="card">
        <h3>Taking a longer break</h3>
        <p class="note">Self-exclusion is handled by the operator, not by this game. In a live deployment this hands off to their account tools and cannot be undone from here.</p>
        <button class="btn btn--wide" data-self-exclude>SELF-EXCLUSION HAND-OFF</button>
      </div>`,
    onMount(root, close) {
      on(root, '[data-rc]', 'click', (_event, node) => {
        const value = node.dataset.rc;
        options.onChange({ playerRealityCheckMinutes: value === 'off' ? null : Number(value) });
        close();
      });
      on(root, '[data-session-limit]', 'click', (_event, node) => {
        const value = node.dataset.sessionLimit;
        options.onChange({ sessionMinutes: value === 'off' ? null : Number(value) });
        close();
      });
      on(root, '[data-loss-limit]', 'click', (_event, node) => {
        const value = node.dataset.lossLimit;
        options.onChange({ lossChips: value === 'off' ? null : value });
        close();
      });
      on(root, '[data-self-exclude]', 'click', () => {
        toast('Graybox: a live build hands off to the operator here.');
      });
    },
  });
}

/* -------------------------------------------------------- reality check ---- */

export function openRealityCheck(options: {
  session: SessionState;
  onKeepPlaying: () => void;
  onTakeABreak: () => void;
}): void {
  const check = options.session.realityCheck;
  openModal(
    `<h2>Reality check</h2>
     <dl class="kv">
       <dt>time played</dt><dd>${check.elapsedMinutes} min</dd>
       <dt>total staked</dt><dd>${esc(credits(BigInt(check.stakedChips)))}</dd>
       <dt>net</dt><dd>${esc(signedCredits(BigInt(check.netChips)))}</dd>
     </dl>
     <div class="row">
       <button class="btn" data-keep>KEEP PLAYING</button>
       <button class="btn" data-break>TAKE A BREAK</button>
     </div>`,
    (root, close) => {
      on(root, '[data-keep]', 'click', () => {
        close();
        options.onKeepPlaying();
      });
      on(root, '[data-break]', 'click', () => {
        close();
        options.onTakeABreak();
      });
    },
  );
}

/* ------------------------------------------------------------- variant ---- */

export function openVariantSheet(options: {
  catalogue: Catalogue;
  current: 'classic' | 'seven';
  onPick: (variantId: 'classic' | 'seven') => void;
}): void {
  const card = (id: 'classic' | 'seven'): string => {
    const variant = options.catalogue.variants[id];
    const full = variant.bets.find((bet) => bet.code === 'full');
    return `<button class="card" data-variant="${id}" style="text-align:left;border-color:${
      options.current === id ? 'var(--ink)' : 'rgba(65,75,88,.6)'
    }">
      <h3>${esc(variant.displayName)}</h3>
      <p class="note"><b style="color:var(--ink)">${variant.n} spheres</b> · ${
        variant.permutationCount
      } possible orders · FULL ORDER pays ${esc(full?.multiplierDecimal ?? '')}</p>
      <p class="note">${
        id === 'seven'
          ? 'More spheres, bigger prizes, same 96%.'
          : 'Five spheres. The default, and never the worse deal.'
      }</p>
      <div style="display:flex;gap:6px">${variant.elements
        .map((element) => glyphSvg(element.glyph, 18, element.hex))
        .join('')}</div>
    </button>`;
  };

  openSheet({
    title: 'Variant',
    body: `${card('classic')}${card('seven')}
      <p class="note">Switching is free and instant, and changes nothing about the 96.000% — every multiplier except BEFORE re-prices because every probability except BEFORE's one-in-two depends on how many spheres there are.</p>`,
    onMount(root, close) {
      on(root, '[data-variant]', 'click', (_event, node) => {
        close();
        options.onPick(node.dataset.variant as 'classic' | 'seven');
      });
    },
  });
}

/* --------------------------------------------------------- state panel ---- */

export function statePanel(message: string, detail: string, action: string, dataAttr: string): string {
  return `<div class="state-panel">
    <b>${esc(message)}</b>
    <span>${esc(detail)}</span>
    <button class="btn btn--wide" ${dataAttr}>${esc(action)}</button>
  </div>`;
}

export { html, elementHex };
