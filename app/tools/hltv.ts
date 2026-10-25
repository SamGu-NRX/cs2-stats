// HLTV per-map JSON (private, scraped; never shipped): parsing and the join to derived facts. Used by
// the HLTV-exact test and the validation CLI only.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MatchFacts } from "../src/stats/facts";
import { DATA_DIR } from "./node-read";

export const HLTV_DIR = path.join(DATA_DIR, "hltv");

/** One scoreboard line (traditional columns, plus the eco-adjusted ones HLTV also shows). */
export interface HltvLine {
  k: number; hs: number; a: number; fa: number; d: number; td: number;
  kast: number; adr: number; opK: number; opD: number; mks: number; clutches: number;
  swing: number; rating: number;
  eK: number; eD: number; eKast: number; eAdr: number;
}

export interface HltvPlayer { nick: string; pid: string; team: string; total: HltvLine; ct: HltvLine | null; t: HltvLine | null }

export interface HltvMap {
  file: string;
  map: string;
  date: string;
  /** [team, rounds won] in HLTV's order */
  teams: [string, number][];
  players: HltvPlayer[];
  /** per round: team equipment in HLTV's team order, rounded as HLTV shows it, and HLTV's class */
  equip: { value: number; label: string }[][];
  /** per round, per player nick: HLTV's swing credit for the round */
  swingPerRound: Map<string, number[]>;
}

const num = (s: string) => Number(s.replace("%", "").replace("+", ""));
const pair = (s: string): [number, number] => {
  const m = /^(-?[\d.]+)\s*[:(]\s*(-?[\d.]+)\)?$/.exec(s.trim());
  if (!m) throw new Error(`HLTV cell "${s}" is not "a (b)" or "a : b"`);
  return [Number(m[1]), Number(m[2])];
};

function parseLine(head: string[], cells: string[]): HltvLine {
  // Columns appear twice for KAST/eKAST (desktop and phone layouts); the first copy is read.
  const at = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`HLTV scoreboard has no "${name}" column`);
    return cells[i];
  };
  const [k, hs] = pair(at("K (hs)"));
  const [a, fa] = pair(at("A (f)"));
  const [d, td] = pair(at("D (t)"));
  const [opK, opD] = pair(at("Op.K-D"));
  const [eK] = pair(at("eK (hs)"));
  const [eD] = pair(at("eD (t)"));
  return {
    k, hs, a, fa, d, td, kast: num(at("KAST")), adr: num(at("ADR")), opK, opD, mks: num(at("MKs")),
    clutches: num(at("1vsX")), swing: num(at("Swing")), rating: num(at("Rating3.0")),
    eK, eD, eKast: num(at("eKAST")), eAdr: num(at("eADR")),
  };
}

export function parseHltvMap(file: string): HltvMap | null {
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (d.v !== 3) return null;
  const info: string = d.info[0];
  const map = /Map(Ancient|Anubis|Cache|Dust2|Inferno|Mirage|Nuke|Overpass|Train|Vertigo)/.exec(info)?.[1];
  const date = /\d{4}-\d{2}-\d{2}/.exec(info)?.[0];
  if (!map || !date) throw new Error(`${file}: no map or date in the info line`);
  const players = new Map<string, HltvPlayer>();
  for (const sb of d.scoreboards as { cls: string; head: [string, string][]; rows: { player: string; pid: string; cells: [string, string][] }[] }[]) {
    const head = sb.head.map((h) => h[1]);
    const team = head[0];
    const kind = sb.cls.includes("totalstats") ? "total" : sb.cls.includes("ctstats") ? "ct" : sb.cls.includes("tstats") ? "t" : null;
    if (!kind) continue;
    for (const row of sb.rows) {
      const line = parseLine(head, row.cells.map((c) => c[1]));
      let p = players.get(row.pid);
      if (!p) players.set(row.pid, (p = { nick: row.player, pid: row.pid, team, total: line, ct: null, t: null }));
      p[kind] = line;
    }
  }
  // Overtime maps list each team twice (regulation, then overtime); wins add up per team.
  const wins = new Map<string, number>();
  for (const h of d.roundHistory as { team: string; outcomes: string[] }[]) {
    wins.set(h.team, (wins.get(h.team) ?? 0) + h.outcomes.filter((o) => !o.startsWith("emptyHistory")).length);
  }
  const teams = [...wins];
  const equip: HltvMap["equip"] = [];
  const swingPerRound = new Map<string, number[]>();
  const perf = d.performance?.players as { nick: string; perRound: [string, string][]; events: Record<string, [number, string][]> }[] | undefined;
  if (perf?.length) {
    for (const [rname, evs] of Object.entries(perf[0].events)) {
      const ri = Number(rname.replace("round", "")) - 1;
      const txt = evs.find(([, s]) => s.includes("equipment value"))?.[1];
      if (!txt) continue;
      equip[ri] = [...txt.matchAll(/\$([\d.]+)(K?) \(([^)]+)\)/g)].map((m) => ({ value: Number(m[1]) * (m[2] ? 1000 : 1), label: m[3] }));
    }
    for (const p of perf) swingPerRound.set(p.nick, p.perRound.map(([, v]) => Number(v)));
  }
  return { file: path.basename(file), map: `de_${map.toLowerCase()}`, date, teams, players: [...players.values()], equip, swingPerRound };
}

