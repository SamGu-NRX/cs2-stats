// Sub-stats under HLTV's current names. Each entry says whether it is exact (a direct count with an
// unambiguous definition), approx (our reading of HLTV's description, or a hand-picked window or
// distance) or unavailable (the files lack the data). HLTV has not published formulas for most of
// these, so "approx" entries state their definition in `def`.
import type { MatchCtx } from "./context";
import type { Counters } from "./counters";
import { METRICS } from "./metrics";
import { rating3 } from "./rating3";
import type { RoundDetail } from "./rounds";
import { TRADE_WINDOW_S } from "./rules";
import type { Vec3 } from "./schema";
import { isUtility, weaponClass } from "./weapons";

/** A teammate within this distance (world units) could have traded a death. Hand-picked: about a long rifle duel on de_dust2's long A. */
export const TRADE_DISTANCE = 1000;

/** Additive inputs for the sub-stats that counters.ts does not already hold. */
export interface HltvCounts {
  /** won rounds with a known swing, and the summed share of the team's positive swing in them */
  winRounds: number;
  rws: number;
  /** enemy kills where the victim had not damaged the killer earlier in the round */
  perfectKills: number;
  /** rounds where the player took part in a duel (dealt or took enemy damage), the summed rank of their first duel among all players, and its time */
  duelRounds: number;
  duelRankSum: number;
  duelTimeSum: number;
  /** deaths to an enemy with positions known, and those with a living teammate within TRADE_DISTANCE */
  deathsWithPos: number;
  tradeableDeaths: number;
  /** teammate deaths within TRADE_DISTANCE of the player while alive, and those the player traded within 5 s */
  tradeOpps: number;
  tradeOppsTaken: number;
  /** damaging gun hits on enemies */
  gunHits: number;
}

export const emptyHltv = (): HltvCounts => ({
  winRounds: 0, rws: 0, perfectKills: 0, duelRounds: 0, duelRankSum: 0, duelTimeSum: 0, deathsWithPos: 0, tradeableDeaths: 0,
  tradeOpps: 0, tradeOppsTaken: 0, gunHits: 0,
});

