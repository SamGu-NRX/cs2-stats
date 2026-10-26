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
median over every unscoped shot at that whole recoil index (`recoil-build.ts`). The kick at one index
is nearly fixed: over 489 pro maps its middle half is at most 0.15 degrees wide for every gun with a
pattern. The ideal pull is minus the kick. The check: how far the pros' median view movement over
steady sprays from a reset sits from the ideal pull, per bullet (2026-10-25):

| Gun | Pattern bullets | Pro band bullets (sprays) | Mean residual, bullets 2 on | Largest |
|---|---|---|---|---|
| AK-47 | 30 | 29 (33,184) | 0.58 deg | 2.27 at bullet 29 |
| M4A4 | 30 | 29 (8,005) | 0.42 | 0.99 at 10 |
| M4A1-S | 20 | 20 (13,757) | 0.40 | 0.89 at 10 |
| FAMAS | 25 | 15 (1,088) | 0.73 | 1.88 at 15 |
| Galil AR | 35 | 25 (4,654) | 0.59 | 1.48 at 22 |
| MAC-10 | 30 | 12 (458) | 0.49 | 0.83 at 8 |
| MP9 | 30 | 14 (1,125) | 0.94 | 2.44 at 12 |
| MP7 | 24 | 9 (180) | 0.86 | 1.82 at 9 |

AK-47 bullets 2 to 9 sit within 0.6 degrees of the ideal pull in both axes, and the largest residual is
on the last bullets, where few sprays remain and the target has usually moved. The residual also holds
whatever the pros' view did besides fighting recoil. AUG (7 bullets), MP5-SD (8), UMP-45 (6) and
CZ75-Auto (7) have short patterns, and SG 553, P90, PP-Bizon, M249 and Negev have none: the demos
hold too few unscoped shots of them. No game cfg sets `weapon_recoil_scale`, and no demo checked
changes it in `server_cvar`, so the kick is at the game's default scale.

## Baselines: `pnpm baselines`

`public/baselines.json` is 391 KB: 21 quantiles of every metric for each pool and side, with no names or
ids. Built from 489 pro maps on 2026-10-25 with #17's merged parameters and swing from the HLTV
win-probability lookup (recorded as its `model` fingerprint, which model-dependent comparisons check): 552 players with 40 or more rounds (454 riflers, 98 AWPers), and per-map pools
of player-maps with 16 or more rounds. A metric's quantiles are written when at least 8 units have a
value. The named pack (per-side style and performance scores) is written to the
private data folder only.
