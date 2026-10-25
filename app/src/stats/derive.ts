// derive(tables) -> facts: the one path from a match's tables to everything the engine knows about
// it. Deterministic and per event; rollup.ts sums the facts under filters.
import { classifyBuy, isPistolRound, type BuyClass } from "./economy";
import { DERIVE_VERSION, emptyMeasures, type KillFact, type MatchFacts, type PlayerInfo, type PlayerRound, type RoundFact } from "./facts";
import { kastRound, markOpening, markTrades } from "./rules";
import type { MatchTables, Side } from "./tables";

const asSide = (s: string | null | undefined): Side | null => (s === "CT" ? "CT" : s === "T" ? "T" : null);

/**
 * The match date and round limit, from the match row's JSON columns. A demo carries no date: local
 * and downloaded demos get `date` from whoever extracted them; HLTV archives only record when the
 * demo file was written (`dem_modified_in_archive`), which is the day of the match or the day after.
 */
export function matchMeta(t: MatchTables): { date: string | null; maxRounds: number } {
  const extra = JSON.parse(t.match.extra[0]) as Record<string, unknown>;
  const convars = JSON.parse(t.match.convars[0]) as Record<string, unknown>;
  const raw = extra.date ?? extra.dem_modified_in_archive;
  return { date: typeof raw === "string" ? raw.slice(0, 10) : null, maxRounds: Number(convars.mp_maxrounds ?? 24) };
}

/** Indexes shared by the families: player ids, sides per round, and rows grouped by round. */
export interface Ctx {
  t: MatchTables;
  tickRate: number;
  nRounds: number;
  pi: Map<string, number>;
  players: PlayerInfo[];
  /** side[ri][pi], null when the player had no side at freeze end */
  side: (Side | null)[][];
  ctTeam: (0 | 1)[];
  freezeEnd: (number | null)[];
  /** row indexes of a table by round (0-based) */
  byRound: (table: "kills" | "damages" | "blinds" | "grenade_throws" | "shots" | "positions") => number[][];
}

export function buildCtx(t: MatchTables): Ctx {
  const tickRate = t.match.tick_rate[0];
  const nRounds = t.rounds.n;
  const teams = [t.match.team_ct_start[0], t.match.team_t_start[0]];
  const pi = new Map<string, number>();
  const players: PlayerInfo[] = [];
  const add = (id: string, name: string, team: string | null) => {
    if (pi.has(id)) return;
    pi.set(id, players.length);
    const ti = team === null ? -1 : teams.indexOf(team);
    players.push({ id, name, team: ti === 0 ? 0 : ti === 1 ? 1 : null });
  };
  for (let i = 0; i < t.players.n; i++) add(t.players.steamid[i], t.players.name[i], t.players.team[i]);
  for (let i = 0; i < t.player_rounds.n; i++) add(t.player_rounds.steamid[i], t.player_rounds.steamid[i], null);

  const side: (Side | null)[][] = Array.from({ length: nRounds }, () => new Array<Side | null>(players.length).fill(null));
  for (let i = 0; i < t.player_rounds.n; i++) {
    const ri = t.player_rounds.round[i] - 1;
    if (ri >= 0 && ri < nRounds) side[ri][pi.get(t.player_rounds.steamid[i])!] = asSide(t.player_rounds.side[i]);
  }
  // The team on CT each round: by name when the tables carry team names, else the CT players' teams.
  const ctTeam = Array.from({ length: nRounds }, (_, ri): 0 | 1 => {
    const name = t.rounds.ct_team[ri];
    if (name !== null && teams.includes(name)) return teams.indexOf(name) as 0 | 1;
    const votes = [0, 0];
    side[ri].forEach((s, p) => { const tm = players[p].team; if (s === "CT" && tm !== null) votes[tm]++; });
    return votes[1] > votes[0] ? 1 : 0;
  });
  // A player without a team name takes the team they played CT or T for.
  for (let p = 0; p < players.length; p++) {
    if (players[p].team !== null) continue;
    for (let ri = 0; ri < nRounds && players[p].team === null; ri++) {
      const s = side[ri][p];
      if (s) players[p].team = s === "CT" ? ctTeam[ri] : ((1 - ctTeam[ri]) as 0 | 1);
    }
  }
  // A round with no player_rounds rows at all (a demo whose recording began with round 1 live has no
  // freeze end to read them at): every player with a team played it, on their team's side.
  for (let ri = 0; ri < nRounds; ri++) {
    if (side[ri].some((s) => s !== null)) continue;
    players.forEach((pl, p) => { if (pl.team !== null) side[ri][p] = pl.team === ctTeam[ri] ? "CT" : "T"; });
  }

  const cache = new Map<string, number[][]>();
  const byRound: Ctx["byRound"] = (name) => {
    let out = cache.get(name);
    if (out) return out;
    out = Array.from({ length: nRounds }, () => []);
    const tab = t[name];
    if (tab) for (let i = 0; i < tab.n; i++) { const ri = tab.round[i] - 1; if (ri >= 0 && ri < nRounds) out[ri].push(i); }
    cache.set(name, out);
    return out;
  };
  return { t, tickRate, nRounds, pi, players, side, ctTeam, freezeEnd: t.rounds.freeze_end_tick, byRound };
}

