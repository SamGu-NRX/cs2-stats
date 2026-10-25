// The match tables: schema v1 as the engine reads it (design/architecture.md). The extractor writes
// them as parquet; load.ts reads them; the transitional plugin adapter (plugin/adapter.ts) builds
// them in memory. Nothing else is an input to the engine.
//
// SCHEMA is the one description of every column the engine reads. The loader requests exactly these
// columns and converts each by its kind; the row types below are derived from the same object.
// Column names are the parquet names. A kind ending in "?" may hold nulls.
//
// Kinds: i int, f float, s string, b boolean, id player id (a string: steamids exceed 2^53), ss a
// list of strings.

type Kind = "i" | "i?" | "f" | "f?" | "s" | "s?" | "b" | "b?" | "id" | "id?" | "ss";

export const SCHEMA = {
  /** one row; `convars` and `extra` are JSON (mp_maxrounds; the archive's metadata, which dates HLTV demos) */
  match: {
    match_id: "s", source: "s", map: "s", tick_rate: "f", team_ct_start: "s", team_t_start: "s",
    schema_version: "i", extractor_version: "s", convars: "s", extra: "s", visibility_status: "s",
  },
  players: { steamid: "id", name: "s", team: "s?", is_bot: "b" },
  rounds: {
    round: "i", start_tick: "i?", freeze_end_tick: "i?", end_tick: "i", official_end_tick: "i?",
    winner_side: "s?", reason: "s?", ct_team: "s?", t_team: "s?",
    plant_tick: "i?", plant_site: "s?", planter_steamid: "id?", defuse_tick: "i?", defuser_steamid: "id?", explode_tick: "i?",
  },
  /** one row per player per round, read at freeze end */
  player_rounds: {
    round: "i", steamid: "id", side: "s", money_start: "i?", money: "i?", cash_spent: "i?",
    equip_value_game: "i?", round_start_equip_value: "i?", armor: "i?", helmet: "b?", defuser: "b?",
    best_primary: "s?", best_secondary: "s?", inventory: "ss",
  },
  kills: {
    tick: "i", round: "i", attacker_steamid: "id?", victim_steamid: "id", assister_steamid: "id?",
    assistedflash: "b?", weapon: "s", headshot: "b", penetrated: "i?", thrusmoke: "b?", attackerblind: "b?",
    noscope: "b?", attackerinair: "b?", distance: "f?", hitgroup: "s?",
    a_side: "s?", a_x: "f?", a_y: "f?", a_z: "f?", a_pitch: "f?", a_yaw: "f?", a_health: "f?", a_place: "s?",
    a_active_weapon: "s?", a_best_primary: "s?", a_flash_duration: "f?", a_scoped: "b?", a_ducking: "b?",
    a_airborne: "b?", a_walking: "b?", a_armor: "f?", a_helmet: "b?", a_equip_value_game: "f?",
    v_side: "s?", v_x: "f?", v_y: "f?", v_z: "f?", v_pitch: "f?", v_yaw: "f?", v_health: "f?", v_place: "s?",
    v_active_weapon: "s?", v_best_primary: "s?", v_flash_duration: "f?", v_armor: "f?", v_helmet: "b?",
    v_equip_value_game: "f?",
    is_suicide: "b", is_teamkill: "b",
  },
  damages: {
    tick: "i", round: "i", attacker_steamid: "id?", victim_steamid: "id", weapon: "s?",
    dmg_health: "i?", dmg_health_capped: "i", dmg_armor: "i?", hitgroup: "s?", health_before: "i?", health_after: "i?",
    a_side: "s?", v_side: "s?", is_team_damage: "b", is_self: "b",
    a_x: "f?", a_y: "f?", a_z: "f?", v_x: "f?", v_y: "f?", v_z: "f?", distance: "f?", grenade_entity_id: "i?",
  },
  shots: {
    tick: "i", round: "i", steamid: "id", weapon: "s", side: "s?", x: "f?", y: "f?", z: "f?", pitch: "f?", yaw: "f?",
    ducking: "b?", ducked: "b?", duck_amount: "f?", scoped: "b?", walking: "b?", airborne: "b?", shots_fired: "i?",
    accuracy_penalty: "f?", inaccuracy: "f?", spread: "f?", recoil_index: "f?",
    eye_x: "f?", eye_y: "f?", eye_z: "f?", bullet_pitch: "f?", bullet_yaw: "f?",
    vel_x: "f?", vel_y: "f?", vel_z: "f?", speed_2d: "f?", place: "s?",
    ammo_clip: "i?", flash_duration: "f?", silenced: "b?",
    // the capture plugin's per-shot aim data (SOURCE_COLUMNS: extractor files have none, rows read null)
    aim_err_yaw: "f?", aim_err_pitch: "f?", target_steamid: "id?", target_on_screen: "b?",
  },
  /** one row per grenade_thrown, linked to its projectile's landing point */
  grenade_throws: {
    tick: "i", round: "i", steamid: "id?", weapon: "s", side: "s?", place: "s?", x: "f?", y: "f?", z: "f?",
    entity_id: "i?", land_tick: "i?", land_x: "f?", land_y: "f?", land_z: "f?",
  },
  grenade_events: { tick: "i", round: "i", event: "s", entity_id: "i?", steamid: "id?", x: "f?", y: "f?", z: "f?" },
  smokes: { entity_id: "i?", steamid: "id?", round: "i", start_tick: "i", end_tick: "i?", x: "f", y: "f", z: "f" },
  infernos: { entity_id: "i?", steamid: "id?", round: "i", start_tick: "i", end_tick: "i?", x: "f", y: "f", z: "f" },
  blinds: {
    tick: "i", round: "i", attacker_steamid: "id?", victim_steamid: "id", duration: "f", flash_entity_id: "i?",
    is_self: "b", is_team_flash: "b", ambiguous: "b",
  },
  bomb: { tick: "i", round: "i", event: "s", steamid: "id?", site: "s?", place: "s?" },
  /** every item bought; `item` is the display name, `was_sold` a refund in the buy zone */
  purchases: { tick: "i", round: "i", steamid: "id", item: "s", cost: "i", was_sold: "b" },
  /** 4 Hz samples */
  positions: {
    tick: "i", round: "i", steamid: "id", side: "s?", x: "f", y: "f", z: "f", pitch: "f?", yaw: "f?",
    vel_x: "f?", vel_y: "f?", vel_z: "f?", is_alive: "b", health: "i?", place: "s?", active_weapon: "s?",
    ducked: "b?", is_scoped: "b?", is_walking: "b?", is_airborne: "b?", flash_duration: "f?",
  },
  /** radar spotted-state changes: from this tick, `spotter` sees `target` on the radar or not. Lags real visibility. */
  spotted: { tick: "i", round: "i", spotted: "b", spotter_steamid: "id", target_steamid: "id" },
  /** one attacker facing one victim (extractor/SCHEMA-v1.md, "Engagements") */
  engagements: {
    engagement_id: "i", round: "i", attacker_steamid: "id", victim_steamid: "id", start_tick: "i", end_tick: "i",
    first_visible_tick: "i?", first_shot_tick: "i?", first_damage_tick: "i?", hits: "i", damage: "i", outcome: "s",
    truncated: "b", weapon: "s?",
  },
  /** every tick of every engagement window; a_* attacker, v_* victim */
  engagement_ticks: {
    engagement_id: "i", tick: "i",
    a_x: "f?", a_y: "f?", a_z: "f?", a_eye_z: "f?", a_pitch: "f?", a_yaw: "f?", a_vel_x: "f?", a_vel_y: "f?", a_duck: "f?",
    a_shot_fired: "b?", a_spotted_by_v: "b?",
    v_x: "f?", v_y: "f?", v_z: "f?", v_eye_z: "f?", v_pitch: "f?", v_yaw: "f?", v_vel_x: "f?", v_vel_y: "f?", v_duck: "f?",
    v_shot_fired: "b?", v_spotted_by_a: "b?",
    mesh_visible: "b?", smoke_blocked: "b?",
  },
} as const satisfies Record<string, Record<string, Kind>>;

