# Validation

What each family was checked against, and the numbers. Every figure here comes from a command in
`package.json`, run from `app/` with the private data folder present (`cs2-stats-data`, or set
`CS2_STATS_DATA`). The pro data was still growing during the run (HLTV demos, re-extracted to schema v1
overnight), so each section names the size of its run; rerunning gives the current figures. HLTV
ground truth is the private per-map JSON (733 maps). The targets are the acceptance table in
`design/architecture.md`.

## Scoreboard: `pnpm hltv-check`, `hltv-exact.test.ts`

Demo maps join HLTV maps by map, at least 7 shared player names, the same final score, then the
nearest date (`tools/hltv.ts`). Maps that join nothing are listed by `pnpm hltv-check` (121 on the run
below): halves of split recordings (`-p1`, `-p2`), whose partial scores match no HLTV map, and matches
whose HLTV pages were not collected.

Rerun on 395 joined maps (3,950 player-maps). Ours is rounded to one decimal as HLTV displays it,
halves to the even digit (`tools/hltv.ts` `hltvRound1`): 13 of 16 rounds is 81.2%, not 81.3%.

| Column | Exact, of 3,950 player-maps | Target |
|---|---|---|
| Kills | 3,950 | exact |
| Deaths | 3,916 | exact |
| KAST | 3,679 (93.1%) | exact |
| ADR within 0.5 | 3,857 (97.6%) | within 0.5 |
| Headshot kills, multi-kill rounds | 3,950, 3,950 | |
| Traded deaths | 3,620 | |
| Opening kills, opening deaths | 3,926, 3,903 | |
| Assists, flash assists | 2,396, 2,545 | |

171 of the 395 maps match for every player on K, D, KAST and ADR. `hltv-exact.test.ts` pins 24 maps
(`pnpm hltv-check` covers every joined map and lists each miss). The KAST misses are a round or two
off, in both directions, and none of the candidate rules below fixes more than it breaks. Where assists miss, HLTV's assists and flash assists usually run higher than the
kill feed's by the same count, so HLTV credits flash assists the kill feed does not; KAST excludes flash assists, so it is not
affected. ADR misses: the ten demos recorded from round 1 live, and a few players 0.6 to 0.9 low,
which fits hits the extractor rebuilt without a unique attacker.

## Why these definitions: `pnpm scoreboard-variants`

Each candidate scored against HLTV on 3,950 player-maps (395 joined maps); bold is the engine's rule:

| Question | Candidate: exact matches |
|---|---|
| ADR damage | health removed (the game's own scoreboard): 1,966; the hurt event's damage capped at health: **3,857** |
| Deaths | every death: 3,868; every death except post-round suicides: **3,916** |
| Traded deaths | 5 s, every avenged death (CS Demo Manager): 2,509; 5 s, earliest only: 3,349; 5.4 s, every death: 2,587; 5.4 s, earliest only: **3,620** |
| KAST trade rule | 5.4 s earliest only, without flash assists: **3,679**; with flash assists: 3,299; 5 s earliest only without flash assists: 3,576 |
| KAST assist rule | the game's non-flash assister: **3,679**; the assister or 40+ enemy damage on the victim: 3,650; 40+ damage only: 2,771; 41+ damage only: 2,737 |
| KAST deaths | every death: **3,679**; team kills and suicides not deaths: 3,607 |

HLTV's round buy labels over every HLTV map: PISTOL $3,000 to $4,700 (2,932 team-rounds), ECO $800 to
$4,950 (1,794), HALF $5,000 to $16,200 (3,773), FULL $16,250 to $38,100 (23,469). The engine's cuts,
$1,000 and $3,250 per player, are those bands for five players.

## Rating 3.0 and swing: `pnpm rating-check`

Rating 3.0 is `params.json`'s six-term linear model as merged in #17 (swing and duel refitted on 304
joins, flash share 0.154), with all six inputs averaged over the rounds swing valued (a player-map with
swing on under half its rounds has no rating, which leaves 10 out; since round 3 of #20 a round must
also have every eco value known). Against HLTV on 371 joined maps
(3,700 player-maps) on 2026-10-25, with each
win-probability source: `pnpm rating-check` uses the HLTV pack when installed,
`CS2_WINPROB_PACK=none pnpm rating-check` forces CS2RB. Raw rows compare the engine's counts with
HLTV's traditional columns, so an eco input's error can be told from a counting error.

