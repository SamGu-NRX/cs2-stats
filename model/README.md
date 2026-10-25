# Round win-probability model

This folder fits the model behind the app's round swing. Round swing is the change in a team's chance of winning the round across one kill. The model gives P(CT wins the round) from the state the app has at each kill. It is an 83-term logistic regression stored in `export/model.json` (7.9 KB, 2.4 KB gzipped). `export/winprob.ts` evaluates it with no dependencies.

## Using it from the app

```ts
import { winProbabilityCT } from "../model/export/winprob";

const p = winProbabilityCT(
  { ctAlive: 3, tAlive: 2, ctHp: 240, tHp: 130, ctEquip: 24500, tEquip: 21000,
    planted: 1, secondsSincePlant: 12.5, secondsSinceFreezeEnd: 71.0 },
  "de_mirage",
);
```

The header of `winprob.ts` defines every field and its units. A kill's `state` array from `SCHEMA.md` maps onto those fields like this:

| `kills.state` index | Field | Conversion |
|---|---|---|
| 0, 1 | `ctAlive`, `tAlive` | none |
| 2, 3 | `ctHp`, `tHp` | none (summed HP of living players) |
| 4, 5 | `ctEquip`, `tEquip` | must be the team's summed post-buy value at freeze end; see "Equipment value the model expects" |
| 6 | `planted` | none |
| 7 | `secondsSincePlant` | `ticksSincePlant / 64`, and `null` stays `null` |
| none | `secondsSinceFreezeEnd` | `(kill tick - rounds.freezeTick[ri]) / 64` |

The state after a kill is the state before it with the victim removed: one fewer alive on the victim's side, and that side's HP lowered by the victim's remaining HP.

The function throws a `RangeError` naming the field when input is out of range: more than five alive, more HP than the living players can have, a plant time while not planted, or a missing plant time while planted. On a map outside the seven CS2RB maps it uses the training-share average of the map effects. `isModelledMap(map)` tells you when that happens. The importing project needs `resolveJsonModule` or a bundler that imports JSON.

Decided states never appear in CS2RB, so the game rules answer them instead of the model:

- no CT alive gives 0
- no T alive before a plant gives 1
- 40 s or more since the plant gives 0
- 115 s or more since freeze end without a plant gives 1

The 40 s and 115 s values are CS2 competitive defaults and live in `model.json` under `terminal`.

## Data

The model is fitted on CS2RB v1.0, which holds 4,768,984 live round states from 5,725 professional CS2 matches (January to August 2026, seven maps). I used `cs2rb_v1_data.zip` (1.43 GB) from the Zenodo record, verified it against Zenodo's MD5 and CS2RB's `SHA256SUMS.txt`, and read 11 of each state table's 136 columns. The other three archive files are 0.4 to 0.8 GB each and hold the paper's predictions, holdout states and check runs. None of them is needed for training.

The splits are CS2RB's frozen per-map train/validation/test roles from `splits.parquet`. Test is the latest 15% of each map's matches. Those roles are per map, so 369 map recordings in the training split belong to matches that are validation or test on another map. Pooled training drops them (139,415 states), and validation and test stay exactly the frozen sets.

| Split | States | Map recordings |
|---|---:|---:|
| train | 3,191,693 | 8,553 |
| validation | 726,225 | 1,906 |
| test | 711,651 | 1,914 |

0.43% of states (20,701) have no equipment record. They get the training median ($26,600 CT, $23,650 T).

### Attribution

The coefficients in `export/model.json` are derived from CS2RB data, which is licensed CC BY 4.0. The model was fitted to a subset of the columns, and no data is redistributed here. Per the dataset's `CITATION.cff`, cite the paper and the archive:

> Bishop, William (2026). *CS2RB: Aggregate and Individual-Player Models for Round-Win Prediction in Counter-Strike 2*, version 1.0. Data archive: https://doi.org/10.5281/zenodo.22970589. Code: https://github.com/williambishop-research/cs2rb. Data licence CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), code licence MIT.

