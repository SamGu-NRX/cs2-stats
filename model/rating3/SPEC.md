# Rating 3.02 reference specification

This document describes the shipped approximation and the research model around it. The shipped implementation belongs in TypeScript and must read `params.json`. Python fits coefficients and checks the implementation; it is not a second production model.

## Data contract

HLTV map files with `v: 3` provide the target. Probability targets use the full-precision `performance.rounds.*.events[].y`. For a round whose graph lists team 1 as T, `y` is P(T wins). For a CT-first round, the target is `1 - y` when the engine wants P(T wins). The stream's `teams` text is display-rounded and is not used for fitting.

A demo join is valid only when map, archive date, both five-player rosters, every round winner, and every enemy kill sequence up to the demo round end agree. Kills after `rounds.end_tick` are excluded because HLTV's event graph stops at round end. The current strict join set is 220 maps, 4,818 rounds, and 31,214 enemy kills; 59 additional current demo folders have no exact HLTV join. The joiner accepts both legacy `meta.parquet` and schema-v1 `match.parquet` outputs.

## Win probability

The fitted lookup stores a list of tables in descending specificity. A table key concatenates its listed fields with `|`. Use the first table containing the key.

The selected table uses these levels:

1. `map, alive_t, alive_ct, planted, buy_t, buy_ct, last_kill_side`
2. `alive_t, alive_ct, planted, buy_t, buy_ct, last_kill_side`
3. `map, alive_t, alive_ct, planted, buy_t, buy_ct`
4. `alive_t, alive_ct, planted, buy_t, buy_ct`
5. `map, alive_t, alive_ct, planted, last_kill_side`
6. `alive_t, alive_ct, planted, last_kill_side`
7. `map, alive_t, alive_ct, planted`
8. `alive_t, alive_ct, planted`

Each cell stores the median observed P(T wins) and its count. `last_kill_side` is `t`, `ct`, or `none`. A `kill.svg`, `ct_win.svg`, or `t_win.svg` event updates it from the event badge. `bombplant.svg` changes `planted` to 1. `bomb_exploded.svg` ends the round for T. `bomb_defused.svg` and `stopwatch.svg` end it for CT. A `ct_win.svg` or `t_win.svg` icon is an elimination/suicide event, not a round end by itself.

Equipment is represented by HLTV's round-start buy labels: `PISTOL`, `ECO`, `HALF`, and `FULL`. A terminal event returns the terminal winner exactly. An unknown state is an error in strict validation and `null` in a general engine adapter. Do not infer a terminal winner from alive counts alone after a bomb plant.

On a chronological 70/15/15 match split, the approximate selected lookup has 0.153 pp test MAE over 20,235 events and 0.160 pp over non-terminal events. Pre-plant MAE is 0.0019 pp. Post-plant timing is still open. The current valid joins provide 1,311 aligned post-plant events across 350 rounds. They are consistent with the nominal 10-second no-kit and 5-second kit defuse limits, but kills can still change elimination probability after defusing becomes impossible, so a threshold cannot be claimed from zero deltas alone.

## Swing credits

For a valued event, let `delta` be the change in the probability of the side that benefits from the event. A kill's victim receives `-delta`. Positive credit is allocated on the killer's side.

The recovered event rule is:

1. If the event is an unpreventable post-bomb kill, `delta = 0`.
2. Build the damage ledger from enemy damage to the victim at or before the kill. Use HP-capped damage, not weapon damage overkill. Exclude team damage and self damage.
3. Add a flash-assist candidate when the demo records an enemy flash that was active on the victim at the kill, excluding the killer, team flashes, and ambiguous flashes.
4. When there is no flash candidate, positive credit follows the damage ledger. If the ledger is empty, the killer receives all positive credit.
5. When a flash candidate exists, reserve the recovered flash share first. The remaining credit follows the damage ledger. A no-damage, one-flash case is about 0.846 killer and 0.154 flash assister. The exact flash amount varies in the current evidence and must not be replaced by an unmeasured fixed constant.
6. A trade death receives the full victim debit. A kill cannot create negative positive-side credit.
7. A trade denial is a player's kill less than five seconds after that player's previous kill in the round. A failed trade is a player dying less than five seconds after a teammate to the same killer. These labels do not remove the victim debit.
8. At round end, distribute the remaining round swing using weights 1 for the clutcher, 2 for each player with kill swing, 1 for the defuser, and 1 for each survivor, then normalise over eligible recipients. The current joined data has not yet isolated this remainder from event credits with enough confidence, so keep the constants in `params.json` and mark the implementation provisional.

