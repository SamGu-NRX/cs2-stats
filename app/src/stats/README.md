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
| Ported families: rounds and economy, utility, roles, attributes, aim, swing, Rating 3.0 | done; Rating 3.0 is `params.json`'s six-term linear model (PR #17) |
| Plugin JSON path | deleted; `plugin/adapter.ts` is the only plugin code left |
| Baselines CLI (`tools/baselines.ts`) | done; `public/baselines.json`, 391 KB, 552 pro players |
| New families: aim, movement, aggression, information, utility quality, identity, gun proficiency, opponents, trends | done; validation per metric in `VALIDATION.md` |
| UI and worker on the new API | in progress on this branch |

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
| `derive(tables, winProb)` (`derive.ts`) | `MatchFacts` | Plain JSON, safe to cache. Cache by `DERIVE_VERSION` (`facts.ts`), which changes whenever a definition does, and by `modelFingerprint(winProb)` (`model-params.ts`: the rating parameters and win-probability source by content), which facts record as `match.model`. `match.inputs.throws` says whether throws are logged or rebuilt. Inputs some metrics need are counted per row (`INPUT_COVERAGE`: loadouts per round, the weapon in hand per death, both loadouts per kill), so a metric over partly known rows is computed over the known ones and its comparison says how many were known. |
| `winProbSource(pack)`, `CS2RB` (`model-params.ts`) | `WinProbSource` | The one loader for the rating model and the win-probability source: HLTV's lookup from the private pack `%APPDATA%\BotMatchStats\packs\winprob-hltv.json` (pass its parsed JSON), or the CS2RB round model in `model/export` when the pack is missing (pass null). A pack that is present but malformed throws. `facts.match.winProb` records which one a match used. |

`MatchFacts` holds:

- `match`: id, source, map, date, `startedAt` (clock time, when the source has one), `durationS`,
  teams, score, `pov` (the recording player), and `roundsPlayed` next to `nRounds`, the rounds the
  facts cover (a converted log may cover few).
- `players`: index `pi` -> steamid, name, team 0/1, bot.
- `rounds`: per round, winner, reason, buy classes, team equipment, plant, `planter` and `defuser`
  (`pi`), and `winProb`, the win-probability path.
- `pr`: one row per player per round, with equipment, money before (`moneyStart`) and after (`money`)
  buying, spend, and `m`, the additive measures.
- `kills`: per kill, trade, opening, eco points, swing credits, positions.
- `weapons`: per player, round and gun, with hits by body part in `groups` (`HIT_GROUPS` order).
- `grenades`: every throw, with where it was thrown from and landed.
- `presence`: per player and side, seconds alive per 128-unit grid cell and per place name (not per
  round: that made cached facts too large; `roundPlaces(tables, round, steamid)` reads one round's
  places from the tables).
- The event facts of `aim`, `movement`, `aggression`, `information` and `utilq`.

Rounds are addressed by row `ri`; `rounds[ri].number` is the match's round number.

### Summaries and metrics
| Call | Returns | Notes |
|---|---|---|
| `rollup(facts, filter)` (`rollup.ts`) | `Summary` | One player (or several ids) over the rounds a filter keeps: `sides`, `ownBuy`, `oppBuy` (HLTV's pistol, eco, half, full), `maps`, `from`/`to` dates, `opponents` (team names), `spawns`, `weapons`, `rounds` (round numbers, for one match's round drawer). `Summary.presence[map]` is the heatmap and top places; it honours player, side and match filters and is empty under a round-level filter. |
| `emptySummary()`, `addMatch(summary, facts, filter)` | | The same sum one match at a time, so a caller can stream facts from storage instead of holding them all. |
| `grenadesOf(facts, filter)` | grenades with their map | The landing map's points. |
| `economyOf(facts, team)` (`economy.ts`) | `EconomyView` | One match from one team's side: per round buy, equipment, money left, spend and saves for both teams; win rate per buy class; buy against buy; rounds won after making the opening kill; plants and how they ended; average equipment. A save's value is the saver's equipment at freeze end, so grenades thrown since still count. |
| `visibilityCoverage(summary.aim)` (`aim.ts`) | 0-1 or null | Share of gun hits fired with an enemy mesh-visible near the view: the visibility coverage meter. |
| `METRICS`, `METRIC[id]` (`metrics.ts`) | `Metric` | Every metric once: `label`, `hltv` name, `kind` (performance or identity), `group`, `unit`, `status` (exact, approx, unavailable), `def`, `value(summary)`. |
| `ATTRIBUTES` (`metrics.ts`) | groups | HLTV's Firepower (performance) and six style attributes (identity), with their metric ids. |
| `rating3Of(summary)`, `rating3BySide(facts, filter)` (`rating3.ts`) | `Rating3` | Rating 3.0 (approx.): `params.json` `rating.intercept` plus `rating.coefficients` times eKPR, eADR, eDPR, eKAST, MK and swing, all six averaged over the rated rounds, those swing valued whose every eco value is known (a kill, assist, death or hit whose economy groups are unknown leaves its round out, never counted at its raw value); no rating when under half are rated, with `reason` saying why (compare() reports it), or when the kept matches cover under half their rounds (`coverage.ts`, the one gate every rating, the rating metric and its percentile pass). Each side is rated over its own rounds (`Summary.sides`), and the total, the one definition the rating metric, its percentile, `inputs` and every view use, is the side inputs weighted by each side's rated rounds (`rounds`): a side under half its rounds rated adds nothing, and the total needs the rated sides to cover half of all rounds. With both sides rated it equals the pooled rating, since the model is linear. Label it `RATING3_LABEL`; `status` is params.json's word for the model ("approximation"). |

