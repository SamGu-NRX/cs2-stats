# Validation

What each family was checked against, and the numbers. The acceptance table in
`design/architecture.md` sets the targets. Pro data: HLTV demos extracted to schema v1 tables
(`cs2-stats-data/demos`), growing during the run; each section names its run's map count. HLTV ground
truth: the private per-map JSON (`cs2-stats-data/hltv`, 733 maps). Commands are in `package.json`.

## Scoreboard (gate): `pnpm hltv-check`, `hltv-exact.test.ts`

Demo maps join HLTV maps by map, at least 7 shared player names, the same final score, then the
nearest date (`tools/hltv.ts`). 194 of 199 maps joined; the five that did not are halves of split
recordings (`-p1`, `-p2`), whose partial scores match no HLTV map.

| Column | Exact on 1,940 player-maps | Target |
|---|---|---|
| Kills | 1,940 | exact |
| Deaths | 1,926 | exact |
| KAST | 1,809 (93.2%) | exact |
| ADR within 0.5 | 1,884 (97.1%) | within 0.5 |
| Headshot kills, multi-kill rounds | 1,940, 1,940 | |
| Traded deaths | 1,768 | |
| Opening kills, opening deaths | 1,926, 1,912 | |

83 of the 194 maps match for every player on K, D, KAST and ADR. `hltv-exact.test.ts` pins 24 of them
and checks kills on every joined map.

How the definitions were found (44-map run, 440 player-maps, scored against HLTV):

| Question | Candidates | Result |
|---|---|---|
| Which kills count | enemy kills; excluding post-round kills | enemy kills including post-round: 360/360 |
| Which deaths count | all; without post-round non-enemy deaths | all except post-round suicides; HLTV dropped 4 of 4 post-round suicides and kept post-round bomb deaths |
| ADR damage | health removed (the game's scoreboard); per-hit reported damage capped at health | health removed 157/440 within 0.5, reported damage 398/440. A least-squares fit put the gap at 0.31 HP per non-lethal hit and 0 per lethal hit, which is the hurt event dropping fractional damage. |
| Trade window and pairing | 2 to 10 s; credit every avenged death, the latest, or the earliest | earliest within 5.4 s: traded deaths 308/340, KAST 317/340 (5 s with every death: 211 and 268) |
| KAST assists | the game's assister; plus flash assists; plus anyone with 41+ damage | damage assister only, flash assists left out: 316/340 against 281 with them |

Known misses: the ten demos recorded from round 1 live disagree with HLTV's ADR in both directions
while kills still match (left out of the gate); about a dozen maps outside them miss ADR by 0.6 to 0.9,
low, consistent with hits the extractor rebuilt without a unique attacker; one G2 vs 1win map has four
players with one extra death each.

## Buy classes

HLTV labels each team's round with its equipment and class. Over 733 HLTV maps (about 32,000
team-rounds): ECO $800 to $4,950, HALF $5,000 to $16,200, FULL $16,250 to $38,100, PISTOL $3,000 to
$4,700. The engine's cuts are $1,000 and $3,250 per player. Our freeze-end team equipment reproduces
HLTV's shown values where checked (pistol round, Astralis vs FaZe Ancient: $4.3K and $4.25K both sides).

## Rating 3.0 and swing: `pnpm rating-check`, `rating3.test.ts`

`rating3.test.ts`: the engine's polynomial reproduces all 30 golden player-maps of
`model/rating3/golden.json` to 1e-9.

Against HLTV on every joined player-map of the final run (about 200 maps):

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

These ratings use the map-level polynomial, which `params.json` now marks as a retired diagnostic
(`rating3()` reports `diagnostic: true`); the per-round model that replaces it is still being fitted.

Targets: swing r above 0.95 (met), rating MAE under 0.04 and r above 0.97 (r met, MAE not). The error
comes from the eco inputs, eKAST most (`params.json` marks its transform unresolved), and from per-side
ratings: HLTV's side ratings are not the overall model applied to one side's rounds (CT runs 0.11 high).
Both belong to the rating fit (`feat/rating3-fit`), not to the engine.

## Plugin adapter: `plugin/adapter.test.ts`

Through `pluginToTables` and `derive`, the converted logs reproduce the game's own per-round totals
(`rounds.basic`, written by the server) on 759 of 760 player-rounds for kills, deaths, assists,
headshots and damage within 3 HP. The miss is one assist the game counts and CS2's single assister
does not. The test asserts kills, deaths and headshots on every covered round.

## Identity: `pnpm fit-roles`, `pnpm identity-check`

Role model, leave-one-out on Jamie Packer's labelled pros (2024): T 100/151 (66.2%), CT 102/151 (67.5%),
against 44% and 47% for always guessing the most common role. Confusions sit between neighbours
(Spacetaker and Half-Lurker, Anchor and Mixed), as expected for graded roles.

Players in both Packer's 2024 data and our October 2026 demos (125 players, 20+ rounds on the side):
our top role matches his label for 50 of 82 labelled players on T (61%) and 40 of 82 on CT (49%), and
AWPer status agrees for 19 of 25. Feature correlations: spacing ranks r 0.47 and 0.56 on T, 0.30 and
0.34 on CT; time alive 0.38 and opening attempts 0.44 on T; trade percentages near 0. Mean spacing ranks
agree (0.60 against 0.59 to 0.60) once tied distances share a rank. Two years and small samples separate the datasets, so
these measure style stability as much as feature agreement.

Face validity on the baselines' 155 players: the AWPer pool is the known AWPers (device, s1mple, sh1ro,
w0nderful, torzsi, Jame, MoDo, phzy, m1n1, among 29); donk, bobeksde and dwushka lead opening attempts;
Aleksib throws the most smokes.

