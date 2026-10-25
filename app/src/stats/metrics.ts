// Every number the app shows about a player, defined once over a Summary. The UI, compare() and the
// baseline builder all read this list. METRICS.md carries the long-form definitions and evidence.
//
// kind: "performance" (how well: rating and the "how good" metrics) or "identity" (how you play:
// HLTV's style attributes and our own style families). design/identity.md is binding on the split.
// status: "exact" (a direct count, or checked against HLTV), "approx" (our reading of an unpublished
// definition), "unavailable" (the tables cannot support it yet; value is always null).
import { AGGRESSION_METRICS } from "./aggression";
import { AIM_METRICS, CONTACT_METRICS } from "./aim";
import { BUYING_METRICS } from "./buying";
import { INFORMATION_METRICS } from "./information";
import { MOVEMENT_METRICS } from "./movement";
import { rating3Of } from "./rating3";
import { UTILQ_METRICS } from "./utilq";
import { FLASHED_MIN_S } from "./utility";
import type { Input } from "./facts";
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
}

export interface Sample { n: (s: Summary) => number; unit: string; min?: number }

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const clutchWins = (s: Summary) => s.m.clutchWon1 + s.m.clutchWon2 + s.m.clutchWon3 + s.m.clutchWon4 + s.m.clutchWon5;
const WINDOW = "5.4 s, the window that reproduces HLTV's traded deaths best";

