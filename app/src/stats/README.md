# Stats engine

Everything here is pure TypeScript with no UI dependency. The worker calls `deriveMatch` once per match file and `buildProfile` over cached summaries; the UI reads the plain objects they return. Match files are described in `SCHEMA.md` at the repo root.

## Entry points

| Call | Returns | Use |
|---|---|---|
| `decodeMatch(bytes, name)` (`decode.ts`) | `MatchFile` | gzip or plain JSON to a validated file |
| `deriveMatch(m, file, model?)` (`derive.ts`) | `MatchView` | the match page, cached by the worker |
| `summarize(view)` | `MatchSummary` | the match list and profile cache |
| `buildProfile(summaries, filter?)` (`profile.ts`) | `ProfileView` | the profile page |

`model` is the win-probability model (`winprob.ts`): `modelFromModule(winProbabilityCT)` when the trained model is bundled, else `stubModel`. Swing, the win-probability path and Rating 3.0's swing input need it.

## What `MatchView` holds

Existing fields are unchanged. New ones:

| Field | Type | Module |
|---|---|---|
| `players[pi].rating3` | `Rating3` | `rating3.ts` |
| `players[pi].role` | `Role` (this match only) | `role.ts` |
| `players[pi].c.r3`, `.c.role`, `.c.hl` | additive inputs for the three above and the sub-stats | |
| `roundDetails` | `RoundDetail[]`, one per round | `rounds.ts` |
| `econ` | `EconomyView` | `economy.ts` |
| `aim.visibility` | `VisibilityEvidence \| null` | `visibility.ts` |

`ProfileView` gains `rating3` and `role` (from summed counters), and each `FormPoint` gains `rating3`. `MatchSummary.human.rating3` is the match's value.

## Round inspector: `RoundDetail` (`rounds.ts`)

One entry per round, including rounds without the kill log (`captured: false`); those carry the game's totals when the file has them (`lite: true`) and nulls otherwise.

- **Round:** `winSide`, `how` (win type: `elim`, `defuse`, `time`, `bomb`), `winner` (`us`/`them`), `scoreBefore`, `scoreAfter`, `durSecs`, `bomb` (`site`, `plantSecs`, `planter`, `defuser`, `defused`, `exploded`).
- **`teams.t` / `teams.ct`:** `team`, `players`, `equip` and `money` (sums at freeze end), `spent`, `buy` (`BuyClass`), `won`, `aliveEnd`, `saves` (players who kept a primary in a lost round).
- **`players[pi]`** (`PlayerRound`, null when the player had no side):
  - `k`, `d`, `a`, `hsKills`, `flashAssists`.
  - `kills`: `KillEvent[]` with `weapon`, `headshot`, `wallbang`, `throughSmoke`, `noscope`, `inAir`, `killerBlind`, `tradeKill` and `opening`. `death` is the `KillEvent` that killed the player, with `killer`, `weapon` and `traded`.
  - `dmg`, `dmgTaken`, `teamDmg`, `utilDmg`, and `swing` (win-probability points; null when unknown).
  - `equip`, `equipEnd`, `money`, `spent`, `utilSpent` and `buy`.
  - `utilThrown` (`he`, `flash`, `smoke`, `molotov`, `decoy`), `enemiesFlashed`, `enemyBlindSecs` and `teamFlashSecs`.
  - `survived`, `traded`, `kast`, `saved` and `clutch`.
- **`winProb`:** `WinProbPoint[]`, P(CT wins) at the start, after each kill (with `before`), at the plant, and at the end (0 or 1). Kill points reuse the swing's own values. Null without the kill log or when the model cannot value a state.
- **`human`** (plugin files only): `shots`, `hits`, `headHits`, `accuracy`, `firstOnTarget`, `firstHits`, `firstAccuracy`, the `ttdMs`, `reactMs` and `xhairDeg` samples, and `spray` (bursts of 2+ bullets with impact and aim error per bullet, in degrees). The three timing arrays are gated like `aim.validated`; see Visibility.

