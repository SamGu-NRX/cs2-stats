/** Additive inputs to the rating, so it can be computed for any set of rounds. */
export interface RatingInputs {
  rounds: number;
  kills: number;
  deaths: number;
  assists: number;
  dmg: number;
  kastRounds: number;
}

/**
 * HLTV Rating 2.0, public approximation (flashed.gg reverse engineering), exactly as CS Demo
 * Manager's HltvRating2: Impact = 2.13·KPR + 0.42·APR − 0.41;
 * Rating = 0.0073·KAST + 0.3591·KPR − 0.5329·DPR + 0.2372·Impact + 0.0032·ADR + 0.1587, floored at 0.
 */
export function rating2(x: RatingInputs): number {
  if (x.rounds <= 0) return 0;
  const kpr = x.kills / x.rounds;
  const dpr = x.deaths / x.rounds;
  const adr = x.dmg / x.rounds;
  const kast = (100 * x.kastRounds) / x.rounds;
  const r = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact(x) + 0.0032 * adr + 0.1587;
  return Math.max(0, r);
}

export function impact(x: RatingInputs): number {
  if (x.rounds <= 0) return 0;
  return 2.13 * (x.kills / x.rounds) + 0.42 * (x.assists / x.rounds) - 0.41;
}

/** HS% as CS Demo Manager reports it: integer percent, rounded down. */
export const hsPercent = (hs: number, kills: number) => (kills > 0 ? Math.floor((100 * hs) / kills) : 0);
