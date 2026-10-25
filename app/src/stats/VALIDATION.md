# Validation

What each family was checked against, and the numbers. Every figure here comes from a command in
`package.json`, run from `app/` with the private data folder present (`cs2-stats-data`, or set
`CS2_STATS_DATA`). The pro data was still growing during the run (HLTV demos, re-extracted to schema v1
overnight), so each section names the size of its run; rerunning gives the current figures. HLTV
ground truth is the private per-map JSON (733 maps). The targets are the acceptance table in
`design/architecture.md`.

## Scoreboard: `pnpm hltv-check`, `hltv-exact.test.ts`

Demo maps join HLTV maps by map, at least 7 shared player names, the same final score, then the
nearest date (`tools/hltv.ts`). 245 of 250 maps joined; the other five are halves of split recordings
(`-p1`, `-p2`), whose partial scores match no HLTV map.

| Column | Exact, of 2,450 player-maps | Target |
|---|---|---|
| Kills | 2,450 | exact |
| Deaths | 2,433 | exact |
| KAST | 2,281 (93.1%) | exact |
| ADR within 0.5 | 2,394 (97.7%) | within 0.5 |
| Headshot kills, multi-kill rounds | 2,450, 2,450 | |
| Traded deaths | 2,236 | |
| Opening kills, opening deaths | 2,433, 2,416 | |

107 of the 245 maps match for every player on K, D, KAST and ADR. `hltv-exact.test.ts` pins 24 of
them and checks kills on every joined map. Known misses: the ten demos recorded from round 1 live
disagree with HLTV's ADR in both directions while kills still match; elsewhere a few players miss ADR
by 0.6 to 0.9, low, which fits hits the extractor rebuilt without a unique attacker.

## Why these definitions: `pnpm scoreboard-variants`

Each candidate scored against HLTV on 2,410 player-maps (241 joined maps):

