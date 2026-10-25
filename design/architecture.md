# Architecture: demos are the only input; one extractor; one engine

Decided 2026-10-25 (Fable architecture counsel, accepted by the lead). This is binding for every workstream. Read before changing the extractor, the engine or how data flows.

## Principle
Unify at the input layer. Every population arrives as a CS2 demo (`.dem`): the user's local matches (via `tv_autorecord`), real matches (Valve share codes, FACEIT) and pros (HLTV).
- **Python knows demos and map geometry; TypeScript knows metrics.** Python never computes a number the UI shows. TypeScript never reads a demo.
- **Every metric exists once,** in the TS engine, and it is used both by the app (the user's matches) and by the baseline builder (pro data).

```
.dem  (local server | Valve share code | FACEIT | HLTV)
 -> extractor   Python: demoparser2 + awpy, one pinned version
 -> match tables  parquet, schema v1, 4-8 MB per map  <- THE CONTRACT
 -> loader      TS (hyparquet), the same code in the app and in Node
 -> engine      TS, pure: derive(tables) -> facts; rollup(facts, filters) -> summary; compare(summary, baselines) -> percentiles
 -> app UI (user)  |  baseline builder (Node CLI over the pro tables -> baselines.json, a few hundred KB)
```

## Schema v1 tables
- `match`: match_id, source {local, valve, faceit, hltv}, map, tick_rate, demo_sha256, extractor_version, schema_version.
- `rounds`: round, start/freeze_end/end ticks, winner, reason, plant tick, equipment value and buy type per side.
- `player_rounds`: round, steamid, side, start money, equipment value, primary weapon, survived.
- `kills`, `damages`, `shots`, `grenades`, `smokes`, `infernos`, `blinds`, `bomb`: as the current extractor writes them.
- `positions`: 4 Hz; tick, steamid, xyz, pitch/yaw, velocity, duck amount, place, hp, armor, scoped.
- `spotted`: change events (spotter, target, state). It lags real visibility; use it only for information metrics, **never for aim**.
- **`engagements`:** id, attacker, victim, start_tick, event_tick, outcome. A window of about 3 s before each damage or kill, per attacker-victim pair.
- **`engagement_ticks`:** id, tick; for each player xyz, eye_z, pitch, yaw, velocity, duck; `mesh_visible` (awpy `.tri` raycast), `smoke_blocked` (our smoke-volume test, labelled as an approximation), the spotted flags, `shot_fired`.

Every aim metric derives from the engagement windows: time to damage, reaction, crosshair placement, pre-aim degrees, and per-bullet spray against the weapon's recoil asset. Times are always in seconds, never ticks, because tick rates differ by source.

## Visibility
The offline mesh model (awpy `.tri` raycast plus smoke volumes) is used for **every** population, because it is the only one that exists for all of them. The plugin's live LOS trace is an **oracle**: compare it with the mesh model on local matches and fix systematic gaps (doors, breakables, models). Then retire the plugin.

## Validation (acceptance)
| Family | Ground truth | Accept when |
|---|---|---|
| Extractor: K, D, ADR, KAST, equipment, buy type | HLTV per-map JSON (733 maps) | K, D, KAST exact; ADR ±0.5; buy type exact once HLTV's thresholds are matched |
| Win probability and swing | HLTV per-event win probabilities and per-player swing credits | win-probability MAE < 0.03; per-player-map swing r > 0.95 |
| Rating 3.0 (approx.) | HLTV per-map rating | MAE < 0.04, r > 0.97; the UI says "approx." |
| Visibility | plugin LOS on local matches | > 97% agreement on engagement ticks |
| Aim and movement | scenario demos on the local server, plus bounds | within 1° / 1 tick; reaction 150–400 ms |
| Utility | scenario demos; blinds exact | exact pair sets |
| Roles and identity | HLTV career cards where definitions overlap; face validity | overlapping stats agree within rounding |
| Leetify import | Leetify's numbers for the same matches | correlation (within-player r > 0.8), not equality; shown with a source label, never merged |

HLTV data stays in the private data folder. Tests that need it **skip loudly** when it's absent.

## Migration order
1. **Prove that local recording works:** `tv_enable 1; tv_autorecord 1` on the local server, then run the extractor and compare table shapes with the pro tables. Needs CS2; the user decides. If it fails, a plugin-to-tables adapter must emit schema v1, never a second model.
2. Freeze schema v1 in writing; add the `engagements` tables (mesh and smoke visibility); add snapshot tests on 2–3 fixture demos.
3. Build the TS loader; port the engine input; the scoreboard comes first and must match HLTV exactly on 20 fixture maps (the CI gate).
4. Port the remaining families one at a time, then delete the plugin-JSON path. Until recording is proven, the user's existing plugin matches reach the engine through a transitional adapter that emits schema v1 tables in memory. Its removal condition is written down.
5. Baseline builder (Node CLI) to `baselines.json`; the app loads it.
6. Rating 3.0: the model is defined once, in TS. Python only solves for coefficients. The constants land in one params file, with dataset size, date and error at the change site.
7. Package the extractor as a Tauri sidecar (PyInstaller). An inbox watcher covers the server's demo folder and a downloads folder.
8. Downloaders (Valve share codes, FACEIT) and Leetify aggregates (an `external_aggregates` table, source-labelled). Pull this earlier than it feels natural: real matches are where identity becomes meaningful, and Valve demo links expire after about 30 days.
9. Validate visibility, then retire the plugin.

## Clipping, later
`moments = score(facts)` (multi-kills, clutches, high-swing events, aim outliers). Scoring happens at extraction time; demos are kept only for matches above a threshold. A separate renderer drives CS2 playback with HLAE or OBS, and ffmpeg templates overlay the facts. The scorer is engine code; the renderer is the only new subsystem.

## Risks to revisit
- **The Python sidecar** (size, antivirus, startup): if two of the three bite, move to a Rust extractor behind the same schema.
- **Map updates can outrun the `.tri` files:** show "visibility unavailable" rather than wrong numbers.
- **Storage:** keep the tables by default (a new engine version can recompute from them); offer a purge that keeps only the facts.
- **Open source:** ship anonymous aggregate baselines. Named-pro comparisons go in a separate optional pack. Nothing scraped from HLTV ships.
