# Rating 3.02 reference specification

This document describes the public approximation and the private research outputs that support it. The production engine reads `params.json`; Python fits coefficients and validates hypotheses. No Python research model is a second production implementation.

## Reproducibility

The commands below run from the repository root in isolated Python mode; `<cs2-stats-data>` is the private data root. They are the producers for the counts and metrics retained in this specification.

### Strict joins

```text
model\.venv\Scripts\python.exe -I model\rating3\join_demos.py --data <cs2-stats-data> --metrics <cs2-stats-data>\model-rating3\winprob_metrics.json --out <cs2-stats-data>\model-rating3\demo_joins.json
```

### Win-probability lookup

```text
model\.venv\Scripts\python.exe -I model\rating3\winprob_fit.py --data <cs2-stats-data>\hltv
```

### Post-plant analysis

```text
model\.venv\Scripts\python.exe -I model\rating3\postplant_analysis.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\postplant_metrics.json
```

### Demo-round probe

```text
model\.venv\Scripts\python.exe -I model\rating3\demo_round_fit.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\demo_round_metrics.json
```

### Swing and duel fits

```text
model\.venv\Scripts\python.exe -I model\rating3\swing_fit.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\swing_metrics.json
```

```text
model\.venv\Scripts\python.exe -I model\rating3\eco_fit.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\eco_metrics.json
```

### Engine rows for the swing and rating fits

`pnpm rating-dump` (in `app/`) writes the engine's per-round rows, kills, hits, win-probability paths and each map's join record for every pro map joined to HLTV into `<cs2-stats-data>\model-rating3\rating-*.private.jsonl`. `fit_params.py` reads them through `swing_credit_fit.py` and `eco_fit.py`, so run the dump first.

```text
model\.venv\Scripts\python.exe -I model\rating3\swing_credit_fit.py --data <cs2-stats-data> --out <cs2-stats-data>\model-rating3\swing_credit_metrics.json
```

### Shipped fit

```text
model\.venv\Scripts\python.exe -I model\rating3\fit_params.py --data <cs2-stats-data> --hltv <cs2-stats-data>\hltv --joins <cs2-stats-data>\model-rating3\demo_joins.json --out model\rating3\params.json --date 2026-10-28
```

### Held-out hypothesis fits

```text
model\.venv\Scripts\python.exe -I model\rating3\hypothesis_fit.py --hltv <cs2-stats-data>\hltv --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --demo-metrics <cs2-stats-data>\model-rating3\demo_round_metrics.json --out <cs2-stats-data>\model-rating3\hypothesis_metrics.json
```

## Data contract

HLTV map files with `v: 3` provide the rating and graph targets. The graph target uses the full-precision `performance.rounds.*.events[].y`; display-rounded team text is not used for fitting.

A strict demo join requires the map, archive date and every round winner to agree, and one pairing of the demo's players with HLTV's players to hold across every enemy kill in order (killer and victim), keep each team together, and give every player HLTV's kill count. Players are matched by what they did, not by name: an in-game name often differs from HLTV's. Names, then SteamID to HLTV player id pairs learned from earlier joins (`<cs2-stats-data>\model-rating3\player_ids.private.json`, which `join_demos.py` updates with every accepted map), only place players with no kill or death, and only when one pairing is left. HLTV's deaths and assists are not compared: its deaths leave out some world and bomb deaths but not others, and its assists are not the game's (on the 304 maps the name join accepted, deaths matched for 94% of players, assists for 63%, kills for all 3,040). Kills after the demo round end are excluded from the sequences because the HLTV event graph stops at round end; they count toward the kill totals, as on HLTV's scoreboard. A map whose `match.extra` names its HLTV match (a loose OpenCS2 demo) is joined only to that match's map of the same name; with no saved scoreboard for it, it is rejected as `HLTV scoreboard not captured`, never joined by date. The archive-date window is for maps without an id, which on 2026-10-27 is every published map (`joined_by_hltv_match` and `joined_by_date_window` in the counts). On that path a candidate is refused if its pairing puts a SteamID on another HLTV player id than an earlier join paired it with (`player_ids.private.json`); learned pairs only narrow this path. The residual: a map without an id whose own scoreboard was never saved is accepted against another HLTV page within 36 hours that has the same rosters under one pairing, every round winner and every enemy kill (killer and victim) in order, when no learned pair contradicts it. Two such pages would describe the same game, so the join treats them as one; the guard rejected none of the 565 maps on 2026-10-27. Each accepted join records its pairing (`players`), and the fits that read players (`swing_fit.py`, `demo_round_fit.py`, `eco_fit.py`, `postplant_analysis.py`) take them from it through `join_demos.joined_players`, not by in-game name; a join file without pairings fails loudly. On the data of 2026-10-27 the structural join accepts 567 maps where the name join accepted 440, rejecting none it accepted and moving none to another HLTV map; 198 players in them play under another name than HLTV's. Each HLTV map (`mapstatsid`) is joined to one published map at most: of several, the newest extraction is kept, the first by folder when versions are equal, and the others are listed under `duplicates`. One archive published under two slugs (`astralis-vs-alliance-2029146f` and `-a7ac677d`) had both copies joined to the same two HLTV maps, so 565 of the 567 remain. On the 440 maps both accept, the fits get the same rows as before; the 127 added maps add 23,549 swing events, 18,443 duel events, 3,810 duel targets and 27,630 player-round rows. The current join command produces **304 accepted joins, 185 rejected folders, 6,630 joined rounds, and 43,138 joined enemy kills** in `demo_joins.json`. Fourteen previously accepted demo inputs remain unavailable after the extractor refresh; the stale 318-join result is retained only where it is explicitly identified as historical below.