| Input | HLTV lookup: MAE / r | CS2RB: MAE / r | Mean ours / HLTV |
|---|---|---|---|
| KPR, raw | 0.0000 / 1.000 | same | 0.655 / 0.655 |
| eKPR | 0.028 / 0.986 | 0.028 / 0.986 | 0.643 / 0.654 |
| DPR, raw | 0.0003 / 1.000 | same | 0.660 / 0.659 |
| eDPR | 0.036 / 0.973 | 0.037 / 0.974 | 0.643 / 0.676 |
| ADR, raw | 0.078 / 1.000 | same | 71.81 / 71.82 |
| eADR | 1.88 / 0.991 | 1.89 / 0.991 | 70.92 / 71.42 |
| KAST, raw (percentage points) | 0.33 / 0.994 | same | 71.11 / 71.13 |
| eKAST | 4.48 / 0.885 | 4.48 / 0.885 | 70.34 / 68.88 |
| Swing (points per round) | 1.00 / 0.955 | 1.51 / 0.904 | 0.00 / -0.02 |
| Rating 3.0 | 0.069 / 0.973 | 0.084 / 0.960 | 1.089 / 1.078 |
| Rating 3.0, CT rounds | 0.120 / 0.966 | 0.135 / 0.952 | 1.172 / 1.101 |
| Rating 3.0, T rounds | 0.107 / 0.970 | 0.126 / 0.957 | 1.007 / 1.067 |

The HLTV-lookup column is the valued-round run; the CS2RB column is from the run before it, on all
rounds. With the HLTV lookup the valued-round change moved swing MAE from 1.006 to 0.998 and the
rating MAE from 0.0694 to 0.0691. Re-run with the HLTV lookup after round 3 of #20 (rated rounds need
every eco value known; the total weights the side ratings by rated rounds): every figure in that
column is unchanged at the precision shown, on the same 3,700 player-maps.

The raw counts are within display rounding of HLTV, so the eco inputs' error is in the eco weighting.
eKAST has the largest error and the weakest correlation (its transform `params.json` marks
unresolved). The merged duel fit moved eKPR and eDPR low (0.643 against 0.654 and 0.676) and eADR from
1.5 HP high to 0.5 HP low. Targets: swing r above 0.95 (met with the HLTV lookup); rating MAE under 0.04
(not met) and r above 0.97 (met with the HLTV lookup). `params.json` reports a held-out MAE of 0.046
when the model reads HLTV's own displayed inputs. Per-side ratings apply the map model to one side's
rounds, which HLTV does not.

## Plugin adapter: `plugin/adapter.test.ts`

Through `pluginToTables` and `derive`, kills, deaths and headshot kills match the game's own per-round
totals (`rounds.basic`, written by the server) on every covered player-round of the converted logs.

## Identity: `pnpm fit-roles <csv>`, `pnpm identity-check <csv>`

The 2026-10-26 run uses 489 pro maps and 634 unique careers. Four retired map folders were skipped by
`proMaps`; no extraction or game process ran. The input is Jamie Packer's 2024 CSV, CC BY 4.0,
SHA256 `162f8c10e41bfe11a3f4a351143d7a875724be1ec11b8d6fe3be59af61d09352`.
These results replace the earlier Gaussian-only figures. They measure cross-era label agreement,
not same-era ground truth. Evaluation fold q10/q90 evidence ranges are fitted from each fold's
training summaries; the production model retains the full-corpus ranges in `role-thresholds.ts`.

