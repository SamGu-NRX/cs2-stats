// Tooltips the engine does not write: what each attribute measures, what each panel shows, and the
// provisional note. A stat's tooltip is the engine's own (Metric.tip, one sentence of 12 words or fewer
// in a player's words; stats/metrics.ts holds every metric to it), read through tipOf. The metric's full
// definition (def) stays the engine's documentation, not a tooltip. tips.test.ts holds the entries here
// to the same rule.
import { hasMetric, metric } from "./meta";

/** The stat's tooltip, the engine's Metric.tip; undefined (no tooltip) for an id the engine does not have. */
export const tipOf = (id: string): string | undefined => (hasMetric(id) ? metric(id).tip : undefined);

/** What each attribute measures, for its (?) and its row. */
export const ATTR_TIP: Record<string, string> = {
  firepower: "Kills and damage that win rounds.",
  entrying: "How often you go in first and get traded.",
  trading: "How often you avenge a teammate.",
  opening: "How early and how often you take the first duel.",
  closing: "How you finish rounds: survival, last alive, clutches.",
  sniping: "How much you play and kill with snipers.",
  utility: "How much utility you throw.",
};

/** The titles' tooltips: what each panel shows. */
export const PANEL_TIP = {
  performance: "How well you play, ranked against pros.",
  identity: "How you play, ranked against bots in your matches.",
  form: "HLTV Rating 3.0, recreated from your matches.",
  swing: "Win chance you add each round.",
  firepower: "Kills and damage that win rounds.",
  howGood: "HLTV's performance stats, ranked against pros.",
  ratingByMatch: "Your rating in each match.",
  maps: "Your numbers on each map.",
  weapons: "Your kills by weapon type.",
  clutches: "Rounds you're your team's last player against survivors.",
  multis: "Rounds where you kill two or more.",
  openings: "The first duel of each round.",
  style: "How you play, ranked against bots in your matches.",
  role: "Your likeliest role on each side.",
  whereYouPlay: "Where you move, kill and die.",
  playsLike: "Pros whose style has the same shape as yours.",
  whereYouRank: "Your percentile on the stats that define you.",
} as const;

/** A provisional style score: the bot pool behind it is still small. */
export const PROVISIONAL_TIP = "Few bot careers yet, so this may shift.";