let cache: HltvMap[] | null = null;
export function hltvMaps(): HltvMap[] {
  if (cache) return cache;
  if (!existsSync(HLTV_DIR)) return (cache = []);
  cache = readdirSync(HLTV_DIR).filter((f) => /^map_\d+\.json$/.test(f)).map((f) => parseHltvMap(path.join(HLTV_DIR, f))).filter((m): m is HltvMap => m !== null);
  return cache;
}

export const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

export interface HltvJoin {
  hltv: HltvMap;
  /** facts player index -> HLTV player */
  player: Map<number, HltvPlayer>;
  /** facts team index (0 started CT) -> HLTV team index */
  team: [number, number];
  unmatched: string[];
}

/**
 * Finds the HLTV map for a demo map: same map, at least 7 of the 10 player names shared, the same
 * final score, then the nearest date. Players join by normalized name; a single leftover player on
 * each side of a team joins by elimination. Returns null when no map qualifies.
 */
export function joinHltv(f: MatchFacts, maps = hltvMaps()): HltvJoin | null {
  const names = f.players.map((p) => normName(p.name));
  const want = [...f.match.score].sort().join(":");
  const cands = maps
    .filter((h) => h.map === f.match.map && h.teams.map((x) => x[1]).sort().join(":") === want)
    .map((h) => ({ h, shared: h.players.filter((p) => names.includes(normName(p.nick))).length }))
    .filter((x) => x.shared >= 7);
  if (!cands.length) return null;
  const day = (s: string | null) => (s ? Date.parse(s) : 0);
  cands.sort((a, b) => b.shared - a.shared || Math.abs(day(a.h.date) - day(f.match.date)) - Math.abs(day(b.h.date) - day(f.match.date)));
  const h = cands[0].h;
  const player = new Map<number, HltvPlayer>();
  const left = new Set(h.players);
  f.players.forEach((p, i) => {
    const m = [...left].find((x) => normName(x.nick) === names[i]);
    if (m) { player.set(i, m); left.delete(m); }
  });
  // The HLTV team of each facts team: where most of its joined players are.
  const team: [number, number] = [0, 1].map((ti) => {
    const votes = h.teams.map(([name]) => [...player].filter(([pi, hp]) => f.players[pi].team === ti && hp.team === name).length);
    return votes[0] >= votes[1] ? 0 : 1;
  }) as [number, number];
  for (const ti of [0, 1] as const) {
    const ours = f.players.map((p, i) => ({ p, i })).filter(({ p, i }) => p.team === ti && !player.has(i) && f.pr.some((r) => r.pi === i));
    const theirs = [...left].filter((x) => x.team === h.teams[team[ti]][0]);
    if (ours.length === 1 && theirs.length === 1) { player.set(ours[0].i, theirs[0]); left.delete(theirs[0]); }
  }
  return { hltv: h, player, team, unmatched: [...left].map((x) => x.nick) };
}
