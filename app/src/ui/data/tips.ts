// What each stat is, in one plain sentence for the tooltip. The rule (as HLTV and Leetify do it): the
// tooltip answers "what is this?" in player terms, in 12 words or fewer. It never explains the method,
// the coverage or a caveat; those live in Data & settings. The metric's full definition (stats/metrics.ts
// def) stays the engine's documentation, not a tooltip.
//
// Profile and Playstyle read their stat tooltips from here; tips.test.ts holds every entry to the rule.

export const TIP: Record<string, string> = {
  rating3: "HLTV Rating 3.0, recreated from your matches.",
  kpr: "Enemies you kill per round.",
  dpr: "Times you die per round.",
  adr: "Damage you deal to enemies per round.",
  kast: "Rounds with a kill, assist, survival or trade.",
  mk: "Rounds where you kill two or more.",
  hs: "Kills that were headshots.",
  swing: "Win chance you add each round.",

  killsPerWin: "Your kills in each round your team wins.",
  rws: "Your share of the team's impact in won rounds.",
  perfectKpr: "Kills on enemies who never hit you first.",
  tradeDenials: "Kills within 5 s of your previous kill.",
  killRounds: "Rounds where you get at least one kill.",
  mkRounds: "Rounds where you kill two or more.",
  netKills24: "Kills minus deaths every 24 rounds.",
  netDamage: "Damage dealt minus damage taken, per round.",

  tradeableDeaths: "Deaths with a teammate close enough to trade you.",
  deathsTradedPct: "Your deaths a teammate avenged.",
  baitAssists: "Deaths that set up a teammate's trade kill.",
  openingTradedPct: "Opening deaths a teammate avenged.",
  tradeOpps: "Teammate deaths close enough for you to trade.",
  tradeKillsPct: "Your kills that avenged a teammate.",
  baitKillsPct: "Your kills right after a teammate died.",
  assistedKillsPct: "Your kills a teammate assisted.",
  openingAttempts: "Rounds where you make or suffer the first kill.",
  firstDuelRank: "How early you fight, compared with your teammates.",
  firstDuelTime: "Seconds into the round before your first fight.",
  weaponAttacks: "Shots you fire per round.",
  timeAlive: "Seconds you stay alive each round.",
  alivePostPlant: "Bomb plants you're still alive for.",
  lastAlive: "Rounds where you end up the last one alive.",
  clutches24: "Clutches you win every 24 rounds.",
  roundsWithSniper: "Rounds you play with a sniper rifle.",
  sniperKillsPct: "Your kills with a sniper rifle.",
  roundsWithAwp: "Rounds you carry an AWP.",
  awpKillsPct: "Your kills with the AWP.",
  smokesPR: "Smokes you throw per round.",
  flashesPR: "Flashbangs you throw per round.",
  molotovsPR: "Molotovs you throw per round.",
  hesPR: "HE grenades you throw per round.",

  tradeKillSuccess: "Chances to trade a teammate that you convert.",
  tradedDeathSuccess: "Tradeable deaths your team actually traded.",
  openingSuccess: "Opening duels you win.",
  openingSwing: "Win chance you add in opening duels.",
  clutchSwing: "Win chance you add as the last one alive.",
  oneVsOne: "1v1 clutches you win.",
  awpSwing: "Win chance you add with the AWP.",
  awpDuelWin: "AWP duels you win.",
  flashSwing: "Win chance your flashes add.",
  assistsPerFlash: "Flash assists per flashbang thrown.",
  dmgPerHe: "Enemy damage per HE grenade thrown.",
  grenadeDmgTaken: "Grenade and fire damage you take per round.",
};

/** The stat's tooltip; undefined (no tooltip) for a stat without one rather than its long definition. */
export const tipOf = (id: string): string | undefined => TIP[id];

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