The modelling setup follows:

> Xenopoulos, Peter, Harish Doraiswamy and Claudio Silva (2020). "Valuing Player Actions in Counter-Strike: Global Offensive." *2020 IEEE International Conference on Big Data*. arXiv:2011.01324.

## Features

These are the nine CS2RB columns the app can supply, plus the map. I checked each definition against CS2RB's dataset card, `benchmark/build/rebuild_states.py` and the state tables themselves.

| CS2RB column | App field | CS2RB definition, as verified |
|---|---|---|
| `ct_alive`, `t_alive` | `ctAlive`, `tAlive` | Count of a side's players with health above 0. CT is 1 to 5 in live states, T is 0 to 5 (0 only after a plant). |
| `ct_hp`, `t_hp` | `ctHp`, `tHp` | Sum of the side's health, clipped at 0, so 0 to 500. |
| `ct_equip`, `t_equip` | `ctEquip`, `tEquip` | Team equipment value at freeze end, in dollars, summed over the whole team. It never changes within a round: none of the 271,421 rounds with an equipment record has two values, so it does not drop when players die. Dust2 pistol rounds have a median of $4,250, which is five players at $850. |
| `planted` | `planted` | 0 or 1. CS2RB's audit never found it on before the plant, and found it up to 1 s late in 61 states. |
| `time_since_plant` | `secondsSincePlant` | Seconds since the plant, 0 to 39.9. It is exactly 0 whenever `planted` is 0, and `winprob.ts` maps the app's `null` to 0. |
| `elapsed_s` | `secondsSinceFreezeEnd` | Seconds since the estimated freeze end, capped at 155 (the largest value is 152). |

The model turns these into nine variables (`compact.VARIABLES`). Missing HP is measured in full-health players (`ctAlive - ctHp/100`), and equipment enters as `ln(1 + equip/1000)`. The terms are:

- one intercept per (CT alive, T alive, planted) cell: 55 cells
- missing HP and log equipment for each side, separately before and after a plant
- a piecewise-linear round clock before the plant (bends at 15, 30, 45, 60, 75, 90 and 105 s)
- a piecewise-linear bomb clock after it (bends at 10, 20, 25, 30 and 35 s), which captures the drop in CT chances once there is too little time left to defuse
- an offset for each map relative to Dust2

### Equipment value the model expects

`ctEquip` and `tEquip` are each team's equipment value **after buying**, read at freeze end, in dollars, summed over all five players on the team. The value is set once per round and stays constant through it. It does not fall when a player dies or drops a weapon, and it does not rise when someone picks one up.

Two plausible readings are wrong:

- The value carried into the round before buying. On an eco after a won round this can be larger than what the team actually holds.
- The current equipment of the living players at the kill. This shrinks with every death, and the alive counts already account for deaths.

The app can build the right value once per round by summing the five freeze-end values per side and reusing that sum for every kill in the round.

### Feature mismatches

1. **Equipment.** `SCHEMA.md` describes `rounds.equip[pi]` as the "round-start equipment value from the pawn at freeze end". The kill state's `ctEquip` is not defined further, and `plugin/` is empty, so I could not check which pawn value the plugin reads. If it is either of the wrong readings under "Equipment value the model expects", the model gets the wrong input. I have not measured how much that would move the predictions. WPA ranks equipment value as the most important feature in its model.
2. **Clock origin.** CS2RB estimates freeze end as the first frame with player movement, which falls a median 0.58 s after the true freeze end. The app uses the exact `round_freeze_end` tick. I left this uncorrected. It shifts `elapsed` by about half a second, small next to the 5 s spacing of the training states.
3. **When states are sampled.** CS2RB samples one state about every 5 s. The app evaluates at kills, and the state just before a kill is mid-fight. The model has no input that can tell the two apart, so it cannot be adjusted for. It does mean the test metrics below describe states every 5 s, not kill moments.
4. **Plant time units.** The app records ticks since the plant, and the model takes seconds. Divide by 64.
5. **Decided states.** The terminal rules above stand in for states CS2RB excludes. A server with a different `mp_c4timer` or `mp_roundtime` needs the `terminal` values in `model.json` changed.