### Comparisons
| Call | Returns | Notes |
|---|---|---|
| `compare(summary, baselines, opt)` (`compare.ts`) | percentile per metric | Pool: the player's role (Rifler, or AWPer above 0.20 AWP kills per round) by default, `pool: "all"`, or `map`. Sniping always compares with everyone. `side`: both, CT or T. Load the pro `baselines` from `public/baselines.json`; they rank performance ("how good", "Work on"). Each `Percentile` has `reason` when it is withheld: a metric's `needs` (an input not known on every row it uses, with the known count, or a model other than the baselines' `model`), or a `sample` under its minimum (`n` is the count). Show the value and the reason, never a rank. |
| `careerBaselines(careers, built)` | `{ baselines, provisional, careers }` | The user's own population for identity (`design/identity.md`): baselines from the bot careers in the user's matches (each `{ both, CT, T }` summaries; careers under 150 rounds are left out). Style attributes and "plays like" rank the user against these, never against pros. `provisional` is true until 15 careers qualify; say so beside the scores. |
| `buildPools(units)` | quantiles per pool and side | What both baselines are built from; `tools/baselines.ts` uses it for the pros. |
| `attributes(summary, baselines, opt)` | `AttributeScore[]` | Each attribute's score is the mean percentile of its metrics. |
| `roleBlend(summary, side)` (`identity.ts`) | `RoleBlend` | Shares of Entry, Lurker, Half-lurker (T) or Anchor, Rotator, Mixed (CT), plus AWPer, with plain-language evidence. The AWP share (`awp`) is over the rounds with a recorded freeze-end loadout (`loadoutRounds`); the evidence gives the count when some lack one, and with none `awp` is null and the blend has no AWPer share. Pass a summary rolled up with `sides: [side]`; add `maps`, `spawns` or `ownBuy` for the breakdowns. |
| `supportTendency(summary, baselines, opt)` | score and evidence | Support has no labelled source, so it stays out of the blend. |
| `mostSimilar(mine, pack, "style" or "performance")` | ranked names | Cosine similarity of profile shape over both sides: "plays like" over the six style attributes on T and on CT, "performs like" over the rating inputs on T and on CT. `mine` is `{ T, CT }`, each built with `styleScores(attributes(sideSummary, b, { side }))` or `performanceScores(...)`. The pack is optional and private (see Baselines). |
| `vsOpponents(facts, filter)` (`opponents.ts`) | per metric | The player against the opponents of the same matches. |
| `gunProficiency(all, perMatch)` (`guns.ts`) | per gun | Familiarity and consistency, not performance. `all` is the rollup over the kept matches, `perMatch` each match's `Summary.weapons`. |
| `series`, `trend`, `correlation`, `winCorrelation` (`trends.ts`) | per match | One value per match, a slope over match order, correlations between metrics or with winning. |
| `cellOf`, `cellCentre`, `GRID`, `CELL` (`positions.ts`) | | The presence grid: 128-unit cells over ±4096 world units. Roll up every player's ids for a map's walkable backdrop. |

### Worker calls (`worker/protocol.ts` `Api`)

Every metric in `meta().metrics` has `tip`, a tooltip of 12 words or fewer, beside the longer `def`.
Views read engine numbers through the stats worker. Besides `rollup` (every metric's value in `v`, the event
count behind each metric that declares one in `n`, and round swing by source in `swingSources`), `ratings`,
`compare` (each `Percentile` carries that count as `n`), `attributes`, `style` (`firepower` is Firepower against
the same bot pool; `careers.pool` names the pool the scores came from, "all" when the AWPer bot pool was too thin),
`playsLike`, `guns`, `positions`, `match`, `rounds` and `places`:

| Call | Returns |
|---|---|
| `attributeBlock(q, opt)` | Firepower against the pros and the six style attributes against the bots, each with its metrics' values, percentiles and reasons, for one side and pool |
| `buySplits(q)` | The query by own and opponent buy class: aggression by economy, pistol and eco splits |
| `opponents(q)` | Every metric against the opponents of the same matches, with a rank for performance metrics |
| `winCorrelation(q, ids)` | Each metric's per-match correlation with winning |
| `roles(q)` | The role blend on T and on CT, and `all`: the two weighted by their rounds (`identity.ts` `overallRole`) |
| `rolesByMap(q)` | `roles(q)` for each map played, most rounds first; rounds are counted under every query filter |
| `rolesBySpawn(q)` | The role blend per side and per spawn used, each spawn with its map, the map's place name there and its position in the side's spawn area facing the enemy ("front left", `positions.ts` `spawnPosition`); each blend covers that spawn's rounds on its own map under every query filter |
| `clutches(q)` | Every clutch by round, with the player's steamid (`player`) and their enemy kills after the clutch started (`kills`) |
| `multiKills(q)` | Every round with two or more kills: file, round, side, player, kills and the round's result |

Scoreboard lines (`match` bundle `lines`) carry `eco` (eK, eD, eADR, eKAST); A(f) and D(t) are `m.flashAssists`
and `m.tradedDeaths`.

### Baselines
`pnpm baselines` derives every pro map in the private data folder and writes `public/baselines.json`
(391 KB, no names or ids; swing from the win-probability source the tools found) and the named pack to `<data>/derived/baselines-named.json`, which
stays outside the repo. Rebuild after any change to `METRICS` or a definition.

## API changes for the UI

The old API (`deriveMatch`, `MatchView`, `summarize`, `buildProfile`, `Counters`, `RoundDetail`,
`AimAgg`, `PosAgg`, `scoreAttributes`, `SUBSTATS`, `stats/schema`) is gone. Where each piece now
comes from:

| Old | New |
|---|---|
| `decodeMatch` then `deriveMatch(m, file, model)` | `pluginToTables(await decodeMatch(bytes, name))` or `await loadTables(read)`, then `derive(tables, winProbSource(pack))`. |
| `MatchView.players[pi]` and `.c` (`Counters`) | `rollup([facts], { player: id }).m` (`Measures`); metric values through `METRIC[id].value(summary)` |
| `PlayerRow.rating3`, the UI's `sideRating.ts` | `rating3BySide(facts, { player: id })`; keep main's coverage rule with `facts.match.nRounds` against `roundsPlayed` |
| `MatchView.roundDetails`, `RoundDetail.players[pi]` | `facts.rounds[ri]` and `facts.pr` rows for `ri`; kills from `facts.kills` filtered by `ri` |
| `MatchView.econ`, buy classes | `facts.rounds[ri].buy` and `.equip` (HLTV's four classes, renamed: force is now half) |
| `KillView` swing and win probability | `facts.kills[i].credits`, `facts.rounds[ri].winProb` |
| `MatchSummary` and `buildProfile(summaries, filter)` | cache `MatchFacts`; `rollup(allFacts, filter)` |
| `scoreAttributes(counters, careers)` | `attributes(summary, baselines)` |
| `SUBSTATS`, `METRICS` from `metrics.ts` and `hltv.ts` | `METRICS` (one list; `hltv` holds HLTV's name) |
| `deriveRole(counters)` | `roleBlend(summary, side)` |
| `AimAgg`, `aimVisibility` | `summary.aim` and the aim metrics; visibility is per match: `facts.match.visibility === "ok"`; the coverage meter is `visibilityCoverage(summary.aim)` |
| `PosAgg` heatmaps | `rollup(...).presence[map]`; "where you spent the round" is `roundPlaces(tables, round, steamid)`; kill and death spots from `facts.kills` (`kpos`, `vpos`) |
| The interim hit map | `Summary.weapons[gun].groups` by `HIT_GROUPS` |
| `MatchView.econ` saves, win rates, matchups | `economyOf(facts, team)` |
| `roundSlice` in the round drawer | `rollup([facts], { player, rounds: [n] })` |
| KAST split (kill, survived, traded) | `killRounds`, `kastA`, `kastS`, `kastT` partition `kast` |
| `MatchView.human` | `facts.match.pov` (the recording player's steamid) |

## Gaps in the inputs

- Demos recorded from round 1 already live have no round 1 rows in `player_rounds`. Derive then takes
  round 1 sides from team names. HLTV's ADR differs on those ten demos, so they stay out of the gate.
- `params.json` has no equipment bands for the duel groups of players without a primary; `rating3.ts`
  keeps them with their derivation until it does.
- The extractor ships no nav mesh, so path efficiency is unavailable.
- Plugin recordings carry no purchases, so utility bought (`utilSpentPR`) is measured on extracted
  demos only; its denominator counts only rounds with the purchases table.
