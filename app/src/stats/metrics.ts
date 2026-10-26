// Every number the app shows about a player, defined once over a Summary. The UI, compare() and the
// baseline builder all read this list. METRICS.md carries the long-form definitions and evidence.
//
// kind: "performance" (how well: rating and the "how good" metrics) or "identity" (how you play:
// HLTV's style attributes and our own style families). design/identity.md is binding on the split.
// status: "exact" (a direct count, or checked against HLTV), "approx" (our reading of an unpublished
// definition), "unavailable" (the tables cannot support it yet; value is always null).
import { AGGRESSION_METRICS } from "./aggression";
import { AGGRO_SCALE_METRICS } from "./aggro-scale";
import { AIM_METRICS, CONTACT_METRICS } from "./aim";
import { BUYING_METRICS } from "./buying";
import { HANDLING_METRICS } from "./handling";
import { LUCK_METRICS } from "./luck";
import { INFORMATION_METRICS } from "./information";
import { MOVEMENT_METRICS } from "./movement";
import { rating3Of } from "./rating3";
import { UTILQ_METRICS } from "./utilq";
import { DUEL_METRICS } from "./xduel";
import { FLASHED_MIN_S } from "./utility";
import type { Input, Measure } from "./facts";
import type { Summary } from "./rollup";

export type Kind = "performance" | "identity";
export type Need = Input | "model";
export type Status = "exact" | "approx" | "unavailable";
export type Unit = "rating" | "perRound" | "pct" | "secs" | "ms" | "deg" | "count" | "money" | "rank" | "dmg" | "units" | "speed";

export interface Metric {
  id: string;
  label: string;
  /** HLTV's name, when this is one of HLTV's metrics */
  hltv?: string;
  kind: Kind;
  /** the attribute or family it belongs to */
  group: string;
  unit: Unit;
  status: Status;
  def: string;
  /** the tooltip: one sentence of 12 words or fewer, in a player's words */
  tip: string;
  /** performance metrics only: lower is better */
  lowerIsBetter?: boolean;
  /**
   * Source inputs the value needs (facts.ts INPUTS), and "model" when it depends on the rating
   * parameters or the win-probability source. compare() shows no percentile when a kept match lacks an
   * input, or when the baselines were built under another model.
   */
  needs?: Need[];
  value: (s: Summary) => number | null;
  /** why value is null for s, for a metric with a rule of its own (Rating 3.0's rated-round gate); compare() reports it */
  why?: (s: Summary) => string | null;
  /**
   * The events the value rests on (AWP duels, saved rounds), so the UI can show their count beside it.
   * With `min`, compare() gives no percentile below that count: the metric's reliability needs it
   * (METRICS.md gives the evidence per metric).
   */
  sample?: Sample;
  /** false for a metric with no meaningful pro percentile (the luck metrics): compare() gives none, and the pools leave it out */
  compared?: false;
  /**
   * For a share of one count in another: the numerator and denominator measures, so a view can show
   * "12 of 30" beside the rate. value is 100 × m[of[0]] / m[of[1]]; restore-profile-engine.test.ts pins the pairing.
   */
  of?: [Measure, Measure];
}

export interface Sample { n: (s: Summary) => number; unit: string; min?: number }

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const clutchWins = (s: Summary) => s.m.clutchWon1 + s.m.clutchWon2 + s.m.clutchWon3 + s.m.clutchWon4 + s.m.clutchWon5;
const WINDOW = "5.4 s, the window that reproduces HLTV's traded deaths best";