The shared resolver accepts flat legacy `meta.parquet`/`economy.parquet` folders and versioned schema-v1 folders selected by `CURRENT`. A current version is usable only when its `COMPLETE` filename-to-size manifest matches every listed file; incomplete versions are skipped by discovery, and an unsupported resolved folder fails loudly. The joiner stores join references and checks, not player identities or derived tables in the public repository.

## Win probability

The private lookup uses the most specific available state table. Its selected model includes `last_kill_side` in addition to map, alive counts, plant state, and round-start buy labels. Terminal bomb outcomes return the terminal winner; unknown states are an error during strict validation and `null` in a general engine adapter. The public `params.json` contains only the preferred private-pack path and the existing fallback model path; it does not contain the lookup.

The current lookup fit contains **135,628 events across 503 matches**. On its chronological test split, the selected `last_kill_side` model has **20,235 events**, **0.15259069454690377 percentage-point MAE** overall, and **0.0018920528807220588 percentage-point MAE over 15,064 pre-plant events**. The lookup remains approximate: post-plant timing is not fully identified.

Those values come from the win-probability command above and `<cs2-stats-data>\model-rating3\winprob_metrics.json`.

The separate post-plant join analysis produces **13,577 aligned event rows over 3,550 rounds**; **9,115 events change after the plant**. This is evidence that post-plant graph values continue to move, not a validated defuse-time threshold. Those values come from the post-plant command above and `postplant_metrics.json`.

## Swing credits

For a valued event, `delta` is the change in the probability of the side helped by the event. HLTV's map page lists every player's credit for every kill to 0.01 percentage points, so the split is fitted to those credits (`swing_credit_fit.py`, 196,022 kills of the 1,610 joined maps with a change of at least 2 points; the fit of 2026-10-25 had 45,034).

A kill's gain is shared among the gaining side by weight:

- each player weighs the HP-capped damage they did to the victim this round (team, self and unattributed damage excluded);
- the killer adds the kill weight, 57.14;
- the earliest teammate the victim killed within 5.5 s before adds the trade weight, 100;
- each enemy flasher whose flash was still blinding the victim adds the flash weight, 28.57.

The victim is charged the whole change, unless the same killer kills a teammate of the victim within 5.5 s after. In that case the charge is split 0.682 to the victim and 0.318 to that teammate, a failed trade. A plant is shared like the round's earlier events that moved the round the same way, each in proportion to its own change; with no such event, each side's living players share it equally. This reproduces 2,922 of 3,144 plants exactly in a sample of 300 maps.

The round's end is shared by how it ended:

- A defuse: the defuser takes the defuse share, 0.50, and the winners' positive credits from the events after the plant that moved the round their way take the rest. The losers alive at the plant share the charge equally (90% of their charges exact). The share is fitted on 8,832 defuses with such events, from every saved HLTV page. On five folds grouped by match, the held-out credit MAE is 0.245 points at 0.50 and 0.268 at 0.60, which the fit of 2026-10-25 picked from 1,903 defuses. 0.50 is better on all five folds, by 0.023 on average, against a fold-to-fold SD of 0.012, and a grid fit on each fold's training defuses picks 0.50.
- A detonation: the winners' positive credits from the events after the plant take it all, else the winners alive share it equally; the losers alive share the charge equally. Replaying the events after the plant cuts the winners' credit error from 1.12 to 0.63 points against an equal split.
- The clock running out: each side's living players share it equally. HLTV's split among the winners is not recovered.
- What an elimination leaves replays the round's events.

The weights are 400/7, 100, 200/7 and 1500/7 : 100 to within the fit's noise. On kills without a flash, 97.1% of HLTV's credits are reproduced to 0.01 points (68,155 credits, MAE 0.067 points). The flash weight comes from 3,021 kills with exactly one credited player outside the damage ledger and the trade candidates; its interquartile range is 28.53 to 28.61. The 5.5 s window gives a lower credit error than 5.0, 5.25, 5.75 or 6.0 s.

