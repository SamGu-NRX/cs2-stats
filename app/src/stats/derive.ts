// derive(tables) -> facts: the one path from a match's tables to everything the engine knows about
// it. Deterministic and per event; rollup.ts sums the facts under filters. Each family module fills
// its own measures (facts.ts MEASURES) from the shared indexes built here.
import { deriveAggro } from "./aggression";
import { deriveAim } from "./aim";
import { closing } from "./closing";
import { duels } from "./duels";
import { classifyBuy, isPistolRound, type BuyClass } from "./economy";
import { DERIVE_VERSION, emptyMeasures, type KillFact, type MatchFacts, type Measures, type OnScreenSource, type PlayerInfo, type PlayerRound, type RoundFact } from "./facts";
import { guns } from "./guns";
import { deriveInfo } from "./information";
import { deriveMove } from "./movement";
import { ecoAdjust, valuedRounds } from "./rating3";
import { positioning } from "./positioning";
import { markOpening, markTrades } from "./rules";
import { scoreboard } from "./scoreboard";
import { sniping } from "./sniping";
import { swing } from "./swing";
import { modelFingerprint, type WinProbSource } from "./model-params";
import type { MatchTables, Side } from "./tables";
import { grenadeFacts, utility } from "./utility";
import { derivePresence } from "./positions";
import { deriveUtilQ } from "./utilq";

const asSide = (s: string | null | undefined): Side | null => (s === "CT" ? "CT" : s === "T" ? "T" : null);

const ON_SCREEN: readonly OnScreenSource[] = ["los", "spotted", "spotted-los-lost"];

/** match.extra "on_screen": absent for demos; any other value is a source this code does not know. */
function onScreenOf(v: unknown): OnScreenSource | null {
  if (v === undefined) return null;
  if (!ON_SCREEN.includes(v as OnScreenSource)) throw new Error(`derive: match.extra on_screen ${JSON.stringify(v)} is not one of ${ON_SCREEN.join(", ")}`);
  return v as OnScreenSource;
}

/**
 * The match date and round limit, from the match row's JSON columns. A demo carries no date: local
 * and downloaded demos get `date` from whoever extracted them; HLTV archives only record when the
 * demo file was written (`dem_modified_in_archive`), which is the day of the match or the day after.
 */
function matchMeta(t: MatchTables) {
  const extra = JSON.parse(t.match.extra[0]) as Record<string, unknown>;
  const convars = JSON.parse(t.match.convars[0]) as Record<string, unknown>;
  const raw = extra.date ?? extra.dem_modified_in_archive;
  return {
    date: typeof raw === "string" ? raw.slice(0, 10) : null, maxRounds: Number(convars.mp_maxrounds ?? 24),
    pov: typeof extra.pov === "string" ? extra.pov : null,
    roundsPlayed: typeof extra.rounds_played === "number" ? extra.rounds_played : null,
    startedAt: typeof extra.started_at === "string" ? extra.started_at : null,
    durationS: typeof extra.duration_s === "number" ? extra.duration_s : null,
    finalScore: Array.isArray(extra.final_score) ? (extra.final_score as [number, number]) : null,
    throws: extra.throws === "rebuilt" ? ("rebuilt" as const) : null,
    onScreen: onScreenOf(extra.on_screen),
    status: typeof extra.status === "string" ? extra.status : null,
  };
}

/**
 * Each player-round's freeze-end loadout (its inventory), or null when the row records none: a row with
 * an empty inventory and no best primary is unknown, not an empty loadout (the plugin records neither).
 */
export function loadouts(c: Ctx): Map<number, string[] | null> {
  const inv = c.t.player_rounds;
  const out = new Map<number, string[] | null>();
  for (let i = 0; i < inv.n; i++) {
    const ri = c.riOf(inv.round[i]);
    if (ri === undefined) continue;
    out.set(ri * 1024 + c.pi.get(inv.steamid[i])!, inv.inventory[i].length || inv.best_primary[i] !== null ? inv.inventory[i] : null);
  }
  return out;
}

/** A player-round while the families fill it: every measure present. */
export type WorkRound = Omit<PlayerRound, "m"> & { m: Measures };