/**
 * Damage one hit counts for ADR: the hurt event's damage, capped at the victim's health before it.
 * This is HLTV's figure. The in-game scoreboard counts health lost instead (dmg_health_capped),
 * which is one HP more on hits where the event dropped fractional damage: 6,184 of 27,680
 * non-lethal hits on the 44 pro maps. With health lost, 157 of 440 HLTV ADRs were within 0.5; with
 * this, 398 are. 41 of the 42 misses are on the ten demos recorded from round 1 live.
 */
export function hitDamage(t: MatchTables, i: number): number {
  return Math.min(t.damages.dmg_health[i], t.damages.health_before[i] ?? 100);
}

function killFacts(c: Ctx): KillFact[][] {
  const k = c.t.kills;
  return c.byRound("kills").map((rows, ri) => {
    // A suicide after the round has ended is not a death (HLTV: 4 of 4 such deaths left out on the
    // pro maps, while bomb deaths after the end tick count).
    const kept = rows.filter((i) => !(k.is_suicide[i] && k.tick[i] > c.t.rounds.end_tick[ri]));
    const list = kept.map((i): KillFact => {
      const killer = k.attacker_steamid[i] === null ? null : c.pi.get(k.attacker_steamid[i]!) ?? null;
      const victim = c.pi.get(k.victim_steamid[i])!;
      const killerSide = killer === null ? null : asSide(k.a_side[i]) ?? c.side[ri][killer];
      const victimSide = asSide(k.v_side[i]) ?? c.side[ri][victim];
      const assister = k.assister_steamid[i] === null ? null : c.pi.get(k.assister_steamid[i]!) ?? null;
      const fe = c.freezeEnd[ri];
      return {
        ri, tick: k.tick[i], t: fe === null ? null : (k.tick[i] - fe) / c.tickRate,
        killer, victim, assister, flashAssist: k.assistedflash[i] === true,
        killerSide, victimSide, weapon: k.weapon[i], headshot: k.headshot[i], wallbang: (k.penetrated[i] ?? 0) > 0,
        smoke: k.thrusmoke[i] === true, noscope: k.noscope[i] === true,
        enemy: killer !== null && killer !== victim && killerSide !== null && victimSide !== null && killerSide !== victimSide,
        opening: false, tradeKill: false, traded: false,
      };
    });
    list.sort((a, b) => a.tick - b.tick);
    markOpening(list);
    markTrades(list, c.tickRate);
    return list;
  });
}

