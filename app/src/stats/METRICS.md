# Metrics

Every metric the engine computes, with its definition, every threshold and where the threshold came
from. `metrics.ts` holds the same list as code; `VALIDATION.md` holds the checks. "Ours" marks a choice
with no published source; "no fit" means no data run picked the number.

Every metric also has a tooltip (`tip`): one sentence of 12 words or fewer in a player's words. A
metric with a sample minimum (`sample.min`) is pooled only over pros who meet it, so its quantiles never
rest on a thin sample; a value under the minimum is still shown, with the count.

Each metric is **performance** (how well) or **identity** (how you play), following
`design/identity.md`. Identity metrics have no better or worse; their percentiles say how much more of
a habit a player has than the pool. Status is **exact** (a direct count, or checked against HLTV),
**approx** (our reading of an unpublished definition) or **unavailable** (the tables cannot support it).

## Shared rules

| Rule | Definition | Source |
|---|---|---|
| Enemy kill | Killer and victim on different sides at the kill, including kills after the round ended | HLTV's K (VALIDATION.md) |
| Death | Every death except a suicide after the round ended | HLTV's D (VALIDATION.md) |
| Hit damage (ADR) | The hurt event's damage, capped at the victim's health before the hit. A hit the extractor rebuilt from a health drop uses the health removed. | HLTV's figure; the game's own scoreboard counts health removed instead |
| Trade | A kill on a player who killed one of the killer's teammates within 5.4 s; it trades only the earliest such death | Window and pairing chosen against HLTV's traded deaths and KAST |
| Opening duel | The round's first enemy kill | HLTV's Op.K-D |
| Buy class | Team equipment at freeze end per player: under $1,000 eco, $3,250 or more full, half in between; the first round of each regulation half is pistol | The bands of HLTV's round labels (VALIDATION.md) |
| AWPer comparison pool | Above 0.20 AWP kills per round, independent of the identity distribution | `compare.ts`, `roleOf`; existing performance-pool rule |
| AWPer identity share | Measured AWP rounds: the share of recorded freeze-end loadouts carrying an AWP. Missing loadouts give `awp: null` and zero AWPer mass, not a measured zero. No softmax or calibration changes known AWP mass. | `identity.ts`; `role-thresholds.ts` retains a separate hand-chosen 20% display tick |

## Rating and scoreboard (performance)

