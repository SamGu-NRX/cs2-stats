// Highlights: the rounds worth going back to. Leetify clips multi-kills (2K to ace); ours lists a
// round with three or more enemy kills, or a clutch the player won, and links it to the round.

/** What makes a round a highlight. A round can be both, such as a 1v3 won with three kills. */
export type HighlightKind = "3k" | "4k" | "ace" | "clutch";

/** Enemy kills in one round from which the round is a multi-kill highlight. */
export const HIGHLIGHT_MIN_KILLS = 3;

/**
 * The kinds of one player-round: its multi-kill size by the player's enemy kills in the round (five
 * or more is an ace), and "clutch" when the round holds a clutch the player won. Empty when it is
 * neither, so it is not a highlight.
 */
export function highlightKinds(kills: number, clutchWon: boolean): HighlightKind[] {
  if (!Number.isInteger(kills) || kills < 0) throw new Error(`highlightKinds: kills must be a whole number of kills, got ${kills}`);
  const out: HighlightKind[] = [];
  if (kills >= 5) out.push("ace");
  else if (kills === 4) out.push("4k");
  else if (kills === HIGHLIGHT_MIN_KILLS) out.push("3k");
  if (clutchWon) out.push("clutch");
  return out;
}
