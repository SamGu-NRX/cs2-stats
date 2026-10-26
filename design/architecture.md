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
**The contract is `extractor/SCHEMA-v1.md`.** It gives every field's type, key, nullability and unit. This section is the overview; where the two differ, the schema doc wins. Players are keyed by SteamID; bots have none, so they're keyed by name plus slot.
- `match`: match_id, source {local, valve, faceit, hltv}, map, map build, tick_rate, demo_sha256, the hash of the `.tri` file used, extractor_version, schema_version.
- `rounds`: round, start/freeze_end/end ticks, winner, reason, plant tick, equipment value and buy type per side.
- `player_rounds`: round, steamid, side, start money, equipment value, primary weapon, survived.
- `kills`, `damages`, `shots`, `grenades`, `smokes`, `infernos`, `blinds`, `bomb`: as the current extractor writes them.
- `positions`: 4 Hz; tick, steamid, xyz, pitch/yaw, velocity, duck amount, place, hp, armor, scoped.
- `spotted`: change events (spotter, target, state). It lags real visibility; use it only for information metrics, **never for aim**.
- **`engagements`:** id, attacker, victim, `first_visible_tick`, `first_shot_tick`, `event_tick`, `outcome` ∈ {kill, damage-only, shots-only, sight-only}, `truncated`. One row per encounter between an attacker and a victim on the other team. An encounter starts with any of three triggers:
  - mesh visibility begins;
  - the attacker shoots while the victim is in their 60° view cone and visible;
  - damage or a kill.

  Windows are not triggered by hits alone: that would drop the encounters where nobody lands a shot and bias every aim metric toward won fights. The window runs from 1.0 s before the first trigger to 1.0 s after the last. Triggers less than 1.5 s apart merge into one encounter, and encounters are capped at 8 s (flagged `truncated`).
- **`engagement_ticks`:** id, tick, sampled every tick inside the window. For each player: xyz, eye_z, pitch, yaw, velocity, duck. Plus `mesh_visible` (awpy `.tri` raycast), `smoke_blocked` (our smoke-volume test, labelled as an approximation), the spotted flags and `shot_fired`. Every shot, misses included, stays in `shots`.

Every aim metric derives from the engagement windows: time to damage, reaction, crosshair placement, pre-aim degrees and per-bullet spray. Times are always in seconds, never ticks, because tick rates differ by source. **Spray scoring stays off** until the recoil reference passes a recorded-spray validation on a stationary target. The pattern algorithm is undocumented, and the current reference is an empirical median of pro sprays.

## Visibility
The offline mesh model (awpy `.tri` raycast plus smoke volumes) is used for **every** population, because it is the only one that exists for all of them. It sees static geometry only: moving doors and breakables are a known limitation.

The **oracle** is the plugin's live line-of-sight probe (`plugin/Game/LosProbe.cs`, PR #13), not the spotted mask. The oracle must be validated first, on local scenario matches where visibility is known, before it judges anything. Recordings with `env.losError` set are excluded: in them the probe turned itself off and the recorder fell back to the spotted mask, so they hold no oracle data. The probe traces solid geometry only (`SolidBrushOnly`), so it judges the mesh model with smoke volumes turned off; smoke blocking is validated separately, with at least 10 scenario demos of a smoke thrown between two stationary players. Our smoke volume is an approximation of CS2's voxel smoke, so it must agree with the observed blocked state on at least 95% of ticks while the smoke is fully formed; the bloom and dissipation ticks are reported but not gated. The mesh model is then compared against the oracle on:
- **visibility onset error** in ms, per encounter;
- **false positives and negatives per tick.**

An aggregate agreement figure alone can hide timing failures. The game's `spotted` lag is measured separately for GOTV demos and for listen-server recordings, not assumed to be equal. The plugin retires only after the mesh model passes.

## Validation (acceptance)
| Family | Ground truth | Accept when |
|---|---|---|
| Extractor: K, D, KAST | the demo's own end-of-match scoreboard; HLTV per-map JSON | exact (integer counts) |
| Extractor: ADR, equipment, buy type | HLTV per-map JSON | ADR ±0.5 (HLTV rounds to 0.1 and differs in HP capping); buy type exact once HLTV's thresholds are matched |
| Win probability and swing | HLTV per-event win probabilities and per-player event credits | an exact recreation: held-out error no larger than HLTV's display rounding explains. `model/rating3/SPEC.md` computes that floor per stage |
| Rating 3.0 | HLTV per-map rating | the same exact-recreation rule on held-out maps; until it passes, the UI shows "approx." and "calibrating" |
| Visibility | the validated plugin LOS oracle on local matches | onset error within 1 tick for 90% of encounters and within 2 ticks for 99%; per-tick false positives and false negatives each under 1%, outside smoke. Measured on at least 200 encounters and 20,000 ticks across at least three maps. One tick is the resolution of the data; these bounds and minimum counts are set before any measurement, so the first run cannot tune them |
| Aim and movement | scenario demos on the local server (known offsets, stationary versus moving shots) | within 1° / 1 tick of the scenario's known value; reaction onset within 1 tick of the oracle's visibility onset |
| Utility | scenario demos; blinds exact | exact pair sets |
| Roles and identity | HLTV's own style scores for the same pros (validation only); face validity | rank correlation with HLTV per attribute, reported |
| Leetify import | Leetify's numbers for the same matches | correlation (within-player r > 0.8), not equality; shown with a source label, never merged |

**Reference data and CI.**
- The HLTV labels (733 per-map JSONs since 2026-10-01: scoreboards, per-event win probabilities, per-player swing credits) stay in the private data folder. They power a **local validation suite** with fixed train and held-out splits, which reports any skipped checks by name.
- The **CI gate** uses redistributable fixtures only: synthetic matches plus anonymized local recordings with hand-checked answers. Those fixtures are mandatory, and nothing in them depends on private data.

## Migration order
1. **Prove that local recording works:** `tv_enable 1; tv_autorecord 1` on the local server, then run the extractor and compare table shapes with the pro tables. Needs CS2; the user decides. If it fails, a plugin-to-tables adapter must emit schema v1, never a second model.
2. Freeze schema v1 in writing; add the `engagements` tables (mesh and smoke visibility); add snapshot tests on 2–3 fixture demos.
3. Build the TS loader and port the engine input. The scoreboard comes first: in the local validation suite it must reproduce 20 HLTV maps within the tolerances above, and in CI it must reproduce the redistributable fixtures exactly.
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
- **Open source:** the repo ships code, schemas and anonymous aggregate baselines computed by our own engine.
  - **Not in the repo:** HLTV text, data or images; Valve artwork (weapon and killfeed icons, map emblems and radars are extracted from the user's own CS2 install by `scripts/extract-icon-pack.cjs` into the local packs folder; agent renders are files the user adds there; a CC-licensed source such as nav-mesh SVG radars could replace the radars); and any pro pack.
  - **The optional named-pro pack** is generated locally on the user's machine. It holds our engine's metrics for named pros, computed from their demos, plus links to public profile pages. The app works without it.

## Rating labels across the migration
- **Until the fitted parameters pass acceptance:** "Rating 3.0 (approx.)" with a "calibrating" marker. Rating 2.0 is available in the tooltip.
- **After they pass:** "Rating 3.0 (approx.)" alone.
- "Rating 2.0" never appears as the headline label again. Older documents that say so (`research-c.md`) are superseded.
