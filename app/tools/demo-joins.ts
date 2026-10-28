// The joins model/rating3/join_demos.py accepted (<data>/model-rating3/demo_joins.json), applied to a demo's
// players. That join pairs each SteamID with an HLTV player id from the kills, so a player whose in-game name
// differs from HLTV's still pairs, and a demo that names its HLTV match joins that match's page.
import type { PlayerInfo } from "../src/stats/facts";
import type { HltvJoin, HltvMap, HltvPlayer } from "./hltv";

/** One accepted record of demo_joins.json. */
export interface DemoJoin {
  /** demos\<archive>\<map>, as join_demos.py writes it */
  demo: string;
  /** the HLTV page's file name in <data>/hltv: map_<id>.json or ocs_map_<id>.json */
  hltv: string;
  /** SteamID -> the HLTV player the join paired it with */
  players: Record<string, { hltv: string; pid: string }>;
}

/** "<archive>/<map>", as mapLabel names a tables folder, of a join record's demo folder. */
export function joinLabel(demo: string): string {
  const parts = demo.split(/[\\/]+/);
  if (parts.length !== 3 || parts[0] !== "demos") throw new Error(`join record demo "${demo}" is not demos\\<archive>\\<map>`);
  return `${parts[1]}/${parts[2]}`;
}

/**
 * The accepted joins of a demo_joins.json, by joinLabel. A record with no pairing was written before
 * join_demos.py recorded one, and throws: run the join again.
 */
export function acceptedJoins(file: { accepted: (Omit<DemoJoin, "players"> & Partial<Pick<DemoJoin, "players">>)[] }): Map<string, DemoJoin> {
  const out = new Map<string, DemoJoin>();
  for (const { players, ...rec } of file.accepted) {
    if (!players) throw new Error(`${rec.demo}: this join records no player pairing; run join_demos.py again`);
    out.set(joinLabel(rec.demo), { ...rec, players });
  }
  return out;
}

/** The HLTV team (index into page.teams) of each demo team (0 started CT): where most of its paired players are. */
export function hltvTeams(players: readonly PlayerInfo[], player: Map<number, HltvPlayer>, page: HltvMap): [number, number] {
  return [0, 1].map((ti) => {
    const votes = page.teams.map(([name]) => [...player].filter(([pi, hp]) => players[pi].team === ti && hp.team === name).length);
    return votes[0] >= votes[1] ? 0 : 1;
  }) as [number, number];
}

/**
 * The HltvJoin a join record gives: each demo player paired by SteamID with the HLTV player of the id the
 * join recorded. A demo player the record doesn't pair (a coach or caster with rows) stays unpaired. A
 * recorded id missing from the page throws: the record and the page disagree.
 */
export function joinFromRecord(players: readonly PlayerInfo[], rec: DemoJoin, page: HltvMap): HltvJoin {
  const byPid = new Map(page.players.map((p) => [p.pid, p]));
  const player = new Map<number, HltvPlayer>();
  players.forEach((p, i) => {
    const paired = rec.players[p.id];
    if (!paired) return;
    const hp = byPid.get(paired.pid);
    if (!hp) throw new Error(`${rec.demo}: the join pairs ${p.name} with HLTV player id ${paired.pid}, who is not on ${rec.hltv}`);
    player.set(i, hp);
  });
  const taken = new Set(player.values());
  return { hltv: page, player, team: hltvTeams(players, player, page), unmatched: page.players.filter((p) => !taken.has(p)).map((p) => p.nick) };
}
