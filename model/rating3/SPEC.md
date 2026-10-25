# Rating 3.02 reference specification

This document describes the research model. The shipped implementation belongs in TypeScript and must read `params.json`. Python fits coefficients and checks the implementation; it is not a second production model.

## Data contract

HLTV map files with `v: 3` provide the target. Probability targets use the full-precision `performance.rounds.*.events[].y`. For a round whose graph lists team 1 as T, `y` is P(T wins). For a CT-first round, the target is `1 - y` when the engine wants P(T wins). The stream's `teams` text is display-rounded and is not used for fitting.

A demo join is valid only when map, archive date, both five-player rosters, every round winner, and every enemy kill sequence up to the demo round end agree. Kills after `rounds.end_tick` are excluded because HLTV's event graph stops at round end. The current strict join set is 29 maps, 682 rounds, and 4,433 enemy kills.

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

On a chronological 70/15/15 match split, the selected lookup has 0.153 pp test MAE over 20,235 events and 0.160 pp over non-terminal events. Pre-plant MAE is 0.0019 pp. Post-plant timing is still open. The current valid joins provide 1,311 aligned post-plant events across 350 rounds. They are consistent with the nominal 10-second no-kit and 5-second kit defuse limits, but kills can still change elimination probability after defusing becomes impossible, so a threshold cannot be claimed from zero deltas alone.

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

## Rating target and per-round fit

The map target is a round-weighted mean of the side targets. For a player with `R_ct` CT rounds and `R_t` T rounds:

```
Rating_map = (R_ct * Rating_ct + R_t * Rating_t) / (R_ct + R_t)
```

Using the displayed total, CT, and T ratings gives MAE 0.00284, p95 0.00652, and maximum error 0.00924 across 7,330 player-map rows. The coordinator's regulation-only probe reports the same result over 6,320 rows: MAE 0.0028, p95 0.0065, and maximum 0.009. This is display rounding, not evidence for a map-level formula.

The target-only rating display floor is ±0.005 rating units, with expected absolute error 0.0025. Map eKPR and eDPR have count quantisation of ±0.5/R because eK and eD are displayed as integer counts. MK has the same count quantisation when converted to a per-round percentage. eADR and eKAST contribute ±0.05 in their displayed units, and Swing contributes ±0.005 percentage points. The propagated floor for the final per-round model is not known yet.

The current reference fit uses round events rather than map aggregates. Each round supplies kills, death or survival, a KAST proxy, a multi-kill indicator, swing, buy label, and side. A 25-term least-squares basis over 21,990 total/CT/T equations reaches MAE 0.0893 and correlation 0.9701. It is a research baseline, not an accepted formula. Damage, assists, exact KAST, exact economy adjustment, and the six HLTV sub-rating transforms remain open.

The degree-two map polynomial is retired. Its 0.0360 MAE on map aggregates is a diagnostic result only and must not be shipped as Rating 3.02.

All numeric constants belong in `params.json`. The engine must not duplicate them in TypeScript.