`role-training.ts` calls production `roleBlend` for every prediction, including fixed threshold rules,
softmax, measured AWP rounds, isotonic adjustment and confidence decisions. Each outer leave-one-player-out
fold excludes that steamid from Gaussian fitting, fold-local threshold fitting and inner-LOO calibration.
Half-Lurker and Lurker merge before fitting one equal-prior class. Calibration fits only Entry/Lurker and
Anchor/Rotator. There are no invented labels for Trader, Support or Aggressor. AWPer-labelled players enter
evaluation, but AWP rounds remain measured loadout share rather than a fitted value.

The headline holdout is stratified by mapped side label with seed `0x5EED`, holding about 20% of each
class. The team holdout uses seed `0xC0DE` and removes every held team's CSV rows from both fitting
stages, including teammates outside the evaluated side population. Team names come from the 2024 CSV;
this is not a 2026 match-grouped split. Duplicate steamids and missing team names fail before fitting.

There are 145 T and 116 CT labelled players with demo summaries. The evaluator excludes 118 T and
153 CT unlabelled or Mixed rows before counting, plus 43 T and 37 CT labelled players without summaries.
Of those with summaries, 21 T and 17 CT players have fewer than 30 side rounds. These remain in the
accuracy denominator as unsuccessful decisions, but not in confusion or reliability rows. No other
missing-feature abstentions occurred. The tail diagnostic lacks summaries for 9 of 30 T holdout
players and 8 of 23 CT holdout players.

A single primary needs 30 side rounds, probability >=0.60 and a >=0.15 top-minus-second margin.
Otherwise the result is top2, or null with a reason below 30 rounds. "Returned set" counts either a
correct primary or the true label inside an abstaining top2. "Single accuracy" divides by single
primaries only. Production rows use the final full-data fit and are not held-out estimates.

### Accuracy and decision coverage

| Side | Evaluation | Top-one accuracy | Single accuracy | Returned set | Single / top2 / insufficient |
|---|---|---|---|---|---|
| T | LOO | 86/145 (59.3%) | 9/13 (69.2%) | 96/145 (66.2%) | 13 / 111 / 21 of 145 |
| T | Stratified | 18/27 (66.7%) | 0/0, unavailable | 19/27 (70.4%) | 0 / 25 / 2 of 27 |
| T | Team holdout | 24/31 (77.4%) | 5/5 (100.0%) | 29/31 (93.5%) | 5 / 24 / 2 of 31 |
| T | Tail diagnostic | 14/21 (66.7%) | 3/5 (60.0%) | 16/21 (76.2%) | 5 / 14 / 2 of 21 |
| T | Production, in-sample | 90/145 (62.1%) | 2/4 (50.0%) | 102/145 (70.3%) | 4 / 120 / 21 of 145 |
| CT | LOO | 76/116 (65.5%) | 18/21 (85.7%) | 80/116 (69.0%) | 21 / 78 / 17 of 116 |
| CT | Stratified | 16/22 (72.7%) | 3/4 (75.0%) | 17/22 (77.3%) | 4 / 16 / 2 of 22 |
| CT | Team holdout | 17/26 (65.4%) | 4/4 (100.0%) | 20/26 (76.9%) | 4 / 20 / 2 of 26 |
| CT | Tail diagnostic | 8/15 (53.3%) | 3/3 (100.0%) | 10/15 (66.7%) | 3 / 11 / 1 of 15 |
| CT | Production, in-sample | 69/116 (59.5%) | 15/16 (93.8%) | 80/116 (69.0%) | 16 / 83 / 17 of 116 |

### Packer map-count ranges

These are CSV `map_count` ranges, not the number of 2026 maps per player. Training counts cover the
side's mapped Gaussian classes. Calibration additionally requires a demo summary. LOO lists the
training pool range; each actual fold removes its held steamid and is recorded in `--report` output.

