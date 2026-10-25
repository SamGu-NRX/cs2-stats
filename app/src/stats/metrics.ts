// Every metric the app shows: label, one-line definition (the tooltip), how to compute it from
// additive counters, and whether the definition is CS Demo Manager's.
import type { Counters } from "./counters";
import { hsPercent, impact, rating2 } from "./rating";
import { sideSlices, type UtilSlice } from "./utility";

export interface Metric {
  id: string;
  label: string;
  def: string;
  /** definition matches CS Demo Manager's analyzer */
  csdm?: boolean;
  fmt: "dec2" | "dec1" | "pct" | "int" | "int0" | "secs" | "money";
  value: (c: Counters) => number | null;
  /** lower values are better (used for attribute scores) */
  lowerIsBetter?: boolean;
}

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

const M: Metric[] = [
  { id: "rating", label: "Rating 2.0", fmt: "dec2", csdm: true, value: (c) => (c.rounds ? rating2(c) : null),
    def: "Rating 2.0 (public approximation): 0.0073·KAST + 0.3591·KPR − 0.5329·DPR + 0.2372·Impact + 0.0032·ADR + 0.1587." },
  { id: "impact", label: "Impact", fmt: "dec2", csdm: true, value: (c) => (c.rounds ? impact(c) : null),
    def: "2.13·kills per round + 0.42·assists per round − 0.41." },
  { id: "kpr", label: "Kills per round", fmt: "dec2", csdm: true, value: (c) => per(c.kills, c.rounds), def: "Enemy kills divided by rounds played." },
  { id: "dpr", label: "Deaths per round", fmt: "dec2", csdm: true, value: (c) => per(c.deaths, c.rounds), def: "Deaths, including world deaths, divided by rounds.", lowerIsBetter: true },
  { id: "adr", label: "ADR", fmt: "dec1", csdm: true, value: (c) => per(c.dmg, c.rounds), def: "Health damage to enemies per round; each hit counts up to the HP the victim had. Matches recorded by the capture plugin can read up to 1 HP per hit below the game's own figure, because the hurt event drops fractional damage." },
  { id: "kast", label: "KAST", fmt: "pct", csdm: true, value: (c) => pct(c.kastRounds, c.rounds), def: "Rounds with a kill, assist, survival or traded death. In rounds captured as totals only, traded deaths are unknown and do not count." },
  { id: "hs", label: "HS%", fmt: "int", csdm: true, value: (c) => (c.kills ? hsPercent(c.hsKills, c.kills) : null), def: "Headshot kills as a share of kills, rounded down." },
  { id: "swing", label: "Round swing", fmt: "pct", value: (c) => (c.swingRounds ? (100 * c.swing) / c.swingRounds : null),
    def: "Average change in your team's round win probability you caused per round: your share of each kill (split by damage on the victim), minus the drop when you died (WPA, Xenopoulos et al. 2020)." },

  // Firepower
  { id: "killsPerWin", label: "Kills per round won", fmt: "dec2", value: (c) => per(c.killsWon, c.roundsWon), def: "Kills in rounds your team won, divided by those rounds." },
  { id: "dmgPerWin", label: "Damage per round won", fmt: "dec1", value: (c) => per(c.dmgWon, c.roundsWon), def: "Enemy damage in rounds your team won, divided by those rounds." },
  { id: "killRounds", label: "Rounds with a kill", fmt: "pct", value: (c) => pct(c.roundsWithKill, c.rounds), def: "Share of rounds with at least one kill." },
  { id: "multiRounds", label: "Multi-kill rounds", fmt: "pct", value: (c) => pct(c.multiKillRounds, c.rounds), def: "Share of rounds with two or more kills." },
  { id: "pistolRating", label: "Pistol round rating", fmt: "dec2", value: (c) => (c.pistol.rounds ? rating2(c.pistol) : null), def: "Rating 2.0 over pistol rounds only (first round of each half)." },

  // Entrying
  { id: "savedByMatePR", label: "Saved by teammate per round", fmt: "dec2", value: (c) => per(c.savedByTeammate, c.fullRounds),
    def: "Times a teammate killed an enemy who had hit you in the previous 2 s while you were still alive, per round." },
  { id: "tradedDeathsPR", label: "Traded deaths per round", fmt: "dec2", csdm: true, value: (c) => per(c.tradedDeaths, c.fullRounds), def: "Deaths whose killer was killed less than 5 s later, per round." },
  { id: "tradedDeathsPct", label: "Traded deaths", fmt: "pct", csdm: true, value: (c) => pct(c.tradedDeaths, c.fullDeaths), def: "Share of your deaths that were traded within 5 s." },
  { id: "openingTradedPct", label: "Opening deaths traded", fmt: "pct", csdm: true, value: (c) => pct(c.openingDeathsTraded, c.openingDeaths), def: "Share of your opening deaths that were traded within 5 s." },
  { id: "apr", label: "Assists per round", fmt: "dec2", csdm: true, value: (c) => per(c.assists, c.rounds), def: "Assists on enemy kills (flash assists included, as the game counts them), per round." },
  { id: "supportRounds", label: "Support rounds", fmt: "pct", value: (c) => pct(c.supportRounds, c.fullRounds), def: "Share of rounds with an assist or flash assist but no kill." },

  // Trading
  { id: "savedMatePR", label: "Saved teammate per round", fmt: "dec2", value: (c) => per(c.savedTeammate, c.fullRounds),
    def: "Times you killed an enemy who had hit a teammate in the previous 2 s while that teammate was still alive, per round." },
  { id: "tradeKillsPR", label: "Trade kills per round", fmt: "dec2", csdm: true, value: (c) => per(c.tradeKills, c.fullRounds), def: "Kills on an enemy who had made a kill less than 5 s earlier, per round." },
  { id: "tradeKillsPct", label: "Trade kills", fmt: "pct", csdm: true, value: (c) => pct(c.tradeKills, c.fullKills), def: "Share of your kills that were trade kills." },
  { id: "assistedKillsPct", label: "Assisted kills", fmt: "pct", value: (c) => pct(c.assistedKills, c.fullKills), def: "Share of your kills where a teammate got the assist." },
  { id: "dmgPerKill", label: "Damage per kill", fmt: "dec1", value: (c) => per(c.dmg, c.kills), def: "Enemy damage divided by kills; lower means less damage spent per kill.", lowerIsBetter: true },

  // Opening
  { id: "openKPR", label: "Opening kills per round", fmt: "dec2", csdm: true, value: (c) => per(c.openingKills, c.fullRounds), def: "First kill of the round (team kills skipped), per round." },
  { id: "openDPR", label: "Opening deaths per round", fmt: "dec2", csdm: true, value: (c) => per(c.openingDeaths, c.fullRounds), def: "First death of the round, per round.", lowerIsBetter: true },
  { id: "openAttempts", label: "Opening attempts", fmt: "pct", value: (c) => pct(c.openingKills + c.openingDeaths, c.fullRounds), def: "Share of rounds where you took part in the first kill." },
  { id: "openSuccess", label: "Opening success", fmt: "pct", value: (c) => pct(c.openingKills, c.openingKills + c.openingDeaths), def: "Opening duels won as a share of opening duels." },
  { id: "winAfterOpen", label: "Win after opening kill", fmt: "pct", value: (c) => pct(c.openingWins, c.openingKills), def: "Rounds won after you made the opening kill." },

  // Clutching
  { id: "clutchPointsPR", label: "Clutch points per round", fmt: "dec2", value: (c) => per(c.clutchPoints, c.fullRounds), def: "Won 1vX clutches weighted by X (1v1 = 1, 1v3 = 3), per round." },
  { id: "lastAlive", label: "Last alive", fmt: "pct", csdm: true, value: (c) => pct(c.lastAlive, c.fullRounds), def: "Share of rounds where you were the last player alive on your team against at least one enemy." },
  { id: "oneVsOne", label: "1v1 win", fmt: "pct", csdm: true, value: (c) => pct(c.clutchW[0], c.clutchN[0]), def: "1v1 clutches won as a share of 1v1 clutches." },
  { id: "timeAlive", label: "Time alive per round", fmt: "secs", value: (c) => per(c.aliveSecs, c.aliveRounds), def: "Seconds from freeze end until your death or the round end, per round." },
  { id: "savesPerLoss", label: "Saves per lost round", fmt: "dec2", value: (c) => per(c.saves, c.fullLost), def: "Rounds lost where you survived with more than $1,000 of equipment, per lost round." },

  // Sniping
  { id: "sniperKPR", label: "Sniper kills per round", fmt: "dec2", value: (c) => per(c.sniperKills, c.fullRounds), def: "Kills with the AWP, SSG 08, SCAR-20 or G3SG1, per round." },
  { id: "sniperPct", label: "Sniper kills", fmt: "pct", value: (c) => pct(c.sniperKills, c.fullKills), def: "Share of your kills made with a sniper rifle." },
  { id: "sniperRounds", label: "Rounds with a sniper kill", fmt: "pct", value: (c) => pct(c.sniperRounds, c.fullRounds), def: "Share of rounds with at least one sniper kill." },
  { id: "sniperMulti", label: "Sniper multi-kill rounds", fmt: "dec2", value: (c) => per(c.sniperMultiRounds, c.fullRounds), def: "Rounds with two or more sniper kills, per round." },
  { id: "sniperOpenPR", label: "Sniper opening kills per round", fmt: "dec2", value: (c) => per(c.sniperOpeningKills, c.fullRounds), def: "Opening kills made with a sniper rifle, per round." },

  // Utility
  { id: "utilDmgPR", label: "Utility damage per round", fmt: "dec1", csdm: true, value: (c) => per(c.utilDmg, c.fullRounds), def: "Enemy damage from grenades and fire, per round." },
  { id: "utilKills100", label: "Utility kills per 100 rounds", fmt: "dec1", value: (c) => (c.fullRounds ? (100 * c.utilKills) / c.fullRounds : null), def: "Kills with grenades or fire, per 100 rounds." },
  { id: "nadesPR", label: "Grenades thrown per round", fmt: "dec2", value: (c) => per(c.nadesThrown, c.fullRounds), def: "HE, flash, smoke and decoy grenades that detonated, per round. Molotovs count when the log names the thrower." },
  { id: "flashesPR", label: "Flashes thrown per round", fmt: "dec2", value: (c) => per(c.flashesThrown, c.fullRounds), def: "Flashbangs you threw that detonated, per round." },
  { id: "flashAssistsPR", label: "Flash assists per round", fmt: "dec2", value: (c) => per(c.flashAssists, c.fullRounds), def: "Enemy kills by a teammate while the victim was blinded by your flash, per round." },
  { id: "blindPR", label: "Time opponent flashed per round", fmt: "secs", value: (c) => per(c.enemyBlindMs / 1000, c.fullRounds), def: "Seconds of blindness your flashes caused on enemies, per round." },
];