The tooltip credits are the ground truth for each player and event. A round-level sum is not a valid check: `performance.players[].perRound` is not additive over the event tooltip values. The strict join data is not sufficient to claim the final per-player-map correlation until post-plant zero rules, mixed damage/trade allocation, and the round-end remainder are fitted.

## Economy adjustment

A duel group is selected from the player's primary weapon, falling back to the round-start equipment band. Groups, strongest first, are `sniper`, `rifle1`, `rifle2`, `smg`, `pistolPlus`, and `pistol`.

The provisional duel model is Bradley-Terry:

```
p = sigmoid(strength[killer] - strength[victim] + sideEdge)
killPoints = k * (1 - p)
```

`sideEdge` is `ct_edge` for a CT killer and `-ct_edge` for a T killer. The stored constants and published anchors live in `params.json`. The anchors include T rifle versus CT rifle at 48%, T rifle versus starter pistol at 75%, and AWP versus rifle at 56% as T and 60% as CT. The free group strengths are provisional until the strict demo joins provide the full duel table.

For each player-map, eKPR is the sum of kill points divided by rounds. eDPR charges the same point value to the victim. eADR weights damage at the attacker/victim group and side at the damage tick. Unknown groups fall back to raw value and are counted.

The map scoreboard exposes eKPR, eDPR, eADR, and eKAST. It does not expose eMK. The reference fit therefore uses raw multi-kill percent for the MK term. Career cards expose an eco multi-kill value, but that value is on a different scale. Do not silently mix the two. `eKAST`'s 3.0.1 reduced-power transformation remains unresolved.

## Shipped approximation

The shipped rating block in `params.json` is a plain six-term ordinary-least-squares approximation over all 733 regulation and overtime maps and 7,330 player-map rows:

```
Rating_hat = 0.4912169184
           + 0.4435502433 * eKPR
           + 0.0043052663 * eADR
           - 0.3625584417 * eDPR
           + 0.0029272188 * eKAST
           + 0.0022287379 * MK
           + 0.0398680331 * Swing
```

The inputs use HLTV's displayed eco-adjusted KPR, ADR, DPR, and KAST, raw multi-kill rate, and displayed Round Swing. A five-fold map-grouped holdout gives MAE 0.0462157, p95 0.1179361, and maximum error 0.4583706. The block has `status: "approximation"`; it is not a recovered HLTV formula.

The following pieces are recovered well enough to keep in the shipped approximation:

- The total rating is the round-weighted mean of the displayed CT and T side ratings. The display-level reconstruction has MAE 0.00284, p95 0.00652, and maximum error 0.00924 over 7,330 rows.
- The pre-plant win-probability lookup reproduces the observed graph with 0.0019 percentage-point MAE on pre-plant events. The lookup remains approximate because post-plant timing is unresolved.
- The display floors are known: rating ±0.005, eK/eD count rounding ±0.5 count, eADR/eKAST ±0.05 displayed units, and Swing ±0.005 percentage points.

The following items remain open:

- **eKAST transform.** HLTV says the October 2025 update added a transformation that treats winning-team KAST more fairly. Adding simple result interactions reduced map holdout MAE from 0.0462 to 0.0430, but exact demo result-conditioned KAST was slightly worse than the unconditioned probe, 0.03482 versus 0.03468. This does not identify the transform.
- **Per-round sub-rating transforms.** The available 25-term round model reaches 0.0893 MAE over 21,990 equations. Exact damage and action features improve a 220-map probe to 0.0341, still far above the display floor.
- **Exact eco function.** A plain linear fit on career eco inputs reaches about 0.0058 MAE, while the same six inputs on map totals reach about 0.0462. The demo duel reconstruction has objective MAE 0.1095 when CT/T eco counts are included. Neither result recovers HLTV's eco function.
- **Post-plant timing.** The joined data contains 1,311 aligned post-plant events across 350 rounds. The observations are consistent with nominal defuse limits, but no timing threshold is claimed because kills can still change the graph after defusing becomes impossible.
- **Mixed-case Swing allocation.** Tooltip credits are the ground truth, but per-player round Swing is not additive over those event tooltips. The clean no-damage, one-flash ratio of about 0.846 killer and 0.154 flash assister is approximate. The round-end remainder and mixed damage, flash, and trade cases remain provisional.

A future investigator should not apply the map fit to career aggregates. The map-fitted linear coefficients overpredict the 275 career ratings by a near-constant +0.053, with MAE 0.0529. A career-fitted linear model reaches MAE 0.006. This supports HLTV's statement that eco adjustment has less influence on smaller samples, but it does not reveal the career transformation.

## Rating target and per-round fit

The map target is a round-weighted mean of the side targets. For a player with `R_ct` CT rounds and `R_t` T rounds:

```
Rating_map = (R_ct * Rating_ct + R_t * Rating_t) / (R_ct + R_t)
```

Using the displayed total, CT, and T ratings gives MAE 0.00284, p95 0.00652, and maximum error 0.00924 across 7,330 player-map rows. The coordinator's regulation-only probe reports the same result over 6,320 rows: MAE 0.0028, p95 0.0065, and maximum 0.009. This is display rounding, not evidence for a map-level formula.

The target-only rating display floor is ±0.005 rating units, with expected absolute error 0.0025. Map eKPR and eDPR have count quantisation of ±0.5/R because eK and eD are displayed as integer counts. MK has the same count quantisation when converted to a per-round percentage. eADR and eKAST contribute ±0.05 in their displayed units, and Swing contributes ±0.005 percentage points. The propagated floor for the final per-round model is not known yet.

The current reference fit uses round events rather than map aggregates. Each round supplies kills, death or survival, a KAST proxy, a multi-kill indicator, swing, buy label, and side. A 25-term least-squares basis over 21,990 total/CT/T equations reaches MAE 0.0893 and correlation 0.9701. It is a research baseline, not an accepted formula. Damage, assists, exact KAST, exact economy adjustment, and the six HLTV sub-rating transforms remain open.

The degree-two map polynomial is retired. Its 0.0360 MAE on map aggregates is a diagnostic result only and must not be shipped as Rating 3.02.

## Demo-join per-round probe

The current strict joins provide 48,180 player-round rows and 6,600 total/CT/T equations. The duel model was refit from the displayed eco-adjusted K/D cells, producing fractional kill and death points for the round features. The selected total-only duel fit has objective MAE 0.1335 over 2,200 player-map targets; a total-plus-CT/T eco-count fit has objective MAE 0.1095 but gives a worse Rating fit, so neither is an accepted production model.

The cumulative research stages are:

| Stage | Total MAE | CT MAE | T MAE | Total correlation |
| --- | ---: | ---: | ---: | ---: |
| Fractional eco K/D | 0.1088 | 0.1668 | 0.1562 | 0.9258 |
| Add game damage | 0.1076 | 0.1649 | 0.1537 | 0.9267 |
| Raw and per-victim capped damage | 0.1018 | 0.1587 | 0.1457 | 0.9365 |
| KAST components | 0.0982 | 0.1532 | 0.1374 | 0.9399 |
| Trade, flash, multikill, swing | 0.0540 | 0.0884 | 0.0753 | 0.9829 |
| Action counts and outcomes | 0.0538 | 0.0884 | 0.0754 | 0.9830 |
| Equipment and interaction terms | 0.0485 | 0.0745 | 0.0690 | 0.9862 |
| Side-identity weighted interactions | 0.0475 | 0.0737 | 0.0673 | 0.9867 |