Against HLTV's per-round swing on 80,950 player-rounds, the engine's error falls from 3.25 to 1.10 points per round, and exact rounds rise from 28% to 73%. Of the kills, 97% have the same change in probability as HLTV's lookup, so most of the remaining error is in events whose probability change differs and in the winners' split at a detonation or time-out.

## Economy adjustment

The duel fit groups weapons as `sniper`, `rifle1`, `rifle2`, `smg`, `pistolPlus`, and `pistol`, strongest first. It fits fractional kill and death points, through a Bradley-Terry-style probability and a side edge, so that the eco inputs the app computes from them (eKPR, eDPR, eADR and eKAST) match HLTV's eco-adjusted cells. Published anchors remain marked as published in `params.json`; fit-derived strengths and scale remain marked as fit-derived.

The shipped duel block is the fit of 2026-10-28. It consumes **1,610 joins** (**1,609 schema-v1**, **1 legacy**) with no skipped joins: **229,584 duel events** and **16,100 HLTV target rows**, one per player-map, from **885 matches**. For each player-map `eco_fit.py` computes the four eco inputs as `rating3.ts` does, from the rating dump's kills, assists, hits and player-rounds, over the rated rounds of the sides the app rates. It weighs each input's error by the slope of that input's rating curve at HLTV's value, so every error is in rating points, and keeps the four errors as separate residuals, so the fit cannot buy one input's accuracy with another's error. The fitted strengths are `sniper=0.9500559845418323`, `rifle1=0.7985820449728466`, `rifle2=0.6690949952077244`, `smg=0.5305667431230878`, `pistolPlus=0.14287245058373932` and `pistol=0`; the kill-points scale is **2.0602307711490817**, and the side edge stays the published one. Full-fit objective MAE is **0.01086** rating points. Match-disjoint held-out error (five folds grouped by match) is **MAE 0.01086**, **p95 0.0311** and **maximum 0.147**; per input it is 0.0236 eKPR, 0.0303 eDPR, 1.53 eADR and 4.14 eKAST. The no-duel baseline, each input at its training-fold mean, has held-out **MAE 0.0492** in the same units. These values come from `eco_fit.py`.

`pnpm rating-check` scores the engine's rating against HLTV's displayed rating on all 1,610 joined maps (16,100 player-maps). Each row is one duel block, with the rest of `params.json` as shipped:

| duel block | rating MAE | rating r | mean (HLTV 1.088) | eKPR MAE | eDPR MAE | eADR MAE | eKAST MAE |
|---|---|---|---|---|---|---|---|
| fit of 2026-10-25 (before) | 0.0428 | 0.9901 | 1.102 | 0.0292 | 0.0363 | 1.92 | 3.89 |
| **fit of 2026-10-28, eKAST fitted (shipped)** | **0.0421** | 0.9913 | 1.109 | 0.0236 | 0.0303 | 1.53 | 4.14 |
| the same, with the side edge fitted too (0.014) | 0.0417 | 0.9914 | 1.108 | 0.0226 | 0.0308 | 1.36 | 4.04 |
| the same, without eKAST | 0.0448 | 0.9916 | 1.117 | 0.0197 | 0.0256 | 1.86 | 4.74 |
| eKPR, eDPR and eADR at fixed weights, the app's groups | 0.0454 | 0.9916 | 1.118 | 0.0198 | 0.0248 | 1.92 | 4.78 |
| the same, `eco_fit`'s own weapon groups | 0.0466 | 0.9910 | 1.117 | 0.0242 | 0.0254 | 2.04 | 4.46 |
| fitted to the rating's own error (diagnostic) | 0.0374 | 0.9916 | 1.090 | 0.0356 | 0.0552 | 2.96 | 3.79 |

Fitting eKAST is what lets a refit beat the old block. Without it the strengths grow until eco kills and assists are worth more than HLTV's eKAST allows, and the rating runs high (fourth and fifth rows). With the side edge fitted as well, the edge falls from the published 0.080 to 0.014 for 0.0004 less error; the shipped block keeps the published edge. The last row fits the duel block to the rating's error itself. It is more accurate only because it pulls eKPR, eDPR and eADR well under HLTV's, letting one input's error offset another's, so it does not ship.

Held out by match, the shipped fit also rates better. Fitted on four of five match-disjoint folds and rated on the fifth, its rating MAE averages 0.0422 against the old block's 0.0428, and it is lower on every fold. This comes from a Python re-implementation of `pnpm rating-check` that reproduces its numbers to the fourth decimal on every block in the table; it is not in the repository.

