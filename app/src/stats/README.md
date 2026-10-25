# Stats engine

Pure TypeScript, no UI dependency. Its only input is one match's tables, schema v1
(`extractor/SCHEMA-v1.md` on `feat/extractor-v1`). The same code runs in the app and in the Node tools
that build the pro baselines. Metric definitions are in `METRICS.md`; the evidence behind them is in
`VALIDATION.md`.

## Progress

| Phase | State |
|---|---|
| Loader (`load.ts`, hyparquet) | done; reads v1 folders and pre-v1 folders |
| Scoreboard on tables, the HLTV gate | done; 83 of 194 joined maps exact for every player on K, D, KAST and ADR; `hltv-exact.test.ts` pins 24 and checks kills on all |
| Ported families: rounds and economy, utility, roles, attributes, aim, swing, Rating 3.0 | done; Rating 3.0 runs the diagnostic polynomial until the per-round model lands in `params.json` |
| Plugin JSON path | deleted; `plugin/adapter.ts` is the only plugin code left |
| Baselines CLI (`tools/baselines.ts`) | done; `public/baselines.json`, 340 KB, 214 pro players |
| New families: aim, movement, aggression, information, utility quality, identity, gun proficiency, opponents, trends | done; validation per metric in `VALIDATION.md` |
| UI and worker on the new API | in progress on this branch (rebased onto `feat/app-redesign`) |

## Pipeline

```
read(name) -> loadTables -> MatchTables -> derive -> MatchFacts -> rollup(facts[], filter) -> Summary
                                                                       compare(summary, baselines) -> percentiles
```

Plugin recordings take one extra step first: `decodeMatch(bytes)` then `pluginToTables(file)`.

## API

### Input
| Call | Returns | Notes |
|---|---|---|
| `loadTables(read)` (`load.ts`) | `MatchTables` | `read(fileName)` returns the file's bytes or null. A missing required table or column, or a null in a non-nullable column, throws `TableError` naming it. Pre-v1 folders (no `match.parquet`) are read through the legacy mapping in `load.ts`. |
| `decodeMatch(bytes, name)`, `pluginToTables(file)` (`plugin/`) | `MatchTables` | Transitional; see the header of `plugin/adapter.ts` for when it goes. |

### Facts
| Call | Returns | Notes |
|---|---|---|
| `derive(tables)` (`derive.ts`) | `MatchFacts` | Plain JSON, safe to cache. Cache by `DERIVE_VERSION` (`facts.ts`); it changes whenever a definition does. |

`MatchFacts` holds `match` (id, source, map, date, teams, score, `pov` = the recording player, and
`roundsPlayed` next to `nRounds`, the rounds the facts cover; a converted log may cover few), `players`
(index `pi` -> steamid, name, team 0/1, bot), `rounds` (per round: winner, reason, buy classes, team
equipment, plant, and `winProb`, the win-probability path), `pr` (one row per player per round, with
`m`, the additive measures), `kills` (per kill: trade, opening, eco points, swing credits), `weapons`
(per player, round and gun), and the event facts of `aim`, `movement`, `aggression`, `information` and
`utilq`. Rounds are addressed by row `ri`; `rounds[ri].number` is the match's round number.