## Model selection

I followed the WPA paper (Xenopoulos et al.) wherever its choices fit the app's features:

- one pooled model with the map as a feature
- team equipment value, alive counts, HP, bomb state and time as inputs; WPA's bomb site and bombsite distances are left out because the app has no positions
- logistic regression, XGBoost and CatBoost as the candidates
- WPA's grids: 100 trees, XGBoost over `max_depth` {6, 8, 10, 12} × `min_child_weight` {1, 3, 5, 7}, CatBoost over `depth` × `l2_leaf_reg` on the same values
- log loss, Brier score and AUC, with WPA's map-average baseline

I departed from it in three places:

- The splits are CS2RB's frozen chronological ones, not WPA's two-thirds/one-third.
- WPA's XGBoost setting (learning rate 0.3, 100 trees) overfits these correlated, 5 s-spaced states. Validation loss is lowest near tree 25 and rises after it. So I added an early-stopped XGBoost (learning rate 0.05, subsampling 0.9, CS2RB's recipe) over three depth settings. It is the best model.
- Logistic regressions are fitted by Newton's method with a ridge penalty of 1 (negligible at 3.2M rows; it keeps rare cells finite). That gives the same maximum-likelihood fit as WPA's unregularised SAGA, without holding a 3.2M-row design matrix in memory.

All hyperparameters were chosen on validation. The compact candidates, smallest first, were WPA's linear model (16 terms) and three engineered logistic models (71, 83 and 130 terms). The original rule was to export the smallest one whose pooled test log loss is within 1% of the best model's. That picks the 71-term model (+0.60%), and the same rule on validation agrees.

The export is the 83-term model (+0.43%) instead, by decision after review. The 71-term model treats both clocks as straight lines, so it is 1 to 2 points off in late rounds. Those are the kills where round swing matters most, and they are too small a share of states to move the pooled loss much. The 83-term model adds the clock bends and is within 0.5 points in the same subgroups:

| Test subgroup | States | Observed CT rate | 71 terms: mean P / LL | 83 terms (exported): mean P / LL |
|---|---:|---:|---:|---:|
| planted, under 20 s | 73,123 | 0.271 | 0.270 / 0.2599 | 0.270 / 0.2583 |
| planted, 20-30 s | 27,089 | 0.287 | 0.274 / 0.1444 | 0.286 / 0.1406 |
| planted, 30 s or more | 19,085 | 0.213 | 0.232 / 0.1306 | 0.213 / 0.1232 |
| not planted, 90 s or more | 34,670 | 0.654 | 0.634 / 0.3526 | 0.649 / 0.3495 |

`train.py --export lr_cells` produces this export. Without `--export`, `train.py` applies the 1% rule.

A logistic model needs no runtime but a dot product and a sigmoid. That makes TS/Python parity exact, so I did not try a tree model exported as a grid. The 130-term model is within 0.04% of XGBoost, so a grid would have bought nothing.

## Metrics

All numbers are on the test split. The tables show log loss / Brier score.