/** Indexes shared by the families. */
export interface Ctx {
  t: MatchTables;
  /** the round win-probability source (model-params.ts) */
  wp: WinProbSource;
  tickRate: number;
  nRounds: number;
  map: string;
  pi: Map<string, number>;
  players: PlayerInfo[];
  /** side[ri][pi], null when the player did not play the round */
  side: (Side | null)[][];
  ctTeam: (0 | 1)[];
  rounds: RoundFact[];
  /** kills[ri], tick order, post-round suicides removed */
  kills: KillFact[][];
  /** pr[ri][pi], null when the player did not play the round; every measure present while deriving */
  pr: (WorkRound | null)[][];
  /** row indexes of a table by round (0-based) */
  byRound: (table: "damages" | "blinds" | "grenade_throws" | "shots" | "bomb" | "purchases") => number[][];
  /** a player's position sample nearest a tick (within half a second), [x, y, z]; null without positions */
  posAt: (ri: number, pi: number, tick: number) => [number, number, number] | null;
  /** a player index from a steamid column value */
  idOf: (id: string | null) => number | null;
  /** row index of a round number in the rounds table; undefined for rounds the tables do not cover */
  riOf: (round: number) => number | undefined;
}

export function buildCtx(t: MatchTables, wp: WinProbSource): Ctx {
  const tickRate = t.match.tick_rate[0];
  const nRounds = t.rounds.n;
  // Rounds are addressed by row. Demos cover every round, but a source may cover only some (the
  // plugin adapter leaves out rounds it has only totals for), so round numbers can skip.
  const rowOf = new Map<number, number>();
  for (let i = 0; i < nRounds; i++) rowOf.set(t.rounds.round[i], i);
  const riOf = (round: number) => rowOf.get(round);
  const teams = [t.match.team_ct_start[0], t.match.team_t_start[0]];
  const pi = new Map<string, number>();
  const players: PlayerInfo[] = [];
  const add = (id: string, name: string, team: string | null, bot: boolean) => {
    if (pi.has(id)) return;
    pi.set(id, players.length);
    const ti = team === null ? -1 : teams.indexOf(team);
    players.push({ id, name, team: ti === 0 ? 0 : ti === 1 ? 1 : null, bot });
  };
  for (let i = 0; i < t.players.n; i++) add(t.players.steamid[i], t.players.name[i], t.players.team[i], t.players.is_bot[i]);
  for (let i = 0; i < t.player_rounds.n; i++) add(t.player_rounds.steamid[i], t.player_rounds.steamid[i], null, false);

  const side: (Side | null)[][] = Array.from({ length: nRounds }, () => new Array<Side | null>(players.length).fill(null));
  for (let i = 0; i < t.player_rounds.n; i++) {
    const ri = riOf(t.player_rounds.round[i]);
    if (ri !== undefined) side[ri][pi.get(t.player_rounds.steamid[i])!] = asSide(t.player_rounds.side[i]);
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
    if (tab) for (let i = 0; i < tab.n; i++) { const ri = riOf(tab.round[i]); if (ri !== undefined) out[ri].push(i); }
    cache.set(name, out);
    return out;
  };

  // positions by (round, player), tick order
  const pos = new Map<number, number[]>();
  const P = t.positions;
  if (P) for (let i = 0; i < P.n; i++) {
    const p = pi.get(P.steamid[i]);
    if (p === undefined) continue;
    const ri = riOf(P.round[i]);
    if (ri === undefined) continue;
    const key = ri * 1024 + p;
    let l = pos.get(key);
    if (!l) pos.set(key, (l = []));
    l.push(i);
  }
  const posAt: Ctx["posAt"] = (ri, p, tick) => {
    const l = P ? pos.get(ri * 1024 + p) : undefined;
    if (!l || !P) return null;
    let lo = 0, hi = l.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (P.tick[l[mid]] < tick) lo = mid + 1; else hi = mid; }
    let best = lo;
    if (lo > 0 && Math.abs(P.tick[l[lo - 1]] - tick) < Math.abs(P.tick[l[lo]] - tick)) best = lo - 1;
    const i = l[best];
    if (Math.abs(P.tick[i] - tick) > tickRate / 2 || !P.is_alive[i]) return null;
    return [P.x[i], P.y[i], P.z[i]];
  };
  const idOf = (id: string | null) => (id === null ? null : pi.get(id) ?? null);

  return {
    t, wp, tickRate, nRounds, map: t.match.map[0], pi, players, side, ctTeam, rounds: [], kills: [], pr: [], byRound, posAt, idOf, riOf,
  };
}

/**
 * Damage one hit counts for ADR: the hurt event's damage, capped at the victim's health before it.
 * This is HLTV's figure. The in-game scoreboard counts health lost instead (dmg_health_capped), which
 * is one HP more on hits where the event dropped fractional damage (VALIDATION.md, pnpm
 * scoreboard-variants).
 */
export function hitDamage(t: MatchTables, i: number): number {
  // A hit the extractor rebuilt from a health drop (damages.source = health) has no event damage; the
  // HP it removed is the only figure there is.
  const reported = t.damages.dmg_health[i];
  return reported === null ? t.damages.dmg_health_capped[i] : Math.min(reported, t.damages.health_before[i] ?? 100);
}

