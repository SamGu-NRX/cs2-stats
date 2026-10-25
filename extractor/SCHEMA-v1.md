# Match tables, schema v1

The contract between the extractor (`extractor/extract.py`, Python) and the TS loader and engine. One CS2 demo becomes one folder of zstd parquet files, one file per table below. The extractor computes no metric the UI shows: every number here is read from the demo, or is a documented geometric test (visibility) or bookkeeping (round assignment, HP capping).

`extractor/schema_v1.py` declares every column's type, and the writer casts to it and fails on any mismatch, so a type never changes from one map to the next. `tests/test_schema_doc.py` fails if this document and that declaration disagree.

## Finding a map's tables
Each map has a folder `cs2-stats-data/demos/<archive slug>/<map>/`. From extractor 1.5.0 its tables are in a version folder inside it, `v-<extractor version>-<8 hex>/`, and the file `CURRENT` holds that folder's name on one line. To read a map:
1. If `<map>/RETIRED` exists, skip the folder: it was replaced by a re-extraction elsewhere and is being deleted.
2. If `<map>/CURRENT` exists, read its one line. It must match `v-[0-9A-Za-z.+_]+-[0-9a-f]{8}`; refuse anything else. Read the tables from `<map>/<that name>/`.
3. Otherwise a `<map>/match.parquet` is a map written before 1.5.0, with its tables in `<map>/` itself.
4. Otherwise the folder holds no complete map (a pre-v1 map has `meta.parquet` instead; see Versions).

The extractor publishes a new version by writing its folder first and then replacing `CURRENT` with an atomic file rename, so a reader that resolves the pointer always gets a complete set of tables. It never renames a map folder, and it deletes an old version only once no reader holds its files open. A file that disappears between resolving and opening means the map was just republished: resolve again. A glob of `demos/*/*/match.parquet` finds only maps written before 1.5.0. `extract.resolve_map_dir()` implements these steps in Python.