export function derive(t: MatchTables): MatchFacts {
  const c = buildCtx(t);
  const kills = killFacts(c);
  const r = t.rounds;
  const { date, maxRounds } = matchMeta(t);

  const rounds: RoundFact[] = [];
  const score: [number, number] = [0, 0];
  for (let ri = 0; ri < c.nRounds; ri++) {
    const winner = asSide(r.winner_side[ri]);
    if (winner) score[winner === "CT" ? c.ctTeam[ri] : 1 - c.ctTeam[ri]]++;
    const equip: Record<Side, number | null> = { CT: 0, T: 0 };
    const count: Record<Side, number> = { CT: 0, T: 0 };
    for (let i = 0; i < t.player_rounds.n; i++) {
      if (t.player_rounds.round[i] - 1 !== ri) continue;
      const s = asSide(t.player_rounds.side[i]);
      if (!s) continue;
      count[s]++;
      const e = t.player_rounds.equip_value_game[i];
      equip[s] = e === null || equip[s] === null ? null : equip[s]! + e;
    }
    for (const s of ["CT", "T"] as const) if (count[s] === 0) equip[s] = null;
    const pistol = isPistolRound(ri, maxRounds);
    const buy = (s: Side): BuyClass | null => (pistol ? "pistol" : equip[s] === null || count[s] === 0 ? null : classifyBuy(equip[s]!, count[s], false));
    const fe = r.freeze_end_tick[ri];
    rounds.push({
      ri, ctTeam: c.ctTeam[ri], winner, reason: r.reason[ri],
      durationS: fe === null ? null : (r.end_tick[ri] - fe) / c.tickRate,
      plantTick: r.plant_tick[ri], plantSite: r.plant_site[ri], defused: r.defuse_tick[ri] !== null, exploded: r.explode_tick[ri] !== null,
      equip, buy: { CT: buy("CT"), T: buy("T") },
    });
  }

  const dmgBy = c.byRound("damages").map((rows) => {
    const d = new Map<number, number>();
    for (const i of rows) {
      const a = t.damages.attacker_steamid[i];
      if (a === null || t.damages.is_self[i] || t.damages.is_team_damage[i]) continue;
      const p = c.pi.get(a)!;
      d.set(p, (d.get(p) ?? 0) + hitDamage(t, i));
    }
    return d;
  });

  const pr: PlayerRound[] = [];
  for (let ri = 0; ri < c.nRounds; ri++) {
    const list = kills[ri];
    const rf = rounds[ri];
    for (let p = 0; p < c.players.length; p++) {
      const side = c.side[ri][p];
      if (!side) continue;
      const m = emptyMeasures();
      m.rounds = 1;
      m.won = rf.winner === side ? 1 : 0;
      for (const k of list) {
        if (k.enemy && k.killer === p) {
          m.kills++;
          if (k.headshot) m.hsKills++;
          if (k.tradeKill) m.tradeKills++;
          if (k.opening) { m.openingKills++; m.openingWins += m.won; }
        }
        if (k.enemy && k.assister === p) { m.assists++; if (k.flashAssist) m.flashAssists++; }
        if (k.victim === p) {
          m.deaths++;
          if (k.traded) m.tradedDeaths++;
          if (k.opening) { m.openingDeaths++; if (k.traded) m.openingTraded++; }
        }
      }
      m.dmg = dmgBy[ri].get(p) ?? 0;
      m.kast = kastRound(list, p) ? 1 : 0;
      m.survived = list.some((k) => k.victim === p) ? 0 : 1;
      m.killRounds = m.kills > 0 ? 1 : 0;
      m.multiKillRounds = m.kills > 1 ? 1 : 0;
      const team = side === "CT" ? rf.ctTeam : ((1 - rf.ctTeam) as 0 | 1);
      pr.push({ ...m, ri, pi: p, side, team, ownBuy: rf.buy[side], oppBuy: rf.buy[side === "CT" ? "T" : "CT"] });
    }
  }

  const teams: [string, string] = [t.match.team_ct_start[0], t.match.team_t_start[0]];
  return {
    v: DERIVE_VERSION,
    match: {
      id: t.match.match_id[0], source: t.match.source[0], map: t.match.map[0], date, tickRate: c.tickRate,
      maxRounds, teams, score, nRounds: c.nRounds,
    },
    players: c.players, rounds, pr, kills: kills.flat(),
  };
}
