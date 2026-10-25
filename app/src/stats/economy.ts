// Round buy classes, HLTV's four: PISTOL, ECO, HALF, FULL.
//
// HLTV labels each team's round with its equipment value and class: ECO below $5,000, HALF from
// $5,000, FULL from $16,250, and PISTOL on the first round of each half (bands read from HLTV's labels,
// VALIDATION.md, pnpm scoreboard-variants). For five players that is $1,000 and $3,250 per player.
export const BUY_CLASSES = ["pistol", "eco", "half", "full"] as const;
export type BuyClass = (typeof BUY_CLASSES)[number];

/** Team equipment per player below which a round is an eco. */
export const ECO_BELOW_PER_PLAYER = 1000;
/** Team equipment per player from which a round is a full buy. */
export const FULL_FROM_PER_PLAYER = 3250;

/** First round of either regulation half (ri is 0-based). Overtime starts with full-buy money and has no pistol rounds. */
export function isPistolRound(ri: number, maxRounds: number): boolean {
  return ri === 0 || ri === maxRounds / 2;
}

export function classifyBuy(teamEquip: number, players: number, pistol: boolean): BuyClass {
  if (pistol) return "pistol";
  const per = teamEquip / Math.max(1, players);
  if (per < ECO_BELOW_PER_PLAYER) return "eco";
  if (per >= FULL_FROM_PER_PLAYER) return "full";
  return "half";
}