| Side | Evaluation | Gaussian train range | Calibration train range | Holdout range |
|---|---|---|---|---|
| T | LOO | 2 to 158 | 4 to 158 | 4 to 158 |
| T | Stratified | 2 to 158 | 4 to 158 | 6 to 140 |
| T | Team holdout | 2 to 158 | 4 to 158 | 5 to 152 |
| T | Tail diagnostic | 11 to 158 | 11 to 158 | 2 to 11 |
| CT | LOO | 2 to 158 | 4 to 158 | 4 to 158 |
| CT | Stratified | 2 to 158 | 4 to 158 | 6 to 140 |
| CT | Team holdout | 2 to 158 | 4 to 158 | 7 to 144 |
| CT | Tail diagnostic | 11 to 158 | 11 to 158 | 2 to 11 |

The old tail split trains on 11-to-158-map players and tests 2-to-11-map players. It remains a
covariate-shift diagnostic, not the headline validation.

### Top-one confusion matrices

Rows are mapped truth. Missing entries are zero; insufficient decisions are counted in the table above.

| Side | Evaluation | Truth | Predicted counts |
|---|---|---|---|
| T | LOO | Entry | Lurker: 7, Support: 6, Entry: 30, Trader: 1 |
| T | LOO | Lurker | Entry: 14, Lurker: 34, AWPer: 1, Support: 4, Trader: 1 |
| T | LOO | AWPer | AWPer: 22, Lurker: 1, Support: 1, Entry: 2 |
| T | Stratified | Entry | Entry: 6, Support: 2, Lurker: 1 |
| T | Stratified | AWPer | AWPer: 5 |
| T | Stratified | Lurker | Lurker: 7, Support: 1, Trader: 1, Entry: 2 |
| T | Team holdout | Lurker | Lurker: 12, Entry: 2, Trader: 1 |
| T | Team holdout | Entry | Entry: 8, Lurker: 1 |
| T | Team holdout | AWPer | AWPer: 4, Lurker: 1 |
| T | Tail diagnostic | Lurker | Lurker: 8, Entry: 3 |
| T | Tail diagnostic | Entry | Lurker: 1, Entry: 6, Support: 1 |
| CT | LOO | Rotator | Rotator: 36, Support: 4, Anchor: 4, AWPer: 1 |
| CT | LOO | AWPer | AWPer: 25, Anchor: 1 |
| CT | LOO | Anchor | Anchor: 15, Rotator: 12, Support: 1 |
| CT | Stratified | Rotator | Rotator: 6, AWPer: 1, Anchor: 1, Support: 1 |
| CT | Stratified | Anchor | Anchor: 5, Support: 1 |
| CT | Stratified | AWPer | AWPer: 5 |
| CT | Team holdout | Anchor | Anchor: 5, Rotator: 3 |
| CT | Team holdout | AWPer | AWPer: 6 |
| CT | Team holdout | Rotator | Rotator: 6, Support: 3, Anchor: 1 |
| CT | Tail diagnostic | Rotator | Rotator: 5, Anchor: 3 |
| CT | Tail diagnostic | Anchor | Rotator: 3, Anchor: 3 |

### Reliability of the final distribution

Reliability uses the highest-share role's correctness even when the confidence gate returns
top2. Bins include the lower bound and exclude the upper bound, except the final bin includes 1.
Empty bins are omitted. These results do not establish calibrated probability across all roles:
isotonic adjustment covers mapped classes only, while rule-only roles remain fit shares and AWPer
remains measured AWP rounds. The frequent 0.4-to-0.6 predictions are underconfident on these labels;
the sparse high-confidence bins do not support a strong precision claim.