`spent` is an estimate: freeze-end equipment minus what the player carried in (last round's `equipEnd`, or the $200 starting pistol after a death or at a half start). A weapon dropped for a teammate moves value between players, so team totals are firmer than per-player values. It is null for files without `equipEnd` (before plugin 1.0.0).

Per-round values sum to the match counters (kills, deaths, assists, damage, headshots, KAST, utility damage, flash assists, saves, swing) on all six fixtures; `rounds.test.ts` checks this.

## Economy (`economy.ts`)

- `BUY_CLASSES = ["pistol", "eco", "force", "full"]`. `classifyBuy(perPlayer, pistolRound)`: the first round of each regulation half is `pistol`; otherwise $1,000 or less per player is `eco`, $4,000 or more is `full`, and anything between is `force`. These follow the bands of HLTV's match economy tab as I recall them ($5k and $20k for a team of five). They have not been checked against HLTV.
- `teamBuyClass(ctx, ri, side)`, `isPistolRound(ri, maxrounds)`.
- `economyView(details)` returns `EconomyView`:
  - `rounds`: per round, `us` and `them` with `buy`, `equip`, `money`, `spent`, `saves` and `savedValue`. These are the money and equipment curves.
  - `winRate.us` and `winRate.them`: rounds and wins by own buy class.
  - `matchup[ours][theirs]`: rounds and our wins.
  - `saves` per team, and `unknown` (rounds with an unclassified buy).
- CS Demo Manager's five-way `BUY_TYPES` and `MatchView.economy` are unchanged.

## Visibility (`visibility.ts`)

The plugin stores the victim's spotted mask at every hit by the human (`aim.hitMask`). A bullet hit means the human could see the victim, so the right bit should be set on almost every row. Hits per candidate bit over the three plugin recordings (93 bullet hits of 104 rows; 11 were grenade or fire damage):

| Candidate | Hits called visible |
|---|---:|
| human's slot, word 0 (what the plugin reads) | 53 |
| controller entity index (= slot + 1) | 0 |
| slot − 1 | 0 |
| pawn entity index (303, outside the 64-bit mask) | 0 |
| slot in word 1 | 0 |
| any bit set (`m_bSpotted`) | 57 |

Every set bit in all 104 rows is the slot of a player on the human's team (`foreignBits` 0), so the slot mapping is right. The mask itself is not line of sight: it is off for 40 of 93 hits, for 21 of those 40 the victim never shows as spotted to the human that round, and in 24 of 61 engagements the human was already shooting at the enemy (10 of 61: already damaging) before the engagement started. Time to damage, reaction time and crosshair placement would start late and miss encounters, so they stay gated.

- `visibilityVerdict(evidence)` opens the gate when the slot bit and the engagements each cover at least `VISIBILITY_MIN_COVERAGE` (90%) of bullet hits. Files without hit masks fall back to the plugin's `env.visibilityValidated` flag.
- `aimVisibility(aim)` returns `{ validated, hitCoverage, engagementCoverage, reason }`. Use `reason` as the "Validating" tooltip.
- A fix needs the plugin: a ray trace from the human's eye to the enemy instead of the spotted mask. The hit test will then report the new coverage.

## Rating 3.0 (approx.) (`rating3.ts`)

Show it as `RATING3_LABEL` ("Rating 3.0 (approx.)"). Rating 2.0 (`rating.ts`, `PlayerRow.rating`) is unchanged.

- `rating3(inputs, params?)` returns `{ label, value, calibrated, source, features }`, where `features` holds the six inputs actually used (`kpr`, `adr`, `dpr`, `kast` %, `mk` %, `swing` % per round). Inputs cover rounds with the kill log only.
- **Uncalibrated for now.** `R3_PARAMS` is `FITTED_R3` from `rating3-params.ts` when the fit has run, else `DEFAULT_R3`. The default restates Rating 2.0's approximation weights on these inputs, with multi-kill and swing at 0. Show `calibrated: false` and `source` to the user.
- **Economy groups:** `weaponGroup(name)`, `groupFromEquip(net)` and `inferGroup(seen, equipNet)` give one of `ECO_GROUPS` (sniper, tier-1 rifle, tier-2 rifle, SMG/shotgun, upgraded pistol, starter pistol). A primary the player was seen using that round decides. Otherwise the stronger of a seen pistol and the freeze-end equipment band (grenades removed when logged) decides. Armor alone lifts a starter pistol to "upgraded pistol".
- **Duel table:** `duelWinProb(killerGroup, victimGroup, killerSide)` and `duelTable()`. This is a Bradley–Terry table that reproduces HLTV's four published anchors: T rifle vs CT rifle 48%, rifle vs starter pistol 75%, AWP vs rifle 56% as T and 60% as CT.
  - Tier-2 rifle (0.83) and upgraded pistol (0.29) were fitted with `fitDuelStrengths` on our 8 matches (875 kills).
  - The same fit put SMG at 1.20, above tier-1 rifles, from 132 bot duels. That breaks the group order, so SMG is the midpoint of its neighbours (0.56).
  - The CS2RB training data is no longer on disk.
- **Kill points:** `killPoints(a, b, side)` = 2.14 × (1 − P(killer wins)). A death is charged the same value, and damage is weighted the same way. On the plugin recordings the average kill is worth between 0.9 and 1.1.
- **Eco KAST and eco multi-kill:** a KAST round counts the value of the event that earned it, at most 1. Survival and traded deaths count 1. A multi-kill round counts its mean kill value, at most 1. These two are my definitions; HLTV has not published its own.
- **Swing:** each kill's change in win probability goes 50% to the final damage and 10% to a flash assister. The rest is shared by damage among the killer and players with 40+ damage. A traded death is charged 75%. `DEFAULT_SPLIT` holds these numbers; there is no evidence for them yet.
- `R3Inputs` also counts `assists40`, `tradeDenials` (a kill less than 5 s after the same player's previous kill) and `failedTrades` (dying less than 5 s after a teammate, to the same killer).

### Fitting

```
cd model
python -I fit_rating3.py --self-test                # recovers known weights from synthetic players
python -I fit_rating3.py hltv_players.csv           # report: R², adj. R², MAE, RMSE, 10-fold CV MAE, weights ± SE
python -I fit_rating3.py hltv_players.csv --write   # also writes app/src/stats/rating3-params.ts
```

The CSV needs `rating, kpr, adr, dpr, kast, mk, swing`. The eco-adjusted columns `kpr_eco, adr_eco, dpr_eco, kast_eco, mk_eco` are optional. `kast`, `mk` and `swing` are in percent. The script fits both feature sets and keeps the one with the lower cross-validated MAE.

## Role (`role.ts`)

`deriveRole(counters)` returns `{ primary, flavour, label, provisional, evidence, flavours }`. Every threshold is an exported constant, chosen by hand with no fit behind it:

| Role | Rule |
|---|---|
| AWPer | sniper kills ≥ 35% of kills (`AWPER_MIN_SNIPER_SHARE`) |
| Entry | opening attempts ≥ 25% of rounds (the average is 20%) |
| Support | (trade kills + assists) / (kills + assists) ≥ 45% |
| Lurker | mean distance to the nearest living T teammate before the plant ≥ 1,100 units |
| Anchor | on A or B with at most one teammate, 15 s after freeze end, in ≥ 50% of CT rounds |

A Rifler gets the qualifying flavour with the highest value / threshold. `flavours` lists every score, and a score is null when its data is missing; Lurker and Anchor need positions from plugin files on de_dust2. The role is `provisional` under 20 rounds.

## Sub-stats under HLTV's names (`hltv.ts`)

`SUBSTATS` lists every sub-stat with `{ id, name, status, def, fmt, value(counters) }`. `status` is one of:

- **exact:** a direct count with a clear definition.
- **approx:** our reading of HLTV's description, or a window or distance we chose. `def` says which.
- **unavailable:** the files lack the data.

New counts (`HltvCounts`, from `hltvCounts`): Round win shares (share of the winners' positive swing), Perfect kills (the victim had not hurt the killer), First duel rank and time, Tradeable deaths and Trade opportunities (a teammate within `TRADE_DISTANCE`, 1,000 units; positions needed), and Weapon attacks (gun hits per round; misses are only recorded for the human). Trade denials, Failed trades, Bait assists and kills, Clutches per 24, the eco-adjusted KPR and ADR, and HLTV's attribute sub-stats are in the same list. Utility success is marked unavailable.

## Changes to existing outputs

- **Swing on plugin 1.0.0 files** (`swing.ts`, `DERIVE_VERSION` 7). The plugin writes the victim into `kills.state` with its HP before the fatal hit; the converter and the synthetic generator write 0. The app used to leave HP unchanged after a kill, so every after-kill state held more HP than the living players could, the model rejected it, and swing was unknown for all 48 plugin rounds. The victim's HP now comes off its side for plugin files (`VICTIM_AT_ZERO_HP_WRITERS` lists the writers that already zero it). Converted and synthetic files give the same numbers as before. `plugin.test.ts` covers this.
- **`aim.validated`** now comes from the hit test whenever a file has hit masks, rather than from `env.visibilityValidated`. For the current plugin files both are false, so nothing shown changes.