The shipped params' mean bias, +0.021 (1.109 against 1.088), comes from the eco inputs. With the engine's inputs against HLTV's times each curve's slope at HLTV's mean: eco deaths 0.027 a round under HLTV's add +0.010, eco KAST 2.3 points over adds +0.009, eKPR takes off 0.002 and eADR adds 0.001, and the curves' bends make up the rest. The eco-death gap is structural. Every eco kill is charged to its victim as an eco death of the same value, so the engine's eKPR and eDPR always share a mean (0.661), while HLTV's eco deaths average 0.022 a round more than its eco kills (0.688 against 0.666). No duel block closes that gap.

## Shipped approximation

HLTV's map total equals the round-weighted mean of its CT and T ratings to display rounding (MAE 0.0035 over 7,330 player-maps), so the model rates each side and averages. One side's rating is

```text
intercept + ct_offset * [CT] + curve(eKPR) + curve(eADR) + curve(eDPR) + curve(eKAST) + curve(Swing)
          + w2 * K2 + w3 * K3 + w4 * K4 + w5 * K5
```

Each curve is piecewise linear: a slope, plus a change of slope at six knots placed at the 5th to 95th percentiles of the training inputs. K2 to K5 are the shares of the side's rounds with exactly two, three or four kills, and five. The curves bend upward for every positive input, which a straight line cannot follow. On HLTV's own displayed inputs, a linear model leaves held-out MAE 0.047, and the curves reach 0.025.

The fit (`side_rating_fit.py`, weighted by side rounds) uses 3,430 HLTV maps, 1,525 matches and 68,598 player-map sides: the HLTV tab's pages and those saved for the OpenCS2 demos (`hltv_pages.py`, one per `mapstatsid`). The held-out split is by event and date. The 22 latest events by first map date (871 maps, 14 to 26 October) are held out, and the other 2,559 maps are fitted. On HLTV's displayed inputs, the held-out total rating has MAE 0.0254, p95 0.0636 and 25.0% within 0.01; the training maps have MAE 0.0254. On the 616 of those maps saved after the fit of 2026-10-25, which neither fit saw, that fit (733 maps) has MAE 0.02587 and this one 0.02581: four times the maps barely move the block, whose error is the formula's, not the sample's. The shipped coefficients are refitted on all maps. The block is labelled `approximation`, because this is not a recovered HLTV formula.

The engine rates a round by its side's split: each curve's value at the side's inputs, plus the curve's slope there times how far the round's input is from them. These average over the side's rated rounds to the side's rating exactly.

## Demo-round probe

The demo-round probe uses strict joins and fits research-only round models. The current run produces **66,300 player-round rows** and **9,060 total/CT/T equations**. Its final `side_identity_expanded_interactions` stage has **MAE 0.06305474113300961**, **p95 0.16687552328770758**, **maximum error 1.6084772348686291**, and **correlation 0.9837171294075339**. This is not a production fit and no demo-derived coefficients are accepted into `params.json`.

These values come from the demo-round command above and `demo_round_metrics.json`.

## Held-out structural hypotheses

`hypothesis_fit.py` uses five outer `GroupKFold` splits by match and three inner grouped splits to select Ridge alpha. The match grouping prevents maps from the same match appearing in different outer folds. The fit uses the current HLTV set and current strict joins.

| Hypothesis | Rows | Matches | Held-out MAE | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Displayed eco baseline | 7,330 | 503 | 0.046193640980563715 | 0.11843299347110106 | 0.4556835305654009 |
| All map features plus CT/T | 7,330 | 503 | 0.03878783710901304 | 0.10004827514472744 | 0.28515025855072607 |
| All map features plus CT/T and exact demo | 3,020 | 161 | 0.0345957065705249 | 0.09227092820783779 | 0.23073380994966453 |

The strongest all-map hypothesis adds displayed traditional scoreboard columns, result-conditioned and nonlinear terms, and displayed CT/T features. The strongest joined-demo hypothesis adds exact demo damage, actions, outcomes, equipment interactions, and side features. Neither is accepted as the production formula: the demo model covers only the joined subset, and both remain well above the display-level target.

These values come from the hypothesis command above and `hypothesis_metrics.json`. The complete tested hypothesis set remains in that private report.

## Open conclusions

The current evidence supports a per-side curved approximation, a fitted Swing kill split and a private approximate win-probability pack. It does not identify HLTV's exact Rating 3.02 formula, the full eKAST transformation, the complete economy function, or the winners' split of a detonation or time-out.

eKAST: a survived lost round (a save) weighs 0.007 in HLTV's side eKAST, and a survived won round weighs 1.07 (a regression over 7,060 joined player-map sides). The engine now counts survival only in won rounds and values kills and assists at their uncapped eco value. That takes the engine's side eKAST error from 6.58 to 5.20 points. The rest remains unexplained: weighting KAST rounds by the team's round-start win probability, by buy class or by side does not close it. Those unresolved parts remain explicit in `params.json` and are not replaced with unmeasured constants.
