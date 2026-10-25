# Match file schema v1

The contract between the capture plugin (`plugin/`) and the app (`app/`). The plugin records facts. The app derives every metric, so a metric definition can change without re-capturing a match.

- **One file per finished match:** `%APPDATA%\BotMatchStats\matches\YYYY\<startUtc>_<map>_<id8>.json.gz`.
- **In progress:** a partial file in `inprogress\`, rewritten after every round.
- **Encoding:** gzip of UTF-8 JSON. Field names are short to keep files small.
- **Columns:** each table is a set of equal-length arrays (columnar), not an array of objects.

## Conventions
- `tick` is the absolute server tick (64 per second) in every table. Time into a round is `tick − rounds.freezeTick[ri]`.
- **Player index** `pi` points into `players`. **Round index** `ri` starts at 0.
- **Positions:** world units rounded to integers. **Angles:** degrees × 100 as integers.
- **Weapons:** index into the file's own `weapons` name table (names without the `weapon_` prefix, as in the `player_death` event: `ak47`, `awp`, `hegrenade`, `inferno`, …).
- **Unknown values** are `null`. Never encode a missing value as 0.

## Top level
| field | type | meaning |
|---|---|---|
| `v` | int | schema version, `1` |
| `id` | string | random 128-bit hex |
| `map` | string | e.g. `de_dust2` |
| `startUtc`, `endUtc` | ISO-8601 string | |
| `status` | `"complete" \| "abandoned" \| "restarted"` | |
| `env` | object | `{plugin, cssharp, game, tickrate, maxrounds, botDifficulty}` |
| `firstFullRound` | int | first round with complete capture (0 if loaded before the match started) |
| `weapons` | string[] | weapon name table |
| `places` | string[] | map place-name table (`LastPlaceName` values) |
| `human` | int | `pi` of the human player |

## `players` (one entry per player that appeared)
`key[]` (SteamID64 for the human, `B:<name>` for bots), `name[]`, `isBot[]`, `startSide[]` (2 = T, 3 = CT, the side in round 0).

## `rounds` (one entry per round)
| field | meaning |
|---|---|
| `winSide` | 2 = T, 3 = CT |
| `how` | `elim`, `defuse`, `time`, `bomb` |
| `freezeTick` | server tick of `round_freeze_end`; kill and damage ticks minus this give time into the round |
| `durTicks` | ticks from freeze end to round end |
| `bombSite`, `plantTick`, `planter`, `defuser` | null when the event didn't happen |
| `ctSetup` | `[A, B, Mid, CT, Other]`: count of alive CTs per macro area at freeze end + 15 s. Uses `places` and the per-map area table; null on maps without one |
| `score` | `[T, CT]` score before the round |
| `side[pi]` | each player's side this round (null if absent) |
| `equip[pi]` | round-start equipment value from the pawn at freeze end |
| `money[pi]` | money at freeze end |

## `kills` (every death, in order)
`ri, tick, killer, victim, assister, flashAssister, weapon, flags, kpos, vpos, state`
- `killer`, `assister` and `flashAssister` are null for world deaths and suicides.
- `flags` bits: 1 headshot, 2 wallbang, 4 through smoke, 8 killer blind, 16 noscope, 32 in air.
- `kpos`, `vpos`: `[x, y, z]`.
- `state`: the round state just *before* the kill, used for the round-swing model: `[ctAlive, tAlive, ctHp, tHp, ctEquip, tEquip, planted(0/1), ticksSincePlant|null]`.

## `damage` (every `player_hurt` between different players)
`ri, tick, attacker, victim, dmg, dmgArmor, weapon, hitgroup`
- `dmg` is capped at the victim's HP before the hit.
- Team damage is kept and flagged by side, not dropped.

## `blinds`
`ri, tick, attacker, victim, ms`

## `grenades`
`ri, tick, thrower, type (he|flash|smoke|molotov|decoy), pos`

## `pos` (location samples)
- **What:** `ri, tick, pi, x, y, z, place, alive`.
- **Who and how often:** the human every 16 ticks (4 Hz); bots every 64 ticks (1 Hz), live rounds only.
- **Size:** about 25 KB gzipped per match, which is the main size cost and is accepted for heatmaps and "where you play".

## `aim`: human only, for Leetify-style analytics
All per-tick work in the plugin happens only for the human and only against alive enemies.

### `aim.engagements`
One row each time an enemy goes from not visible to visible for the human. Visible = the engine's own `EntitySpottedState.SpottedByMask` bit for the human's slot. A new engagement for the same enemy needs at least 1 s of not visible in between.
- `ri, enemy, tVis` (tick it became visible)
- `angVis`: angle in degrees × 100 between your view direction and the enemy's eye position at `tVis`; used for crosshair placement
- `angVisYaw`, `angVisPitch`: signed components of the same angle
- `dist`: distance in world units at `tVis`
- `tAimStart`: first tick after `tVis` where your angle to the enemy shrinks by at least 30°/s; null if never
- `tFirstShot`: first shot fired while the enemy was visible and within 10° of your aim; null if none
- `tFirstDmg`: first damage you dealt to this enemy; null if none
- `tEnd`: when the enemy stopped being visible or died
- `outcome`: `kill`, `died` (you died), `none`

### `aim.shots`
One row per bullet you fired.
- `ri, tick, weapon`
- `burst`: id of the burst; a new burst starts after 0.3 s without firing
- `idx`: bullet index within the burst, starting at 1
- `speed`: horizontal speed in units/s at the shot
- `maxSpeed`: the weapon's max speed from its VData, used for the counter-strafe threshold
- `scoped`, `ducked`
- `target`: the visible enemy closest to your aim at that tick (within 10°), or null
- `aimErr`: `[yaw, pitch]` × 100 from your view direction to the target's eye position
- `impact`: `[yaw, pitch]` × 100 from your eye to the bullet's first `bullet_impact` point, relative to your view direction; used for the spray pattern
- `hit`: hitgroup of the damage this bullet caused (same attacker, same tick), or null

## Performance budget (plugin)
- **Game thread:** under 50 µs average per tick and under 0.5 ms for any single event handler.
- **No allocations per tick:** cache player lists and refresh them on spawn/death/team events or once a second.
- **Disk:** the game thread never touches the disk. Encoding and writes run on a worker thread once per round.
- **Instrumentation:** the plugin records its own per-round timing (average and max µs per tick and per event, GC count) into the file under `perf`, so the budget can be checked on real matches.

## Optional fields (plugin 1.0.0)
Additions to v1 that do not change any field above; the version stays `1`. Readers must treat each as possibly absent. Index columns (`throw`, `flash`, `nade`) are row indices into another table of the same file, or null.

### Economy
- `rounds.equipEnd[pi]`: equipment value at `round_end`; 0 when the player was dead, null if absent.
- `rounds.survPrimary[pi]`: 1 if alive at `round_end` holding a primary (any weapon in the rifle gear slot), else 0; null if absent.
- `rounds.utilBought[pi]`: grenades bought this round as counts `[he, flash, smoke, molotov, incgrenade, decoy]`; null if absent.
- `rounds.utilSpent[pi]`: money spent on those grenades, from each item's VData price; null if absent or if any price was unreadable.

### Utility
- `throws`: one row per `grenade_thrown`: `ri, tick, thrower, type (he|flash|smoke|molotov|incgrenade|decoy), pos` (thrower's position).
- `grenades` rows are detonations: `hegrenade_detonate`, `flashbang_detonate`, `smokegrenade_detonate`, `inferno_startburn` (type `molotov`, covers the incendiary; thrower is the inferno entity's owner) and `decoy_started`. `grenades.throw`: the thrower's oldest unlinked throw of the same kind in the round.
- `blinds.flash`: the attacker's latest flash detonation at most 1 s earlier. Blinds include teammates and the thrower; events with 0 ms duration are not stored.
- `damage.nade`, `kills.nade`: for `hegrenade` damage, the attacker's latest HE detonation at most 1 s earlier; for `inferno` damage, the latest molotov detonation at most 8 s earlier.
- `kills.vUtil`: grenades the victim held at death as `[he, flash, smoke, molotov, incgrenade, decoy]`, read in the `player_death` pre-hook, falling back to the once-a-second inventory snapshot; null if unknown.

### Shots (`aim.shots`)
- `target`: the alive enemy closest to the shot's aim within 10°, whether visible or not. This differs from the v1 text above because the spotted mask under-reports visibility; visibility is now in `visTarget`.
- `visTarget`: 1/0 whether `target` was visible to the human at that tick, from the engine's spotted mask. The mask's bit is under review. Null without a target.
- `smoke`: 1 if the ray from the eye along the view direction crosses an active smoke before reaching the target, or 4096 units without one; else 0. A smoke is a 144-unit sphere around its detonation point, active from `smokegrenade_detonate` until `smokegrenade_expired` (matched by entity) or 22 s, whichever is first. These constants approximate CS2's volumetric smoke and have not been validated in-game.
- `impacts`: number of `bullet_impact` events in the shot's tick. More than 1 means penetration or several surfaces (and pellets for shotguns).
- `pen`: 1 if the shot killed an enemy with `player_death.penetrated` > 0, and 0 if it damaged no enemy or killed without penetrating. It is null when the shot hit an enemy non-fatally, because without a ray trace the plugin cannot tell whether the path was clear.
- `cls`: weapon class, one of `rifle`, `sniper`, `smg`, `pistol`, `shotgun`, `heavy`, from the item name. Null for the taser.

### Reconciliation (`recon`)
Each round is compared with the game's `CSPerRoundStats_t` at the next `round_start` (or 1 s after `cs_win_panel_match`). Kills count enemy kills, deaths count every death, and assists count damage and flash assists; these must match exactly. Damage must satisfy `0 <= game - ours <= hits`, because `player_hurt` truncates fractional damage (measured on `fixtures/events_two_matches.jsonl`).
- `rounds`: `ri, checked, kOk, dOk, aOk, dmgOk, missing` (players whose stats could not be read).
- `mismatch`: `ri, pi, field (k|d|a|dmg), ours, game, hits`.
- `partial`: rounds with incomplete capture (before `firstFullRound`, or interrupted by a reload). Rounds before capture began have only `winSide` and `how`.
- `unknownResult`: rounds whose `MatchStats_RoundResults` code is unknown; their `winSide` and `how` are null.
- `capUnknown`: damage rows whose pre-hit HP was unknown (capped at 100). `dropped`: rows lost to full buffers, by table.

### `perf`
Columns per round: `ri, ticks, tickAvgUs, tickMaxUs, events, evAvgUs, evMaxUs, evMaxName, tickAllocB, evAllocB, gen0`, plus `write: {lastMs, maxMs, lastBytes}` for the worker's previous write. Times cover only the plugin's own handlers; allocation is `GC.GetAllocatedBytesForCurrentThread` measured inside them.

### In-progress files
Files under `inprogress\` have `status: "inprogress"` and a `resume: {gameStart, nextBurst}` object; final files have neither. A hot-reloaded plugin resumes the file whose `map` and `gameStart` (`m_flGameStartTime`) match the running game. Any other in-progress file is written to `matches\` as `abandoned`.

### `pos`
Only alive players are sampled, so `alive` is always 1 in plugin 1.0.0.
