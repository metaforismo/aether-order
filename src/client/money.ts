/** Chips in, credits on screen. The client formats money; it never computes it. */

export const CHIPS_PER_CREDIT = 100n;

export function credits(chips: bigint): string {
  const negative = chips < 0n;
  const absolute = negative ? -chips : chips;
  return `${negative ? '-' : ''}${absolute / CHIPS_PER_CREDIT}.${(absolute % CHIPS_PER_CREDIT)
    .toString()
    .padStart(2, '0')}`;
}

/** Signed rendering, for a net position that has to read as a loss. */
export function signedCredits(chips: bigint): string {
  return chips > 0n ? `+${credits(chips)}` : credits(chips);
}

export const chips = (wire: string | number | bigint): bigint => BigInt(wire);

/**
 * What the top rail shows while a round is playing: the balance after the stake
 * was debited and before the return was credited.
 *
 * **This exists because round 1 printed the result four seconds before the tube
 * did.** The whole settlement arrives in the COMMIT response — it has to, because
 * the choreography is a function of the transcript — so `session.balanceChips` is
 * already the settled figure the instant the button is pressed. The client
 * rendered the rail from it, and the sign of the change at COMMIT therefore told
 * the player the outcome: proven over six consecutive rounds, losses read
 * 500 → 450 while wins read strictly *above* the pre-commit balance
 * (450 → 496, +46.00 on a 50.00 stake), before a single sphere had fallen. The
 * same bug made §10's count-up dead code, because the "before" value it
 * interpolated from was the final one.
 *
 * docs/DESIGN.md §2 is unambiguous about the order: beat 2 COMMIT debits the
 * wallet, beat 7 STAMP credits it. So the honest figure during beats 3 to 6 is
 * `balanceAfter − credited`, which is `balanceBefore − stake` — a fall by exactly
 * the stake in every round, win or lose, revealing nothing. It is arithmetic on
 * two figures the server published rather than a computation of the client's own.
 */
export function balanceDuringRound(balanceAfterChips: bigint, creditedChips: bigint): bigint {
  return balanceAfterChips - creditedChips;
}