## Aim

164 pro maps (121 v1, 119 with visibility), 39,212 sightings, 150 players with 100 or more. Per-player
values are p10 / p50 / p90.

| Metric | Result | Bound or check |
|---|---|---|
| Reaction | pooled median 203 ms; players 188 / 211 / 234 ms | 60.5% within 150 to 400 ms, 23.9% under, 15.6% over. Target: within 150 to 400 ms. |
| Time to first shot | median 266 ms | 65.2% within 150 to 400 ms |
| Crosshair placement | pooled median 3.99 degrees; players 3.17 / 4.07 / 5.30 | AWPers 3.25 against riflers 4.10; best device 2.2, ZywOo 2.8, m0NESY 2.8 |
| Accuracy | AK 15.6%, M4A1-S 18.3%, AWP 48.9% | |
| First-bullet accuracy | AK 35.8%, AWP 67.3% | AWPers 46.4% against riflers 37.5% |
| Counter-strafed first shots | rifles 71 to 76%, AWP 97.8% | |
| Spray path vs pros | AK 2.31 degrees, M4A1-S 1.84 | relative only; the asset is not approved for scoring |

Reactions under 150 ms most likely come from onsets the mesh reports late (eye or chest rays only, so a
shoulder shows first) and from anticipation. The architecture's aim acceptance needs scenario demos on
the local server, which do not exist yet. They need: a bot stepping out at a scripted tick against a
known crosshair offset, logged mouse deltas, scripted strafe and counter-strafe sequences, full sprays at
a stationary target, a bot strafing at known speed, and two bots at a known angular separation.

## Movement, aggression, information

139 pro maps, 180 players with 60 or more rounds.

- Entry players come out early and deep: donk and bobeksde top entry attempts (31.0, 36.6) and have the
  earliest first-contact rank (2.04, 2.21); push depth about p90.
- AWPers come out low and shallow: all below the median on entry attempts and push depth; Spearman
  between push depth and AWP kills per round -0.46.
- Against HLTV-style opening attempts: Spearman 0.57 (entry attempts), -0.72 (first contact rank), 0.50
  (push depth).
- Jiggle peeks are about 1% of peeks, likely because the mesh test sees eyes and chests, not shoulders.
  Exposure before the first shot barely spreads between players (0.22 to 0.27 s).
- Radar spotting is sparse in GOTV demos (9,461 s spotted against 33,331 s of mesh line of sight on 97
  maps), so the information metrics rank sensibly but measure radar state, not sight.

## Utility quality

Round-outcome analysis on 5,956 pro team-rounds (140 maps): logistic regression of the round win on one
metric summed per team-round, controlling for both buy classes and side, standard errors clustered by
map; model B adds grenades thrown, model C adds both teams' alive time. Odds ratio per SD [95% CI]:

| Metric | Buy and side | + thrown | + alive | Kept |
|---|---|---|---|---|
| flashKillsPR | 1.52 [1.40, 1.65] | 1.52 [1.39, 1.65] | 1.19 [1.07, 1.32] | yes |
| assistsPerFlash | 1.51 [1.42, 1.60] | 1.50 [1.41, 1.59] | 1.17 [1.07, 1.28] | yes |
| dmgPerHe | 1.13 [1.07, 1.19] | 1.09 [1.02, 1.16] | 1.10 [1.00, 1.21] | yes |
| smokeSights | 1.14 [1.07, 1.22] | 1.04 [0.97, 1.12] | 1.13 [1.02, 1.26] | yes |
| utilDmgPR | 1.11 [1.05, 1.18] | 1.04 [0.98, 1.11] | 1.08 [0.99, 1.18] | no: duplicates dmgPerHe (r 0.87) |
| enemiesPerFlash | 1.01 [0.96, 1.07] | 0.92 [0.86, 0.99] | 1.08 [0.97, 1.21] | no |
| blindPerFlash | 1.04 [0.98, 1.10] | 0.95 [0.89, 1.02] | 1.09 [0.98, 1.22] | no: duplicates enemiesPerFlash (r 0.97) |
| teamFlashPR | 1.12 [1.06, 1.18] | 1.05 [0.98, 1.12] | 1.02 [0.93, 1.12] | no |
| utilUnused | 0.30 [0.28, 0.32] | 0.31 [0.29, 0.34] | 0.48 [0.43, 0.53] | yes, mostly measures dying early |
| grenadeDmgTaken | 0.90 [0.85, 0.95] | 0.89 [0.84, 0.95] | 0.95 [0.87, 1.03] | yes, HLTV parity |
| smokesPR, molotovsPR | 1.68, 1.65 | 1.49, 1.44 | 1.33, 1.28 | yes (HLTV identity counts) |

smokeSights: 66% of 13,780 smokes block no sightline; per player p10 0.56, median 0.82, p90 1.15;
split-half reliability 0.52 at about 134 smokes, so a player's value needs several hundred smokes.

## Baselines: `pnpm baselines`

`public/baselines.json` is 340 KB: 21 quantiles of every metric for each pool and side, with no names
or ids. Built from every pro map on 2026-10-25: 214 players with 40 or more rounds (174 riflers, 40
AWPers), and per-map pools of player-maps with 16 or more rounds (Ancient 190, Anubis 170, Cache 350,
Dust2 360, Inferno 190, Mirage 430, Nuke 230 on both sides). A metric's quantiles are written when at
least 8 units have a value. The named pack (214 players, per-side style and performance scores) is
written to the private data folder only.
