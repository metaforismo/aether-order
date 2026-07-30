/**
 * S2 — the picker sheet. docs/DESIGN.md §5 S2.
 *
 * The rule the sheet is built to is **one tap per thing you are claiming**: a
 * BEFORE line is two claims and costs two taps; a FULL ORDER line is a claim
 * about every sphere and costs `n − 1`, because the last sphere places itself.
 * Nothing is ever more taps than it is decisions.
 *
 * Every drag has a tap equivalent (§11) — in fact nothing here uses a drag at
 * all — and the live sentence, not the icon row, is the confirmation.
 */

import { sound } from './audio.js';
import { claimSentence, paramsFor, type Params } from './claims.js';
import { credits } from './money.js';
import { orbSvg } from './sphere.js';
import type { BetInfo, VariantInfo } from './types.js';
import { esc, html, on, openSheet } from './ui.js';

export interface PickerOptions {
  variant: VariantInfo;
  bet: BetInfo;
  stakeChips: bigint;
  ladder: bigint[];
  onAdd: (params: Params, stakeChips: bigint) => void;
}

const WELL_LABELS: Readonly<Record<string, [string, string]>> = Object.freeze({
  before: ['FIRST PICK', 'SECOND PICK'],
  stack: ['LOWER', 'DIRECTLY ABOVE'],
  opening: ['FIRST PICK', 'SECOND PICK'],
  neighbours: ['EITHER ORDER', 'EITHER ORDER'],
});

