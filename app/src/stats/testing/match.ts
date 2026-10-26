// Hand-built one-round matches for the movement, aggression and information tests. Round 1 runs
// from tick 0, freezes until FREEZE_END and ends at ROUND_END, at 64 ticks per second. Team A is
// CT and team B is T. Columns a test does not give are null.
import { derive } from "../derive";
import { CS2RB } from "../model-params";
import type { MatchFacts } from "../facts";
import { emptyTable, SCHEMA, type MatchTables, type Table, type TableName } from "../tables";
import { pushRow } from "./tables";

export const TICK_RATE = 64;
export const FREEZE_END = 640;
export const ROUND_END = 64 * 120;

type Row = Record<string, unknown>;

function table<N extends TableName>(name: N, rows: Row[]): Table<N> {
  const t = emptyTable(name);
  for (const r of rows) pushRow(t, { ...Object.fromEntries(Object.keys(SCHEMA[name]).map((c) => [c, null])), ...r } as Parameters<typeof pushRow<N>>[1]);
  return t;
}

export interface OneRound {
  /** steamid -> side; CT players are on team A, T players on team B */
  players: Record<string, "CT" | "T">;
  bots?: string[];
  /** extra kills columns (such as v_x, v_y) go in `at` */
  kills?: { tick: number; killer: string; victim: string; assister?: string; at?: Row }[];
  engagements?: Row[];
  engagement_ticks?: Row[];
  shots?: Row[];
  positions?: Row[];
  spotted?: Row[];
  player_rounds?: Record<string, Row>;
  damages?: Row[];
  blinds?: Row[];
  purchases?: Row[];
  grenade_throws?: Row[];
  /** detonations and other grenade events: tick, event, entity_id, steamid, x, y */
  grenade_events?: Row[];
  /** the match row's convars, such as { mp_roundtime_defuse: "1.92" } */
  convars?: Row;
  /** disconnects: tick, steamid and whether the player was alive */
  leaves?: Row[];
  /** columns of the rounds row to override, such as plant_tick */
  roundRow?: Row;
  /** the round's number (default 1, a pistol round) */
  round?: number;
}

export const oneRound = (m: OneRound): MatchFacts => derive(oneRoundTables(m), CS2RB);

export function oneRoundTables(m: OneRound): MatchTables {
  const ids = Object.keys(m.players);
  const round = m.round ?? 1;
  const side = (id: string) => m.players[id];
  const t: MatchTables = {
    match: table("match", [{ match_id: "test", source: "local", map: "de_test", tick_rate: TICK_RATE, team_ct_start: "A", team_t_start: "B", convars: JSON.stringify(m.convars ?? {}), extra: "{}", visibility_status: "ok" }]),
    players: table("players", ids.map((id) => ({ steamid: id, name: id, team: side(id) === "CT" ? "A" : "B", is_bot: m.bots?.includes(id) ?? false }))),
    rounds: table("rounds", [{ round, start_tick: 0, freeze_end_tick: FREEZE_END, end_tick: ROUND_END, ct_team: "A", t_team: "B", winner_side: "CT", ...m.roundRow }]),
    player_rounds: table("player_rounds", ids.map((id) => ({ round, steamid: id, side: side(id), inventory: [], ...m.player_rounds?.[id] }))),
    kills: table("kills", (m.kills ?? []).map((k) => ({
      tick: k.tick, round, attacker_steamid: k.killer, victim_steamid: k.victim, assister_steamid: k.assister ?? null, weapon: "ak47", headshot: false,
      a_side: side(k.killer), v_side: side(k.victim), is_suicide: false, is_teamkill: false, ...k.at,
    }))),
    damages: table("damages", (m.damages ?? []).map((d) => ({ round, is_self: false, is_team_damage: false, ...d }))), blinds: table("blinds", (m.blinds ?? []).map((b) => ({ round, is_self: false, is_team_flash: false, ambiguous: false, ...b }))), bomb: emptyTable("bomb"),
    grenade_throws: m.grenade_throws ? table("grenade_throws", m.grenade_throws.map((g) => ({ round, ...g }))) : null, grenade_events: m.grenade_events ? table("grenade_events", m.grenade_events.map((g) => ({ round, ...g }))) : null, smokes: null, infernos: null,
    shots: m.shots ? table("shots", m.shots.map((s) => ({ round, weapon: "ak47", ...s }))) : null,
    positions: m.positions ? table("positions", m.positions.map((p) => ({ round, is_alive: true, z: 0, ...p }))) : null,
    spotted: m.spotted ? table("spotted", m.spotted.map((s) => ({ round, ...s }))) : null,
    engagements: m.engagements ? table("engagements", m.engagements.map((e) => ({ round, hits: 0, damage: 0, outcome: "sight-only", truncated: false, ...e }))) : null,
    engagement_ticks: m.engagement_ticks ? table("engagement_ticks", m.engagement_ticks) : null,
    purchases: m.purchases ? table("purchases", m.purchases.map((p) => ({ round, was_sold: false, ...p }))) : null,
    leaves: m.leaves ? table("leaves", m.leaves.map((x) => ({ round, ...x }))) : null,
  };
  return t;
}