The target display floor remains MAE 0.0025 and maximum 0.005. For each stage, local input-rounding probes include eK/eD count rounding of ±0.5 per side or total round count and Swing display rounding of ±0.005. The final side-identity stage gives input-quantisation MAE 0.00096, p95 half-width 0.0695, and maximum half-width 0.4291; the fit is therefore not at its floor.

Of the 220 accepted folders, 192 contain schema-v1 `player_rounds.game_damage`; 28 legacy folders use the capped-damage fallback. The exact game-owned damage input is therefore available for most, but not all, joins. The listed feature families and their tested interactions do not reach the rounding floor. The remaining mismatch is not assigned to a production constant; exact eKAST transformation, sub-rating transforms, and any omitted input remain open. No demo-derived coefficients are accepted into `params.json`.

## Held-out structural hypothesis tests

`hypothesis_fit.py` evaluates map-level models with five outer `GroupKFold` splits by map and three inner group splits for Ridge-alpha selection. The full HLTV set contains 7,330 player-map rows over 733 maps. Round-graph outcome features are exact only for kills, deaths, survival, and per-round Swing; the KAST proxy does not include unobserved assists or traded deaths. Parenthetical scoreboard values are parsed as headshots, traded deaths, and flash assists. Side features use the displayed CT and T tables and their round counts.

| Hypothesis | Rows | Held-out MAE | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| Displayed eco baseline | 7,330 | 0.046210 | 0.118155 | 0.457171 |
| KAST/result interaction and transforms | 7,330 | 0.043031 | 0.107542 | 0.339835 |
| Per-round result sub-ratings | 7,330 | 0.043800 | 0.110593 | 0.395798 |
| Assists and flash assists | 7,330 | 0.046198 | 0.118295 | 0.455845 |
| Opening/clutch/traded-death/headshot | 7,330 | 0.044330 | 0.112903 | 0.477171 |
| Winner/loser normalisation | 7,330 | 0.042546 | 0.108230 | 0.341428 |
| Swing on won rounds | 7,330 | 0.045593 | 0.115260 | 0.433803 |
| All scoreboard columns | 7,330 | 0.043556 | 0.111362 | 0.433350 |
| Displayed CT/T columns | 7,330 | 0.045260 | 0.114226 | 0.472424 |
| Displayed CT/T plus result | 7,330 | 0.042201 | 0.106270 | 0.370337 |
| All map features | 7,330 | 0.039526 | 0.102480 | 0.306290 |
| All map features plus CT/T | 7,330 | 0.038696 | 0.099608 | 0.314038 |
| Displayed plus exact demo damage | 2,200 | 0.045276 | 0.116348 | 0.337944 |
| Displayed plus exact demo action counts | 2,200 | 0.044506 | 0.113448 | 0.334384 |
| Displayed plus exact demo action outcomes | 2,200 | 0.041731 | 0.107014 | 0.286333 |
| Displayed plus exact demo equipment interactions | 2,200 | 0.042205 | 0.107383 | 0.325308 |
| Displayed plus exact demo result-conditioned features | 2,200 | 0.042952 | 0.113466 | 0.289779 |
| Displayed plus all exact demo features | 2,200 | 0.034682 | 0.091235 | 0.266950 |
| Displayed plus all exact demo and result-conditioned features | 2,200 | 0.034822 | 0.092183 | 0.260737 |
| All map features plus CT/T and exact demo | 2,200 | 0.034133 | 0.091033 | 0.240318 |

The strongest all-map model is a standardized linear model over the displayed eco and traditional columns, round-outcome proxies, nonlinear KAST terms, and displayed CT/T features; it reaches MAE 0.038696 and is not an exact formula. The strongest joined-demo probe reaches MAE 0.034133, but it covers only 220 maps and uses demo-owned damage/action/equipment features in addition to displayed HLTV values. Conditioning exact demo KAST components on won versus lost rounds slightly worsens that probe, so this test does not support a simple winning-team KAST split as the missing input. Assists, flash assists, opening duels, clutches, traded deaths, and headshots do not independently approach the floor. The residual therefore remains unexplained by the tested observable inputs; no fitted coefficients are accepted into `params.json`.

All numeric constants belong in `params.json`. The engine must not duplicate them in TypeScript.