### Summaries and metrics
| Call | Returns | Notes |
|---|---|---|
| `rollup(facts[], filter)` (`rollup.ts`) | `Summary` | One player (or several ids) over the rounds a filter keeps: `sides`, `ownBuy`, `oppBuy` (HLTV's pistol, eco, half, full), `maps`, `from`/`to` dates, `opponents` (team names), `spawns`, `weapons`. |
| `METRICS`, `METRIC[id]` (`metrics.ts`) | `Metric` | Every metric once: `label`, `hltv` name, `kind` (performance or identity), `group`, `unit`, `status` (exact, approx, unavailable), `def`, `value(summary)`. |
| `ATTRIBUTES` (`metrics.ts`) | groups | HLTV's Firepower (performance) and six style attributes (identity), with their metric ids. |
| `rating3(m)`, `rating3BySide(facts, filter)` (`rating3.ts`) | `Rating3` | Rating 3.0 (approx.). Per side it is the rating of that side's rounds, pooled. Label it `RATING3_LABEL`; while `diagnostic` is true, say so and show `status` (params.json has retired the map polynomial pending the per-round model). |

### Comparisons
| Call | Returns | Notes |
|---|---|---|
| `compare(summary, baselines, opt)` (`compare.ts`) | percentile per metric | Pool: the player's role (Rifler, or AWPer above 0.20 AWP kills per round) by default, `pool: "all"`, or `map`. Sniping always compares with everyone. `side`: both, CT or T. Load `baselines` from `public/baselines.json`. |
| `attributes(summary, baselines, opt)` | `AttributeScore[]` | Each attribute's score is the mean percentile of its metrics. |
| `roleBlend(summary, side)` (`identity.ts`) | `RoleBlend` | Shares of Entry, Lurker, Half-lurker (T) or Anchor, Rotator, Mixed (CT), plus AWPer, with plain-language evidence. Pass a summary rolled up with `sides: [side]`; add `maps`, `spawns` or `ownBuy` for the breakdowns. |
| `supportTendency(summary, baselines, opt)` | score and evidence | Support has no labelled source, so it stays out of the blend. |
| `mostSimilar(mine, pack, side, "style" or "performance")` | ranked names | "Plays like" over the six style attributes; "performs like" over the rating inputs. `styleScores(attributes(...))` and `performanceScores(...)` build `mine`. The pack is optional and private (see Baselines). |
| `vsOpponents(facts, filter)` (`opponents.ts`) | per metric | The player against the opponents of the same matches. |
| `gunProficiency(facts, filter)` (`guns.ts`) | per gun | Familiarity and consistency, not performance. |
| `series`, `trend`, `correlation`, `winCorrelation` (`trends.ts`) | per match | One value per match, a slope over match order, correlations between metrics or with winning. |
| `presence(tables, playerId, side?)`, `addPresence` (`positions.ts`) | `Presence` | Alive samples per 64-unit grid cell and seconds per place, from a match's tables (facts do not keep positions). `playerId = null` gives every player, the map's walkable backdrop. |

### Baselines
`pnpm baselines` derives every pro map in the private data folder and writes `public/baselines.json`
(about 220 KB, no names or ids) and the named pack to `<data>/derived/baselines-named.json`, which
stays outside the repo. Rebuild after any change to `METRICS` or a definition.

## API changes for the UI

The old API (`deriveMatch`, `MatchView`, `summarize`, `buildProfile`, `Counters`, `RoundDetail`,
`AimAgg`, `PosAgg`, `scoreAttributes`, `SUBSTATS`, `stats/schema`) is gone. Where each piece now
comes from:

| Old | New |
|---|---|
| `decodeMatch` then `deriveMatch(m, file, model)` | `pluginToTables(await decodeMatch(bytes, name))` or `await loadTables(read)`, then `derive(tables)`. There is no model argument: win probability reads `params.json`. |
| `MatchView.players[pi]` and `.c` (`Counters`) | `rollup([facts], { player: id }).m` (`Measures`); metric values through `METRIC[id].value(summary)` |
| `PlayerRow.rating3`, the UI's `sideRating.ts` | `rating3BySide(facts, { player: id })`; keep main's coverage rule with `facts.match.nRounds` against `roundsPlayed` |
| `MatchView.roundDetails`, `RoundDetail.players[pi]` | `facts.rounds[ri]` and `facts.pr` rows for `ri`; kills from `facts.kills` filtered by `ri` |
| `MatchView.econ`, buy classes | `facts.rounds[ri].buy` and `.equip` (HLTV's four classes, renamed: force is now half) |
| `KillView` swing and win probability | `facts.kills[i].credits`, `facts.rounds[ri].winProb` |
| `MatchSummary` and `buildProfile(summaries, filter)` | cache `MatchFacts`; `rollup(allFacts, filter)` |
| `scoreAttributes(counters, careers)` | `attributes(summary, baselines)` |
| `SUBSTATS`, `METRICS` from `metrics.ts` and `hltv.ts` | `METRICS` (one list; `hltv` holds HLTV's name) |
| `deriveRole(counters)` | `roleBlend(summary, side)` |
| `AimAgg`, `aimVisibility` | `summary.aim` and the aim metrics; visibility is per match: `facts.match.visibility === "ok"` |
| `PosAgg` heatmaps | `presence(tables, id)` per match, summed with `addPresence`; kill and death spots from `facts.kills` (`kpos`, `vpos`) |
| `MatchView.human` | `facts.match.pov` (the recording player's steamid) |

## Gaps in the inputs

- Demos recorded from round 1 already live have no round 1 rows in `player_rounds`. Derive then takes
  round 1 sides from team names. HLTV's ADR differs on those ten demos, so they stay out of the gate.
- `params.json` has no flash share for swing (SPEC.md rule 5), so flash assists get no swing credit
  and Flash Swing is unavailable. It has no equipment bands either; `rating3.ts` keeps them with their
  derivation until it does.
- The extractor ships no nav mesh, so path efficiency is unavailable.