/** True for a damage row that counts as enemy damage (not self, team or world damage). */
export const enemyHit = (t: MatchTables, i: number) => t.damages.attacker_steamid[i] !== null && !t.damages.is_self[i] && !t.damages.is_team_damage[i];

function killFacts(c: Ctx): KillFact[][] {
  const k = c.t.kills;
  const rows: number[][] = Array.from({ length: c.nRounds }, () => []);
  for (let i = 0; i < k.n; i++) { const ri = c.riOf(k.round[i]); if (ri !== undefined) rows[ri].push(i); }
  return rows.map((list, ri) => {
    // A suicide after the round has ended is not a death; a bomb death after the end tick is
    // (HLTV's counts, VALIDATION.md).
    const kept = list.filter((i) => !(k.is_suicide[i] && k.tick[i] > c.t.rounds.end_tick[ri]));
    const out = kept.map((i): KillFact => {
      const killer = c.idOf(k.attacker_steamid[i]);
      const victim = c.pi.get(k.victim_steamid[i])!;
      const killerSide = killer === null ? null : asSide(k.a_side[i]) ?? c.side[ri][killer];
      const victimSide = asSide(k.v_side[i]) ?? c.side[ri][victim];
      const fe = c.t.rounds.freeze_end_tick[ri];
      const xy = (x: number | null, y: number | null): [number, number] | null => (x === null || y === null ? null : [x, y]);
      return {
        ri, tick: k.tick[i], t: fe === null ? null : (k.tick[i] - fe) / c.tickRate,
        killer, victim, assister: c.idOf(k.assister_steamid[i]), flashAssist: k.assistedflash[i] === true,
        killerSide, victimSide, weapon: k.weapon[i], victimWeapon: k.v_active_weapon[i],
        headshot: k.headshot[i], wallbang: (k.penetrated[i] ?? 0) > 0, smoke: k.thrusmoke[i] === true, noscope: k.noscope[i] === true,
        killerBlind: k.attackerblind[i], killerInAir: k.attackerinair[i],
        kpos: xy(k.a_x[i], k.a_y[i]), vpos: xy(k.v_x[i], k.v_y[i]),
        enemy: killer !== null && killer !== victim && killerSide !== null && victimSide !== null && killerSide !== victimSide,
        opening: false, tradeKill: false, traded: false, ecoPoints: null, credits: [],
      };
    });
    out.sort((a, b) => a.tick - b.tick);
    markOpening(out);
    markTrades(out, c.tickRate);
    return out;
  });
}

function roundFacts(c: Ctx, maxRounds: number): RoundFact[] {
  const r = c.t.rounds;
  const pr = c.t.player_rounds;
  const equip = Array.from({ length: c.nRounds }, () => ({ CT: 0 as number | null, T: 0 as number | null, nCT: 0, nT: 0 }));
  for (let i = 0; i < pr.n; i++) {
    const ri = c.riOf(pr.round[i]);
    const s = asSide(pr.side[i]);
    if (ri === undefined || !s) continue;
    const e = pr.equip_value_game[i];
    const x = equip[ri];
    x[s] = e === null || x[s] === null ? null : x[s]! + e;
    if (s === "CT") x.nCT++; else x.nT++;
  }
  return Array.from({ length: c.nRounds }, (_, ri): RoundFact => {
    const x = equip[ri];
    const pistol = isPistolRound(r.round[ri] - 1, maxRounds);
    const team = { CT: x.nCT ? x.CT : null, T: x.nT ? x.T : null };
    const buy = (s: Side): BuyClass | null => (pistol ? "pistol" : team[s] === null ? null : classifyBuy(team[s]!, s === "CT" ? x.nCT : x.nT, false));
    const fe = r.freeze_end_tick[ri];
    return {
      ri, number: r.round[ri], ctTeam: c.ctTeam[ri], winner: asSide(r.winner_side[ri]), reason: r.reason[ri],
      durationS: fe === null ? null : (r.end_tick[ri] - fe) / c.tickRate, freezeEndTick: fe, endTick: r.end_tick[ri],
      plantTick: r.plant_tick[ri], plantSite: r.plant_site[ri], planter: c.idOf(r.planter_steamid[ri]), defuser: c.idOf(r.defuser_steamid[ri]), defused: r.defuse_tick[ri] !== null, exploded: r.explode_tick[ri] !== null,
      equip: team, buy: { CT: buy("CT"), T: buy("T") }, winProb: null,
    };
  });
}