/** Nearest position sample of a player to a tick, within one second; positions are plugin-only. */
function positionIndex(ctx: MatchCtx): (ri: number, pi: number, tick: number) => Vec3 | null {
  const p = ctx.m.pos;
  const by = new Map<string, number[]>();
  for (let i = 0; i < p.ri.length; i++) {
    const k = `${p.ri[i]}:${p.pi[i]}`;
    let l = by.get(k);
    if (!l) by.set(k, (l = []));
    l.push(i);
  }
  return (ri, pi, tick) => {
    let best = -1;
    let bd = ctx.tickrate + 1;
    for (const i of by.get(`${ri}:${pi}`) ?? []) {
      const d = Math.abs(p.tick[i] - tick);
      if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? null : [p.x[best], p.y[best], p.z[best]];
  };
}

const dist2 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function hltvCounts(ctx: MatchCtx, details: RoundDetail[]): HltvCounts[] {
  const m = ctx.m;
  const out = Array.from({ length: ctx.nPlayers }, emptyHltv);
  const posAt = m.pos.ri.length ? positionIndex(ctx) : null;
  const window = TRADE_WINDOW_S * ctx.tickrate;
  const d = m.damage;
  const dmgByRound = new Map<number, number[]>();
  for (let j = 0; j < d.ri.length; j++) {
    let l = dmgByRound.get(d.ri[j]);
    if (!l) dmgByRound.set(d.ri[j], (l = []));
    l.push(j);
  }

  for (const r of details) {
    if (!r.captured) continue;
    const ri = r.ri;
    const freeze = m.rounds.freezeTick[ri];
    const players = r.players.filter((p) => p !== null).map((p) => p!);
    const rows = dmgByRound.get(ri) ?? [];

    // round win shares
    if (r.winSide !== null && players.every((p) => p.swing !== null)) {
      const team = players.filter((p) => p.side === r.winSide);
      const total = team.reduce((s, p) => s + Math.max(0, p.swing!), 0);
      for (const p of team) { out[p.pi].winRounds++; out[p.pi].rws += total > 0 ? Math.max(0, p.swing!) / total : 1 / team.length; }
    }

    // perfect kills and gun hits
    for (const p of players) {
      for (const k of p.kills) {
        const hurt = rows.some((j) => d.attacker[j] === k.victim && d.victim[j] === p.pi && d.tick[j] <= k.tick);
        if (!hurt) out[p.pi].perfectKills++;
      }
    }
    for (const j of rows) {
      const a = d.attacker[j];
      if (a === null || !r.players[a] || !r.players[d.victim[j]] || r.players[a]!.side === r.players[d.victim[j]]!.side) continue;
      const w = m.weapons[d.weapon[j]] ?? "";
      if (!isUtility(w) && weaponClass(w) !== "knife" && weaponClass(w) !== "other") out[a].gunHits++;
    }

    // first duel: each player's first enemy damage dealt or taken, ranked across the round
    const first = new Map<number, number>();
    for (const j of rows) {
      const a = d.attacker[j];
      const v = d.victim[j];
      if (a === null || !r.players[a] || !r.players[v] || r.players[a]!.side === r.players[v]!.side) continue;
      for (const pi of [a, v]) if (!first.has(pi) || d.tick[j] < first.get(pi)!) first.set(pi, d.tick[j]);
    }
    const ticks = [...first.values()].sort((x, y) => x - y);
    for (const [pi, t] of first) {
      out[pi].duelRounds++;
      out[pi].duelRankSum += ticks.indexOf(t) + 1; // ties share the better rank
      if (freeze !== null) out[pi].duelTimeSum += (t - freeze) / ctx.tickrate;
    }

    // tradeable deaths and trade opportunities (positions needed)
    if (!posAt) continue;
    for (const v of players) {
      const k = v.death;
      if (!k || k.teamKill || k.suicide || k.killer === null) continue;
      const at = m.kills.vpos[ctx.kills[k.k].i] ?? posAt(ri, v.pi, k.tick);
      if (!at) continue;
      out[v.pi].deathsWithPos++;
      let tradeable = false;
      for (const mate of players) {
        if (mate.pi === v.pi || mate.side !== v.side) continue;
        if (mate.death && mate.death.tick <= k.tick) continue;
        const mp = posAt(ri, mate.pi, k.tick);
        if (!mp || dist2(mp, at) > TRADE_DISTANCE) continue;
        tradeable = true;
        out[mate.pi].tradeOpps++;
        if (mate.kills.some((x) => x.victim === k.killer && x.tick > k.tick && x.tick - k.tick < window)) out[mate.pi].tradeOppsTaken++;
      }
      if (tradeable) out[v.pi].tradeableDeaths++;
    }
  }
  return out;
}

export type SubStatStatus = "exact" | "approx" | "unavailable";

export interface SubStat {
  id: string;
  /** HLTV's name for the stat */
  name: string;
  status: SubStatStatus;
  def: string;
  fmt: "dec2" | "dec1" | "pct" | "secs" | "int0";
  value: (c: Counters) => number | null;
}

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const fromMetric = (id: string, name: string, status: SubStatStatus, note = ""): SubStat => {
  const mt = METRICS[id];
  return { id, name, status, def: mt.def + note, fmt: mt.fmt === "int" || mt.fmt === "money" ? "pct" : mt.fmt, value: mt.value };
};
const WINDOW = " The 5 s window is CS Demo Manager's trade window; HLTV does not publish its own.";

export const SUBSTATS: SubStat[] = [
  { id: "rating3", name: "Rating 3.0", status: "approx", fmt: "dec2", value: (c) => rating3(c.r3).value, def: "Rating 3.0 (approx.), see rating3.ts." },
  fromMetric("kpr", "Kills per round", "exact"),
  fromMetric("adr", "Damage per round", "exact"),
  fromMetric("dpr", "Deaths per round", "exact"),
  fromMetric("kast", "KAST", "exact", WINDOW),
  { id: "multiKill", name: "Multi-kill", status: "exact", fmt: "pct", value: (c) => pct(c.multiKillRounds, c.rounds), def: "Share of rounds with two or more kills." },
  { id: "roundSwing", name: "Round swing", status: "approx", fmt: "pct", value: (c) => (c.r3.swingRounds ? (100 * c.r3.swing) / c.r3.swingRounds : null),
    def: "Change in your team's round win probability per round from your kills (final damage 50 %, 40+ damage shared, flash assist 10 %) and deaths (a quarter forgiven when traded). The split is a parameter set, not HLTV's." },
  fromMetric("killsPerWin", "Kills per round win", "exact"),
  fromMetric("dmgPerWin", "Damage per round win", "exact"),
  { id: "rws", name: "Round win shares", status: "approx", fmt: "pct", value: (c) => pct(c.hl.rws, c.hl.winRounds),
    def: "In rounds your team won, your share of the team's positive round swing, averaged over those rounds (20 % is an even share)." },
  { id: "perfectKills", name: "Perfect kills", status: "approx", fmt: "pct", value: (c) => pct(c.hl.perfectKills, c.fullKills),
    def: "Share of your kills where the victim had not damaged you earlier in the round." },
  { id: "tradeDenials", name: "Trade denials", status: "approx", fmt: "dec2", value: (c) => per(c.r3.tradeDenials, c.r3.rounds),
    def: "Kills made less than 5 s after your previous kill in the round (you killed the player coming to trade), per round." },
  { id: "failedTrades", name: "Failed trades", status: "approx", fmt: "dec2", value: (c) => per(c.r3.failedTrades, c.r3.rounds),
    def: "Deaths less than 5 s after a teammate, to the same enemy, per round." },
  { id: "tradeableDeaths", name: "Tradeable deaths", status: "approx", fmt: "pct", value: (c) => pct(c.hl.tradeableDeaths, c.hl.deathsWithPos),
    def: `Share of your deaths with a living teammate within ${TRADE_DISTANCE} units. Needs positions (capture plugin 1.0.0).` },
  { id: "tradeOpps", name: "Trade opportunities", status: "approx", fmt: "dec2", value: (c) => per(c.hl.tradeOpps, c.fullRounds),
    def: `Teammate deaths within ${TRADE_DISTANCE} units of you while you were alive, per round. Needs positions (capture plugin 1.0.0).` },
  { id: "tradeOppsTaken", name: "Trade success", status: "approx", fmt: "pct", value: (c) => pct(c.hl.tradeOppsTaken, c.hl.tradeOpps),
    def: "Trade opportunities where you killed the killer within 5 s." },
  { id: "baitAssists", name: "Bait assists", status: "approx", fmt: "dec2", value: (c) => per(c.tradedDeaths, c.fullRounds),
    def: "Your deaths that a teammate traded within 5 s, per round: you drew the enemy out." + WINDOW },
  { id: "baitKills", name: "Bait kills", status: "approx", fmt: "dec2", value: (c) => per(c.tradeKills, c.fullRounds),
    def: "Kills on an enemy who had made a kill less than 5 s earlier, per round." + WINDOW },
  { id: "firstDuelRank", name: "First duel rank", status: "approx", fmt: "dec2", value: (c) => per(c.hl.duelRankSum, c.hl.duelRounds),
    def: "Average order (1 = first of the ten players) in which you first dealt or took enemy damage in a round, over rounds where you did." },
  { id: "firstDuelTime", name: "First duel time", status: "approx", fmt: "secs", value: (c) => per(c.hl.duelTimeSum, c.hl.duelRounds),
    def: "Average seconds after freeze end of your first enemy damage dealt or taken." },
  { id: "weaponAttacks", name: "Weapon attacks", status: "approx", fmt: "dec2", value: (c) => per(c.hl.gunHits, c.fullRounds),
    def: "Damaging gun hits on enemies per round. Shots that miss are only recorded for you, so bots cannot be compared on attacks fired." },
  { id: "clutchesPer24", name: "Clutches per 24", status: "exact", fmt: "dec2", value: (c) => (c.fullRounds ? (24 * c.clutchW.reduce((a, b) => a + b, 0)) / c.fullRounds : null),
    def: "1vX clutches won per 24 rounds (CS Demo Manager's clutch detection)." },
  fromMetric("openKPR", "Opening kills per round", "exact"),
  fromMetric("openDPR", "Opening deaths per round", "exact"),
  fromMetric("openAttempts", "Opening attempts", "exact"),
  fromMetric("openSuccess", "Opening success", "exact"),
  fromMetric("winAfterOpen", "Win% after opening kill", "exact"),
  fromMetric("savedByMatePR", "Saved by teammate per round", "approx", " The 2 s window is our choice."),
  fromMetric("savedMatePR", "Saved teammate per round", "approx", " The 2 s window is our choice."),
  fromMetric("tradedDeathsPR", "Traded deaths per round", "exact", WINDOW),
  fromMetric("tradedDeathsPct", "Traded deaths percentage", "exact", WINDOW),
  fromMetric("openingTradedPct", "Opening deaths traded percentage", "exact", WINDOW),
  fromMetric("tradeKillsPR", "Trade kills per round", "exact", WINDOW),
  fromMetric("tradeKillsPct", "Trade kills percentage", "exact", WINDOW),
  fromMetric("assistedKillsPct", "Assisted kills percentage", "exact"),
  fromMetric("dmgPerKill", "Damage per kill", "exact"),
  fromMetric("apr", "Assists per round", "exact"),
  fromMetric("supportRounds", "Support rounds", "approx", " HLTV's exact rule is not published."),
  fromMetric("clutchPointsPR", "Clutch points per round", "approx", " The 1vX weighting is our choice."),
  fromMetric("lastAlive", "Last alive percentage", "exact"),
  fromMetric("oneVsOne", "1on1 win percentage", "exact"),
  fromMetric("timeAlive", "Time alive per round", "exact"),
  fromMetric("savesPerLoss", "Saves per round loss", "approx", " Plugin files count survival with a primary; older files count survival with more than $1,000 of equipment."),
  fromMetric("sniperKPR", "Sniper kills per round", "exact"),
  fromMetric("sniperPct", "Sniper kills percentage", "exact"),
  fromMetric("sniperRounds", "Rounds with sniper kills percentage", "exact"),
  fromMetric("sniperMulti", "Sniper multi-kill rounds", "exact"),
  fromMetric("sniperOpenPR", "Sniper opening kills per round", "exact"),
  fromMetric("utilDmgPR", "Utility damage per round", "exact"),
  fromMetric("utilKills100", "Utility kills per 100 rounds", "exact"),
  fromMetric("flashesPR", "Flashes thrown per round", "exact"),
  fromMetric("flashAssistsPR", "Flash assists per round", "exact"),
  fromMetric("blindPR", "Time opponent flashed per round", "exact"),
  fromMetric("pistolRating", "Pistol round rating", "approx", " Uses Rating 2.0 (approx.)."),
  { id: "ecoKpr", name: "Kills per round (eco-adjusted)", status: "approx", fmt: "dec2", value: (c) => per(c.r3.ecoKills, c.r3.rounds),
    def: "Kills weighted by the duel's economy (rating3.ts kill points), per round." },
  { id: "ecoAdr", name: "Damage per round (eco-adjusted)", status: "approx", fmt: "dec1", value: (c) => per(c.r3.ecoDmg, c.r3.rounds),
    def: "Damage weighted like kills, per round." },
  { id: "utilSuccess", name: "Utility success", status: "unavailable", fmt: "pct", value: () => null,
    def: "HLTV has not published what counts as a successful grenade, and smokes' effect cannot be read from the files." },
];

export const SUBSTAT_BY_ID: Record<string, SubStat> = Object.fromEntries(SUBSTATS.map((s) => [s.id, s]));