/** Utility metrics, defined on one side's utility slice so they can be split by T and CT. */
export interface UtilMetric extends Omit<Metric, "value"> { u: (u: UtilSlice) => number | null; needsPlugin?: boolean }
const NEEDS_PLUGIN = " The capture plugin does not record this yet.";
export const UTIL_METRICS: UtilMetric[] = [
  // HLTV names first
  { id: "u_dmgPR", label: "Utility damage per round", fmt: "dec1", csdm: true, u: (u) => per(u.utilDmg, u.rounds), def: "Enemy damage from grenades and fire, per round." },
  { id: "u_killsPer100", label: "Utility kills per 100 rounds", fmt: "dec1", u: (u) => (u.rounds ? (100 * u.utilKills) / u.rounds : null), def: "Kills with grenades or fire, per 100 rounds." },
  { id: "u_flashesPR", label: "Flashes thrown per round", fmt: "dec2", u: (u) => per(u.flashes, u.rounds), def: "Flashbangs you threw that detonated, per round." },
  { id: "u_flashAssistsPR", label: "Flash assists per round", fmt: "dec2", u: (u) => per(u.flashAssists, u.rounds), def: "Enemy kills by a teammate while the victim was blinded by your flash, per round." },
  { id: "u_blindPR", label: "Time opponent flashed per round", fmt: "secs", u: (u) => per(u.enemyBlindMs / 1000, u.rounds), def: "Seconds of blindness your flashes caused on enemies, per round." },
  { id: "u_grenadeDmgPR", label: "Grenade damage per round", fmt: "dec1", u: (u) => per(u.heDmg + u.fireDmg, u.rounds), def: "Enemy damage from HE grenades and fire (molotov, incendiary), per round." },
  { id: "u_oppFlashed", label: "Opponents flashed", fmt: "int0", u: (u) => u.enemiesFlashed, def: "Enemies your flashes blinded, counted once per enemy per flash." },
  { id: "u_flashAssists", label: "Flash assists", fmt: "int0", u: (u) => u.flashAssists, def: "Enemy kills by a teammate while the victim was blinded by your flash." },
  // More (Leetify-style)
  { id: "u_enemiesPerFlash", label: "Enemies flashed per flash", fmt: "dec2", u: (u) => per(u.enemiesFlashed, u.flashes), def: "Enemies blinded by your flashes, divided by flashes thrown." },
  { id: "u_blindPerFlash", label: "Enemy blind time per flash", fmt: "secs", u: (u) => per(u.enemyBlindMs / 1000, u.flashes), def: "Seconds of enemy blindness per flash thrown." },
  { id: "u_blindPerEnemy", label: "Blind time per enemy flashed", fmt: "secs", u: (u) => per(u.enemyBlindMs / 1000, u.enemiesFlashed), def: "Average seconds each blinded enemy stayed blind." },
  { id: "u_effectivePct", label: "Effective flashes", fmt: "pct", u: (u) => pct(u.effectiveFlashes, u.flashes), def: "Share of your flashes that blinded at least one enemy for 2.0 s or more." },
  { id: "u_flashKills", label: "Flashes that led to a kill", fmt: "int0", u: (u) => u.flashKills, def: "Enemies blinded by your flash who were killed by your team while still blind." },
  { id: "u_teamFlashed", label: "Teammates flashed", fmt: "int0", u: (u) => u.teamFlashed, def: "Times your flashes blinded a teammate." },
  { id: "u_teamBlind", label: "Team blind time", fmt: "secs", u: (u) => u.teamBlindMs / 1000, def: "Total seconds your flashes blinded teammates." },
  { id: "u_teamBlindAvg", label: "Average teammate blind time", fmt: "secs", u: (u) => per(u.teamBlindMs / 1000, u.teamFlashed), def: "Average seconds per teammate your flash blinded." },
  { id: "u_selfFlashed", label: "Self-flashes", fmt: "int0", u: (u) => u.selfFlashed, def: "Times your own flash blinded you." },
  { id: "u_hesPR", label: "HE grenades per round", fmt: "dec2", u: (u) => per(u.hes, u.rounds), def: "HE grenades you threw that exploded, per round." },
  { id: "u_dmgPerHE", label: "Damage per HE", fmt: "dec1", u: (u) => per(u.heDmg, u.hes), def: "Enemy damage from your HE grenades, divided by HEs thrown." },
  { id: "u_enemiesPerHE", label: "Enemies hit per HE", fmt: "dec2", u: (u) => per(u.heHits, u.hes), def: "Enemies your HE grenades damaged, divided by HEs thrown." },
  { id: "u_heTeamDmg", label: "HE team damage", fmt: "int0", u: (u) => u.heTeamDmg, def: "Damage your HE grenades did to teammates." },
  { id: "u_molotovsPR", label: "Molotovs per round", fmt: "dec2", u: (u) => per(u.molotovs, u.rounds), def: "Molotovs and incendiaries you threw that caught fire, per round. Legacy logs do not name the thrower." },
  { id: "u_dmgPerMolotov", label: "Damage per molotov", fmt: "dec1", u: (u) => per(u.fireDmg, u.molotovs), def: "Enemy fire damage divided by molotovs and incendiaries thrown." },
  { id: "u_burnTime", label: "Enemy burn time", fmt: "secs", needsPlugin: true, u: () => null, def: "Seconds enemies spent burning in your fire." + NEEDS_PLUGIN },
  { id: "u_smokesPR", label: "Smokes per round", fmt: "dec2", u: (u) => per(u.smokes, u.rounds), def: "Smoke grenades you threw that popped, per round." },
  { id: "u_thrownPR", label: "Utility thrown per round", fmt: "dec2", u: (u) => per(u.flashes + u.smokes + u.hes + u.molotovs + u.decoys, u.rounds), def: "All grenades you threw, per round." },
  { id: "u_spentPR", label: "Utility spent per round", fmt: "money", needsPlugin: true, u: (u) => (u.spentRounds ? u.spent / u.spentRounds : null), def: "Dollars spent on grenades per round, from each grenade's price. Needs capture plugin 1.0.0 or later." },
  { id: "u_unusedPR", label: "Unused utility on death per round", fmt: "money", needsPlugin: true, u: (u) => (u.heldDeaths ? u.heldValue / u.rounds : null), def: "Value of grenades you still held when you died, per round (Leetify-style). Needs capture plugin 1.0.0 or later." },
];

for (const um of UTIL_METRICS) M.push({ ...um, value: (c: Counters) => um.u(sideSlices(c.util, "both")) });

export const METRICS: Record<string, Metric> = Object.fromEntries(M.map((m) => [m.id, m]));


export function tooltip(m: Metric): string {
  return m.csdm ? `${m.def} As in CS Demo Manager.` : m.def;
}

export function formatMetric(m: Metric, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  switch (m.fmt) {
    case "dec2": return v.toFixed(2);
    case "dec1": return v.toFixed(1);
    case "pct": return `${v.toFixed(1)}%`;
    case "int": return `${Math.round(v)}%`;
    case "secs": return `${v.toFixed(1)} s`;
    case "int0": return String(Math.round(v));
    case "money": return `$${Math.round(v).toLocaleString("en-US")}`;
  }
}