| id | HLTV name | Status | Definition |
|---|---|---|---|
| rating3 | Rating 3.0 | approx | `model/rating3/SPEC.md`. A linear model in eco-adjusted KPR, ADR, DPR and KAST, raw multi-kill % and swing: `params.json` `rating.intercept` plus `rating.coefficients` times each input (ordinary least squares on HLTV's displayed inputs, PR #17). `rating3.ts` throws on any other `rating.basis`. Per side it is the rating of that side's rounds (`rating3BySide`); the total is the side inputs weighted by each side's rated rounds (`rating3Of`), so a side too thin to rate adds nothing. |
| rounds2k, rounds3k, rounds4k, rounds5k | | exact | Share of rounds with exactly 2, 3 or 4 kills, and with 5. As metrics they have pro quantiles in every pool; the 50th is the pros' median. |
| kpr, dpr, adr, kast, mk, hs | KPR, DPR, ADR, KAST, Multi-kill | exact | Per round over the shared rules. KAST counts a kill, a damage assist (flash assists left out), survival or a traded death. Each KAST round is also credited to the first of those that earned it, so the parts sum to KAST: `killRounds + kastA + kastS + kastT`. |
| ecoKpr | Eco-adjusted KPR | approx | Rating 3.0's own `kpr_eco` input: kills weighted by the duel's economy (kill points), per rated round. It shares `rating3Of`, so the row and the rating breakdown cannot disagree. |
| swing | Round swing | approx | `swing.ts`: each kill's and plant's change in win probability (HLTV's lookup from the private pack when installed, else the CS2RB round model, which also reads the living players' health, team equipment and time; `model-params.ts`), with the victim charged the drop and the gaining side credited by damage share, else the killer. The round-end remainder goes to winners by weight (clutcher 1, players with kill swing 2, defuser 1, survivors 1, from `params.json`) and is charged equally to the losing side's survivors (all losers when none survived; ours). An eligible flash (the gaining side's, still blinding the victim at the kill, not the killer's, a team flash or an ambiguous one) takes `params.json`'s flash share first. |

Swing by source (`swing.ts` `swingSources`, the worker's `Rolled.swingSources`): every swing credit is also
filed under one source, so the six sum to swing. Kills is the killer's own share of a kill that was not a
trade, trades the same for a trade kill, damage a share of a teammate's kill earned by damage on the
victim, flashes the flash share (flashSwing), deaths the charge to the victim, and round end the
remainder shared at the round's end. Each is in percent per valued round, like swing.

Eco adjustment (`rating3.ts`): a player's duel group comes from the best primary held at the kill,
else their equipment value; a kill is worth `k (1 - P(killer wins))` from the Bradley-Terry table in
`params.json`, and the death is charged the same. Without a primary, equipment bands decide: $2,400
tier-2 rifle, $1,600 SMG, $800 upgraded pistol, else starter pistol. Each band starts at the cheapest
loadout of its group with kevlar and the $200 pistol (ours; `params.json` has no bands).

## HLTV's attributes

Firepower is performance; the other six are identity. Scores are the mean percentile of the four (eight
for Firepower) metrics against the role pool (`compare.ts`). Sniping always compares with everyone.

### Firepower (performance)
| id | HLTV name | Status | Definition |
|---|---|---|---|
| killsPerWin | Kills per Round Win | exact | Kills in won rounds per won round |
| rws | Round Win Shares | approx | In won rounds, your share of your team's positive swing; 20% is an even share |
| perfectKpr | Perfect Kills per Round | approx | Kills where the victim had not damaged you earlier in the round |
| tradeDenials | Trade Denials per Round | approx | Kills less than 5 s after your previous kill in the round (SPEC.md) |
| killRounds, mkRounds | Rounds with a Kill, with a Multi-Kill | exact | Share of rounds |
| netKills24 | Net Kills per 24 Rounds | exact | (kills - deaths) x 24 / rounds |
| netDamage | Net Damage per Round | approx | Damage dealt to enemies minus damage taken from enemies, per round |

Firepower includes pistol rounds. The pistol-round line is any metric over `rollup` with
`ownBuy: ["pistol"]`.

### Entrying, Trading, Opening, Closing, Sniping, Utility (identity)
| id | HLTV name | Status | Definition |
|---|---|---|---|
| tradeableDeaths | Tradeable Deaths per Round | approx | Deaths with a living teammate within 1,000 units (2D), per round with positions. 1,000 is ours, no fit. |
| deathsTradedPct | Deaths Traded % | exact | Traded deaths over deaths |
| baitAssists | Bait Assists per Round | approx | Traded deaths per round: you drew the enemy out |
| openingTradedPct | Opening Deaths Traded % | exact | Traded opening deaths over opening deaths |
| tradeOpps | Trade Opportunities per Round | approx | Teammate deaths within 1,000 units of you while you lived, per round with positions |
| tradeKillsPct | Trade Kills % | exact | Trade kills over kills |
| baitKillsPct | Bait Kills % | approx | Kills less than 5 s after a teammate died, on any enemy (ours; HLTV's rule is unpublished) |
| assistedKillsPct | Assisted Kills % | exact | Kills where a teammate got the assist |
| openingAttempts | Opening Attempts | exact | Rounds in the opening duel |
| firstDuelRank | First Duel Rank in Team | approx | Your place among teammates in first dealing or taking enemy damage, averaged |
| firstDuelTime | First Duel Time | approx | Seconds after freeze end of that first damage |
| weaponAttacks | Weapon Attacks per Round | approx | Gun shots fired per round |
| timeAlive | Time Alive per Round | exact | Freeze end to your death or the round end |
| alivePostPlant | Alive for Post-Plant % | approx | Planted rounds where you were alive at the plant |
| lastAlive | Last Alive in Team | approx | Rounds where you were at some moment the only one of your side alive, a teammate's mid-round disconnect counting as a death. Before any death this reads the round's rows, so it counts only when they are a freeze-end snapshot; in a round recorded live it starts with a death, as clutches do |
| clutches24 | Clutches per 24 Rounds | exact | 1vX clutches won per 24 rounds (CS Demo Manager's detection, with the alive counts read at freeze end as well as after each death and each mid-round disconnect of a living player, so a side that starts a round with one player is in a clutch before any kill and a disconnect can start one; a player the source marks dead at freeze end, or who disconnected at or before it, is not counted) |
| roundsWithSniper, roundsWithAwp | Rounds with a Sniper, with an AWP | approx | Rounds you carried one at freeze end or killed with one |
| sniperKillsPct, awpKillsPct | Sniper Kills %, AWP Kills % | exact | Share of kills |
| smokesPR, flashesPR, molotovsPR, hesPR | Smokes, Flashbangs, Molotovs, HE Grenades Thrown per Round | exact | Throws per round (molotovs include incendiaries) |

Restored from main's unscored rows (E20): shown under the attributes, not part of any score.

| id | Status | Definition |
|---|---|---|
| failedTradesPR | approx | Deaths less than 5 s after a teammate's death to the same enemy, per round |
| baitKillsPR | approx | Kills less than 5 s after a teammate died, on any enemy, per round (ours; HLTV's rule is unpublished) |
| flashAssistsPR | exact | The game's flash assists per round |
| clutchPointsPR | approx | Won 1vX clutches weighted by X (1v1 = 1, 1v3 = 3), per round; the weighting is main's, no fit |
| tradeAssistShare | exact | Trade kills plus assists (flash assists included), over kills plus assists; the role card's Support signal reads it against main's 45% |
| teamDistance | exact | Mean 3D distance to your nearest teammate (`nearestDistSum` over `spacingSamples`): sampled every 3 s from 10 s after freeze end until the plant, while all five of your side are alive (`positioning.ts`). The role card's Lurker sentence reads it on T against 1,100 units, a hand-chosen tick recorded with the pro-corpus quantiles in `role-thresholds.ts`. |

### HLTV's "how good" metrics (performance)
| id | HLTV name | Status | Definition |
|---|---|---|---|
| tradeKillSuccess | Trade Kill Success % | approx | Trade opportunities where you killed the killer within 5.4 s |
| tradedDeathSuccess | Traded Death Success % | approx | Traded deaths among tradeable deaths, over tradeable deaths. Both counts need positions, so a match without them adds to neither. |
| openingSwing, clutchSwing, awpSwing | Opening, Clutch, AWP Swing | approx | Swing from opening kills and deaths; from kills and deaths after you became your side's last player; from AWP kills and deaths holding the AWP. Per round. |
| awpDuelWin | AWP Duel Win % | approx | Your AWP kills over AWP kills plus deaths holding the AWP |
| flashSwing | Flash Swing | approx | Swing your flashes earned: a kill on an enemy your flash was still blinding gives you `params.json`'s flash share (0.154) of its credit; several flashers split it equally (ours) |
| assistsPerFlash | Assists per Flash | approx | The game's flash assists per flashbang thrown |
| grenadeDmgTaken | Grenade Damage Received | exact | Enemy grenade and fire damage you took, per round |
| dmgPerHe | Damage per HE Thrown | exact | Enemy HE damage per HE thrown |
| oneVsOne | 1v1 win rate | exact | 1v1 clutches won |
| openingWinPct | Rounds won after an opening kill | exact | Rounds your team won, of the rounds where you made the opening kill |
| perfectKillsPct | Perfect kills % | approx | Share of your kills where the victim had not damaged you earlier in the round (`perfectKpr` as a share of kills) |

## Utility quality (performance)

Flash rules are Leetify's (`research-data-sources.md`): an enemy counts as flashed above 1.1 s of
blind, and a flash-to-kill is a flashed enemy dying to the team while still blind.

| id | Status | Definition |
|---|---|---|
| flashKillsPerFlash | exact | Flash-to-kills per flashbang thrown (Leetify's rate) |
| utilUnused | approx | Value of grenades you held at freeze end and had not thrown when you died, per death (Leetify's rate). Grenades picked up later are not seen. Unmeasured, not $0, for sources without inventories. |
| smokeSights | approx | Enemy sightlines blocked per smoke thrown (`utilq.ts`). A sightline is the onset of a directed engagement (`first_visible_tick`); one that opened through a smoke (`smoke_blocked`) counts for the smoke(s) whose sphere crosses it, split equally, and only for a smoke thrown by the victim's team. Smoke model: the extractor's, a sphere of radius 144 centred 60 units above the detonation (awpy 3.1.1 defaults). Needs v1 maps with visibility. |
| smokeBlockedSecs | approx | Seconds an enemy's mesh line of sight to your team ran through your smoke (same sphere, engagement ticks with mesh visibility and the smoke flag), per smoke; shared among smokes crossing the line, credited only to the hidden team's smokes. |
| molotovEnemiesHit | approx | Distinct enemies your molotov or incendiary damaged, per one thrown. Ours. |
| molotovDmg | approx | Enemy fire damage per molotov thrown. Ours. |

The user asked for smoke and molotov usefulness by name, so those metrics stay whatever their link to
round wins; VALIDATION.md states the link. **Pruned from performance**, on a round-outcome analysis of pro team-rounds (`pnpm utility-outcomes`;
numbers in VALIDATION.md): blindPerFlash and utilDmgPR duplicated enemiesPerFlash and dmgPerHe;
enemiesPerFlash and teamFlashPR showed no lasting link to winning; two smoke variants duplicated
smokeSights; no molotov candidate earned a place. Kept with caveats: grenadeDmgTaken (HLTV parity),
utilUnused (now per death; per round it mostly measured dying early).

### Descriptive utility (identity)

The pruned flash and damage counts stay as description: what a player's utility did, with no claim
that more is better. They are identity metrics, so no view scores them or lists them under "Work on".

| id | Status | Definition |
|---|---|---|
| enemiesPerFlash | exact | Enemies blinded for more than 1.1 s per flashbang thrown |
| blindPerFlash | exact | Seconds of enemy blindness (blinds over 1.1 s) per flashbang thrown |
| teamFlashPR | exact | Teammates blinded for more than 1.1 s, per round |
| utilDmgPR | exact | Enemy damage from your grenades and fire, per round |
| fireDmgPR | exact | Enemy damage from your molotovs and incendiaries, per round |
| utilSpentPR | exact | Money spent on grenades per round, less refunds in the buy zone, over rounds with the purchases table |

## Aim (performance unless noted)

Inputs: engagement windows, `shots` and `damages`. Radar spotting is never used for aim. A **sighting**
is the first tick of an engagement where the victim is mesh-visible and not smoke-blocked after a tick
where they were not, within CS2's fixed 90-degree field of view on 4:3 (45 degrees of yaw, 36.87 of
pitch). Ticks after either player's death are cut. Needs v1 maps with visibility.

| id | Status | Definition and thresholds |
|---|---|---|
| timeToDamage | approx | Median time from sighting to your first damage on the victim while he stays visible; values of 1 s or more are left out (Leetify's cut; the pros' share above it is in VALIDATION.md) |
| timeToKill | approx | Median time from sighting to your kill on the victim while he stays visible |
| reactionTime | approx | Median time from sighting to the start of the movement that halves the aim error within 1 s. The movement must peak at 60 deg/s or more (well above idle view drift; ours, no fit); it starts at the first tick holding 10% of that peak. Sightings within 2 degrees of the head, or with the turn already under way, are left out. 0.5 and 1 s: ours, no fit. |
| timeToShot | approx | Median time from sighting to the first shot, leaving out sightings with a shot in the previous 0.3 s (ours: the spray reset spacing, `aim.ts` RESET_GAP_S) |
| crosshairPlacement | approx | Median angle between the view and the victim's eye at sighting |
| crosshairMoved | approx | Median angle the view turned from sighting to the first damage (Leetify reports it beside the static error) |
| preAim | approx | Share of sightings with placement 2 degrees or less (ours: about a player's width at 1,000 units). Its percentile against the pros is the "better or worse than baseline" reading. |
| flickOvershoot | approx | Median distance past the head, along the flick's direction, during the reaction flick |
| microCorrections | approx | Movements (view speed rising through 20 deg/s) between the flick's end and the first shot, or 0.5 s without one, per flick. Ours, no fit. |
| trackingError | approx | Mean angle to the eye while tracking: from 2 degrees or less until 10 degrees or lost sight, on ticks where the sightline turns at 10 deg/s or more. Ours, no fit. |
| accuracy | exact | Gun shots with an enemy hit on the same tick, over gun shots. Per gun with the weapon filter. |
| sightAccuracy | approx | Hits per shot fired while an enemy was visible within 30 degrees of the shot (the extractor's shot trigger) |
| headAccuracy | exact | Gun hits on the head, of all your gun hits on enemies; a hit the game files under no body part counts in the total only |
| adjustedAccuracy | approx | Accuracy at visible enemies without the shots fired on a tick where your kill went through a wall or object (the game's penetration flag); a kill shot with no recorded penetration is set aside |
| sprayAccuracy | approx | Hits per bullet 4 and later of a spray fired at an enemy mesh-visible within 30 degrees |
| shotsThroughSmoke | approx, identity | Gun shots fired while every enemy mesh-visible within 30 degrees stood behind a smoke (the extractor's smoke spheres), of your gun shots on maps with mesh visibility; null without mesh visibility |
| firstBulletAccuracy | approx | Hits per first bullet at a visible enemy. A first bullet has recoil index 0 to 0.01 and comes 0.3 s or more after the previous shot (ours, `aim.ts` RESET_RECOIL and RESET_GAP_S). |
| counterStrafe | approx | Rifle and sniper first bullets fired on the ground at or under 34% of the gun's max speed (NextFrag via `research-data-sources.md`; max speed is `m_flMaxSpeed` from the weapons vdata, scoped speed for scoped guns) |
| csTooEarly, csLateReversal, csNoStop | approx, identity | Among inaccurate first bullets: no stop when at or above the peak speed of the previous 0.25 s or above 90% of it; late reversal when moving against the peak's direction; too early otherwise. 0.25 s and 0.9: ours. |
| sprayDeviation | approx, identity | Mean per-bullet distance between your view change from bullet 1 and the ideal pull, the mirror of the game's own recoil kick (`recoil-ref.ts`), for the bullets the in-game pattern covers. The kick is each bullet's direction (fire_bullets) minus the view at weapon_fire, the median over every shot at that whole recoil index in 489 pro maps `pnpm recoil` (`recoil.ts`); a gun pros spray too rarely has no reference, and the user's own shots never enter it. A plugin M4A1-S spray is not compared: the plugin records no silencer state. Any steady spray counts (accurate speed, unscoped, on the ground, not flashed), at an enemy or not. Not a grade: following a moving target moves the view too. On plugin recordings (no recoil index, ammo count or view angles) a spray is shots of one gun each within one tick of its cycle time (the AK's 0.1 s lands 6 or 7 ticks apart), from a shot 0.3 s or more after the previous one, and only speed and scope filter its bullets. There the view change is the change in aim error to bullet 1's target since bullet 1 (`aimErr`: the turn from the view to the eye of the alive enemy nearest the view within 10 degrees), counted while that target is on screen by the plugin's `aim.los` (line-of-sight files) or `visTarget` (spotted mask). That change includes the target's own movement, so those sprays are shown relative to the target (`Summary.aim.relPath`) and never compared with the pro path. Plugin 1.2.0 records absolute view angles per shot; a spray whose bullets all carry them uses the view's change from bullet 1, as extractor sprays do, and is compared. |
| sprayPull | approx, identity | Mean pitch residual per bullet against the ideal pull; positive is more pull-down than the kick needs. Plugin recordings: as sprayDeviation. |
| sprayTransfers | approx, identity | Sprays whose target changes: each bullet aims at the visible enemy nearest its direction within 5 degrees, and a switch holds for 2 bullets. Ours. Plugin recordings: sprays as in sprayDeviation, and the enemy is the shot's `target` when on screen and within 5 degrees of the view. |
| transferHits | approx | Switches after which the rest of the spray hit the new target. Plugin recordings: as sprayTransfers. |

Each spray also records its distance from the target (`SprayFact.dist`, listed per spray in
`Summary.aim.sprayDist`): the mean angle between each bullet's direction and the eye of the enemy bullet 1
aimed at (the visible enemy nearest its direction within 30 degrees), over the bullets where he was
visible. Plugin sprays use the plugin's aim error to bullet 1's target while on screen. It is a measure
for the spray views, not a ranked metric.

The spray reference is `recoil.ts`, generated by `pnpm recoil <weapons_out>` from the pro demos' shot
tables alone (no user shots) and the decoded weapons vdata (hash in its header), read through
`recoil-ref.ts`. Only shots with their gun's normal recoil count (`shot-state.ts`: unscoped, the
M4A1-S silenced, unrecorded states left out). Max speeds are `aim-ref.ts` (`pnpm aim-ref <weapons_out>`).

## Movement (identity)

An **exposure** is a run of engagement ticks where `mesh_visible` is true and `smoke_blocked` is false (unknown is not visible);
gaps under 0.05 s merge. A **peek** is an exposure with an observed onset where your speed is at least
75 u/s (ours, near 34% of a rifle's max speed). Needs v1 maps with visibility.

| id | Status | Definition and thresholds |
|---|---|---|
| shoulderPeekPct | approx | Peeks of 0.3 s or less, with no shot, whose velocity reverses after sight breaks, within 0.25 s. 0.3 s and 0.25 s: ours, no fit. |
| jigglePeekPct | approx | Shoulder peeks at the same enemy with onsets at most 1.5 s apart (the engagement merge gap) |
| widePeekPct | approx | Peeks that travel 64 units or more along the onset direction within 0.5 s (ours, no fit: two hull widths) |
| exposureBeforeShot | approx | Median time from an exposure's onset to the first gun shot in it |
| openingSpeed | approx | Mean speed from freeze end to the round's first kill or your death |
| pathEfficiency | unavailable | The tables carry no nav mesh |
| crouchShotPct | exact | Gun shots fired ducked |
| crouchTimePct | approx | Alive samples with `ducked`, freeze end to round end |

## Aggression (identity)

**Contact** is your earliest visible, unsmoked engagement tick as attacker or victim, or your first hit.

| id | Status | Definition |
|---|---|---|
| firstContactTime | approx | Seconds from freeze end to contact |
| firstContactRank | approx | 1 + teammates with strictly earlier contact |
| entryAttempts | approx | Rounds where you made your team's first contact as the attacker, moving at 75 u/s or more |
| pushDepth | approx | Furthest projection onto the line from your spawn to the enemy spawn before the first kill or your death; spawns are the mean freeze-end positions of each side |
| lowBuyBuys | exact | Rounds where your team's buy is eco or half and you spent $1,000 or more, over such rounds with a known spend |

Breakdowns by round type and economy ("aggressive on ecos") are the same metrics over `rollup` with
`ownBuy` or `oppBuy`. The aggression family also counts, over your team's eco and half-buy rounds, your
kills and the rounds where you made contact (`AggroAgg.lowKills`, `lowFights`). Two metrics built on them,
fights taken and kills per round on those rounds, failed the reliability bar and do not ship (evidence below).

## Contact and duels

Each sighting (Aim, above) also records what the individual-play research measured at a contact
(`research/individual/extract_individual.py`). Windows are the research's: the first shot within 1 s of
the onset while the enemy stays visible, peek travel over 0.25 s, a duel settled by a kill between the
two players within 3 s, and a stop looked for in the 0.5 s before the shot. "Moving" is above 75 u/s.
All need line of sight (the `sight` input): a match without the extractor's engagements, such as a
plugin recording, gives no value and the reason "line of sight known for 0 of N rounds".

The engine's sighting differs from the research's contact in three ways, so the research's reliability
is not claimed for any of them; the evidence table gives the engine's own. The onset is the first
mesh-visible tick after one without sight, kept only when it falls inside the 90-degree view (the
research's onset is the first tick both visible and inside the view). The windows run while the enemy
stays visible (the research's take any visible tick inside them). And no sighting is dropped for a
flashed attacker (the research dropped those above 0.1 s of blindness).

| id | Kind | Status | Definition and thresholds |
|---|---|---|---|
| shotSpeed | identity | approx | Median 2D speed at your first shot within 1 s of a sighting |
| shotError | performance, lower is better | approx | Median angle between your view and the enemy's eye at that shot (a true 3-D angle; the research used the hypotenuse of the yaw and pitch errors) |
| stopBuffer | identity | approx | Median time from your last tick above 75 u/s to that shot, minus one tick, over shots fired at or under 75 u/s with a moving tick in the 0.5 s before |
| movingSpray | identity | approx | Mean, over rifle bursts, of the share of bullets fired above 75 u/s. A burst is two or more shots of one rifle, each within 0.3 s of the last; a burst with any bullet of unknown speed is left out. Reads only shots, so plugin recordings have it. |
| peekTravel | identity | approx | Median distance you moved from the onset to the last visible tick within 0.25 s; sightings that stay visible for one tick only are left out |
| duelExposure | identity | approx | Median seconds from the onset to a kill between the two of you within 3 s |
| firedFirst | identity | approx | Share of mutual sightings where you fired first: per pair and round, each player's earliest sighting of the other with a first shot, compared by tick; equal ticks count for neither |
| engageDistance | identity | approx | Median horizontal distance to the enemy at the onset |
| aggressionScore | identity | approx | Four signed z-scores, averaged, then standardized: peek travel and fired first count toward aggressive, exposure before the duel and engagement distance toward passive. Each part's z-score is against the pros' mean and standard deviation over 551 players with 40+ rounds; their mean is then a z-score against the same pros' spread of it (mean 0, standard deviation 0.477), so the score is in pro standard deviations and 0 is the average pro (`aggression-scale.json`). Null unless all four parts have a value. The signs are ours: on the pro player-maps every part correlates under 0.1 with entry attempts, either way, so no data run set them. |
| expectedDuel | identity | approx | Mean chance of winning your settled duels, from a logistic model of the research's nine features at the onset: placement, distance, both speeds, both health values (the latest 4 Hz sample no older than 0.3 s), living players a side, round time and the pitch error. Fitted on 88,069 pro duels from 489 maps with the research's ridge of 1e-3 (`xduel-params.json`); five-fold cross-validation grouped by match gives AUC 0.681 and Brier 0.223 (the research's: 0.692, 0.221). Health comes from the latest living sample strictly before the onset, so it never holds the duel's own outcome. Shows a value from 80 settled duels. |
| duelsOverExpected | performance | approx | Your settled duels won minus the expected wins, per duel, in percentage points. Shows a value from 444 settled duels. |

The two duel gates come from `pnpm metric-evidence`: a player's first n settled duels split into
alternate halves, Spearman's r between the halves' means across players, then Spearman-Brown. The gate is
the smallest n from which every larger measured n reaches 0.4. Expected duel reaches 0.445 at 10 duels,
dips to 0.396 at 40, and holds 0.468, 0.508 and 0.739 at 80, 160 and 320, so its gate is 80. Duels over
expected never reaches 0.4 (0.20 to 0.33 from 10 to 320 duels), so its gate is a projection, not a
measurement: Spearman-Brown carries its 0.325 at 320 duels to 0.4 at 444. Under its gate a metric has no
value, and compare() says how many duels there are and how many it needs.

## Buying (identity)

From the team research (`research/team/explore.py`).

| id | Status | Definition and thresholds |
|---|---|---|
| buyDeviation | approx | Your freeze-end equipment value minus your side's mean, over rounds where every player on the side has one. The research divides the team's total by five and keeps only 5v5 rounds; the engine divides by the players on the side. |
| saveConversion | approx | The next round's starting equipment (`round_start_equip_value`) after a round you lost and survived, when that round is on the same side and the lost round did not end a half (regulation halves of `mp_maxrounds` / 2, overtime halves of `mp_overtime_maxrounds` / 2, default 6). The research's `save_conversion_proxy` is the same quantity in thousands of dollars. Needs the `carry` input: plugin files record no starting equipment. Its percentile needs 10 saved rounds (`SAVE_MIN`): a player's first 10 saves have a split-half reliability of 0.54 on the pros, 0.67 at 20. The value shows below that, with the count. |

## Evidence for the metrics-v2 metrics

The coordinator's bar: reliability (split-half, Spearman-Brown) of 0.4 or more, and no correlation of 0.5
or more in absolute value with an existing stat. Research numbers are as the two research files give them:
`research/individual/analysis.json` `candidates[].reliability.map_split.sb` and `max_existing_abs_corr`
(per player-map, players with 4+ maps, against KPR, ADR, HS%, accuracy, swing, HLTV rating and AWP share
of kills), and `research/team/candidate_summary.json` `candidates[].reliability_split_half` and
`max_abs_existing_corr` (per player-map-side, against the team research's set, which has no AWP share).
Engine numbers are `pnpm metric-evidence` on the engine's definitions, over the same 489 pro maps:
player-maps with 16+ rounds, players with 4+ of them, first half of their maps against the last half,
and the same seven comparisons with Rating 3.0 in place of HLTV's rating. The full report is
`cs2-stats-data/derived/metric-evidence-v2.json` (no names or ids).

| id | Research key | Research reliability, max \|r\| | Engine reliability (players), max \|r\| (with) | Ships |
|---|---|---|---|---|
| shotSpeed | shot_speed | 0.79, 0.43 | 0.76 (354), 0.45 (AWP share) | yes |
| shotError | shot_error | 0.46, 0.17 | 0.55 (354), 0.19 (AWP share) | yes |
| stopBuffer | stop_buffer | 0.45, 0.25 | 0.47 (354), 0.27 (AWP share) | yes |
| movingSpray | moving_spray | 0.67, 0.14 | 0.67 (377), 0.15 (accuracy) | yes |
| peekTravel | peek_travel | 0.63, 0.36 | 0.60 (354), 0.38 (AWP share) | yes |
| duelExposure | exposure | 0.41, 0.30 | 0.48 (354), 0.34 (AWP share) | yes |
| firedFirst | fired_first | 0.50, 0.10 | 0.49 (354), 0.17 (AWP share) | yes |
| engageDistance | distance | 0.53, 0.28 | 0.55 (354), 0.30 (AWP share) | yes |
| aggressionScore | none | | 0.50 (354), 0.27 (AWP share) | yes |
| expectedDuel | expected_duel | 0.34, 0.29 | 0.25 (354), 0.25 (KPR); per duel 0.47 at 80 | yes, from 80 duels |
| duelsOverExpected | execution_over_expected | 0.21, 0.69 (rating) | 0.32 (354), 0.70 (Rating 3.0); per duel 0.33 at 320 | yes, from 444 duels |
| buyDeviation | buy_deviation | 0.70, 0.20 | 0.87 (377), 0.61 (AWP share) | yes; see below |
| saveConversion | save_conversion_proxy | 0.27, 0.16 | 0.45 (259), 0.28 (AWP share); per save 0.54 at 10 | yes, percentile from 10 saves |
| ecoFights | none | | 0.28 (349), 0.05 | no: under 0.4 |
| ecoKills | none | | 0.12 (367), 0.32 (KPR) | no: under 0.4 |
| crosshairPlacement (existing) | preaim, the median placement | 0.51, 0.25 | 0.57 (354), 0.26 (AWP share) | already shipped |
| timeToShot (existing) | time_to_shot | 0.57, 0.11 | 0.72 (354), 0.10 (Rating 3.0) | already shipped |

The research's "pre-aim" is the median placement at the onset, which is the engine's existing
crosshairPlacement; its "time to shot" is the existing timeToShot (which keeps shots past 1 s and leaves out
sightings with a shot in the previous 0.3 s). Neither got a new metric.

Two of the shipped metrics clear the bar in the research file but not on the engine's own numbers, and
are flagged for the coordinator rather than dropped. buyDeviation correlates 0.61 with AWP share of kills,
a stat the team research did not compare against: an AWP costs $4,750, so AWPers buy above their team.
duelsOverExpected correlates 0.70 with Rating 3.0, as the research's 0.69 with HLTV's rating already
showed; it ships under the duel-difficulty exception with its 444-duel gate.

Fights taken (`ecoFights`: rounds with contact over eco and half-buy rounds with visibility) and kills per
round on those rounds (`ecoKills`) are the eco-aggression candidates. Neither is in the research files;
on the engine's numbers both fall under 0.4, so neither ships. The per-buy-class breakdown of the existing
metrics (`buySplits`) still answers "aggressive on ecos".

## Luck (for fun, never ranked)

How much the dice favoured a player (`luck.ts`). None of these is a skill measure, so none has a pro
percentile: `compared: false` makes compare() say "for fun, with no pro percentile" and keeps them out of
every pool. Positive luck means the dice favoured you.

**Spread luck.** Every gun shot (shotguns aside, since each pellet has its own spread) fired while an
enemy was mesh-visible and unsmoked within 30 degrees of the aim counts once. Everything is measured on
the plane one unit ahead of the eye, in the aim direction's right and up coordinates, because that is
where the game places the cone. A point there at distance d from the aim is tan(angle) off it.

- **The cone.** The game's own aim angles, inaccuracy and spread for that bullet (`fire_bullets`, which the
  extractor writes to `shots`). The bullet's direction is forward + x right + y up, with (x, y) =
  inaccuracy x u0 at a uniform angle plus spread x u1 at another, u0 and u1 uniform on [0, 1]. That is
  CS:GO's published formula, and CS2 is read the same way.
- **The target.** An upright box facing the shooter, 13 units to each side and from the feet to 6 units
  above the eye, both half-sizes scaled by HIT_AREA_SCALE. Its four corners are projected onto that plane,
  each divided by its depth along the aim, and a bullet hits when its point falls inside the projection.
  The target is the visible enemy whose box centre projects nearest the aim point, and the 30-degree gate
  is tan 30 degrees on the same plane.
- **Calibration.** A logistic map of the geometric chance's log-odds (CALIBRATION), because the box and
  cone alone are too sure at both ends.

A shot hit if the shooter damaged that enemy with a gun on the shot's tick; each such hit goes to one
shot, so two shot rows on one tick never share one hit. Luck is hits minus the summed chances, for your
shots (luckHits) and for the enemies' shots at you (luckAgainst). The luck score is the first minus the
second. All three are per 24 rounds over the covered rounds, so a regulation match reads as its own total.
A round is covered only when every gun shot in it has the cone, both aim angles and the eye position, on
a map with mesh visibility. A round with one shot missing any of them is unknown, not zero, and a player
with no covered round has no luck value.

`pnpm fit-luck` fitted both constants on the even-numbered pro maps (153,583 shots in covered rounds) and
checked them on the odd-numbered ones (154,979). HIT_AREA_SCALE 0.869 makes the geometric chances sum to
the hits on the fitting maps. On its own that chance is too sure: on the checking maps, shots given 0.4%
hit 8.6% of the time, and shots given 95% hit 82%. CALIBRATION (a = -0.124, b = 0.374) corrects it.

| Calibrated chance | Checking shots | Mean chance | Hit rate |
|---|---|---|---|
| 0.05-0.10 | 40,921 | 0.063 | 0.074 |
| 0.10-0.20 | 5,517 | 0.158 | 0.146 |
| 0.20-0.30 | 14,851 | 0.256 | 0.178 |
| 0.30-0.40 | 19,943 | 0.349 | 0.319 |
| 0.40-0.50 | 14,876 | 0.450 | 0.459 |
| 0.50-0.60 | 16,729 | 0.550 | 0.606 |
| 0.60-0.80 | 20,027 | 0.681 | 0.758 |
| 0.80-1.00 | 22,115 | 0.912 | 0.872 |

Every band is within 0.08 of its hit rate, and hits are 1.006 of the expected overall. The remaining error
is what a box, a cone and a nearest-enemy target leave out: limbs, partial cover, and target movement
within the tick.

| id | Needs | Definition and thresholds |
|---|---|---|
| luckHits, luckAgainst, luckScore | spread | As above. Plugin files have no cone and no line of sight, so they give no value. |
| runAndGunKills, runAndGunDeaths | killShot, deathShot | Gun kills whose killing shot (the killer's gun shot on the kill's tick) was fired above 34% of the gun's max speed, scoped speed when scoped (`speed.ts` accurateSpeed), over the kills with that shot's speed known. For a scoped gun whose scope state is not recorded, the limit, and so the kill, is unknown. Plugin files record only the recording player's shots, so deaths to bots there are unknown. |
| luckyHeadshots, luckyHeadshotDeaths | hsShot, hsDeathShot | Headshot kills whose killing shot had an inaccuracy cone of 0.05 or more (about 2.9 degrees; ours, no fit). Moving, jumping and spraying all widen the cone, so one threshold covers them. Needs the cone, so demos only. |
| blindKills, airKills, noscopeKills, smokeKills | flags | Share of your kills with the game's blind, in-the-air, no-scope or through-smoke flag, over kills with all four flags recorded (they are nullable since #27) |
| flagDeaths | deathFlags | Share of your deaths to an enemy kill with any of those flags |
| closeCalls | | Rounds you survived on 5 health or less at the round's end, per 24 rounds. Health is 100 less the round's damage taken from every source (`health_after` where the source records it). |
| lowHpKills, lowHpDeaths | | Enemy kills made, and deaths to an enemy, on 20 health or less (ours, no fit), per 24 rounds |

What each source gives:

| Input | Pro and Valve demos (extractor) | Plugin files |
|---|---|---|
| Cone, aim angles and eye per bullet | yes, every gun shot | no (the plugin would need each shot's inaccuracy, spread, aim angles and eye position, for every player) |
| Line of sight to the target | yes (engagements) | no (it would need line of sight, or at least the target's position at each shot, for every shooter) |
| Killing shot's speed | every player | the recording player only |
| Kill flags | yes | yes |
| Health from damage | yes | yes |

## Career views (`career.ts`, `handling.ts`)

Leetify's career pages were the checklist; the definitions and every weight are ours, since Leetify
publishes neither its rating weights nor its buy bands.

| View or metric | Definition |
|---|---|
| Aim Rating | 0-100: the mean of seven pro percentiles, each weight 1: crosshair placement, time to damage, first-bullet accuracy, spray accuracy, headshot accuracy, counter-strafing and accuracy at visible enemies. Lower-is-better metrics are already flipped by compare(). Null unless every input has a percentile. |
| Utility Rating | The mean of its two sub-ratings. Quantity: the mean percentile of flashes, smokes, HEs and molotovs thrown per round. Quality: the mean percentile of flash-to-kills per flash, enemies flashed and blind time per flash, damage per HE and per molotov, unused utility on death, and teammates flashed per round (inverted, since more is worse). |
| Period comparison | Every metric over one date range of the query against another, with the delta and its direction (better or worse for performance metrics, higher or lower for identity ones) |
| Personal bests | The most in one match of kills, assists, headshot kills, damage, multi-kill rounds, opening kills, trade kills, clutches won, enemies flashed and utility damage. And the best match value of every performance metric (the lowest where lower is better), from matches of 10 rounds or more that meet the metric's sample minimum; a tie keeps the earlier match. |
| Top stats | The five performance metrics with the highest pro percentile |
| Focus areas | Performance metrics under the pros' 50th percentile that have a tip in `FOCUS_TIPS`, ranked by the gap to 50, each with its tip |
| Sessions | Matches grouped so that a gap of 3 hours or more between one match's end and the next one's start begins a new session. Each session has its record, rounds, kills, deaths, Rating 3.0 and two awards: the best match (highest Rating 3.0) and the most kills. |
| Buy tiers | HLTV's classes with the half buy split at $2,000 a player: eco under $1,000, semi-eco $1,000 to $1,999, force $2,000 to $3,249, full from $3,250; the first round of each half is pistol. The $2,000 split is ours. `Filter.ownTier` keeps a tier and `buyTiers` splits a query. |
| wastedMagazine | Identity. There is no reload event, so a reload is read from the clip count each shot carries (`shots.ammo_clip`, the count before the bullet). When the next shot of the same gun in the round shows more than the earlier one left, there was a reload in between, and the bullets left were thrown away, as a share of the new clip. The metric is the mean share per reload. Shots carry no weapon entity id, so picking up a second copy of the gun looks the same; a rise counts only when no copy was bought between the shots or dropped by a dying player within 256 units of the player's path, which the 4 Hz positions trace (`handling.ts` `PICKUP_REACH`, set wide with no measurement behind it). A switch to another weapon and back keeps the gun: the game drops only the gun in hand. A reload with no later shot in the round, and a copy a living player dropped, are not seen. Needs the clip counts, which plugin files lack, and positions. |
| reloadsPR | Identity. Those reloads per round with clip counts |

## Per-match views (`matchviews.ts`)

These are views of one match, not metrics: nothing is ranked. The definitions are ours, over schema v1
data; Leetify's match pages were the checklist.

| View | Definition |
|---|---|
| Rating by round | Rating 3.0 is linear in six per-round averages, so each rated round has a rating of its own: the intercept plus each coefficient times the round's eco-adjusted kills, damage and deaths, KAST and multi-kill (0 or 100), and swing (points). Over a set of rated rounds the mean is the rating of those rounds. A round Rating 3.0 does not rate (unknown swing or eco value) has none. Each round also says whether it counts toward the match rating: rated, on a side rating3Of rates (half its rounds rated), in a match past the rating's gates. The counting rounds average to the match's Rating 3.0. |
| Head to head | Every pair of players on opposite teams, quiet pairs at zero. Each way: enemy kills, hit damage (HLTV's capped figure), kills by weapon class, blinds over 1.1 s (Leetify's cut) with their seconds, and opening kills |
| Map zones | Your kills and deaths per zone (the map's place name) and side. A kill's zone is the kills table's place for you, else your position sample from the same round within half a second of the kill, since plugin files carry no kill places; with neither, the kill has no zone. The zone list is every place this match's position samples name. |
| Your match | Every metric over this match against the same metric over your `n` most recent earlier matches, pooled. The direction is better or worse for performance metrics (lower is better where marked) and higher or lower for identity metrics. |
| Opening duels | Each round's first enemy kill (killer, victim, weapon, time, whether the victim was traded, whether the killer's side won). Your best opening weapon is your gun with the most opening kills, ties broken by rounds won. Rounds won after your opening kill, and after your opening death. Conversions and each weapon's wins count only rounds with a known result. |
| Situations | The alive counts of your side and the enemy's at freeze end, then after every death or disconnect of a living player, in tick order, from freeze end to the round's end (an event during freeze time is not counted). A player the source marks dead at freeze end (plugin `alive0`) is not counted, and disconnects come from the plugin's `leaves`; each state reached counts once per round, with the round's result. States with a side at 0 are the end and are left out. |
| Bombsites | Per site letter. T: a take attempt is a round where a living T player entered the site's zone (the map's "Bombsite" place) before the plant; it succeeds when the bomb was planted there. Post-plant: rounds planted there, won. CT: a hold attempt is a round a T player entered the zone before the plant; it succeeds when CT won the round with no plant there. Retake: rounds planted there, won by CT. Take and hold need positions, the round's freeze end and the map's "Bombsite" place names; they are null until a round has all three, and the result says how many rounds could be read and which inputs were missing. Retake and post-plant come from plants alone. |

## Information (identity)

Source: the radar `spotted` table, clipped to freeze end, round end and both players' deaths. It lags
real sight and is used for nothing else.

| id | Status | Definition |
|---|---|---|
| firstSpotPct | approx | Rounds where your first spot of an enemy came no later than any teammate's; null when a teammate is a bot (bots never appear as spotters) |
| spotSecsPR | approx | Seconds you had enemies on radar while both were alive, per round |
| spotAssistsPR | approx | Teammates' kills of an enemy you had spotted in the previous 3 s (ours, no fit) |

## Identity beyond HLTV

| Output | Definition |
|---|---|
| Role blend (`roleBlend`) | T outputs Entry, Trader, Support, Lurker and AWPer; CT outputs Anchor, Rotator, Aggressor, Support and AWPer. Gaussian naive Bayes uses Jamie Packer's six features: time alive per death, opening attempts, traded deaths %, trade kills %, and team-relative ranks of nearest-teammate and team-centre distance. Packer's Spacetaker maps to Entry; Half-Lurker and Lurker merge before fitting one equal-prior class. Mixed labels are excluded. Trader, Support and Aggressor use hand-chosen demo-feature rules. The mapped classes blend 55% Gaussian posterior with 45% rules; non-AWPer scores use softmax with multiplier 4. Both weights and multiplier are design choices, not fitted constants. Inner-LOO isotonic curves adjust only mapped classes; non-AWPer mass then sums to one minus measured AWP rounds. Calibrated mapped roles are exposed as calibrated probability; rule-only roles as fit; AWPer as measured AWP rounds. Spacing samples occur every 3 s from 10 s after freeze end, before the plant, with all five alive; tied ranks share their mean. Packer's 2024 data is CC BY 4.0, with labels from Harry Richards' Positions Database. |
| Role decision | At least 30 side rounds, a top share at least 0.60 and a top-minus-second margin at least 0.15 return `primary` and `probability`, with `top2: null`. Otherwise sufficient evidence returns `primary: null`, `probability: null`, `top2: [a,b]` and a reason. Under 30 rounds or without required evidence, both primary and top2 are null with a reason. IGL is excluded because leadership is not observable. The distribution's mapped values are calibrated probability; rule-only values are fit; AWPer is measured AWP rounds. |
| Evidence rows | Value, unit, measured pro q10/q90 and hand-chosen threshold tick share `role-thresholds.ts` with classification. Quantiles use player-map-side summaries with at least 16 side rounds, so they describe long halves. `areaChanges` remains unavailable. Utility counts all grenades per round, not only pre-contact throws. |
| Support tendency | Legacy mean percentile of flashes and smokes thrown, trade kills % and assisted kills %. This helper is separate from the Support fit in the role distribution. Neither has labelled Support validation. |
| Overall and per-map role (`overallRole`, the worker's `roles(q).all` and `rolesByMap`) | Weight each available side distribution by its rounds and sum matching role names, including shared Support and AWPer. A missing distribution adds no weight. Apply the same decision gates using the combined round count. Overall mapped values retain calibrated probability status, rule-only values retain fit status, and AWPer remains measured AWP rounds; the combined distribution is not separately calibrated. Per map, use only that map's summaries. |
| Clutch rows (`clutches`) | Each clutch with the player's steamid and their enemy kills after the death that left them alone (`ClutchFact.kills`), over the rounds the query's filter keeps. `saved`: lost, with the player alive at the round's end (the same rule as `saves`: alive at freeze end (not marked dead then, and not disconnected at or before it), not killed by the end, and not disconnected). `t`: seconds since freeze end when it began. `left`: the clock then, the round timer before a plant and the bomb timer after one (`closing.ts` `matchClocks`). The round timer is `mp_roundtime_defuse`, else `mp_roundtime`, else the length of a round of the match that ran out of time; the bomb timer is `mp_c4timer`, else the plant-to-explosion time of a bomb that exploded in the match. With none of those, `left` is null rather than a game default, because the recorded explosions disagree with one: 41 s after the plant in the two pro demos, 51 s in the bot server's recordings of 2026-10-25. |
| Highlights (`highlights`) | Rounds where the player made three or more enemy kills (3K, 4K, five or more an ace) or won a clutch (`highlights.ts` `highlightKinds`; a round can be both), over the rounds the query's filter keeps, newest match first and the later round first. Each carries the player's kills in order with their killfeed flags. Leetify clips 2K to ace; a 2K is left out here as too common to be worth going back to (ours). |
| Flash tool (`flashes`) | The player's flashbangs in one match from the detonation rows (`flash_detonate`), each with its detonation point, everyone it blinded but the thrower (seconds, team or enemy, over 1.1 s or not, and where they stood: the position sample nearest the blind, within half a second) and the enemy kills it led to (`flashes.ts`). A blind belongs to the latest detonation at or before it that its `flash_entity_id` names in the same round, unless its recorded attacker is another player (the game reuses entity ids); an unlinked blind is left out and counted in the call's notes. A flash led to a kill when the kill carries a flash assist for the thrower and this is the thrower's latest flash to have blinded the victim before it, or when an enemy it blinded for over 1.1 s died to the thrower's side before the blind ran out (the kills `flashKills` counts). The notes name what a file lacks: detonations for logged flashbang throws (`thrown` counts the throws, paired with detonations by entity id or else by tick; null when the throw table has no row for anyone, as in the Valve imports, whose players did throw flashbangs), detonation points, blinded players' positions, linked blinds, or every grenade and flash event. |
| Spawn names (`rolesBySpawn`) | Each spawn with its map, the map's place name at the spawn sample (`PlayerRound.spawnPlace`), and its position in the side's spawn area: facing the mean of the enemy's spawns from the mean of the side's, "front" or "back" when 64 units or more along that line, "left" or "right" when 64 or more across it, else "centre". 64 units (two player widths) is ours, no fit. Every spawn on a side shares one place name on the pro maps checked (TSpawn, CTSpawn), which is why the position is there. |
| Populations | Style attributes and "plays like" rank the user against the bot careers in their own matches (`careerBaselines`; careers with 150 or more rounds, provisional until 15 qualify) and each pro against pros. Performance metrics and "Work on" rank against the pros. `design/identity.md`. Firepower is also scored against the same bots (`StyleResult.firepower`). An AWPer pool with fewer than 8 samples on a side takes the all-bots pool there and says so (`Careers.pool`): in the user's seven recorded matches of 2026-10-25 two bot matches passed 0.20 AWP kills per round and no bot id played twice. |
| Plays like | Cosine similarity, as a percentage, of twelve scores: the six style attributes on T and on CT, each taken as its distance from the pool middle (score minus 50). The user and the pros are scored against different populations, so only the profile's shape compares (`design/identity.md`): 100 is the same shape, 0 unrelated, -100 the opposite. Keys either player lacks are left out. |
| Performs like | The same over the percentiles of KPR, ADR, DPR, KAST, multi-kill % and swing, on T and on CT |
| Gun proficiency | Familiarity (rounds used over 100, capped at 1; ours) times consistency (1 minus the coefficient of variation of per-match accuracy over matches with 20 or more shots, at least 3 matches; ours). Not performance. |
| Opponents | Each metric against the mean of the opponents in the same matches, with your rank for performance metrics |
| Trends | Per-match series, least-squares slope over match order, Pearson correlations between metrics and with winning |