export type TableName = keyof typeof SCHEMA;

/**
 * Columns only some sources write. The plugin adapter fills these shots columns: the view's aim error
 * to the target's eye in degrees, [yaw, pitch] (the turn the view still needed), the target (the alive
 * enemy nearest the view within 10 degrees) and whether it was on screen at the shot (line of sight or
 * the spotted mask). The extractor's v1 files have no such columns; the loader reads them as null rather
 * than failing on them. Every other column must be in the file.
 */
export const SOURCE_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  shots: ["aim_err_yaw", "aim_err_pitch", "target_steamid", "target_on_screen"],
};

type Value<K> =
  K extends "i" | "f" ? number : K extends "i?" | "f?" ? number | null :
  K extends "s" | "id" ? string : K extends "s?" | "id?" ? string | null :
  K extends "b" ? boolean : K extends "b?" ? boolean | null :
  K extends "ss" ? string[] : never;

/** A columnar table: one array per column, all of length n. */
export type Table<N extends TableName> = { n: number } & { [C in keyof (typeof SCHEMA)[N]]: Value<(typeof SCHEMA)[N][C]>[] };

/** One match. Tables the source cannot provide are null; the families that need them report "unavailable". */
export interface MatchTables {
  match: Table<"match">;
  players: Table<"players">;
  rounds: Table<"rounds">;
  player_rounds: Table<"player_rounds">;
  kills: Table<"kills">;
  damages: Table<"damages">;
  blinds: Table<"blinds">;
  bomb: Table<"bomb">;
  grenade_throws: Table<"grenade_throws"> | null;
  grenade_events: Table<"grenade_events"> | null;
  smokes: Table<"smokes"> | null;
  purchases: Table<"purchases"> | null;
  infernos: Table<"infernos"> | null;
  shots: Table<"shots"> | null;
  positions: Table<"positions"> | null;
  spotted: Table<"spotted"> | null;
  engagements: Table<"engagements"> | null;
  engagement_ticks: Table<"engagement_ticks"> | null;
}

export const REQUIRED_TABLES = ["match", "players", "rounds", "player_rounds", "kills", "damages", "blinds", "bomb"] as const;
export const OPTIONAL_TABLES = ["grenade_throws", "grenade_events", "smokes", "infernos", "shots", "positions", "spotted", "engagements", "engagement_ticks", "purchases"] as const;

export function kindOf(table: TableName, column: string): Kind {
  return (SCHEMA[table] as Record<string, Kind>)[column];
}

/** An empty table with every column, for the adapter and for tests that build matches. */
export function emptyTable<N extends TableName>(name: N): Table<N> {
  const t: Record<string, unknown> = { n: 0 };
  for (const c of Object.keys(SCHEMA[name])) t[c] = [];
  return t as Table<N>;
}

export type Side = "T" | "CT";
