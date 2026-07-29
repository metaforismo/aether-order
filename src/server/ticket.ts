/**
 * Ticket validation, the figure the player sees before committing, and the
 * celebration gate.
 *
 * Validation is the engine's: `openTicket` is the only path that decides what a
 * legal ticket is, so the quote a player sees and the ticket that gets debited
 * are validated by exactly one implementation, with one set of error codes.
 *
 * The headline figure is docs/DESIGN.md §4 / docs/MATH.md §8.1's **best possible
 * outcome** — a maximum over the n! settled orders, not the sum of every line's
 * return-if-hit, which for any ticket with mutually exclusive lines is an amount
 * the game cannot pay.
 */

import {
  exactPayout,
  openTicket,
  type Settlement,
  type Ticket,
} from '@axiom-games/reveal-engine/modules/permutation/aether';
import { roundPresentation } from '../../tools/lib/presentation.mjs';
import {
  familyFor,
  instanceFor,
  viewsFor,
  type PermutationGameDefinition,
  type VariantId,
} from './engine.js';
import { chipString, credits } from './money.js';

export interface QuoteLine {
  readonly code: string;
  readonly name: string;
  readonly tier: string;
  readonly label: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly stakeChips: string;
  readonly multiplierDecimal: string;
  readonly returnIfHitChips: string;
}

export interface TicketQuote {
  readonly variantId: string;
  readonly lineCount: number;
  readonly totalStakeChips: string;
  /** THE published figure. Labelled "best possible outcome", never "max". */
  readonly bestOutcomeChips: string;
  /** The settled order that attains it, so the figure is falsifiable. */
  readonly bestOutcomeOrder: string;
  readonly bestOutcomeWinningLines: number;
  readonly everyLineCanHitTogether: boolean;
  readonly lines: readonly QuoteLine[];
  readonly display: {
    readonly lines: string;
    readonly stake: string;
    readonly best: string;
  };
}

const QUOTE_CONTEXT = { roundId: 'quote', nonce: 0 };

/**
 * Validate a raw ticket through the engine and return the opened, canonically
 * ordered ticket. Throws `RevealEngineError` with the codes in
 * docs/ENGINE.md §9 for anything hostile or illegal.
 */
export function openForQuote(
  game: PermutationGameDefinition,
  lines: readonly { code: string; params: object; stake: bigint }[],
): Ticket {
  return openTicket(
    game,
    { variantId: game.variantId, roundId: QUOTE_CONTEXT.roundId, nonce: QUOTE_CONTEXT.nonce },
    { lines },
  );
}

export function multiplierDecimal(game: PermutationGameDefinition, code: string): string {
  const multiplier = game.pricing.multipliers[code];
  if (!multiplier) throw new RangeError(`No multiplier for ${code}`);
  // Every published multiplier terminates at two decimals (docs/MATH.md §5).
  const scaled = (multiplier.numerator * 100n) / multiplier.denominator;
  if (scaled * multiplier.denominator !== multiplier.numerator * 100n)
    throw new RangeError(`Multiplier for ${code} does not terminate at two decimals`);
  return `${credits(scaled)}×`;
}

/**
 * The ticket strip figures, exact.
 *
 * At most `5,040 x 12` predicate evaluations, which is why docs/MATH.md §8.1
 * says this is recomputed on every ticket edit rather than approximated.
 */
export function quoteTicket(game: PermutationGameDefinition, ticket: Ticket): TicketQuote {
  const views = viewsFor(game.variantId as VariantId);
  const resolvedLines = ticket.lines.map((line) => {
    const family = familyFor(game, line.code);
    if (!family) throw new RangeError(`Unknown bet code ${line.code}`);
    const instance = instanceFor(game, family, line.params);
    if (!instance) throw new RangeError(`Unknown instance of ${line.code}`);
    const multiplier = game.pricing.multipliers[line.code];
    if (!multiplier) throw new RangeError(`No multiplier for ${line.code}`);
    return {
      family,
      instance,
      line,
      returnIfHit: exactPayout(line.stake, multiplier, `$.lines.${line.code}`),
    };
  });

  let best = 0n;
  let bestOrder = '';
  let bestWinningLines = 0;
  let sumIfEveryLineHit = 0n;
  for (const resolved of resolvedLines) sumIfEveryLineHit += resolved.returnIfHit;

  for (const view of views) {
    let payout = 0n;
    let winning = 0;
    for (const resolved of resolvedLines) {
      if (resolved.family.resolve(resolved.instance, view) === true) {
        winning += 1;
        payout += resolved.returnIfHit;
      }
    }
    if (payout > best) {
      best = payout;
      bestOrder = view.order;
      bestWinningLines = winning;
    }
  }

  return Object.freeze({
    variantId: game.variantId,
    lineCount: ticket.lines.length,
    totalStakeChips: chipString(ticket.totalStake),
    bestOutcomeChips: chipString(best),
    bestOutcomeOrder: bestOrder,
    bestOutcomeWinningLines: bestWinningLines,
    everyLineCanHitTogether: sumIfEveryLineHit === best,
    lines: Object.freeze(
      resolvedLines.map(
        (resolved): QuoteLine =>
          Object.freeze({
            code: resolved.family.code,
            name: resolved.family.name,
            tier: resolved.family.tier,
            label: resolved.instance.label,
            params: Object.freeze({ ...(resolved.line.params as Record<string, unknown>) }),
            stakeChips: chipString(resolved.line.stake),
            multiplierDecimal: multiplierDecimal(game, resolved.family.code),
            returnIfHitChips: chipString(resolved.returnIfHit),
          }),
      ),
    ),
    display: Object.freeze({
      lines: `${ticket.lines.length} line${ticket.lines.length === 1 ? '' : 's'}`,
      stake: credits(ticket.totalStake),
      best: credits(best),
    }),
  });
}

export interface WirePresentation {
  readonly outcome: 'win' | 'partial-return' | 'no-return';
  readonly celebrate: boolean;
  readonly headline: string;
  readonly stakedChips: string;
  readonly creditedChips: string;
  readonly netChips: string;
  readonly audio: string;
  readonly haptic: string;
  readonly multiplierStamp: boolean;
  readonly balanceCountsUp: boolean;
  readonly goldBloom: boolean;
  readonly lineLighting: true;
}

/**
 * The celebration gate, delegated rather than restated.
 *
 * docs/DESIGN.md §10: "The gate is one comparison: `creditedChips >
 * totalStakeChips` ... It is implemented once, in `roundPresentation`
 * (`tools/lib/presentation.mjs`), and the client must not reimplement it."
 * So the server calls that function and ships its answer to the client, which
 * renders it. There is exactly one comparison in the product.
 */
export function presentSettlement(settlement: Settlement): WirePresentation {
  const presentation = roundPresentation({
    totalStakeChips: settlement.totalStake,
    creditedChips: settlement.credited,
    netChips: settlement.net,
  });
  return Object.freeze({
    outcome: presentation.outcome as WirePresentation['outcome'],
    celebrate: presentation.celebrate,
    headline: presentation.headline,
    stakedChips: chipString(presentation.stakedChips),
    creditedChips: chipString(presentation.creditedChips),
    netChips: chipString(presentation.netChips),
    audio: presentation.audio,
    haptic: presentation.haptic,
    multiplierStamp: presentation.multiplierStamp,
    balanceCountsUp: presentation.balanceCountsUp,
    goldBloom: presentation.goldBloom,
    lineLighting: presentation.lineLighting,
  });
}