const M: Metric[] = [
  // ---- rating and scoreboard (performance)
  { id: "rating3", label: "Rating 3.0 (approx.)", hltv: "Rating 3.0", kind: "performance", group: "rating", unit: "rating", status: "approx",
    def: "HLTV Rating 3.02 as the rating agent reconstructs it (model/rating3/SPEC.md): a linear model in eco-adjusted KPR, ADR, DPR and KAST, multi-kill rounds and swing, with params.json's coefficients.",
    needs: ["model", "eco"], value: (s) => rating3Of(s).value, why: (s) => rating3Of(s).reason },
  { id: "kpr", label: "Kills per round", hltv: "Kills per round", kind: "performance", group: "rating", unit: "perRound", status: "exact",
    def: "Enemy kills (killer and victim on different sides at the kill) per round.", value: (s) => per(s.m.kills, s.m.rounds) },
  { id: "dpr", label: "Deaths per round", hltv: "Deaths per round", kind: "performance", group: "rating", unit: "perRound", status: "exact", lowerIsBetter: true,
    def: "Deaths of any cause except a suicide after the round ended, per round.", value: (s) => per(s.m.deaths, s.m.rounds) },
  { id: "adr", label: "ADR", hltv: "Damage per round", kind: "performance", group: "rating", unit: "dmg", status: "exact",
    def: "Damage to enemies per round, each hit counting its reported damage capped at the victim's health (HLTV's figure).", value: (s) => per(s.m.dmg, s.m.rounds) },
  { id: "kast", label: "KAST", hltv: "KAST", kind: "performance", group: "rating", unit: "pct", status: "exact",
    def: `Rounds with a kill, a damage assist, survival or a traded death (trade window ${WINDOW}).`, value: (s) => pct(s.m.kast, s.m.rounds) },
  { id: "mk", label: "Multi-kill rounds", hltv: "Multi-kill", kind: "performance", group: "rating", unit: "pct", status: "exact",
    def: "Rounds with two or more kills.", value: (s) => pct(s.m.multiKillRounds, s.m.rounds) },
  { id: "swing", label: "Round swing", hltv: "Round swing", kind: "performance", group: "rating", unit: "pct", status: "approx",
    def: "Average change per round in your team's win probability credited to you (swing.ts).",
    needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.swing) / s.m.swingRounds : null) },
  { id: "hs", label: "Headshot kills", kind: "performance", group: "rating", unit: "pct", status: "exact", def: "Headshot kills as a share of kills.", value: (s) => pct(s.m.hsKills, s.m.kills) },

  // ---- Firepower (performance, HLTV's attribute)
  { id: "killsPerWin", label: "Kills per round win", hltv: "Kills per Round Win", kind: "performance", group: "firepower", unit: "perRound", status: "exact",
    def: "Kills in rounds your team won, per won round.", value: (s) => per(s.m.killsInWins, s.m.won) },
  { id: "rws", label: "Round win shares", hltv: "Round Win Shares", kind: "performance", group: "firepower", unit: "pct", status: "approx",
    def: "In won rounds, your share of your team's positive swing (20% is an even share), averaged.", needs: ["model"], value: (s) => pct(s.m.rws, s.m.rwsRounds) },
  { id: "perfectKpr", label: "Perfect kills per round", hltv: "Perfect Kills per Round", kind: "performance", group: "firepower", unit: "perRound", status: "approx",
    def: "Kills where the victim had not damaged you earlier in the round, per round.", value: (s) => per(s.m.perfectKills, s.m.rounds) },
  { id: "tradeDenials", label: "Trade denials per round", hltv: "Trade Denials per Round", kind: "performance", group: "firepower", unit: "perRound", status: "approx",
    def: "Kills less than 5 s after your previous kill in the round (SPEC.md), per round.", value: (s) => per(s.m.tradeDenials, s.m.rounds) },
  { id: "killRounds", label: "Rounds with a kill", hltv: "Rounds with a Kill", kind: "performance", group: "firepower", unit: "pct", status: "exact",
    def: "Rounds with at least one kill.", value: (s) => pct(s.m.killRounds, s.m.rounds) },
  { id: "mkRounds", label: "Rounds with a multi-kill", hltv: "Rounds with a Multi-Kill", kind: "performance", group: "firepower", unit: "pct", status: "exact",
    def: "Rounds with two or more kills.", value: (s) => pct(s.m.multiKillRounds, s.m.rounds) },
  { id: "netKills24", label: "Net kills per 24 rounds", hltv: "Net Kills per 24 Rounds", kind: "performance", group: "firepower", unit: "count", status: "exact",
    def: "Kills minus deaths, per 24 rounds.", value: (s) => (s.m.rounds ? (24 * (s.m.kills - s.m.deaths)) / s.m.rounds : null) },
  { id: "netDamage", label: "Net damage per round", hltv: "Net Damage per Round", kind: "performance", group: "firepower", unit: "dmg", status: "approx",
    def: "Damage dealt to enemies minus damage taken from enemies, per round.", value: (s) => per(s.m.dmg - s.m.dmgTaken, s.m.rounds) },

  // ---- Entrying (identity)
  { id: "tradeableDeaths", label: "Tradeable deaths per round", hltv: "Tradeable Deaths per Round", kind: "identity", group: "entrying", unit: "perRound", status: "approx",
    def: "Deaths with a living teammate within 1,000 units, per round with positions.", value: (s) => per(s.m.tradeableDeaths, s.m.posRounds) },
  { id: "deathsTradedPct", label: "Deaths traded", hltv: "Deaths Traded %", kind: "identity", group: "entrying", unit: "pct", status: "exact",
    def: `Share of your deaths that a teammate traded (${WINDOW}).`, value: (s) => pct(s.m.tradedDeaths, s.m.deaths) },
  { id: "baitAssists", label: "Bait assists per round", hltv: "Bait Assists per Round", kind: "identity", group: "entrying", unit: "perRound", status: "approx",
    def: "Your deaths that a teammate traded, per round: you drew the enemy out.", value: (s) => per(s.m.tradedDeaths, s.m.rounds) },
  { id: "openingTradedPct", label: "Opening deaths traded", hltv: "Opening Deaths Traded %", kind: "identity", group: "entrying", unit: "pct", status: "exact",
    def: "Share of your opening deaths that a teammate traded.", value: (s) => pct(s.m.openingTraded, s.m.openingDeaths) },

  // ---- Trading (identity)
  { id: "tradeOpps", label: "Trade opportunities per round", hltv: "Trade Opportunities per Round", kind: "identity", group: "trading", unit: "perRound", status: "approx",
    def: "Teammate deaths within 1,000 units of you while you were alive, per round with positions.", value: (s) => per(s.m.tradeOpps, s.m.posRounds) },
  { id: "tradeKillsPct", label: "Trade kills", hltv: "Trade Kills %", kind: "identity", group: "trading", unit: "pct", status: "exact",
    def: `Share of your kills that were trade kills (${WINDOW}).`, value: (s) => pct(s.m.tradeKills, s.m.kills) },
  { id: "baitKillsPct", label: "Bait kills", hltv: "Bait Kills %", kind: "identity", group: "trading", unit: "pct", status: "approx",
    def: "Share of your kills made less than 5 s after a teammate died, on any enemy. HLTV's rule is unpublished; this one is ours.", value: (s) => pct(s.m.baitKills, s.m.kills) },
  { id: "assistedKillsPct", label: "Assisted kills", hltv: "Assisted Kills %", kind: "identity", group: "trading", unit: "pct", status: "exact",
    def: "Share of your kills where a teammate got the assist.", value: (s) => pct(s.m.assistedKills, s.m.kills) },

  // ---- Opening (identity)
  { id: "openingAttempts", label: "Opening attempts", hltv: "Opening Attempts", kind: "identity", group: "opening", unit: "pct", status: "exact",
    def: "Rounds where you made or suffered the first kill.", value: (s) => pct(s.m.openingKills + s.m.openingDeaths, s.m.rounds) },
  { id: "firstDuelRank", label: "First duel rank in team", hltv: "First Duel Rank in Team", kind: "identity", group: "opening", unit: "rank", status: "approx",
    def: "Your place (1 = first) among teammates in first dealing or taking enemy damage, averaged over rounds where you did.", value: (s) => per(s.m.duelRankSum, s.m.duelRounds) },
  { id: "firstDuelTime", label: "First duel time", hltv: "First Duel Time", kind: "identity", group: "opening", unit: "secs", status: "approx",
    def: "Seconds after freeze end of your first enemy damage dealt or taken.", value: (s) => per(s.m.duelTimeSum, s.m.duelRounds) },
  { id: "weaponAttacks", label: "Weapon attacks per round", hltv: "Weapon Attacks per Round", kind: "identity", group: "opening", unit: "perRound", status: "approx",
    def: "Gun shots fired per round.", value: (s) => per(s.m.gunShots, s.m.rounds) },

  // ---- Closing (identity)
  { id: "timeAlive", label: "Time alive per round", hltv: "Time Alive per Round", kind: "identity", group: "closing", unit: "secs", status: "exact",
    def: "Seconds from freeze end to your death or the round end.", value: (s) => per(s.m.aliveSecs, s.m.rounds) },
  { id: "alivePostPlant", label: "Alive for post-plant", hltv: "Alive for Post-Plant %", kind: "identity", group: "closing", unit: "pct", status: "approx",
    def: "Rounds with a plant where you were alive when the bomb went down.", value: (s) => pct(s.m.aliveAtPlant, s.m.postPlantRounds) },
  { id: "lastAlive", label: "Last alive", hltv: "Last Alive in Team", kind: "identity", group: "closing", unit: "pct", status: "approx",
    def: "Rounds where you were, at some moment, the only player of your side alive.", value: (s) => pct(s.m.lastAlive, s.m.rounds) },
  { id: "clutches24", label: "Clutches per 24 rounds", hltv: "Clutches per 24 Rounds", kind: "identity", group: "closing", unit: "count", status: "exact",
    def: "1vX clutches won per 24 rounds (CS Demo Manager's clutch detection).", value: (s) => (s.m.rounds ? (24 * clutchWins(s)) / s.m.rounds : null) },

  // ---- Sniping (identity)
  { id: "roundsWithSniper", label: "Rounds with a sniper", hltv: "Rounds with a Sniper", kind: "identity", group: "sniping", unit: "pct", status: "approx",
    def: "Rounds you carried a sniper rifle at freeze end or killed with one.", needs: ["loadout"], value: (s) => pct(s.m.roundsWithSniper, s.m.loadoutRounds) },
  { id: "sniperKillsPct", label: "Sniper kills", hltv: "Sniper Kills %", kind: "identity", group: "sniping", unit: "pct", status: "exact",
    def: "Share of your kills made with the AWP, SSG 08, SCAR-20 or G3SG1.", value: (s) => pct(s.m.sniperKills, s.m.kills) },
  { id: "roundsWithAwp", label: "Rounds with an AWP", hltv: "Rounds with an AWP", kind: "identity", group: "sniping", unit: "pct", status: "approx",
    def: "Rounds you carried an AWP at freeze end or killed with one.", needs: ["loadout"], value: (s) => pct(s.m.roundsWithAwp, s.m.loadoutRounds) },
  { id: "awpKillsPct", label: "AWP kills", hltv: "AWP Kills %", kind: "identity", group: "sniping", unit: "pct", status: "exact",
    def: "Share of your kills made with the AWP.", value: (s) => pct(s.m.awpKills, s.m.kills) },

  // ---- Utility (identity)
  { id: "smokesPR", label: "Smokes thrown per round", hltv: "Smokes Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    def: "Smoke grenades thrown per round.", value: (s) => per(s.m.smokes, s.m.rounds) },
  { id: "flashesPR", label: "Flashbangs thrown per round", hltv: "Flashbangs Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    def: "Flashbangs thrown per round.", value: (s) => per(s.m.flashes, s.m.rounds) },
  { id: "molotovsPR", label: "Molotovs thrown per round", hltv: "Molotovs Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    def: "Molotovs and incendiaries thrown per round.", value: (s) => per(s.m.molotovs, s.m.rounds) },
  { id: "hesPR", label: "HE grenades thrown per round", hltv: "HE Grenades Thrown per Round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    def: "HE grenades thrown per round.", value: (s) => per(s.m.hes, s.m.rounds) },

  // ---- HLTV's "how good" metrics (performance)
  { id: "tradeKillSuccess", label: "Trade kill success", hltv: "Trade Kill Success %", kind: "performance", group: "trading", unit: "pct", status: "approx",
    def: `Trade opportunities where you killed the killer within ${WINDOW}.`, value: (s) => pct(s.m.tradeOppsTaken, s.m.tradeOpps) },
  { id: "tradeAttemptPct", label: "Trade attempts", kind: "performance", group: "trading", unit: "pct", status: "approx",
    def: `Trade opportunities (a teammate died within 1,000 units of you) where you hit the killer within ${WINDOW}. With Trade kill success and opportunities, Leetify's opportunity, attempt, success triple.`,
    value: (s) => pct(s.m.tradeAttempts, s.m.tradeOpps) },
  { id: "tradeAttemptSuccess", label: "Trade attempt success", kind: "performance", group: "trading", unit: "pct", status: "approx",
    def: `Trade attempts (you hit the killer within ${WINDOW}) that ended with you killing him.`, value: (s) => pct(s.m.tradeOppsTaken, s.m.tradeAttempts) },
  { id: "tradedAttemptPct", label: "Trade attempts for your deaths", kind: "performance", group: "entrying", unit: "pct", status: "approx",
    def: `Tradeable deaths (a teammate within 1,000 units) where a teammate hit your killer within ${WINDOW}; Traded death success is how many of them were traded.`,
    value: (s) => pct(s.m.tradedAttempts, s.m.tradeableDeaths) },
  { id: "tradedDeathSuccess", label: "Traded death success", hltv: "Traded Death Success %", kind: "performance", group: "entrying", unit: "pct", status: "approx",
    def: "Tradeable deaths (a living teammate within 1,000 units) that a teammate traded.", value: (s) => pct(s.m.tradeableTraded, s.m.tradeableDeaths) },
  { id: "openingSwing", label: "Opening swing", hltv: "Opening Swing", kind: "performance", group: "opening", unit: "pct", status: "approx",
    def: "Swing from opening kills and deaths, per round.", needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.openingSwing) / s.m.swingRounds : null) },
  { id: "clutchSwing", label: "Clutch swing", hltv: "Clutch Swing", kind: "performance", group: "closing", unit: "pct", status: "approx",
    def: "Swing from kills and deaths after you became the last of your side alive, per round.", needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.clutchSwing) / s.m.swingRounds : null) },
  { id: "awpSwing", label: "AWP swing", hltv: "AWP Swing", kind: "performance", group: "sniping", unit: "pct", status: "approx",
    def: "Swing from your AWP kills and your deaths holding the AWP, per round.", needs: ["model", "activeWeapon"], value: (s) => (s.m.swingRounds ? (100 * s.m.awpSwing) / s.m.swingRounds : null) },
  { id: "awpDuelWin", label: "AWP duel win", hltv: "AWP Duel Win %", kind: "performance", group: "sniping", unit: "pct", status: "approx",
    def: "Duels with the AWP in hand (your AWP kills plus your deaths holding it) that you won.", needs: ["activeWeapon"], value: (s) => pct(s.m.awpDuelWins, s.m.awpDuels),
    sample: { n: (s) => s.m.awpDuels, unit: "AWP duels" } },
  { id: "flashSwing", label: "Flash swing", hltv: "Flash Swing", kind: "performance", group: "utility", unit: "pct", status: "approx",
    def: "Swing credited to your flashes: the flash share of a kill's credit when your flash was blinding the victim (params.json swing.flash_credit_fraction), split equally when several flashes were, per round.",
    needs: ["model"], value: (s) => (s.m.swingRounds ? (100 * s.m.flashSwing) / s.m.swingRounds : null) },
  { id: "assistsPerFlash", label: "Assists per flash", hltv: "Assists per Flash", kind: "performance", group: "utility", unit: "perRound", status: "approx",
    def: "Flash assists (the game's) per flashbang thrown.", value: (s) => per(s.m.flashAssists, s.m.flashes) },
  { id: "grenadeDmgTaken", label: "Grenade damage received per round", hltv: "Grenade Damage Received", kind: "performance", group: "utility", unit: "dmg", status: "exact", lowerIsBetter: true,
    def: "Damage you took from enemy grenades and fire, per round.", value: (s) => per(s.m.utilDmgTaken, s.m.rounds) },
  { id: "dmgPerHe", label: "Damage per HE thrown", hltv: "Damage per HE Thrown", kind: "performance", group: "utility", unit: "dmg", status: "exact",
    def: "Enemy damage from your HE grenades per HE thrown.", value: (s) => per(s.m.heDmg, s.m.hes) },
  { id: "oneVsOne", label: "1v1 win rate", kind: "performance", group: "closing", unit: "pct", status: "exact",
    def: "1v1 clutches won.", value: (s) => pct(s.m.clutchWon1, s.m.clutch1) },

  // ---- utility quality (performance; Leetify's flash definitions)
  { id: "flashKillsPerFlash", label: "Flash-to-kills per flash", kind: "performance", group: "utility", unit: "perRound", status: "exact",
    def: "Enemies you flashed who died to your team while still blind (Leetify's flash-to-kill), per flashbang thrown, as Leetify counts it so players who flash more or less compare.", value: (s) => per(s.m.flashKills, s.m.flashes) },
  { id: "utilUnused", label: "Unused utility on death", kind: "performance", group: "utility", unit: "money", status: "approx", lowerIsBetter: true,
    def: "Value of grenades you held at freeze end and had not thrown when you died, per death (Leetify's rate; per round it mostly measured dying early). Grenades picked up later are not seen.", needs: ["loadout"], value: (s) => per(s.m.utilUnused, s.m.utilDeaths) },

  // ---- utility description (identity). Not scored as performance: on pro team-rounds these duplicate
  // other metrics or show no lasting link to winning rounds (METRICS.md, "Descriptive utility").
  { id: "enemiesPerFlash", label: "Enemies flashed per flash", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    def: `Enemies blinded for more than ${FLASHED_MIN_S} s (Leetify's cut) per flashbang thrown.`, value: (s) => per(s.m.enemiesFlashed, s.m.flashes) },
  { id: "blindPerFlash", label: "Enemy blind time per flash", kind: "identity", group: "utility", unit: "secs", status: "exact",
    def: `Seconds of enemy blindness (blinds over ${FLASHED_MIN_S} s) per flashbang thrown.`, value: (s) => per(s.m.enemyBlindSecs, s.m.flashes) },
  { id: "teamFlashPR", label: "Teammates flashed per round", kind: "identity", group: "utility", unit: "perRound", status: "exact",
    def: `Teammates you blinded for more than ${FLASHED_MIN_S} s, per round.`, value: (s) => per(s.m.teamFlashed, s.m.rounds) },
  { id: "utilDmgPR", label: "Utility damage per round", kind: "identity", group: "utility", unit: "dmg", status: "exact",
    def: "Enemy damage from your grenades and fire, per round.", value: (s) => per(s.m.utilDmg, s.m.rounds) },
  { id: "utilSpentPR", label: "Utility bought per round", kind: "identity", group: "utility", unit: "money", status: "exact",
    def: "Money spent on grenades per round, less grenades refunded in the buy zone. Needs the purchases table (demos through the extractor).",
    value: (s) => per(s.m.utilSpent, s.m.purchaseRounds) },
  { id: "molotovEnemiesHit", label: "Enemies burned per molotov", kind: "performance", group: "utility", unit: "perRound", status: "approx",
    def: "Distinct enemies your molotov or incendiary damaged, per one thrown (a fire that burned two enemies counts 2). Ours; nobody publishes a molotov usefulness definition, and its link to round wins is weak (VALIDATION.md).",
    value: (s) => per(s.m.molotovHits, s.m.molotovs) },
  { id: "molotovDmg", label: "Fire damage per molotov", kind: "performance", group: "utility", unit: "dmg", status: "approx",
    def: "Enemy damage from your molotovs and incendiaries per one thrown. Ours; its link to round wins is weak (VALIDATION.md).",
    value: (s) => per(s.m.fireDmg, s.m.molotovs) },
  { id: "fireDmgPR", label: "Fire damage per round", kind: "identity", group: "utility", unit: "dmg", status: "exact",
    def: "Enemy damage from your molotovs and incendiaries, per round.", value: (s) => per(s.m.fireDmg, s.m.rounds) },

  // ---- sniping and clutching extras kept from the old attribute cards
  { id: "sniperKpr", label: "Sniper kills per round", kind: "performance", group: "sniping", unit: "perRound", status: "exact", def: "Sniper rifle kills per round.", value: (s) => per(s.m.sniperKills, s.m.rounds) },
  { id: "awpKpr", label: "AWP kills per round", kind: "performance", group: "sniping", unit: "perRound", status: "exact",
    def: "AWP kills per round. Above 0.20 a player is compared with AWPers (design/identity.md).", value: (s) => per(s.m.awpKills, s.m.rounds) },
  { id: "savesPerLoss", label: "Saves per lost round", kind: "identity", group: "closing", unit: "perRound", status: "exact", def: "Rounds lost where you were alive at the end, per lost round.", value: (s) => per(s.m.saves, s.m.lostRounds) },
  { id: "openingSuccess", label: "Opening duel success", kind: "performance", group: "opening", unit: "pct", status: "exact",
    def: "Opening duels won.", value: (s) => pct(s.m.openingKills, s.m.openingKills + s.m.openingDeaths) },
];

export const METRICS: Metric[] = [...M, ...AIM_METRICS, ...MOVEMENT_METRICS, ...AGGRESSION_METRICS, ...CONTACT_METRICS, ...BUYING_METRICS, ...INFORMATION_METRICS, ...UTILQ_METRICS];
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
