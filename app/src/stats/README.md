# Stats engine

Pure TypeScript, no UI dependency. Its only input is a match's tables, schema v1
(`extractor/SCHEMA-v1.md` on branch `feat/extractor-v1`). The same code runs in the app and in the
Node tools that build the pro baselines.

## Progress

| Phase | State |
|---|---|
| Loader (`load.ts`, hyparquet) | done; reads v1 folders and pre-v1 folders |
| Scoreboard on tables, HLTV gate | done: K 440/440, D 438/440, KAST 411/440, ADR 398/440 within 0.5 on 44 maps; 16 maps exact for every player (`hltv-exact.test.ts`) |
| Port of the other families | not started |
| Plugin adapter, delete the plugin-JSON path | not started |
| Baselines CLI | not started |
| New families | not started |

The old engine is in `legacy/` until every family is ported, then it goes.

## Pipeline

```
read(name) -> loadTables -> MatchTables -> derive -> MatchFacts -> rollup(facts[], filter) -> Summary
```

| Call | Returns | Notes |
|---|---|---|
| `loadTables(read)` (`load.ts`) | `MatchTables` | `read(fileName)` returns the file's bytes or null. Missing required tables or columns throw `TableError` naming them. |
| `derive(tables)` (`derive.ts`) | `MatchFacts` | One record per round, per player-round and per kill. Plain JSON, safe to cache; `DERIVE_VERSION` changes when a definition does. |
| `rollup(facts[], filter)` (`rollup.ts`) | `Summary` | Sums one player's player-round measures over the rounds a filter keeps: sides, own and opponent buy class, maps, date range, opponent teams. |

`SCHEMA` in `tables.ts` lists every column the engine reads, and the loader decodes only those.
Steamids come out as strings because they exceed 2^53.

## Scoreboard definitions

HLTV publishes none of these. Each was found by scoring candidate definitions against HLTV's per-map
scoreboards on 44 pro maps; the numbers are in `VALIDATION.md` (to come) and the scripts in
`tools/hltv-check.ts`.

- **Kills** count when killer and victim were on different sides at the kill, including kills after
  the round ended.
- **Deaths** count every cause except a suicide after the round ended.
- **ADR** sums each hit's reported damage capped at the victim's health before it, not the health
  lost: the hurt event drops fractional damage, and HLTV uses the event's number.
- **KAST** is a kill, a damage assist (CS2's named assister, flash assists left out), survival, or a
  traded death.
- **Trades.** A kill trades one death: the earliest teammate the victim killed within 5.4 s.
- **Buy class** is HLTV's PISTOL, ECO, HALF, FULL, by team equipment at freeze end: under $1,000 per
  player is an eco, $3,250 or more a full buy.

## Known gaps in the tables

- Ten pro demos start with round 1 already live, so `player_rounds` has no round 1 rows. Derive then
  takes round 1 sides from team names. HLTV's ADR differs on those demos by up to 6 per round in both
  directions while kills still match, so they stay out of the gate.