| Map | Constant | Alive-count lookup | Exported (83 terms) | Best: XGBoost, early-stopped |
|---|---:|---:|---:|---:|
| pooled | 0.6933 / 0.2501 | 0.5174 / 0.1780 | **0.4571 / 0.1543** | 0.4551 / 0.1538 |
| de_dust2 | 0.6928 / 0.2498 | 0.5233 / 0.1806 | 0.4605 / 0.1555 | 0.4579 / 0.1549 |
| de_mirage | 0.6937 / 0.2503 | 0.5183 / 0.1781 | 0.4536 / 0.1527 | 0.4525 / 0.1526 |
| de_inferno | 0.6920 / 0.2494 | 0.5205 / 0.1795 | 0.4675 / 0.1587 | 0.4649 / 0.1580 |
| de_ancient | 0.6934 / 0.2501 | 0.5125 / 0.1759 | 0.4520 / 0.1520 | 0.4506 / 0.1517 |
| de_nuke | 0.6942 / 0.2506 | 0.5117 / 0.1758 | 0.4546 / 0.1535 | 0.4524 / 0.1529 |
| de_anubis | 0.6918 / 0.2493 | 0.5136 / 0.1769 | 0.4536 / 0.1537 | 0.4521 / 0.1532 |
| de_overpass | 0.6950 / 0.2509 | 0.5198 / 0.1786 | 0.4566 / 0.1538 | 0.4544 / 0.1532 |

The constant is the training CT win rate. The alive-count lookup is the training CT win rate for each (CT alive, T alive) pair, with add-one smoothing. Scored as an unknown map (map effects averaged), the exported model's pooled test log loss is 0.4577.

Every model, pooled:

| Model | Size | Validation LL | Test LL | Test Brier | Test AUC | vs best |
|---|---|---:|---:|---:|---:|---:|
| XGBoost, early-stopped (best) | depth 6, 218 trees | 0.4569 | 0.4551 | 0.1538 | 0.8559 | 0 |
| Logistic, 130 terms | 130 terms | 0.4575 | 0.4553 | 0.1538 | 0.8560 | +0.04% |
| **Logistic, 83 terms (exported)** | 83 terms | 0.4598 | 0.4571 | 0.1543 | 0.8550 | +0.43% |
| WPA XGBoost | depth 6, min_child_weight 7 | 0.4593 | 0.4578 | 0.1549 | 0.8535 | +0.59% |
| Logistic, 71 terms (straight-line clocks) | 71 terms | 0.4605 | 0.4578 | 0.1545 | 0.8546 | +0.60% |
| WPA CatBoost | depth 12, l2_leaf_reg 1 | 0.4651 | 0.4637 | 0.1551 | 0.8547 | +1.90% |
| WPA logistic regression | 16 terms | 0.4715 | 0.4682 | 0.1575 | 0.8495 | +2.89% |
| Alive-count lookup | 30 cells | 0.5193 | 0.5174 | 0.1780 | 0.7929 | +13.7% |
| Map average (WPA baseline) | 7 rates | 0.6929 | 0.6922 | 0.2495 | 0.5282 | +52.1% |
| Constant | 1 rate | 0.6935 | 0.6933 | 0.2501 | 0.5000 | +52.3% |

Calibration of the exported model, pooled test, in 10 equal-width bins:

| Predicted P(CT) | States | Mean predicted | Observed CT win rate |
|---|---:|---:|---:|
| 0.0-0.1 | 117,272 | 0.029 | 0.028 |
| 0.1-0.2 | 40,128 | 0.151 | 0.149 |
| 0.2-0.3 | 46,048 | 0.251 | 0.253 |
| 0.3-0.4 | 45,498 | 0.351 | 0.346 |
| 0.4-0.5 | 102,347 | 0.461 | 0.470 |
| 0.5-0.6 | 113,852 | 0.541 | 0.551 |
| 0.6-0.7 | 49,783 | 0.649 | 0.662 |
| 0.7-0.8 | 52,905 | 0.748 | 0.751 |
| 0.8-0.9 | 42,567 | 0.853 | 0.854 |
| 0.9-1.0 | 101,251 | 0.965 | 0.969 |

No bin is off by more than 0.014. The model runs slightly low between 0.4 and 0.7.

### Against published numbers