export function openPicker(options: PickerOptions): void {
  const { variant, bet } = options;
  const { n } = variant;
  let picks: number[] = [];
  let slot: number | null = null;
  let stake = options.stakeChips;
  let note = '';

  /*
   * The colour token is the sphere itself.
   *
   * Not a glyph in a coloured box: the same orb the chamber renders, from the
   * same gradient master (`sphere.ts`), so a player who taps AMBER here has
   * already met the object that will land in the tube. The etched glyph rides on
   * it because §6.1 proves seven colours clearing the 4.5:1 floor cannot be
   * separated by luminance, and the name is written underneath because colour is
   * never the only channel (§11).
   */
  const colourToken = (index: number, disabled: boolean, pressed: boolean): string => {
    const element = variant.elements[index];
    if (!element) return '';
    return `<button class="colour" data-colour="${index}" ${
      disabled ? 'disabled' : ''
    } aria-pressed="${pressed}" aria-label="${esc(element.name)}">
      ${orbSvg(element, 30)}
      <span>${esc(element.name)}</span>
    </button>`;
  };

  const colourRow = (used: number[]): string =>
    `<div class="colour-row">${variant.elements
      .map((_element, index) => colourToken(index, used.includes(index), picks.includes(index)))
      .join('')}</div>`;

  const tubeCells = (count: number, labels: string[] | null): string => {
    const cells: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const filled = picks[index];
      const element = filled === undefined ? null : variant.elements[filled];
      cells.push(`<button class="slot-cell" data-cell="${index}" data-filled="${element ? 'true' : 'false'}">
        <small>${esc(labels ? (labels[index] ?? '') : index + 1)}</small>
        ${element ? `${orbSvg(element, 26)}<b>${esc(element.name)}</b>` : '<span>—</span>'}
      </button>`);
    }
    return `<div class="slot-strip">${cells.join('')}</div>`;
  };

  const slotStrip = (): string => {
    const cells: string[] = [];
    for (let index = 0; index < n; index += 1) {
      const chosen = slot === index && picks[0] !== undefined;
      const element = chosen ? variant.elements[picks[0] as number] : null;
      cells.push(`<button class="slot-cell" data-slot="${index}" data-filled="${
        chosen ? 'true' : 'false'
      }" aria-pressed="${slot === index}" aria-label="Slot ${index + 1}">
        <small>${index + 1}</small>
        ${element ? `${orbSvg(element, 26)}<b>${esc(element.name)}</b>` : '<span>—</span>'}
      </button>`);
    }
    return `<div class="slot-strip">${cells.join('')}</div>`;
  };

  const currentParams = (): Params | null => paramsFor(bet.code, picks, slot, n);

  const body = (): string => {
    const params = currentParams();
    const sentence = params ? claimSentence(variant, bet.code, params) : '';
    const hint =
      bet.shape === 'E'
        ? 'Tap a colour and it falls into the lowest empty slot. When one is left it places itself.'
        : bet.shape === 'D'
          ? 'Tap a colour to drop it into the lowest empty place. Tap a filled place to take it back.'
          : bet.shape === 'C'
            ? bet.code === 'neighbours'
              ? 'Two colours, side by side. The order does not matter.'
              : 'Two colours, in the order you mean them.'
            : bet.shape === 'B'
              ? 'Pick a colour, then pick the slot on the tube.'
              : 'Pick one colour.';

    let picker = '';
    if (bet.shape === 'A') picker = colourRow([]);
    else if (bet.shape === 'B') picker = `${colourRow([])}${slotStrip()}`;
    else if (bet.shape === 'C') {
      const labels = WELL_LABELS[bet.code] ?? ['FIRST PICK', 'SECOND PICK'];
      picker = `<div class="wells">${[0, 1]
        .map((index) => {
          const element = picks[index] === undefined ? null : variant.elements[picks[index] as number];
          return `<button class="well" data-cell="${index}" data-filled="${element ? 'true' : 'false'}">
            <span>${esc(labels[index] ?? '')}</span>
            ${
              element
                ? `${orbSvg(element, 30)}<b>${esc(element.name)}</b>`
                : '<b class="well__hint">tap a colour</b>'
            }
          </button>`;
        })
        .join('')}</div>${colourRow(picks)}`;
    } else if (bet.shape === 'D')
      picker = `${tubeCells(3, ['1st', '2nd', '3rd'])}${colourRow(picks)}`;
    else picker = `${tubeCells(n, null)}${colourRow(picks)}`;

    return `
      <p class="note">${esc(bet.rule)} <b class="lit">${esc(bet.multiplierDecimal)}</b> · ${esc(
        bet.probability ?? '',
      )} · pays the same 96% as every other chip.</p>
      <p class="note">${esc(hint)}</p>
      ${picker}
      ${bet.shape === 'E' ? '<div class="row"><button class="btn" data-randomise>RANDOMISE</button><button class="btn btn--quiet" data-clear>CLEAR</button></div>' : ''}
      <p class="sentence">${sentence ? esc(sentence) : '<em>make your picks</em>'}</p>
      ${note ? `<p class="note note--warn">${esc(note)}</p>` : ''}`;
  };

  const foot = (): string => {
    const params = currentParams();
    const ready = params !== null;
    return `
      <div class="stepper">
        <small>STAKE</small>
        <button data-stake="down" aria-label="Lower stake">−</button>
        <b>${credits(stake)}</b>
        <button data-stake="up" aria-label="Raise stake">+</button>
      </div>
      <button class="cta" data-add ${ready ? '' : 'disabled'}>ADD ${credits(stake)}</button>`;
  };

  openSheet({
    title: bet.name,
    subtitle: `${bet.tier} · ${bet.picks}`,
    full: bet.shape === 'D' || bet.shape === 'E',
    body: body(),
    foot: foot(),
    onMount(root, close) {
      const bodyNode = root.querySelector('.sheet__body') as HTMLElement;
      const footNode = root.querySelector('.sheet__foot') as HTMLElement;

      const redraw = (): void => {
        bodyNode.innerHTML = body();
        footNode.innerHTML = foot();
        wire();
      };

      const placeColour = (index: number): void => {
        note = '';
        if (bet.shape === 'A') picks = [index];
        else if (bet.shape === 'B') picks = [index];
        else {
          const limit = bet.shape === 'C' ? 2 : bet.shape === 'D' ? 3 : n;
          if (picks.includes(index)) picks = picks.filter((pick) => pick !== index);
          else if (picks.length < limit) picks = [...picks, index];
          // FULL ORDER: the last sphere places itself. A permutation of n things
          // is n-1 free choices, and the picker teaches that rather than hiding it.
          if (bet.shape === 'E' && picks.length === n - 1) {
            const remaining = variant.elements
              .map((_element, elementIndex) => elementIndex)
              .find((candidate) => !picks.includes(candidate));
            if (remaining !== undefined) {
              picks = [...picks, remaining];
              note = 'only one left — it placed itself';
            }
          }
        }
        redraw();
      };

      const wire = (): void => {
        on(bodyNode, '[data-colour]', 'click', (_event, node) =>
          placeColour(Number(node.dataset.colour)),
        );
        on(bodyNode, '[data-slot]', 'click', (_event, node) => {
          slot = Number(node.dataset.slot);
          redraw();
        });
        on(bodyNode, '[data-cell]', 'click', (_event, node) => {
          const cell = Number(node.dataset.cell);
          if (picks[cell] !== undefined) {
            picks = picks.filter((_pick, index) => index !== cell);
            note = '';
            redraw();
          }
        });
        on(bodyNode, '[data-randomise]', 'click', () => {
          const order = variant.elements.map((_element, index) => index);
          const random = new Uint32Array(order.length);
          crypto.getRandomValues(random);
          for (let index = order.length - 1; index > 0; index -= 1) {
            const swap = (random[index] as number) % (index + 1);
            [order[index], order[swap]] = [order[swap] as number, order[index] as number];
          }
          picks = order;
          note = 'a random order — no better or worse than the one you would have picked';
          redraw();
        });
        on(bodyNode, '[data-clear]', 'click', () => {
          picks = [];
          note = '';
          redraw();
        });
        on(footNode, '[data-stake]', 'click', (_event, node) => {
          const index = options.ladder.findIndex((step) => step === stake);
          const next =
            node.dataset.stake === 'up'
              ? options.ladder[Math.min(options.ladder.length - 1, index + 1)]
              : options.ladder[Math.max(0, index - 1)];
          stake = next ?? stake;
          footNode.innerHTML = foot();
          wire();
        });
        on(footNode, '[data-add]', 'click', () => {
          const params = currentParams();
          if (!params) return;
          // Confirmation of a claim being added, never a cue about its quality.
          sound.tick();
          options.onAdd(params, stake);
          close();
        });
      };

      wire();
    },
  });
}

export function stakeLadder(variant: VariantInfo): bigint[] {
  return variant.limits.stakeLadderChips.map((value) => BigInt(value));
}

export { html };
