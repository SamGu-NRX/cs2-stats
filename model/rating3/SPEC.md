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

On a chronological 70/15/15 match split, the selected lookup has 0.153 pp test MAE over 20,235 events and 0.160 pp over non-terminal events. Pre-plant MAE is 0.0019 pp. Post-plant MAE is 0.710 pp. The remaining post-plant errors occur where HLTV holds a probability constant after the bomb becomes unpreventable but the event stream does not expose the timing rule.

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

The event ledger conserves positive and negative swing to rounding error on ordinary kills. The strict join data is not sufficient to claim the final per-player-map correlation until post-plant zero rules and round-end remainder are fitted.

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

## Sub-ratings and final fit

The reference fit uses four eco-adjusted map inputs, raw multi-kill percent, and swing:

```
q = (eKPR, eADR, eDPR, eKAST, MK, Swing)
z_i = (q_i - mean_i) / sd_i
Rating = max(0, sum(c_t * phi_t(z)))
```

`phi` is the degree-two polynomial basis with an intercept, six first-order terms, six square terms, and fifteen pairwise products. Coefficients are stored under `rating.terms` in `params.json`, using scikit-learn's order: `1`, six feature names, then `x_i^2` and `x_i x_j` in feature order. This is the smallest tested extension that meets the map acceptance error. A six-term linear fit has 0.0474 MAE; the degree-two fit has 0.0360 MAE and R² 0.9844 on 7,330 player-map rows.

The career check applies the map-fitted means, standard deviations, and terms to 275 valid career cards. It is a scale check, not a second fit. Its current error is recorded in `rating.career_fit` and must be rerun after eMK and eKAST are resolved.

All numeric constants belong in `params.json`. The engine must not duplicate them in TypeScript.