| Question | Candidate: exact matches |
|---|---|
| ADR damage | health removed (the game's own scoreboard): 1,184; the hurt event's damage capped at health: **2,354** |
| Deaths | every death: 2,361; every death except post-round suicides: **2,393** |
| Traded deaths | 5 s, every avenged death (CS Demo Manager): 1,528; 5 s, earliest only: 2,057; 5.4 s, every death: 1,576; 5.4 s, earliest only: **2,199** |
| KAST | 5.4 s earliest only, without flash assists: **2,245**; with flash assists: 2,010; 5 s every death without flash assists: 1,915 |

HLTV's round buy labels over every HLTV map: PISTOL $3,000 to $4,700 (2,932 team-rounds), ECO $800 to
$4,950 (1,794), HALF $5,000 to $16,200 (3,773), FULL $16,250 to $38,100 (23,469). The engine's cuts,
$1,000 and $3,250 per player, are those bands for five players.

## Rating 3.0 and swing: `pnpm rating-check`, `rating3.test.ts`

`rating3.test.ts`: the engine reproduces all 30 golden player-maps of `model/rating3/golden.json` to
1e-9. Against HLTV, every joined player-map (about 200 maps at the run):

| Input | MAE | Pearson r | Mean ours / HLTV |
|---|---|---|---|
| eKPR | 0.020 | 0.993 | 0.659 / 0.652 |
| eDPR | 0.023 | 0.980 | 0.659 / 0.674 |
| eADR | 3.08 | 0.984 | 73.1 / 71.2 |
| eKAST | 4.56 | 0.881 | 70.2 / 68.9 |
| Swing (points per round) | 1.01 | 0.953 | 0.00 / -0.02 |
| Rating 3.0 | 0.065 | 0.977 | 1.098 / 1.076 |
| Rating 3.0, CT rounds | 0.125 | 0.976 | 1.207 / 1.098 |
| Rating 3.0, T rounds | 0.086 | 0.976 | 1.058 / 1.066 |

Targets: swing r above 0.95 (met); rating MAE under 0.04 (not met) and r above 0.97 (met). These use
the map-level polynomial that `params.json` now marks as a retired diagnostic (`rating3()` reports
`diagnostic: true`) while the rating agent fits a per-round model. The largest errors are in eKAST,
whose transform `params.json` marks unresolved, and in per-side ratings, which HLTV does not compute by
applying the map model to one side's rounds.

## Plugin adapter: `plugin/adapter.test.ts`

Through `pluginToTables` and `derive`, kills, deaths and headshot kills match the game's own per-round
totals (`rounds.basic`, written by the server) on every covered player-round of the converted logs.

## Identity: `pnpm fit-roles <csv>`, `pnpm identity-check <csv>`

The CSV is Jamie Packer's `cs2_playstyle_roles_2024.csv` (CC BY 4.0).

Role model, leave-one-out on Packer's labelled pros: T 100 of 151 (66.2%), CT 102 of 151 (67.5%), against
44% and 47% for always guessing the most common role. Confusions sit between neighbours (Spacetaker
and Half-Lurker, Anchor and Mixed), as expected for graded roles.

Players in both Packer's 2024 data and our October 2026 demos, with 20+ rounds on the side: our top role
matches his label for 50 of 82 on T and 40 of 82 on CT, and AWPer status agrees for 19 of 25. Spacing
ranks correlate at r 0.47 and 0.56 on T and 0.30 and 0.34 on CT, with equal means (0.60 against 0.59
to 0.60); time alive 0.38 and opening attempts 0.44 on T; trade percentages near 0. Two years and small
samples separate the datasets, so these measure style stability as much as feature agreement.

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

Top players: opening attempts bobeksde, insani, doc, flouzer, YEKINDAR; entry attempts bobeksde, flameZ,
tabseN, YEKINDAR, FL1T; smokes per round Aleksib, kyxsan, ztr, magixx, MisteM; counter-strafed first
shots m0NESY, afro, MoDo, frontales, gr1ks. Entry players come out early and deep, AWPers late and
shallow, and the in-game leaders throw the most smokes.

Aim bounds (architecture.md: reaction 150 to 400 ms): pooled reaction median 203 ms, 60.3% of 15,818
within the range and 24.0% under; time to first shot median 266 ms, 65.0% of 44,173 within and 11.8%
under. Reactions under 150 ms most likely come from onsets the mesh reports late (it casts rays to eyes
and chests, so a shoulder shows first) and from anticipation. The architecture's aim acceptance (within
1 degree and 1 tick) needs scenario demos on the local server, which do not exist yet: a bot stepping
out at a scripted tick against a known crosshair offset, logged mouse deltas, scripted strafe and
counter-strafe sequences, full sprays at a stationary target, a bot strafing at known speed, and two
bots at a known angular separation.

Cached facts (the same command, rerun on 332 maps after presence facts were added at 128-unit cells):
a map's `MatchFacts` JSON is 600 KB at the median and 1,383 KB at most; presence is 119 KB of that at
the median and 250 KB at most.

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
| flashKillsPR | 1.57 [1.47, 1.68] | 1.56 [1.46, 1.66] | 1.19 [1.10, 1.29] |
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
utilDmgPR 0.88, flashKillsPR and assistsPerFlash 0.66, smokesPR and molotovsPR 0.61. Pruned:
utilDmgPR (duplicates dmgPerHe), blindPerFlash (duplicates enemiesPerFlash), enemiesPerFlash and
teamFlashPR (no lasting link to winning). The four thrown counts stay as HLTV's identity metrics;
utilUnused stays with the caveat that it mostly measures dying early. The smoke candidates that
duplicated smokeSights (blocked seconds, kills prevented) and the molotov candidates were removed with
their code during development, so their figures are not reproducible here; no molotov metric is defined.

## Baselines: `pnpm baselines`

`public/baselines.json` is 340 KB: 21 quantiles of every metric for each pool and side, with no names or
ids. Built from every pro map on 2026-10-25: 214 players with 40 or more rounds (174 riflers, 40
AWPers), and per-map pools of player-maps with 16 or more rounds. A metric's quantiles are written when
at least 8 units have a value. The named pack (per-side style and performance scores) is written to the
private data folder only.