| Side | Evaluation | Probability bin | n | Mean probability | Observed correct |
|---|---|---|---|---|---|
| T | LOO | 0.2-0.4 | 51 | 0.338 | 0.529 |
| T | LOO | 0.4-0.6 | 60 | 0.494 | 0.833 |
| T | LOO | 0.6-0.8 | 12 | 0.662 | 0.750 |
| T | LOO | 0.8-1.0 | 1 | 0.829 | 0.000 |
| T | Stratified | 0.2-0.4 | 13 | 0.318 | 0.538 |
| T | Stratified | 0.4-0.6 | 12 | 0.508 | 0.917 |
| T | Team holdout | 0.2-0.4 | 12 | 0.330 | 0.667 |
| T | Team holdout | 0.4-0.6 | 12 | 0.470 | 0.917 |
| T | Team holdout | 0.6-0.8 | 5 | 0.629 | 1.000 |
| T | Tail diagnostic | 0.2-0.4 | 7 | 0.328 | 0.571 |
| T | Tail diagnostic | 0.4-0.6 | 7 | 0.518 | 1.000 |
| T | Tail diagnostic | 0.6-0.8 | 5 | 0.668 | 0.600 |
| CT | LOO | 0.2-0.4 | 7 | 0.376 | 0.429 |
| CT | LOO | 0.4-0.6 | 71 | 0.520 | 0.775 |
| CT | LOO | 0.6-0.8 | 21 | 0.644 | 0.857 |
| CT | Stratified | 0.2-0.4 | 3 | 0.349 | 0.333 |
| CT | Stratified | 0.4-0.6 | 13 | 0.514 | 0.923 |
| CT | Stratified | 0.6-0.8 | 4 | 0.695 | 0.750 |
| CT | Team holdout | 0.2-0.4 | 5 | 0.346 | 0.000 |
| CT | Team holdout | 0.4-0.6 | 15 | 0.538 | 0.867 |
| CT | Team holdout | 0.6-0.8 | 4 | 0.651 | 1.000 |
| CT | Tail diagnostic | 0.2-0.4 | 3 | 0.346 | 0.333 |
| CT | Tail diagnostic | 0.4-0.6 | 8 | 0.539 | 0.500 |
| CT | Tail diagnostic | 0.6-0.8 | 3 | 0.635 | 1.000 |

### Threshold provenance and remaining limits

`role-thresholds.ts` records units, sample counts and measured q10/q90 ranges used by both the evidence
display and rule-score widths. The reference population contains only player-map-side summaries with
at least 16 side rounds: 312 summaries, or 290 to 310 when a metric lacks a denominator. This selects
long halves. Evaluation folds refit q10/q90 from their training summaries only; degenerate fold ranges
fall back to the shared range because a zero-width score cannot be evaluated. Production retains the
full-corpus ranges. All decision ticks, the 55% Gaussian blend weight and softmax multiplier 4 remain
hand-chosen, without a threshold-tuning experiment.

Nearest-teammate distance uses 3D `Math.hypot(dx,dy,dz)` in `positioning.ts`. Its q10/q90 are
374.78/881.27 Source units across 300 summaries. Only 4/300 reach the retained 1,100-unit Lurker tick.
That tick is a conservative design choice, not a validated Lurker boundary. Site presence's 50% tick
and utility's 1.2-per-round tick also remain design choices despite lying outside their measured
q10/q90 ranges. No claim of optimal thresholds follows from these measurements.

IGL is not observable. Area changes remain unavailable, utility counts all throws rather than only
pre-contact throws, and overall side-weighted distributions have no separate calibration. Missing
Packer denominators still withhold the distribution even if loadout evidence exists. Unknown AWP
loadouts remain explicitly unknown, with zero AWPer mass rather than an inferred usage estimate.

Reproduction: `pnpm fit-roles <csv> --cache-write <private-summary-cache.json> --report <evaluation.json>`.
A later run can use `--cache-read` for the same summaries. The cache checks the derive version, not a
full parquet fingerprint; regenerate it after corpus changes. The report includes decision matrices,
all reliability bins, held teams, and per-fold map-count ranges. `pnpm identity-check <csv>` uses the
same label policy and evaluator, but measures agreement with the full-data production model.

## Families without ground truth: `pnpm family-check`

246 maps, 230 players with 60 or more rounds (43 AWPers). Per-player p10 / p50 / p90:

| Metric | p10 / p50 / p90 | AWPer / rifler median |
|---|---|---|
| reactionTime (ms) | 188 / 211 / 234 | 203 / 219 |
| timeToShot (ms) | 250 / 266 / 297 | 266 / 273 |
| crosshairPlacement (deg) | 3.12 / 4.08 / 5.13 | 3.18 / 4.32 |
| preAim (%) | 24.9 / 30.1 / 36.8 | 35.4 / 29.3 |
| firstBulletAccuracy (%) | 29.6 / 37.7 / 49.3 | 47.4 / 36.0 |
| counterStrafe (%) | 66.8 / 77.4 / 89.2 | 89.2 / 75.3 |
| sprayDeviation (deg) | 1.61 / 2.07 / 2.97 | 1.97 / 2.09 |
| shoulderPeekPct (%) | 7.7 / 10.3 / 13.4 | |
| jigglePeekPct (%) | 0.0 / 1.0 / 2.2 | |
| exposureBeforeShot (s) | 0.22 / 0.23 / 0.27 | |
| entryAttempts (%) | 3.1 / 6.4 / 11.2 | 4.1 / 6.9 |
| pushDepth (%) | 39.6 / 44.6 / 47.7 | 39.6 / 45.0 |
| firstContactTime (s) | 32.0 / 40.3 / 47.7 | 42.5 / 39.6 |
| smokeSights (per smoke) | 0.59 / 0.87 / 1.17 | |

The five players at the top of each measure (opening attempts, entry attempts, smokes per round,
counter-strafed first shots) fit their known roles; the research output that names them stays in the
private data folder. Entry players come out early and deep, AWPers late and shallow, and the in-game
leaders throw the most smokes.

Aim bounds (architecture.md: reaction 150 to 400 ms): pooled reaction median 203 ms, 60.3% of 15,818
within the range and 24.0% under; time to first shot median 266 ms, 65.0% of 44,173 within and 11.8%
under. Reactions under 150 ms most likely come from onsets the mesh reports late (it casts rays to eyes
and chests, so a shoulder shows first) and from anticipation. The architecture's aim acceptance (within
1 degree and 1 tick) needs scenario demos on the local server, which do not exist yet: a bot stepping
out at a scripted tick against a known crosshair offset, logged mouse deltas, scripted strafe and
counter-strafe sequences, full sprays at a stationary target, a bot strafing at known speed, and two
bots at a known angular separation.

Cached facts (the same command, on 403 maps, presence kept per player and side): a map's
`MatchFacts` JSON is 527 KB at the median and 1,187 KB at most. Median KB per part: per-player-round
rows (`pr`) 146, aim 96, kills 66, movement 47, presence 44, grenades 37, weapons 27, aggression 27,
information 17, rounds 15, utilq 3, players 1. Presence per player-round, at the same 128-unit cells,
was 119 KB at the median (600 KB facts) on 332 maps.

Time-to-damage cut (`aim.ts` TTD_MAX_S, the same command on 489 maps): of 55,903 pro times to damage,
2.9% are 1 s or more and the 95th percentile is 0.859 s, so Leetify's 1 s cut drops the stragglers and
keeps the body of the distribution. On that run a map's cached facts are 562 KB at the median (1,259 KB
at most): per-player-round rows 172, aim 102, kills 66, movement 47, presence 44 KB.

Radar spotting: 19,327 spotter-target seconds against 70,644 seconds of mesh line of sight on the
maps with both, so the information metrics measure radar state, not sight. Jiggle peeks are rare
because the mesh test sees eyes and chests, not shoulders.

## Utility: `pnpm utility-outcomes`

10,528 pro team-rounds on 246 maps. Logistic regression of the round win on one metric summed per
team-round, with one dummy per own-buy and opponent-buy cell and a CT dummy, standard errors clustered by
map; model B adds the team's grenades thrown, model C also both teams' seconds alive. Odds ratio per SD
[95% CI]:

| Metric | Buy and side | + thrown | + alive |
|---|---|---|---|
| flashKillsPerFlash | 1.57 [1.47, 1.68] | 1.56 [1.46, 1.66] | 1.19 [1.10, 1.29] |
| assistsPerFlash | 1.57 [1.50, 1.65] | 1.55 [1.48, 1.63] | 1.21 [1.13, 1.30] |
| dmgPerHe | 1.13 [1.08, 1.18] | 1.09 [1.04, 1.14] | 1.09 [1.01, 1.17] |
| smokeSights | 1.15 [1.10, 1.20] | 1.06 [1.00, 1.11] | 1.12 [1.05, 1.20] |
| smokesPR | 1.61 [1.48, 1.74] | 1.43 [1.31, 1.57] | 1.27 [1.13, 1.42] |
| molotovsPR | 1.54 [1.44, 1.65] | 1.32 [1.22, 1.43] | 1.17 [1.04, 1.31] |
| flashesPR | 1.30 [1.24, 1.37] | 1.10 [1.04, 1.16] | 0.99 [0.92, 1.07] |
| hesPR | 1.24 [1.17, 1.32] | 1.00 [0.93, 1.06] | 0.85 [0.77, 0.93] |
| utilUnused | 0.30 [0.27, 0.33] | 0.30 [0.28, 0.33] | 0.49 [0.45, 0.55] |
| grenadeDmgTaken | 0.90 [0.86, 0.94] | 0.89 [0.85, 0.93] | 0.94 [0.89, 1.00] |
| utilDmgPR (pruned) | 1.12 [1.07, 1.16] | 1.06 [1.01, 1.11] | 1.08 [1.01, 1.15] |
| enemiesPerFlash (pruned) | 1.03 [0.99, 1.07] | 0.93 [0.89, 0.98] | 1.02 [0.94, 1.11] |
| blindPerFlash (pruned) | 1.05 [1.01, 1.10] | 0.96 [0.91, 1.01] | 1.03 [0.96, 1.12] |
| teamFlashPR (pruned) | 1.11 [1.07, 1.16] | 1.04 [1.00, 1.10] | 1.02 [0.95, 1.09] |

Team-round correlations at |r| 0.6 or more: enemiesPerFlash and blindPerFlash 0.97, dmgPerHe and
utilDmgPR 0.88, flashKillsPerFlash and assistsPerFlash 0.66, smokesPR and molotovsPR 0.61. Pruned:
utilDmgPR (duplicates dmgPerHe), blindPerFlash (duplicates enemiesPerFlash), enemiesPerFlash and
teamFlashPR (no lasting link to winning). The four thrown counts stay as HLTV's identity metrics;
utilUnused stays with the caveat that it mostly measures dying early. The smoke candidates that
duplicated smokeSights (blocked seconds, kills prevented) and the molotov candidates were removed with
their code during development, so their figures are not reproducible here; no molotov metric is defined.

Rerun on 489 maps (21,026 team-rounds) after smoke and molotov usefulness were restored, odds ratio per
standard deviation of the team-round sum, with buy and side controls / plus grenades thrown / plus time
alive:

| Metric | buy+side | + thrown | + alive |
|---|---|---|---|
| smokeSights | 1.13 [1.10, 1.17] | 1.06 [1.03, 1.10] | 1.13 [1.08, 1.18] |
| smokeBlockedSecs | 1.07 [1.04, 1.10] | 1.02 [0.98, 1.05] | 1.09 [1.04, 1.13] |
| molotovEnemiesHit | 1.02 [0.99, 1.05] | 0.98 [0.95, 1.01] | 1.02 [0.98, 1.07] |
| molotovDmg | 1.01 [0.98, 1.04] | 0.98 [0.96, 1.01] | 1.01 [0.96, 1.05] |

smokeBlockedSecs tracks smokeSights closely (r 0.91 over team-rounds) and links to winning a little
more weakly; the molotov metrics show no link to winning once grenades thrown are controlled for. They
stay because the user asked for smoke and molotov usefulness by name; their link is weak, and this is
where that is said.

## Spray patterns: `pnpm recoil <weapons_out>`