## Conventions
- **Versions.** `match.schema_version` is 1 and `match.extractor_version` is the extractor's semver. A folder without `match.parquet` was written before v1 and lacks the engagement tables; those maps are listed in `cs2-stats-data/demos/needs_reextract.jsonl`.
- **Player ids.** Every `steamid` and `*_steamid` column is a UInt64 player id. For a human it is the SteamID64. A bot has no SteamID, so its id is `2^32 * (user_id + 1) + crc32(name)`: the server user id (slot) and the bot's name, always below 2^40, so it can never collide with a SteamID64. `players.is_bot` marks bots. Radar spotters are named by SteamID in the demo, so `spotted` and the spotted flags cannot identify a bot spotter; those rows are dropped.
- **Time.** `tick` and every `*_tick` column are demo ticks (Int32). Convert to seconds with `match.tick_rate`; never assume 64, because tick rates differ by source. Columns ending in `_s` are already seconds.
- **Space.** Positions are Hammer units in the map's world frame, `z` at the feet. Eye height is `z + 64 - 18 * duck_amount` (on the Ancient fixture, `fire_bullets` eye origins sit at median 63.2 / p95 64.0 standing and 45.2 / 46.0 ducked). Angles are degrees; pitch is positive looking down.
- **Money** is in dollars. **HP and armor** are points.
- **Rounds.** `round` is 1-based. Rows outside a counted round are dropped: warmup, backup-restored attempts (from the attempt's start to the restore tick, inclusive), and anything after game over. An attempt ended with no winner counts as voided only if the game rolled its stats back (kills plus deaths unchanged across it); otherwise it is kept as a round with `aborted = true` and no winner. `events_misc` keeps warmup rows as round 0.
- **Nulls.** A missing value is null, never 0 or an empty string. "null: yes" below means the column can be null; a "no" column never is.
- **Pre-event state.** Player state attached to an event (kills `a_*`/`v_*`, shots, damages) is read at the event tick, before the event applies; a victim's health in `kills` is his health before the fatal hit.

## Engagements
An engagement is one attacker facing one victim on the opposite team. It is triggered by any of:
1. a mesh-visibility onset between the two while both are alive: the eye-to-eye segment becomes clear of the map's collision mesh;
2. a shot by the attacker while the victim is mesh-visible and within the attacker's 60° view cone (30° either side of the view ray);
3. any damage or kill by the attacker on the victim (team and self damage excluded).

Triggers of one ordered pair less than 1.5 s apart extend the same engagement. The window runs from 1.0 s before the first trigger to 1.0 s after the last, inside the round (freeze end, or round start for a round recorded already live, to round end). It is capped at 8 s from its start: a capped window has `truncated = true`, and the next trigger opens a new engagement that starts after it. Windows of one pair never overlap. `engagement_ticks` has every tick of every window. Every shot, misses included, stays in `shots`; `engagement_ticks.a_shot_fired` points to it by tick.

Hit-only windows would drop encounters where nobody lands a shot, which biases reaction, pre-aim and spray metrics. When `match.visibility_status` is not `ok`, triggers 1 and 2 cannot fire, so only damage and kills create engagements; the engine must treat such a map as visibility-unavailable, not as a map without sightings.

## Visibility
- **`mesh_visible`** (per engagement tick, directed): an awpy `VisibilityChecker` raycast against the map's collision mesh from the attacker's eye to the victim's eye, or to the victim's chest (eye − 16 units, an approximation) when the eye ray is blocked. Doors, props and breakables in their live state are not in the mesh.
- **Onsets** (trigger 1) use the eye-to-eye ray only. They are sampled every 4 ticks and recomputed at every tick between two samples that differ, so each onset lands on its exact tick; a sight shorter than 4 ticks can be missed.
- **Mesh source.** awpy-data release 2000935 (`cs2-stats-data/mapdata/2000935`), built from CS2 1.41.9.2, Steam build 26144732: the same build as the local install (`steam.inf` ClientVersion 2000935, SourceRevision 11162119). `match` records the release, patch, build id and the SHA-256 of the mesh file used. A map without a mesh gives `visibility_status = no_mesh`.
- **Mismatch guard.** At kills that were not wallbangs, the attacker should have mesh line of sight to the victim. If that holds for fewer than 90% of them (`match.mesh_kill_agreement`), the mesh does not fit the demo's map version: `visibility_status = mesh_mismatch` and `mesh_visible` is null for the whole map. Measured: 0.941 (Ancient) and 0.915 (Cache) with the matching mesh. No mismatched mesh has been tried, so 0.9 guards against gross mismatch and is not a calibrated cut.
- **`smoke_blocked`** is an approximation. Each smoke is a sphere of radius 144 centred 60 units above its detonation point (awpy 3.1.1 `map_control` defaults), live from detonation to expiry; the eye-to-eye segment is blocked while it crosses a live sphere. On the Ancient fixture it flags 8 of the 13 kills the game marked `thrusmoke` and 10 of the 125 it did not.
- **`spotted`** (radar) lags real visibility. Use it for information metrics only, never for aim: at the first hit of an engagement it was set only half the time on the Ancient fixture, against 91% for `mesh_visible`.

## Validation
The extractor fails a map unless the tables reproduce the demo's own final scoreboard:
- **kills** are enemy kills; a player with team kills or suicides may also match kills minus those, because CS2 deducts them;
- **deaths** count every cause;
- **assists** include flash assists, except an assist on the assister's own teammate, which the event names but the scoreboard does not count;
- **damage, the rating input:** `player_rounds.game_damage` summed over rounds equals the scoreboard's `damage_total` exactly. The game commits `damage_total` once per round, between round end and the next round start, so a round's damage is the counter's rise across its boundary;
- **damage, the hit table:** per player and round, the enemy hits in `damages` (`dmg_health_capped`, the HP actually removed: `player_hurt` reports a truncated amount, 25 reported for 26 removed) never exceed `game_damage`. More than the game counted fails the map, because lost events cannot cause it. Less is allowed: a demo can lose a stretch of events, and a health drop with no `player_hurt` on that tick is rebuilt as a `damages` row with `source = health` (see `damages`) whose attacker may be unknown. The total shortfall is `match.unattributed_damage_hp` and the warning `damage_events_incomplete: N HP`. The map's damage passes on `game_damage` alone, so use `game_damage` for a player's damage and treat the shortfall as damage no event credits;
- **rounds:** every round has ordered start, freeze-end and end ticks (except a round recorded already live), and the wins per team add up to the final score.
- **Split recordings.** One map can arrive as two demos (`-p1`, `-p2`). Every count is checked as the final counter minus the same counter at round 1's freeze end (`scoreboard.*_at_start`): zero for a whole match, the earlier parts' totals for a later part. The match starts at the last `begin_new_match` before the first real round end, because a first part can end with one after its last round. A demo without a win panel reads its final scoreboard at the next round start after its last round, the tick on which the game commits that round's damage. Merge parts by `match.archive` and `match.map_key` without the `-pN` suffix.

Cross-checks against awpy (round, kill and blind counts; awpy's K/D) are recorded in the manifest and never fail a map.

## Truncated demos
awpy refuses a demo cut off mid-file ("unexpected end of data"). demoparser2 reads it up to the cut, so the extractor keeps every round up to the last complete one: a round whose stats the game committed, which happens on the next round start. A last round with no later start is dropped. `match.truncated` is true, the tick rate is measured from game time, velocity is position-differenced (`match.velocity_source`), and grenade paths come from demoparser2. Validation runs against the scoreboard at that round. If demoparser2 cannot read a complete round either, the map fails with `fail_reason` `truncated_demo` and is not retried. Verified on a copy of the Ancient fixture cut at 185 MB: 12 rounds, every check exact.

## Not in the demo
- **Penetration** for non-fatal hits: `player_hurt` has none (`kills.penetrated` covers kill shots).
- **Aim punch:** `m_aimPunchAngle` is not networked to GOTV.
- **Inferno extent:** only the origin and lifetime are stored.
- **player_blind:** GOTV omits it; `blinds` is rebuilt from flash-duration changes, and every change lands on a flashbang detonation tick.
- **Weapon max speed:** no verified per-weapon table is bundled; join a cited table in the engine.

## Tables
### `match`
One row. Identity, provenance and visibility status of this extraction. Key: match_id.

| field | type | null | meaning, units |
|---|---|---|---|
| `archive` | String | no | archive id the demo came from |
| `awpy_convars` | String | no | JSON of convars as awpy read them |
| `awpy_version` | String | no | parser version |
| `build_num` | Int32 | yes | demo header build number; null for a truncated demo, which has no playback header |
| `convars` | String | no | JSON of server convars from the demo |
| `dem_bytes` | Int64 | no | demo size, bytes |
| `dem_file` | String | no | demo file name |
| `demo_sha256` | String | no | SHA-256 of the .dem file |
| `demo_version_guid` | String | no | demo header GUID |
| `demoparser2_version` | String | no | parser version |
| `extra` | String | no | JSON from the caller (archive metadata) |
| `extractor_version` | String | no | version of this extractor (semver) |
| `final_tick` | Int32 | no | tick the final scoreboard was read (win panel, or last round end + 1) |
| `map` | String | no | map name from the demo header, e.g. de_dust2 |
| `map_key` | String | no | map key from the file name, e.g. m1-nuke |
| `match_id` | String | no | first 16 hex digits of demo_sha256 |
| `match_start_tick` | Int32 | no | begin_new_match tick (0 when absent) |
| `mesh_buildid` | String | no | Steam build id the mesh was built from |
| `mesh_kill_agreement` | Float32 | no | share of non-wallbang kills where the mesh gives the attacker line of sight; below 0.9 sets mesh_mismatch |
| `mesh_patch_version` | String | no | CS2 patch the mesh was built from, e.g. 1.41.9.2 |
| `mesh_release` | String | no | awpy-data release (CS2 ClientVersion) the mesh came from |
| `mesh_sha256` | String | no | SHA-256 of the .mesh file used |
| `n_rounds` | Int16 | no | rounds played |
| `unattributed_damage_hp` | Int32 | no | HP of enemy damage the game counted (player_rounds.game_damage) that no damages row credits to its attacker; 0 when every hit is in the event stream |
| `pandas_version` | String | no | library version |
| `parsed_at_utc` | String | no | ISO-8601 extraction time |
| `patch_version` | String | no | demo header network protocol |
| `playback_ticks` | Int32 | yes | demo length, ticks; null for a truncated demo, which has no playback header |
| `polars_version` | String | no | library version |
| `position_stride_ticks` | Int16 | no | positions sampling stride, ticks |
| `price_file` | String | no | item price table used |
| `price_source` | String | no | where the prices were decoded from |
| `python_version` | String | no | interpreter version |
| `schema_version` | Int16 | no | 1 |
| `score_ct_start` | Int16 | no | final score of team_ct_start |
| `score_t_start` | Int16 | no | final score of team_t_start |
| `server_name` | String | no | server name |
| `smoke_model` | String | no | how smoke_blocked is computed (an approximation) |
| `source` | String | no | local | valve | faceit | hltv |
| `team1_file` | String | yes | first team slug in the file name; null when the file name does not start `<team1>-vs-<team2>-` |
| `team2_file` | String | yes | second team slug in the file name; null when team1_file is |
| `team_ct_start` | String | no | clan name of the team on CT in round 1 |
| `team_t_start` | String | no | clan name of the team on T in round 1 |
| `tick_rate` | Float32 | no | ticks per second (playback ticks / playback time). Divide tick differences by this; never assume 64 |
| `trade_window_s` | Float32 | no | window for trade flags, s |
| `unavailable_fields` | String | no | JSON: data the demo does not carry, and what replaces it |
| `visibility_status` | String | no | ok | no_mapdata | no_mesh | mesh_mismatch. Anything but ok means mesh_visible is null and only damage and kills trigger engagements |
| `voided_windows` | String | no | JSON [[from, to], ...] tick ranges dropped as backup restores |
| `truncated` | Boolean | no | the demo is cut off mid-file (awpy refuses it); tables cover the rounds up to the last complete one |
| `velocity_source` | String | no | networked (m_vecVelocity via awpy) or position_diff (demoparser2, used for a truncated demo) |

### `players`
One row per player. Key: steamid.

| field | type | null | meaning, units |
|---|---|---|---|
| `is_bot` | Boolean | no | true for a bot (id below 2^40) |
| `name` | String | no | last seen name |
| `rounds_present` | Int16 | no | rounds the player was on a team at freeze end |
| `side_h1` | String | yes | CT | T in the first half; null if the player played none of it |
| `side_h2` | String | yes | CT | T in the second half; null if the player played none of it, as when the demo ends before halftime |
| `side_ot` | List(String) | no | side in each overtime half |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `team` | String | yes | clan name |

### `rounds`
One row per round that counted (backup-restored attempts are dropped). Key: round.

| field | type | null | meaning, units |
|---|---|---|---|
| `ct_buy_type` | String | no | pistol | eco | semi_eco | semi_buy | full (thresholds $5k/$10k/$20k; a convention, not fitted) |
| `ct_equip_value` | Int32 | no | sum of CT players' game equipment value at freeze end, $ |
| `ct_money_start` | Int32 | no | sum of CT money before buying, $ |
| `ct_team` | String | no | clan name on CT |
| `ct_team_score_after` | Int16 | no | score of ct_team after the round |
| `defuse_tick` | Int32 | yes | tick |
| `defuser_steamid` | UInt64 | yes | player id (see Conventions) |
| `duration_s` | Float32 | no | freeze end to round end, s; from the round start for a round recorded already live (no freeze end) |
| `end_tick` | Int32 | no | tick |
| `explode_tick` | Int32 | yes | tick |
| `freeze_end_tick` | Int32 | yes | tick |
| `official_end_tick` | Int32 | yes | tick |
| `plant_site` | String | yes | A | B |
| `plant_tick` | Int32 | yes | tick |
| `planter_steamid` | UInt64 | yes | player id (see Conventions) |
| `reason` | String | no | end reason, e.g. bomb_exploded, t_killed |
| `round` | Int16 | no | 1-based round number |
| `start_tick` | Int32 | no | tick |
| `started_live` | Boolean | no | true when the recording began mid-round 1 (no freeze end) |
| `t_buy_type` | String | no | as ct_buy_type |
| `t_equip_value` | Int32 | no | as ct_equip_value |
| `t_money_start` | Int32 | no | as ct_money_start |
| `t_team` | String | no | clan name on T |
| `t_team_score_after` | Int16 | no | score of t_team after the round |
| `voided_attempts` | Int16 | no | backup-restored attempts of this round |
| `winner_side` | String | no | CT | T |
| `winner_team` | String | no | clan name of the winner |
| `aborted` | Boolean | no | a round ended with no winner whose stats the game kept (its kills and deaths count); not part of the score |

### `player_rounds`
One row per player per round, read at freeze end. Key: (round, steamid).

| field | type | null | meaning, units |
|---|---|---|---|
| `armor` | Int32 | no | armor points |
| `best_primary` | String | yes | most expensive primary held |
| `best_primary_price` | Int32 | yes | $ |
| `best_secondary` | String | no | most expensive pistol held |
| `best_secondary_price` | Int32 | no | $ |
| `cash_spent` | Int32 | no | spent this round, $ |
| `defuser` | Boolean | no | has a defuse kit |
| `equip_value_game` | Int32 | no | the game's own equipment value, $ |
| `helmet` | Boolean | no | has a helmet |
| `inventory` | List(String) | no | item display names |
| `inventory_value` | Int32 | no | inventory priced from the price file (armor and kit not included), $ |
| `money` | Int32 | no | money after buying, $ |
| `money_start` | Int32 | no | money before buying (money + cash_spent), $ |
| `name` | String | no | player name |
| `round` | Int16 | no | round |
| `round_start_equip_value` | Int32 | no | the game's equipment value at round start, $ |
| `side` | String | no | CT | T |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `survived` | Boolean | no | did not die this round |
| `game_damage` | Int32 | yes | the game's own damage this round (rise of its damage_total counter across the round boundary); the exact ADR input; null if the player had no counter at the boundary |
| `tick` | Int32 | no | freeze end tick |

### `kills`
Every player_death in a counted round. a_* is the attacker, v_* the victim, both read before the kill. Key: (tick, victim_steamid).

| field | type | null | meaning, units |
|---|---|---|---|
| `a_active_weapon` | String | yes | display name |
| `a_airborne` | Boolean | yes |  |
| `a_armor` | Int32 | yes | armor points |
| `a_best_primary` | String | yes | display name |
| `a_best_primary_price` | Int32 | yes | $ |
| `a_best_secondary` | String | yes | display name |
| `a_best_secondary_price` | Int32 | yes | $ |
| `a_ducking` | Boolean | yes |  |
| `a_equip_value_game` | Int32 | yes | $ |
| `a_flash_duration` | Float32 | yes | s |
| `a_health` | Int32 | yes | HP |
| `a_helmet` | Boolean | yes |  |
| `a_inventory_value` | Int32 | yes | $ |
| `a_money` | Int32 | yes | $ |
| `a_pitch` | Float32 | yes | degrees, down positive |
| `a_place` | String | yes | map place name |
| `a_scoped` | Boolean | yes |  |
| `a_side` | String | yes | CT | T |
| `a_walking` | Boolean | yes |  |
| `a_x` | Float32 | yes | Hammer units |
| `a_y` | Float32 | yes | Hammer units |
| `a_yaw` | Float32 | yes | degrees |
| `a_z` | Float32 | yes | Hammer units (feet) |
| `assistedflash` | Boolean | no | the assist was a flash |
| `assister_side` | String | yes | CT | T |
| `assister_steamid` | UInt64 | yes | player id (see Conventions) |
| `attacker_steamid` | UInt64 | yes | player id (see Conventions) |
| `attackerblind` | Boolean | no |  |
| `attackerinair` | Boolean | no |  |
| `distance` | Float32 | no | attacker to victim, Hammer units |
| `dmg_armor` | Int32 | no | event field |
| `dmg_health` | Int32 | no | event field |
| `headshot` | Boolean | no |  |
| `hitgroup` | String | no | e.g. head, chest |
| `is_suicide` | Boolean | no |  |
| `is_teamkill` | Boolean | no |  |
| `noscope` | Boolean | no |  |
| `penetrated` | Int32 | no | objects the bullet passed through (0 = no wallbang) |
| `round` | Int16 | no | round |
| `s_since_freeze_end` | Float32 | no | s |
| `s_since_plant` | Float32 | yes | s; null before the plant or without one |
| `thrusmoke` | Boolean | no |  |
| `tick` | Int32 | no | tick |
| `trade_kill_5s` | Boolean | no | the victim had killed the attacker's teammate within 5 s |
| `traded_death_5s` | Boolean | no | this death was traded within 5 s |
| `v_active_weapon` | String | no |  |
| `v_airborne` | Boolean | no |  |
| `v_armor` | Int32 | no |  |
| `v_best_primary` | String | yes |  |
| `v_best_primary_price` | Int32 | yes |  |
| `v_best_secondary` | String | no |  |
| `v_best_secondary_price` | Int32 | no |  |
| `v_ducking` | Boolean | no |  |
| `v_equip_value_game` | Int32 | no |  |
| `v_flash_duration` | Float32 | no |  |
| `v_health` | Int32 | no |  |
| `v_helmet` | Boolean | no |  |
| `v_inventory_value` | Int32 | no |  |
| `v_money` | Int32 | no |  |
| `v_pitch` | Float32 | no |  |
| `v_place` | String | no |  |
| `v_scoped` | Boolean | no |  |
| `v_side` | String | no |  |
| `v_walking` | Boolean | no |  |
| `v_x` | Float32 | no |  |
| `v_y` | Float32 | no |  |
| `v_yaw` | Float32 | no |  |
| `v_z` | Float32 | no |  |
| `victim_steamid` | UInt64 | no | player id (see Conventions) |
| `weapon` | String | no | weapon class without weapon_, e.g. ak47 |

### `damages`
Every player_hurt in a counted round, plus hits rebuilt from health drops the event stream lost. Key: (tick, attacker_steamid, victim_steamid, row order).

| field | type | null | meaning, units |
|---|---|---|---|
| `a_place` | String | yes |  |
| `a_side` | String | yes | CT | T |
| `a_x` | Float32 | yes | Hammer units |
| `a_y` | Float32 | yes |  |
| `a_z` | Float32 | yes |  |
| `armor_after` | Int32 | yes |  |
| `armor_before` | Int32 | yes |  |
| `attacker_steamid` | UInt64 | yes | player id (see Conventions) |
| `distance` | Float32 | yes | Hammer units |
| `dmg_armor` | Int32 | yes | event field |
| `dmg_armor_capped` | Int32 | yes | armor actually removed |
| `dmg_health` | Int32 | yes | event field (truncated) |
| `dmg_health_capped` | Int32 | no | HP actually removed (health_before - health_after); enemy hits sum exactly to the scoreboard |
| `grenade_entity_id` | Int32 | yes | the grenade or inferno that did it |
| `grenade_link` | String | yes | he | inferno | impact |
| `source` | String | no | event (a player_hurt), or health: rebuilt from a health drop whose player_hurt the demo lost. A rebuilt row names an attacker only from its own tick: the player_death attacker for a lethal drop, else the one enemy with a weapon_fire or bullet_impact on that tick. Event-only fields are null |
| `reconstructed_ambiguous` | Boolean | no | a rebuilt row with no player_death and not exactly one enemy shot on its tick; attacker_steamid is null, and its HP is part of match.unattributed_damage_hp |
| `health_after` | Int32 | no | HP |
| `health_before` | Int32 | no | HP before the hit (chained within a tick) |
| `hitgroup` | String | yes |  |
| `is_self` | Boolean | no |  |
| `is_team_damage` | Boolean | no | false when the attacker is unknown |
| `round` | Int16 | no | round |
| `tick` | Int32 | no | tick |
| `v_place` | String | yes |  |
| `v_side` | String | no |  |
| `v_x` | Float32 | yes |  |
| `v_y` | Float32 | yes |  |
| `v_z` | Float32 | yes |  |
| `victim_steamid` | UInt64 | no | player id (see Conventions) |
| `weapon` | String | yes | weapon class, e.g. ak47, inferno |
### `shots`
Every weapon_fire, misses included. Shooter state is read before the shot. Key: (tick, steamid, row order).

| field | type | null | meaning, units |
|---|---|---|---|
| `accuracy_penalty` | Float32 | no | weapon accuracy penalty |
| `active_weapon` | String | no | display name |
| `airborne` | Boolean | no |  |
| `ammo_clip` | Int32 | no | rounds in the magazine |
| `bullet_inair` | Boolean | yes |  |
| `bullet_pitch` | Float32 | yes | degrees |
| `bullet_yaw` | Float32 | yes | degrees |
| `duck_amount` | Float32 | no | 0..1 |
| `ducked` | Boolean | no |  |
| `ducking` | Boolean | no |  |
| `eye_x` | Float32 | yes | bullet origin, Hammer units |
| `eye_y` | Float32 | yes |  |
| `eye_z` | Float32 | yes |  |
| `flash_duration` | Float32 | no | s |
| `has_bullet_info` | Boolean | no | a fire_bullets row matched |
| `health` | Int32 | no | HP |
| `inaccuracy` | Float32 | yes | from fire_bullets; null for knives and grenades |
| `item_def_index` | UInt32 | yes |  |
| `num_bullets_remaining` | UInt32 | yes |  |
| `pitch` | Float32 | no | degrees |
| `place` | String | no |  |
| `recoil_index` | Float32 | yes |  |
| `round` | Int16 | no | round |
| `scoped` | Boolean | no |  |
| `seed` | UInt32 | yes | spread seed |
| `shots_fired` | Int32 | no | consecutive shots in the current spray |
| `side` | String | no | CT | T |
| `silenced` | Boolean | no |  |
| `speed_2d` | Float32 | yes | horizontal speed, units/s; null with vel_x |
| `spread` | Float32 | yes |  |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `tick` | Int32 | no | tick |
| `vel_x` | Float32 | yes | networked velocity, units/s; null when the parser has no velocity for the shooter on that tick |
| `vel_y` | Float32 | yes |  |
| `vel_z` | Float32 | yes |  |
| `velocity_modifier` | Float32 | no | movement slowdown from being hit, 0..1 |
| `walking` | Boolean | no |  |
| `weapon` | String | no | weapon class |
| `x` | Float32 | no | Hammer units |
| `y` | Float32 | no |  |
| `yaw` | Float32 | no | degrees |
| `z` | Float32 | no | feet |
| `zoom_lvl` | Float32 | yes |  |

### `engagements`
One row per attacker-victim encounter. Definition: Engagements below. Key: engagement_id.

| field | type | null | meaning, units |
|---|---|---|---|
| `attacker_steamid` | UInt64 | no | player id (see Conventions) |
| `damage` | Int32 | no | HP removed from the victim in the window |
| `end_tick` | Int32 | no | tick |
| `engagement_id` | Int32 | no | 0-based, unique in the match |
| `first_damage_tick` | Int32 | yes | attacker's first hit on the victim |
| `first_shot_tick` | Int32 | yes | attacker's first shot in the window |
| `first_visible_tick` | Int32 | yes | first tick with mesh_visible; null if never or visibility unavailable |
| `hits` | Int16 | no | hits on the victim in the window |
| `outcome` | String | no | kill | damage-only | shots-only (attacker fired, no damage) | sight-only (no shots) |
| `round` | Int16 | no | round |
| `start_tick` | Int32 | no | tick |
| `truncated` | Boolean | no | the window hit the 8 s cap |
| `victim_steamid` | UInt64 | no | player id (see Conventions) |
| `weapon` | String | yes | weapon of the first hit |

### `engagement_ticks`
One row per tick of every engagement window. a_* attacker, v_* victim. Key: (engagement_id, tick).

| field | type | null | meaning, units |
|---|---|---|---|
| `a_duck` | Float32 | yes | duck amount 0..1 |
| `a_eye_z` | Float32 | yes | z + 64 - 18 * duck |
| `a_pitch` | Float32 | yes | degrees, down positive |
| `a_shot_fired` | Boolean | yes | a shots row exists for (tick, attacker) |
| `a_spotted_by_v` | Boolean | yes | the victim's radar shows the attacker (lags real visibility) |
| `a_vel_x` | Float32 | yes | networked velocity, units/s |
| `a_vel_y` | Float32 | yes |  |
| `a_vel_z` | Float32 | yes |  |
| `a_x` | Float32 | yes | Hammer units |
| `a_y` | Float32 | yes |  |
| `a_yaw` | Float32 | yes | degrees |
| `a_z` | Float32 | yes | feet |
| `engagement_id` | Int32 | no | engagements.engagement_id |
| `mesh_visible` | Boolean | yes | attacker eye to victim eye, or chest, clear of the map mesh; null when visibility_status is not ok |
| `smoke_blocked` | Boolean | yes | approximation: the eye-to-eye segment crosses a live smoke sphere |
| `tick` | Int32 | no | tick |
| `v_duck` | Float32 | yes |  |
| `v_eye_z` | Float32 | yes |  |
| `v_pitch` | Float32 | yes |  |
| `v_shot_fired` | Boolean | yes |  |
| `v_spotted_by_a` | Boolean | yes | the attacker's radar shows the victim (lags real visibility) |
| `v_vel_x` | Float32 | yes |  |
| `v_vel_y` | Float32 | yes |  |
| `v_vel_z` | Float32 | yes |  |
| `v_x` | Float32 | yes |  |
| `v_y` | Float32 | yes |  |
| `v_yaw` | Float32 | yes |  |
| `v_z` | Float32 | yes |  |

### `positions`
Every player every POSITION_STRIDE_TICKS ticks (4 Hz at 64 tick) inside counted rounds. Key: (tick, steamid).

| field | type | null | meaning, units |
|---|---|---|---|
| `active_weapon` | String | yes | display name |
| `armor` | Int32 | no |  |
| `duck_amount` | Float32 | no | 0..1 |
| `ducked` | Boolean | no |  |
| `ducking` | Boolean | no |  |
| `flash_duration` | Float32 | no | s |
| `health` | Int32 | no | HP |
| `helmet` | Boolean | no |  |
| `is_airborne` | Boolean | no |  |
| `is_alive` | Boolean | no |  |
| `is_scoped` | Boolean | no |  |
| `is_walking` | Boolean | no |  |
| `money` | Int32 | no | $ |
| `pitch` | Float32 | no | degrees |
| `place` | String | no | map place name |
| `round` | Int16 | no |  |
| `side` | String | no | CT | T |
| `spotted` | Boolean | no | radar-spotted by anyone |
| `spotted_by` | List(UInt64) | no | player ids whose radar shows this player |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `tick` | Int32 | no | tick |
| `user_id` | Int32 | no | server user id |
| `vel_x` | Float32 | yes | units/s; null when the parser has no velocity for the player on that tick |
| `vel_y` | Float32 | yes |  |
| `vel_z` | Float32 | yes |  |
| `velocity_modifier` | Float32 | no | 0..1 |
| `x` | Float32 | no | Hammer units |
| `y` | Float32 | no |  |
| `yaw` | Float32 | no | degrees |
| `z` | Float32 | no | feet |

### `spotted`
Radar spotted-state changes at tick resolution. Lags real visibility: information metrics only, never aim. Key: (tick, target_steamid, spotter_steamid).

| field | type | null | meaning, units |
|---|---|---|---|
| `round` | Int16 | no |  |
| `spotted` | Boolean | no | state from this tick on |
| `spotter_steamid` | UInt64 | no | player id (see Conventions) |
| `target_steamid` | UInt64 | no | player id (see Conventions) |
| `tick` | Int32 | no | tick |

### `blinds`
Every flash blind, rebuilt from flash-duration changes (GOTV has no player_blind). Key: (tick, victim_steamid).

| field | type | null | meaning, units |
|---|---|---|---|
| `ambiguous` | Boolean | no | two flashes detonated on that tick; the nearer one is credited |
| `attacker_steamid` | UInt64 | yes | player id (see Conventions) |
| `duration` | Float32 | no | s |
| `flash_entity_id` | Int32 | no |  |
| `is_self` | Boolean | no |  |
| `is_team_flash` | Boolean | no |  |
| `round` | Int16 | no |  |
| `tick` | Int32 | no | tick |
| `v_x` | Float32 | no |  |
| `v_y` | Float32 | no |  |
| `v_z` | Float32 | no |  |
| `victim_steamid` | UInt64 | no | player id (see Conventions) |

### `smokes`
One row per smoke. Key: entity_id + start_tick.

| field | type | null | meaning, units |
|---|---|---|---|
| `duration_s` | Float32 | yes | s |
| `end_tick` | Int32 | yes | tick; null if it never expired in the demo |
| `entity_id` | Int32 | no |  |
| `round` | Int16 | no |  |
| `start_tick` | Int32 | no | tick |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `x` | Float32 | no | detonation point, Hammer units |
| `y` | Float32 | no |  |
| `z` | Float32 | no |  |

### `infernos`
One row per molotov or incendiary fire. Flame extent is not in the demo. Key: entity_id + start_tick.

| field | type | null | meaning, units |
|---|---|---|---|
| `duration_s` | Float32 | yes | s |
| `end_tick` | Int32 | yes | tick |
| `entity_id` | Int32 | no |  |
| `round` | Int16 | no |  |
| `start_tick` | Int32 | no | tick |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `x` | Float32 | no | origin, Hammer units |
| `y` | Float32 | no |  |
| `z` | Float32 | no |  |

### `grenade_throws`
One row per grenade_thrown, linked to its projectile. Key: (tick, steamid).

| field | type | null | meaning, units |
|---|---|---|---|
| `entity_id` | Int32 | no |  |
| `flight_s` | Float32 | no | s |
| `land_tick` | Int32 | no | tick |
| `land_x` | Float32 | no |  |
| `land_y` | Float32 | no |  |
| `land_z` | Float32 | no |  |
| `link_distance` | Float32 | no | projectile start to thrower eye, Hammer units |
| `pitch` | Float32 | no | degrees |
| `place` | String | no |  |
| `projectile` | Int32 | no | grenade_paths.projectile |
| `round` | Int16 | no |  |
| `side` | String | no |  |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `tick` | Int32 | no | tick |
| `weapon` | String | no | grenade class |
| `x` | Float32 | no | thrower feet |
| `y` | Float32 | no |  |
| `yaw` | Float32 | no | degrees |
| `z` | Float32 | no |  |

### `grenade_paths`
Projectile trajectories, one row per tick where the position changed. Key: (projectile, tick).

| field | type | null | meaning, units |
|---|---|---|---|
| `entity_id` | Int32 | no |  |
| `projectile` | Int32 | no | id unique in the match |
| `round` | Int16 | no |  |
| `steamid` | UInt64 | yes | player id (see Conventions) |
| `tick` | Int32 | no | tick |
| `type` | String | no | smoke | flashbang | he | molotov | ... |
| `x` | Float32 | no |  |
| `y` | Float32 | no |  |
| `z` | Float32 | no |  |

### `grenade_events`
Detonations, smoke and inferno start and end. Key: (tick, event, entity_id).

| field | type | null | meaning, units |
|---|---|---|---|
| `entity_id` | Int32 | no |  |
| `event` | String | no | he_detonate | flash_detonate | smoke_detonate | smoke_expired | inferno_start | inferno_expire | ... |
| `round` | Int16 | no |  |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `tick` | Int32 | no | tick |
| `x` | Float32 | no |  |
| `y` | Float32 | no |  |
| `z` | Float32 | no |  |

### `bomb`
Bomb events. Key: (tick, event).

| field | type | null | meaning, units |
|---|---|---|---|
| `event` | String | no | planted | defused | exploded | dropped | pickup | ... |
| `place` | String | no |  |
| `round` | Int16 | no |  |
| `site` | String | yes | A | B |
| `site_entity` | Int32 | yes | bomb site entity index |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `tick` | Int32 | no | tick |
| `x` | Float32 | no |  |
| `y` | Float32 | no |  |
| `z` | Float32 | no |  |
| `zone` | Int8 | yes | planter's bomb zone, 1 = A, 2 = B |

### `purchases`
Every item purchase. Key: (tick, steamid, row order).

| field | type | null | meaning, units |
|---|---|---|---|
| `cost` | Int32 | no | $ |
| `inventory_slot` | Int16 | no |  |
| `item` | String | no | display name |
| `round` | Int16 | no |  |
| `side` | String | no |  |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `tick` | Int32 | no | tick |
| `was_sold` | Boolean | no | refunded in the buy zone |
| `x` | Float32 | no |  |
| `y` | Float32 | no |  |
| `z` | Float32 | no |  |

### `scoreboard`
The game's own end-of-match scoreboard, one row per player. The validation reference. Key: steamid.

| field | type | null | meaning, units |
|---|---|---|---|
| `3k_rounds_total` | Int32 | no | counter from the game's scoreboard |
| `4k_rounds_total` | Int32 | no | counter from the game's scoreboard |
| `ace_rounds_total` | Int32 | no | counter from the game's scoreboard |
| `alive_time_total` | Int32 | no | counter from the game's scoreboard |
| `assists_total` | Int32 | no | counter from the game's scoreboard |
| `cash_earned_total` | Int32 | no | counter from the game's scoreboard |
| `crosshair_code` | String | no |  |
| `damage_total` | Int32 | no | counter from the game's scoreboard |
| `deaths_total` | Int32 | no | counter from the game's scoreboard |
| `enemies_flashed_total` | Int32 | no | counter from the game's scoreboard |
| `equipment_value_total` | Int32 | no | counter from the game's scoreboard |
| `headshot_kills_total` | Int32 | no | counter from the game's scoreboard |
| `kill_reward_total` | Int32 | no | counter from the game's scoreboard |
| `kills_total` | Int32 | no | counter from the game's scoreboard |
| `money_saved_total` | Int32 | no | counter from the game's scoreboard |
| `mvps` | Int32 | no | counter from the game's scoreboard |
| `name` | String | no |  |
| `objective_total` | Int32 | no | counter from the game's scoreboard |
| `score` | Int32 | no | counter from the game's scoreboard |
| `side` | String | no | CT | T at the end |
| `steamid` | UInt64 | no | player id (see Conventions) |
| `team_clan_name` | String | no |  |
| `team_rounds_total` | Int32 | no | counter from the game's scoreboard |
| `tick` | Int32 | no | tick it was read |
| `utility_damage_total` | Int32 | no | counter from the game's scoreboard |
| `kills_total_at_start` | Int32 | no | kills_total at round 1's freeze end: 0 for a whole match, the earlier parts' totals for a later part of a split recording |
| `deaths_total_at_start` | Int32 | no | deaths_total at round 1's freeze end: 0 for a whole match, the earlier parts' totals for a later part of a split recording |
| `assists_total_at_start` | Int32 | no | assists_total at round 1's freeze end: 0 for a whole match, the earlier parts' totals for a later part of a split recording |
| `damage_total_at_start` | Int32 | no | damage_total at round 1's freeze end: 0 for a whole match, the earlier parts' totals for a later part of a split recording |
| `headshot_kills_total_at_start` | Int32 | no | headshot_kills_total at round 1's freeze end: 0 for a whole match, the earlier parts' totals for a later part of a split recording |
| `team_rounds_total_at_start` | Int32 | no | team_rounds_total at round 1's freeze end: 0 for a whole match, the earlier parts' totals for a later part of a split recording |

### `events_misc`
Every other game event, as JSON. Key: (tick, event, row order).

| field | type | null | meaning, units |
|---|---|---|---|
| `data` | String | no | JSON of the event's fields |
| `event` | String | no | game event name |
| `round` | Int16 | no | 0 for warmup |
| `steamid` | UInt64 | yes | player id (see Conventions) |
| `tick` | Int32 | no | tick |