/** Spawn point key from the round's first position sample. */
function spawnOf(c: Ctx, ri: number, p: number): string | null {
  const at = c.posAt(ri, p, c.t.rounds.start_tick[ri] ?? c.rounds[ri].freezeEndTick ?? c.rounds[ri].endTick);
  return at ? `${Math.round(at[0] / 16) * 16},${Math.round(at[1] / 16) * 16}` : null;
}

function playerRounds(c: Ctx): (WorkRound | null)[][] {
  const t = c.t.player_rounds;
  const row = new Map<number, number>();
  for (let i = 0; i < t.n; i++) { const ri = c.riOf(t.round[i]); if (ri !== undefined) row.set(ri * 1024 + c.pi.get(t.steamid[i])!, i); }
  return c.rounds.map((rf) => c.players.map((_, p) => {
    const side = c.side[rf.ri][p];
    if (!side) return null;
    const i = row.get(rf.ri * 1024 + p);
    const m = emptyMeasures();
    m.rounds = 1;
    const won = rf.winner === null ? null : rf.winner === side;
    if (won) m.won = 1;
    if (won === false) m.lostRounds = 1;
    return {
      ri: rf.ri, pi: p, side, team: side === "CT" ? rf.ctTeam : ((1 - rf.ctTeam) as 0 | 1), won,
      ownBuy: rf.buy[side], oppBuy: rf.buy[side === "CT" ? "T" : "CT"],
      equip: i === undefined ? null : t.equip_value_game[i], moneyStart: i === undefined ? null : t.money_start[i],
      money: i === undefined ? null : t.money[i], spent: i === undefined ? null : t.cash_spent[i], primary: i === undefined ? null : t.best_primary[i], spawn: spawnOf(c, rf.ri, p), m,
    };
  }));
}

/** Seconds from the first round's start (or freeze end) to the last round's end. */
function ticksSpan(c: Ctx): number | null {
  const r = c.t.rounds;
  const first = r.start_tick[0] ?? r.freeze_end_tick[0];
  return c.nRounds && first !== null ? (r.end_tick[c.nRounds - 1] - first) / c.tickRate : null;
}

const sparse = (m: Measures): Partial<Measures> => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0));

/**
 * One match's facts. `wp` is the round win-probability source (model-params.ts winProbSource: HLTV's
 * lookup when its pack is installed, else CS2RB); swing and the win-probability path depend on it, so
 * cache facts by it too.
 */
export function derive(t: MatchTables, wp: WinProbSource): MatchFacts {
  const c = buildCtx(t, wp);
  const { date, maxRounds, pov, roundsPlayed, startedAt, durationS, finalScore, status, throws, onScreen } = matchMeta(t);
  c.rounds = roundFacts(c, maxRounds);
  c.kills = killFacts(c);
  c.pr = playerRounds(c);

  scoreboard(c);
  const clutches = closing(c);
  sniping(c);
  duels(c);
  positioning(c);
  utility(c);
  ecoAdjust(c);
  swing(c);
  valuedRounds(c);
  const weapons = guns(c);

  const counted: [number, number] = [0, 0];
  for (const rf of c.rounds) if (rf.winner) counted[rf.winner === "CT" ? rf.ctTeam : 1 - rf.ctTeam]++;
  const score = finalScore ?? counted;
  const complete = status !== null ? status === "complete" : Math.max(...score) > maxRounds / 2 || (score[0] === score[1] && 2 * score[0] >= maxRounds);
  return {
    v: DERIVE_VERSION,
    match: {
      id: t.match.match_id[0], source: t.match.source[0], map: c.map, date, tickRate: c.tickRate, maxRounds,
      teams: [t.match.team_ct_start[0], t.match.team_t_start[0]], score, complete, nRounds: c.nRounds, visibility: t.match.visibility_status[0], pov,
      roundsPlayed: roundsPlayed ?? c.nRounds, startedAt, durationS: durationS ?? ticksSpan(c), winProb: wp.kind, model: modelFingerprint(wp),
      inputs: { throws: throws ?? (t.grenade_throws && t.grenade_throws.n ? "logged" : null), onScreen },
    },
    players: c.players, rounds: c.rounds,
    pr: c.pr.flat().filter((x): x is WorkRound => x !== null).map((r) => ({ ...r, m: sparse(r.m) })),
    kills: c.kills.flat(), weapons, grenades: grenadeFacts(c), clutches, presence: derivePresence(c),
    aim: deriveAim(c), movement: deriveMove(c), aggression: deriveAggro(c), information: deriveInfo(c), utilq: deriveUtilQ(c),
  };
}