WPA's Table II reports XGBoost at 0.5353 / 0.1842 (AUC 0.791), CatBoost at 0.5443, logistic regression at 0.5539 and the map average at 0.6917. On CS2RB the same three model families score 0.4578, 0.4637 and 0.4682, in the same order, and the map average lands at 0.6922, almost exactly WPA's. The absolute losses are not comparable. WPA used CS:GO LAN matches from 2016 to 2019, took a state at every footstep, damage and bomb event, and had bomb site and bombsite-distance features.

CS2RB's own XGBoost uses 28 features including player positions. Fitted per map on the full training split, it scores these test losses: Dust2 0.4510, Mirage 0.4488, Inferno 0.4604, Ancient 0.4478, Nuke 0.4518, Anubis 0.4490, Overpass 0.4519 (`results/evaluation/RESULTS.md`, mean of four seeds). The 9-feature best model is 0.001 to 0.007 behind on each map, so positions add little at this scale.

## Known gaps

- **Pro matches, applied to bots.** The model was fitted on professional matches and is applied to bot matches. Bots trade, rotate, retake and save differently, and nothing here measures how far that moves the probabilities. Swings will be ranked sensibly, but the absolute percentages are pro-match percentages.
- **HLTV's model is not public.** HLTV has not published its round-swing model, so these swings will not match HLTV's numbers, and there is no way to calibrate against them.
- **No context beyond the nine features.** The model has no weapons, utility, positions, money left, defuse kits or score.
- **Mid-fight states.** Test metrics describe states every 5 s, not states at kills (mismatch 3).

## Files

| Path | Contents |
|---|---|
| `train.py` | Loads CS2RB, fits every model, selects, exports. Run `--help` for options. |
| `compact.py` | Term definitions for the logistic candidates, the Newton fit, and `predict_from_json`, the Python twin of `winprob.ts`. |
| `export/model.json` | The exported model: format, inputs, variables, factor grammar, map shares, terminal rules, test and validation metrics, terms. |
| `export/winprob.ts` | `winProbabilityCT(state, map)` and `isModelledMap(map)`. |
| `export/parity_rows.json` | 50 test states sampled with seed 42 (7 per map, 8 on Dust2), plus 7 edge cases, each with the Python prediction. |
| `export/winprob.test.ts` | Asserts TS equals Python to 1e-6 on every row, and that invalid input throws. |
| `metrics.json` | Every model's validation and per-map test metrics, grid results, row counts and package versions. |

## Retraining

Training uses at most 4 threads and runs below normal priority. While `cs2.exe` is running, each heavy step drops to 2 threads and the hyperparameter grids wait for it to close. The last full run took 27 minutes, 17 of them in the CatBoost grid.

```bash
cd model
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

# Data: about 1.4 GB download, 1.4 GB extracted, kept in the gitignored data/
mkdir -p data && cd data
curl -fL -o cs2rb_v1_data.zip "https://zenodo.org/api/records/22970589/files/cs2rb_v1_data.zip/content"
md5sum cs2rb_v1_data.zip          # 6963980b2e3d52d79418f8d8661dbdf0
unzip -q cs2rb_v1_data.zip && rm cs2rb_v1_data.zip
cd cs2rb_v1 && sha256sum -c SHA256SUMS.txt && cd ../..

.venv/Scripts/python -I train.py --data data/cs2rb_v1 --export lr_cells   # full run, the current export
.venv/Scripts/python -I train.py --data data/cs2rb_v1 --quick    # 1-minute smoke run into runs/quick/

npm install --legacy-peer-deps    # npm 10.8 crashes resolving vitest's peers without it
npm test                          # parity and input checks
npm run typecheck
```

Retraining rewrites `export/model.json`, `export/parity_rows.json` and `metrics.json`. The tests then check the new parity rows.

The training dependencies are pinned in `requirements.txt` (Python 3.12): numpy, pandas and pyarrow for loading, scikit-learn for AUC, xgboost and catboost for the WPA comparison models, and threadpoolctl to cap BLAS threads. The app itself needs none of these.
