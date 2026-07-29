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