const M: Metric[] = [
  // ---- rating and scoreboard (performance)
  { id: "rating3", label: "Rating 3.0 (approx.)", hltv: "Rating 3.0", kind: "performance", group: "rating", unit: "rating", status: "approx",
    tip: "HLTV-style overall rating from kills, deaths, damage, survival and impact.", def: "HLTV Rating 3.02 as the rating agent reconstructs it (model/rating3/SPEC.md): a linear model in eco-adjusted KPR, ADR, DPR and KAST, multi-kill rounds and swing, with params.json's coefficients.",
    needs: ["model", "eco"], value: (s) => rating3Of(s).value, why: (s) => rating3Of(s).reason },
  { id: "kpr", label: "Kills per round", hltv: "Kills per round", kind: "performance", group: "rating", unit: "perRound", status: "exact",
    tip: "Enemies you kill per round.", def: "Enemy kills (killer and victim on different sides at the kill) per round.", value: (s) => per(s.m.kills, s.m.rounds) },
  { id: "dpr", label: "Deaths per round", hltv: "Deaths per round", kind: "performance", group: "rating", unit: "perRound", status: "exact", lowerIsBetter: true,
    tip: "How often you die per round.", def: "Deaths of any cause except a suicide after the round ended, per round.", value: (s) => per(s.m.deaths, s.m.rounds) },
  { id: "adr", label: "ADR", hltv: "Damage per round", kind: "performance", group: "rating", unit: "dmg", status: "exact",
    tip: "Damage you deal to enemies per round.", def: "Damage to enemies per round, each hit counting its reported damage capped at the victim's health (HLTV's figure).", value: (s) => per(s.m.dmg, s.m.rounds) },
  { id: "kast", label: "KAST", hltv: "KAST", kind: "performance", group: "rating", unit: "pct", status: "exact",
    tip: "Rounds where you got a kill, assist, survived or were traded.", def: `Rounds with a kill, a damage assist, survival or a traded death (trade window ${WINDOW}).`, value: (s) => pct(s.m.kast, s.m.rounds) },
  { id: "mk", label: "Multi-kill rounds", hltv: "Multi-kill", kind: "performance", group: "rating", unit: "pct", status: "exact",
    tip: "Rounds where you killed two or more enemies.", def: "Rounds with two or more kills.", value: (s) => pct(s.m.multiKillRounds, s.m.rounds) },
  { id: "swing", label: "Round swing", hltv: "Round swing", kind: "performance", group: "rating", unit: "pct", status: "approx",
    tip: "How much you change your team's chance to win each round.", def: "Average change per round in your team's win probability credited to you (swing.ts).",
    needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.swing) / s.m.swingRounds : null) },
  // exactly k kills in a round; the scoreboard's k3Rounds and up count k or more
  { id: "rounds2k", label: "2-kill rounds", kind: "performance", group: "multikill", unit: "pct", status: "exact",
    tip: "Rounds where you got exactly two kills.", def: "Rounds where you got exactly two kills.", value: (s) => pct(s.m.multiKillRounds - s.m.k3Rounds, s.m.rounds) },
  { id: "rounds3k", label: "3-kill rounds", kind: "performance", group: "multikill", unit: "pct", status: "exact",
    tip: "Rounds where you got exactly three kills.", def: "Rounds where you got exactly three kills.", value: (s) => pct(s.m.k3Rounds - s.m.k4Rounds, s.m.rounds) },
  { id: "rounds4k", label: "4-kill rounds", kind: "performance", group: "multikill", unit: "pct", status: "exact",
    tip: "Rounds where you got exactly four kills.", def: "Rounds where you got exactly four kills.", value: (s) => pct(s.m.k4Rounds - s.m.k5Rounds, s.m.rounds) },
  { id: "rounds5k", label: "5-kill rounds", kind: "performance", group: "multikill", unit: "pct", status: "exact",
    tip: "Rounds where you killed the whole enemy team.", def: "Rounds where you got five kills.", value: (s) => pct(s.m.k5Rounds, s.m.rounds) },
  { id: "hs", label: "Headshot kills", kind: "performance", group: "rating", unit: "pct", status: "exact", tip: "Share of your kills that were headshots.", def: "Headshot kills as a share of kills.", value: (s) => pct(s.m.hsKills, s.m.kills) },

  // ---- Firepower (performance, HLTV's attribute)
  { id: "killsPerWin", label: "Kills per round win", hltv: "Kills per Round Win", kind: "performance", group: "firepower", unit: "perRound", status: "exact",
    tip: "Your kills in rounds your team won, per won round.", def: "Kills in rounds your team won, per won round.", value: (s) => per(s.m.killsInWins, s.m.won) },
  { id: "rws", label: "Round win shares", hltv: "Round Win Shares", kind: "performance", group: "firepower", unit: "pct", status: "approx",
    tip: "Your share of the work in the rounds your team won.", def: "In won rounds, your share of your team's positive swing (20% is an even share), averaged.", needs: ["model"], value: (s) => pct(s.m.rws, s.m.rwsRounds) },
  { id: "perfectKpr", label: "Perfect kills per round", hltv: "Perfect Kills per Round", kind: "performance", group: "firepower", unit: "perRound", status: "approx",
    tip: "Kills where the enemy never damaged you first, per round.", def: "Kills where the victim had not damaged you earlier in the round, per round.", value: (s) => per(s.m.perfectKills, s.m.rounds) },
  { id: "tradeDenials", label: "Trade denials per round", hltv: "Trade Denials per Round", kind: "performance", group: "firepower", unit: "perRound", status: "approx",
    tip: "Quick follow-up kills before the enemy could trade back, per round.", def: "Kills less than 5 s after your previous kill in the round (SPEC.md), per round.", value: (s) => per(s.m.tradeDenials, s.m.rounds) },
  { id: "killRounds", label: "Rounds with a kill", hltv: "Rounds with a Kill", kind: "performance", group: "firepower", unit: "pct", status: "exact",
    tip: "Rounds where you got at least one kill.", def: "Rounds with at least one kill.", value: (s) => pct(s.m.killRounds, s.m.rounds) },
  { id: "mkRounds", label: "Rounds with a multi-kill", hltv: "Rounds with a Multi-Kill", kind: "performance", group: "firepower", unit: "pct", status: "exact",
    tip: "Rounds where you got two or more kills.", def: "Rounds with two or more kills.", value: (s) => pct(s.m.multiKillRounds, s.m.rounds) },
  { id: "netKills24", label: "Net kills per 24 rounds", hltv: "Net Kills per 24 Rounds", kind: "performance", group: "firepower", unit: "count", status: "exact",
    tip: "Kills minus deaths, scaled to a 24-round match.", def: "Kills minus deaths, per 24 rounds.", value: (s) => (s.m.rounds ? (24 * (s.m.kills - s.m.deaths)) / s.m.rounds : null) },
  { id: "netDamage", label: "Net damage per round", hltv: "Net Damage per Round", kind: "performance", group: "firepower", unit: "dmg", status: "approx",
    tip: "Damage you dealt minus damage you took, per round.", def: "Damage dealt to enemies minus damage taken from enemies, per round.", value: (s) => per(s.m.dmg - s.m.dmgTaken, s.m.rounds) },

  // ---- Entrying (identity)
  { id: "tradeableDeaths", label: "Tradeable deaths per round", hltv: "Tradeable Deaths per Round", kind: "identity", group: "entrying", unit: "perRound", status: "approx",
    tip: "Deaths with a teammate close enough to trade you, per round.", def: "Deaths with a living teammate within 1,000 units, per round with positions.", value: (s) => per(s.m.tradeableDeaths, s.m.posRounds) },
  { id: "deathsTradedPct", label: "Deaths traded", hltv: "Deaths Traded %", kind: "identity", group: "entrying", unit: "pct", status: "exact",
    tip: "Share of your deaths that a teammate quickly avenged.", def: `Share of your deaths that a teammate traded (${WINDOW}).`, value: (s) => pct(s.m.tradedDeaths, s.m.deaths) },
  { id: "baitAssists", label: "Bait assists per round", hltv: "Bait Assists per Round", kind: "identity", group: "entrying", unit: "perRound", status: "approx",
    tip: "Deaths a teammate avenged, per round: you drew the enemy out.", def: "Your deaths that a teammate traded, per round: you drew the enemy out.", value: (s) => per(s.m.tradedDeaths, s.m.rounds) },
  { id: "openingTradedPct", label: "Opening deaths traded", hltv: "Opening Deaths Traded %", kind: "identity", group: "entrying", unit: "pct", status: "exact",
    tip: "Share of your first-death rounds where a teammate avenged you.", def: "Share of your opening deaths that a teammate traded.", value: (s) => pct(s.m.openingTraded, s.m.openingDeaths) },

  // ---- Trading (identity)
  { id: "tradeOpps", label: "Trade opportunities per round", hltv: "Trade Opportunities per Round", kind: "identity", group: "trading", unit: "perRound", status: "approx",
    tip: "Teammates who died near you while you could trade, per round.", def: "Teammate deaths within 1,000 units of you while you were alive, per round with positions.", value: (s) => per(s.m.tradeOpps, s.m.posRounds) },
  { id: "tradeKillsPct", label: "Trade kills", hltv: "Trade Kills %", kind: "identity", group: "trading", unit: "pct", status: "exact",
    tip: "Share of your kills that avenged a teammate.", def: `Share of your kills that were trade kills (${WINDOW}).`, value: (s) => pct(s.m.tradeKills, s.m.kills) },
  { id: "baitKillsPct", label: "Bait kills", hltv: "Bait Kills %", kind: "identity", group: "trading", unit: "pct", status: "approx",
    tip: "Share of your kills soon after a teammate died.", def: "Share of your kills made less than 5 s after a teammate died, on any enemy. HLTV's rule is unpublished; this one is ours.", value: (s) => pct(s.m.baitKills, s.m.kills) },
  { id: "assistedKillsPct", label: "Assisted kills", hltv: "Assisted Kills %", kind: "identity", group: "trading", unit: "pct", status: "exact",
    tip: "Share of your kills where a teammate helped.", def: "Share of your kills where a teammate got the assist.", value: (s) => pct(s.m.assistedKills, s.m.kills) },

  // ---- Opening (identity)
  { id: "openingAttempts", label: "Opening attempts", hltv: "Opening Attempts", kind: "identity", group: "opening", unit: "pct", status: "exact",
    tip: "Rounds where you were in the first kill of the round.", def: "Rounds where you made or suffered the first kill.", value: (s) => pct(s.m.openingKills + s.m.openingDeaths, s.m.rounds) },
  { id: "firstDuelRank", label: "First duel rank in team", hltv: "First Duel Rank in Team", kind: "identity", group: "opening", unit: "rank", status: "approx",
    tip: "How early, among your team, you first trade damage.", def: "Your place (1 = first) among teammates in first dealing or taking enemy damage, averaged over rounds where you did.", value: (s) => per(s.m.duelRankSum, s.m.duelRounds) },
  { id: "firstDuelTime", label: "First duel time", hltv: "First Duel Time", kind: "identity", group: "opening", unit: "secs", status: "approx",
    tip: "Seconds into the round of your first damage dealt or taken.", def: "Seconds after freeze end of your first enemy damage dealt or taken.", value: (s) => per(s.m.duelTimeSum, s.m.duelRounds) },
  { id: "weaponAttacks", label: "Weapon attacks per round", hltv: "Weapon Attacks per Round", kind: "identity", group: "opening", unit: "perRound", status: "approx",
    tip: "Shots you fire per round.", def: "Gun shots fired per round.", value: (s) => per(s.m.gunShots, s.m.rounds) },

  // ---- Closing (identity)
  { id: "timeAlive", label: "Time alive per round", hltv: "Time Alive per Round", kind: "identity", group: "closing", unit: "secs", status: "exact",
    tip: "Seconds you stay alive each round.", def: "Seconds from freeze end to your death or the round end.", value: (s) => per(s.m.aliveSecs, s.m.rounds) },
  { id: "alivePostPlant", label: "Alive for post-plant", hltv: "Alive for Post-Plant %", kind: "identity", group: "closing", unit: "pct", status: "approx",
    tip: "Planted rounds where you were alive when the bomb went down.", def: "Rounds with a plant where you were alive when the bomb went down.", value: (s) => pct(s.m.aliveAtPlant, s.m.postPlantRounds) },
  { id: "lastAlive", label: "Last alive", hltv: "Last Alive in Team", kind: "identity", group: "closing", unit: "pct", status: "approx",
    tip: "Rounds where you became your team's last player alive.", def: "Rounds where you were, at some moment, the only player of your side alive.", value: (s) => pct(s.m.lastAlive, s.m.rounds) },
  { id: "clutches24", label: "Clutches per 24 rounds", hltv: "Clutches per 24 Rounds", kind: "identity", group: "closing", unit: "count", status: "exact",
    tip: "Clutches you won, scaled to a 24-round match.", def: "1vX clutches won per 24 rounds (CS Demo Manager's clutch detection).", value: (s) => (s.m.rounds ? (24 * clutchWins(s)) / s.m.rounds : null) },

  // ---- Sniping (identity)
  { id: "roundsWithSniper", label: "Rounds with a sniper", hltv: "Rounds with a Sniper", kind: "identity", group: "sniping", unit: "pct", status: "approx",
    tip: "Rounds where you had a sniper rifle.", def: "Rounds you carried a sniper rifle at freeze end or killed with one.", needs: ["loadout"], value: (s) => pct(s.m.roundsWithSniper, s.m.loadoutRounds) },
  { id: "sniperKillsPct", label: "Sniper kills", hltv: "Sniper Kills %", kind: "identity", group: "sniping", unit: "pct", status: "exact",
    tip: "Share of your kills with any sniper rifle.", def: "Share of your kills made with the AWP, SSG 08, SCAR-20 or G3SG1.", value: (s) => pct(s.m.sniperKills, s.m.kills) },
  { id: "roundsWithAwp", label: "Rounds with an AWP", hltv: "Rounds with an AWP", kind: "identity", group: "sniping", unit: "pct", status: "approx",
    tip: "Rounds where you had an AWP.", def: "Rounds you carried an AWP at freeze end or killed with one.", needs: ["loadout"], value: (s) => pct(s.m.roundsWithAwp, s.m.loadoutRounds) },
  { id: "awpKillsPct", label: "AWP kills", hltv: "AWP Kills %", kind: "identity", group: "sniping", unit: "pct", status: "exact",
    tip: "Share of your kills with the AWP.", def: "Share of your kills made with the AWP.", value: (s) => pct(s.m.awpKills, s.m.kills) },

  // ---- Utility (identity)
  { id: "smokesPR", label: "Smokes thrown per round", hltv: "Smokes Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    tip: "Smokes you throw per round.", def: "Smoke grenades thrown per round.", value: (s) => per(s.m.smokes, s.m.rounds) },
  { id: "flashesPR", label: "Flashbangs thrown per round", hltv: "Flashbangs Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    tip: "Flashbangs you throw per round.", def: "Flashbangs thrown per round.", value: (s) => per(s.m.flashes, s.m.rounds) },
  { id: "molotovsPR", label: "Molotovs thrown per round", hltv: "Molotovs Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    tip: "Molotovs and incendiaries you throw per round.", def: "Molotovs and incendiaries thrown per round.", value: (s) => per(s.m.molotovs, s.m.rounds) },
  { id: "hesPR", label: "HE grenades thrown per round", hltv: "HE Grenades Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    tip: "HE grenades you throw per round.", def: "HE grenades thrown per round.", value: (s) => per(s.m.hes, s.m.rounds) },

  // ---- HLTV's "how good" metrics (performance)
  { id: "tradeKillSuccess", label: "Trade kill success", hltv: "Trade Kill Success %", kind: "performance", group: "trading", unit: "pct", status: "approx",
    tip: "How often you avenge a teammate who died near you.", def: `Trade opportunities where you killed the killer within ${WINDOW}.`, of: ["tradeOppsTaken", "tradeOpps"], value: (s) => pct(s.m.tradeOppsTaken, s.m.tradeOpps) },
  { id: "tradeAttemptPct", label: "Trade attempts", kind: "performance", group: "trading", unit: "pct", status: "approx",
    tip: "How often you shoot at the killer of a nearby teammate.", def: `Trade opportunities (a teammate died within 1,000 units of you) where you hit the killer within ${WINDOW}. With Trade kill success and opportunities, Leetify's opportunity, attempt, success triple.`,
    value: (s) => pct(s.m.tradeAttempts, s.m.tradeOpps) },
  { id: "tradeAttemptSuccess", label: "Trade attempt success", kind: "performance", group: "trading", unit: "pct", status: "approx",
    tip: "How often shooting at a teammate's killer ends with the kill.", def: `Trade attempts (you hit the killer within ${WINDOW}) that ended with you killing him.`, value: (s) => pct(s.m.tradeOppsTaken, s.m.tradeAttempts) },
  { id: "tradedAttemptPct", label: "Trade attempts for your deaths", kind: "performance", group: "entrying", unit: "pct", status: "approx",
    tip: "How often a nearby teammate shoots back after you die.", def: `Tradeable deaths (a teammate within 1,000 units) where a teammate hit your killer within ${WINDOW}; Traded death success is how many of them were traded.`,
    value: (s) => pct(s.m.tradedAttempts, s.m.tradeableDeaths) },
  { id: "tradedDeathSuccess", label: "Traded death success", hltv: "Traded Death Success %", kind: "performance", group: "entrying", unit: "pct", status: "approx",
    tip: "How often a nearby teammate avenges your death.", def: "Tradeable deaths (a living teammate within 1,000 units) that a teammate traded.", of: ["tradeableTraded", "tradeableDeaths"], value: (s) => pct(s.m.tradeableTraded, s.m.tradeableDeaths) },
  { id: "openingSwing", label: "Opening swing", hltv: "Opening Swing", kind: "performance", group: "opening", unit: "pct", status: "approx",
    tip: "Win-chance change from first kills and first deaths, per round.", def: "Swing from opening kills and deaths, per round.", needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.openingSwing) / s.m.swingRounds : null) },
  { id: "clutchSwing", label: "Clutch swing", hltv: "Clutch Swing", kind: "performance", group: "closing", unit: "pct", status: "approx",
    tip: "Win-chance change you make while last alive, per round.", def: "Swing from kills and deaths after you became the last of your side alive, per round.", needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.clutchSwing) / s.m.swingRounds : null) },
  { id: "awpSwing", label: "AWP swing", hltv: "AWP Swing", kind: "performance", group: "sniping", unit: "pct", status: "approx",
    tip: "Win-chance change from your AWP kills and AWP deaths.", def: "Swing from your AWP kills and your deaths holding the AWP, per round.", needs: ["model", "activeWeapon"], value: (s) => (s.m.swingRounds ? (100 * s.m.awpSwing) / s.m.swingRounds : null) },
  { id: "awpDuelWin", label: "AWP duel win", hltv: "AWP Duel Win %", kind: "performance", group: "sniping", unit: "pct", status: "approx",
    tip: "Fights won while holding the AWP.", def: "Duels with the AWP in hand (your AWP kills plus your deaths holding it) that you won.", needs: ["activeWeapon"], of: ["awpDuelWins", "awpDuels"], value: (s) => pct(s.m.awpDuelWins, s.m.awpDuels),
    sample: { n: (s) => s.m.awpDuels, unit: "AWP duels" } },
  { id: "flashSwing", label: "Flash swing", hltv: "Flash Swing", kind: "performance", group: "utility", unit: "pct", status: "approx",
    tip: "Win-chance change earned by your flashes on enemies who died.", def: "Swing credited to your flashes: the flash share of a kill's credit when your flash was blinding the victim (params.json swing.flash_credit_fraction), split equally when several flashes were, per round.",
    needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.flashSwing) / s.m.swingRounds : null) },
  { id: "assistsPerFlash", label: "Assists per flash", hltv: "Assists per Flash", kind: "performance", group: "utility", unit: "perRound", status: "approx",
    tip: "Flash assists per flashbang you throw.", def: "Flash assists (the game's) per flashbang thrown.", value: (s) => per(s.m.flashAssists, s.m.flashes) },
  { id: "grenadeDmgTaken", label: "Grenade damage received per round", hltv: "Grenade Damage Received", kind: "performance", group: "utility", unit: "dmg", status: "exact", lowerIsBetter: true,
    tip: "Damage you take from enemy grenades and fire per round.", def: "Damage you took from enemy grenades and fire, per round.", value: (s) => per(s.m.utilDmgTaken, s.m.rounds) },
  { id: "dmgPerHe", label: "Damage per HE thrown", hltv: "Damage per HE Thrown", kind: "performance", group: "utility", unit: "dmg", status: "exact",
    tip: "Enemy damage per HE grenade you throw.", def: "Enemy damage from your HE grenades per HE thrown.", value: (s) => per(s.m.heDmg, s.m.hes) },
  { id: "oneVsOne", label: "1v1 win rate", kind: "performance", group: "closing", unit: "pct", status: "exact",
    tip: "Share of your one-on-one clutches that you won.", def: "1v1 clutches won.", of: ["clutchWon1", "clutch1"], value: (s) => pct(s.m.clutchWon1, s.m.clutch1) },

  // ---- utility quality (performance; Leetify's flash definitions)
  { id: "flashKillsPerFlash", label: "Flash-to-kills per flash", kind: "performance", group: "utility", unit: "perRound", status: "exact",
    tip: "Enemies your team killed while blinded by your flash, per flash.", def: "Enemies you flashed who died to your team while still blind (Leetify's flash-to-kill), per flashbang thrown, as Leetify counts it so players who flash more or less compare.", value: (s) => per(s.m.flashKills, s.m.flashes) },
  { id: "utilUnused", label: "Unused utility on death", kind: "performance", group: "utility", unit: "money", status: "approx", lowerIsBetter: true,
    tip: "Grenade value you still held when you died.", def: "Value of grenades you held at freeze end and had not thrown when you died, per death (Leetify's rate; per round it mostly measured dying early). Grenades picked up later are not seen.", needs: ["loadout"], value: (s) => per(s.m.utilUnused, s.m.utilDeaths) },

  // ---- utility description (identity). Not scored as performance: on pro team-rounds these duplicate
  // other metrics or show no lasting link to winning rounds (METRICS.md, "Descriptive utility").
  { id: "enemiesPerFlash", label: "Enemies flashed per flash", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    tip: "Enemies properly blinded per flashbang you throw.", def: `Enemies blinded for more than ${FLASHED_MIN_S} s (Leetify's cut) per flashbang thrown.`, value: (s) => per(s.m.enemiesFlashed, s.m.flashes) },
  { id: "blindPerFlash", label: "Enemy blind time per flash", kind: "identity", group: "utility", unit: "secs", status: "exact",
    tip: "Seconds of enemy blindness per flashbang you throw.", def: `Seconds of enemy blindness (blinds over ${FLASHED_MIN_S} s) per flashbang thrown.`, value: (s) => per(s.m.enemyBlindSecs, s.m.flashes) },
  { id: "teamFlashPR", label: "Teammates flashed per round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    tip: "Teammates you blinded per round.", def: `Teammates you blinded for more than ${FLASHED_MIN_S} s, per round.`, value: (s) => per(s.m.teamFlashed, s.m.rounds) },
  { id: "utilDmgPR", label: "Utility damage per round", kind: "identity", group: "utility", unit: "dmg", status: "exact",
    tip: "Damage your grenades and fire deal per round.", def: "Enemy damage from your grenades and fire, per round.", value: (s) => per(s.m.utilDmg, s.m.rounds) },
  { id: "utilSpentPR", label: "Utility bought per round", kind: "identity", group: "utility", unit: "money", status: "exact",
    tip: "Money you spend on grenades per round.", def: "Money spent on grenades per round, less grenades refunded in the buy zone. Needs the purchases table (demos through the extractor).",
    value: (s) => per(s.m.utilSpent, s.m.purchaseRounds) },
  { id: "molotovEnemiesHit", label: "Enemies burned per molotov", kind: "performance", group: "utility", unit: "perRound", status: "approx",
    tip: "Enemies each molotov you throw burns.", def: "Distinct enemies your molotov or incendiary damaged, per one thrown (a fire that burned two enemies counts 2). Ours; nobody publishes a molotov usefulness definition, and its link to round wins is weak (VALIDATION.md).",
    value: (s) => per(s.m.molotovHits, s.m.molotovs) },
  { id: "molotovDmg", label: "Fire damage per molotov", kind: "performance", group: "utility", unit: "dmg", status: "approx",
    tip: "Damage each molotov you throw deals.", def: "Enemy damage from your molotovs and incendiaries per one thrown. Ours; its link to round wins is weak (VALIDATION.md).",
    value: (s) => per(s.m.fireDmg, s.m.molotovs) },
  { id: "fireDmgPR", label: "Fire damage per round", kind: "identity", group: "utility", unit: "dmg", status: "exact",
    tip: "Damage your molotovs deal per round.", def: "Enemy damage from your molotovs and incendiaries, per round.", value: (s) => per(s.m.fireDmg, s.m.rounds) },

  // ---- sniping and clutching extras kept from the old attribute cards
  { id: "sniperKpr", label: "Sniper kills per round", kind: "performance", group: "sniping", unit: "perRound", status: "exact", tip: "Sniper rifle kills per round.", def: "Sniper rifle kills per round.", value: (s) => per(s.m.sniperKills, s.m.rounds) },
  { id: "awpKpr", label: "AWP kills per round", kind: "performance", group: "sniping", unit: "perRound", status: "exact",
    tip: "AWP kills per round.", def: "AWP kills per round. Above 0.20 a player is compared with AWPers (design/identity.md).", value: (s) => per(s.m.awpKills, s.m.rounds) },
  { id: "savesPerLoss", label: "Saves per lost round", kind: "identity", group: "closing", unit: "perRound", status: "exact", tip: "Lost rounds you survived, per lost round.", def: "Rounds lost where you were alive at the end, per lost round.", value: (s) => per(s.m.saves, s.m.lostRounds) },
  { id: "openingSuccess", label: "Opening duel success", kind: "performance", group: "opening", unit: "pct", status: "exact",
    tip: "Share of the round's first fights that you won.", def: "Opening duels won.", value: (s) => pct(s.m.openingKills, s.m.openingKills + s.m.openingDeaths) },

  // ---- values main's Profile and Playstyle showed (REMOVALS.md, E20), defined over the measures that
  // already exist. None has pro quantiles until public/baselines.json is rebuilt, so the performance
  // ones show without a pro percentile; the identity ones rank against the bot careers like the rest.
  { id: "openingWinPct", label: "Rounds won after an opening kill", kind: "performance", group: "opening", unit: "pct", status: "exact",
    tip: "Rounds your team won after you got the first kill.", def: "Rounds your team won, of the rounds where you made the opening kill.", of: ["openingWins", "openingKills"], value: (s) => pct(s.m.openingWins, s.m.openingKills) },
  { id: "perfectKillsPct", label: "Perfect kills", kind: "performance", group: "firepower", unit: "pct", status: "approx",
    tip: "Share of your kills where the enemy never damaged you first.", def: "Share of your kills where the victim had not damaged you earlier in the round.", of: ["perfectKills", "kills"], value: (s) => pct(s.m.perfectKills, s.m.kills) },
  // Rating 3.0's own eco-adjusted KPR input (rating3Of), so the breakdown and this row cannot disagree.
  { id: "ecoKpr", label: "Kills per round (eco-adjusted)", kind: "performance", group: "firepower", unit: "perRound", status: "approx",
    tip: "Kills per round, weighted by how fair each fight's economy was.", def: "Kills weighted by the duel's economy (rating3.ts kill points), per round Rating 3.0 rated: the rating's eco-adjusted KPR input.",
    needs: ["model", "eco"], value: (s) => rating3Of(s).inputs?.kpr_eco ?? null, why: (s) => rating3Of(s).reason },
  { id: "failedTradesPR", label: "Failed trades per round", kind: "identity", group: "entrying", unit: "perRound", status: "approx",
    tip: "Times you died trying to avenge a teammate, per round.", def: "Deaths less than 5 s after a teammate's death to the same enemy, per round.", value: (s) => per(s.m.failedTrades, s.m.rounds) },
  { id: "baitKillsPR", label: "Bait kills per round", kind: "identity", group: "trading", unit: "perRound", status: "approx",
    tip: "Kills soon after a teammate died, per round.", def: "Kills less than 5 s after a teammate died, on any enemy, per round. HLTV's rule is unpublished; this one is ours.", value: (s) => per(s.m.baitKills, s.m.rounds) },
  // Identity, like utilDmgPR beside it: no run has tested its link to winning rounds.
  { id: "flashAssistsPR", label: "Flash assists per round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    tip: "Kills your flashes set up for teammates, per round.", def: "Flash assists (the game's) per round.", value: (s) => per(s.m.flashAssists, s.m.rounds) },
  { id: "clutchPointsPR", label: "Clutch points per round", kind: "identity", group: "closing", unit: "perRound", status: "approx",
    tip: "Clutches won, bigger ones counting more, per round.", def: "Won 1vX clutches weighted by X (1v1 = 1, 1v3 = 3), per round. The weighting is ours.",
    value: (s) => per(s.m.clutchWon1 + 2 * s.m.clutchWon2 + 3 * s.m.clutchWon3 + 4 * s.m.clutchWon4 + 5 * s.m.clutchWon5, s.m.rounds) },
  // The role signals (identity.ts ROLE_SIGNALS) and the style compass read these two with openingAttempts.
  { id: "tradeAssistShare", label: "Trades and assists", kind: "identity", group: "trading", unit: "pct", status: "exact",
    tip: "How much of your fragging comes from trades and assists.", def: "Trade kills plus assists (flash assists included), as a share of kills plus assists: how much of your fragging plays off teammates.",
    value: (s) => pct(s.m.tradeKills + s.m.assists, s.m.kills + s.m.assists) },
  { id: "teamDistance", label: "Distance to nearest teammate", kind: "identity", group: "spacing", unit: "units", status: "exact",
    tip: "How far you usually stand from your nearest teammate.", def: "Mean distance to your nearest teammate, sampled every 3 s from 10 s after freeze end until the plant while all five of your side are alive (positioning.ts).",
    value: (s) => per(s.m.nearestDistSum, s.m.spacingSamples) },
];

export const METRICS: Metric[] = [...M, ...AIM_METRICS, ...MOVEMENT_METRICS, ...AGGRESSION_METRICS, ...CONTACT_METRICS, ...AGGRO_SCALE_METRICS, ...DUEL_METRICS, ...BUYING_METRICS, ...INFORMATION_METRICS, ...UTILQ_METRICS, ...LUCK_METRICS, ...HANDLING_METRICS];
export const METRIC: Record<string, Metric> = Object.fromEntries(METRICS.map((m) => [m.id, m]));

/**
 * HLTV's attributes: Firepower (performance) and the six style attributes (identity), each with the
 * metrics HLTV now shows for it (design/hltv-ref/player-attributes-expanded.png).
 */
export const ATTRIBUTES: { id: string; label: string; kind: Kind; metrics: string[] }[] = [
  { id: "firepower", label: "Firepower", kind: "performance", metrics: ["killsPerWin", "rws", "perfectKpr", "tradeDenials", "killRounds", "mkRounds", "netKills24", "netDamage"] },
  { id: "entrying", label: "Entrying", kind: "identity", metrics: ["tradeableDeaths", "deathsTradedPct", "baitAssists", "openingTradedPct"] },
  { id: "trading", label: "Trading", kind: "identity", metrics: ["tradeOpps", "tradeKillsPct", "baitKillsPct", "assistedKillsPct"] },
  { id: "opening", label: "Opening", kind: "identity", metrics: ["openingAttempts", "firstDuelRank", "firstDuelTime", "weaponAttacks"] },
  { id: "closing", label: "Closing", kind: "identity", metrics: ["timeAlive", "alivePostPlant", "lastAlive", "clutches24"] },
  { id: "sniping", label: "Sniping", kind: "identity", metrics: ["roundsWithSniper", "sniperKillsPct", "roundsWithAwp", "awpKillsPct"] },
  { id: "utility", label: "Utility", kind: "identity", metrics: ["smokesPR", "flashesPR", "molotovsPR", "hesPR"] },
];