The in-game spray pattern is each bullet's direction (fire_bullets) minus the view at weapon_fire, the
median over every pro shot with its gun's normal recoil (`shot-state.ts`: known unscoped shots, the
M4A1-S silenced, and unrecorded states left out) at that whole recoil index (`recoil-build.ts`). No
user shot enters it. A row needs 10 kick samples, and the generated prefix stops at the first bullet
below that count. The kick at one index is nearly fixed: over 489 pro maps its middle half is at most
0.16 degrees wide for every gun in the table below, and up to 0.30 for the short patterns (UMP-45
0.30, CZ75-Auto 0.26, MP5-SD 0.17, AUG 0.14). The ideal pull is minus the kick. The check: how far
the pros' median view movement over steady sprays from a reset sits from the ideal pull, per bullet
(2026-10-25, rebuilt from pro demos only after review of #34):

| Gun | Pattern bullets | Pro band bullets (sprays) | Mean residual, bullets 2 on | Largest |
|---|---|---|---|---|
| AK-47 | 30 | 29 (33,184) | 0.58 deg | 2.27 at bullet 29 |
| M4A4 | 30 | 29 (8,005) | 0.42 | 0.99 at 10 |
| M4A1-S (silenced) | 20 | 20 (13,756) | 0.40 | 0.89 at 10 |
| FAMAS | 25 | 15 (1,088) | 0.73 | 1.88 at 15 |
| Galil AR | 35 | 25 (4,654) | 0.59 | 1.48 at 22 |
| MAC-10 | 30 | 12 (458) | 0.49 | 0.83 at 8 |
| MP9 | 30 | 14 (1,125) | 0.94 | 2.44 at 12 |
| MP7 | 24 | 9 (180) | 0.86 | 1.82 at 9 |

The nine guns tracked for ENG-AIM-03 stop at these measured prefixes. The numbers in parentheses are
kick samples for the last published bullet. A dash means that even bullet 1 has fewer than 10 samples.

| Gun | Pattern bullets | Last published sample count | Why it stops |
|---|---:|---:|---|
| AUG | 7 | 13 | Unscoped samples fall below 10 at bullet 8. Scoped shots stay out of this unscoped reference, as they do in `shot-state.ts`, because zoom is a separate recoil state. |
| SG 553 | 0 | - | No normal-recoil SG 553 shot reaches the 10-sample threshold. |
| MP5-SD | 7 | 11 | Samples fall below 10 at bullet 8. |
| UMP-45 | 6 | 10 | Samples fall below 10 at bullet 7. |
| P90 | 0 | - | The first three bullets have only 4, 3, and 3 samples. |
| PP-Bizon | 0 | - | Only one sample exists at each of the first three indices. |
| M249 | 0 | - | No normal-recoil M249 shot exists in the pro tables. |
| Negev | 0 | - | No normal-recoil Negev shot exists in the pro tables. |
| CZ75-Auto | 7 | 10 | Samples fall below 10 at bullet 8. |

AUG and SG 553 use the same mode rule as the M4A1-S: the reference has one known firing state,
not a mixture of modes. For the M4A1-S that state is silenced. For scoped guns this app's normal
state is known unscoped fire, so scoped shots are excluded rather than combined with unscoped shots.
The plugin's v1.2.0 per-shot angles can add user evidence later, but they do not fill this pro-only
reference.

AK-47 bullets 2 to 9 sit within 0.6 degrees of the ideal pull in both axes, and the largest residual is
on the last bullets, where few sprays remain and the target has usually moved. The residual also holds
whatever the pros' view did besides fighting recoil. The user's own shots are never used to fill a
reference. No game cfg sets `weapon_recoil_scale`, and no demo checked
changes it in `server_cvar`, so the kick is at the game's default scale.

## Baselines: `pnpm baselines`

`public/baselines.json` is 391 KB: 21 quantiles of every metric for each pool and side, with no names or
ids. Built from 489 pro maps on 2026-10-25 with #17's merged parameters and swing from the HLTV
win-probability lookup (recorded as its `model` fingerprint, which model-dependent comparisons check): 552 players with 40 or more rounds (454 riflers, 98 AWPers), and per-map pools
of player-maps with 16 or more rounds. A metric's quantiles are written when at least 8 units have a
value. The named pack (per-side style and performance scores) is written to the
private data folder only.
