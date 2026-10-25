# Metrics

Every metric the engine computes, with its definition, every threshold and where the threshold came
from. `metrics.ts` holds the same list as code; `VALIDATION.md` holds the checks. "Ours" marks a choice
with no published source; "no fit" means no data run picked the number.

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
| AWPer | More than 0.20 AWP kills per round in the sample | `design/identity.md` |

## Rating and scoreboard (performance)

| id | HLTV name | Status | Definition |
|---|---|---|---|
| rating3 | Rating 3.0 | approx | `model/rating3/SPEC.md`. A linear model in eco-adjusted KPR, ADR, DPR and KAST, raw multi-kill % and swing: `params.json` `rating.intercept` plus `rating.coefficients` times each input (ordinary least squares on HLTV's displayed inputs, PR #17). `rating3()` throws on any other `rating.basis`. Per side it is the rating of that side's rounds (`rating3BySide`). |
| kpr, dpr, adr, kast, mk, hs | KPR, DPR, ADR, KAST, Multi-kill | exact | Per round over the shared rules. KAST counts a kill, a damage assist (flash assists left out), survival or a traded death. Each KAST round is also credited to the first of those that earned it, so the parts sum to KAST: `killRounds + kastA + kastS + kastT`. |
| swing | Round swing | approx | `swing.ts`: each kill's and plant's change in win probability (HLTV's lookup from the private pack when installed, else the CS2RB round model, which also reads the living players' health, team equipment and time; `model-params.ts`), with the victim charged the drop and the gaining side credited by damage share, else the killer. The round-end remainder goes to winners by weight (clutcher 1, players with kill swing 2, defuser 1, survivors 1, from `params.json`) and is charged equally to the losing side's survivors (all losers when none survived; ours). An eligible flash (the gaining side's, still blinding the victim at the kill, not the killer's, a team flash or an ambiguous one) takes `params.json`'s flash share first. |

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
| lastAlive | Last Alive in Team | approx | Rounds where you were at some moment the only one of your side alive |
| clutches24 | Clutches per 24 Rounds | exact | 1vX clutches won per 24 rounds (CS Demo Manager's detection) |
| roundsWithSniper, roundsWithAwp | Rounds with a Sniper, with an AWP | approx | Rounds you carried one at freeze end or killed with one |
| sniperKillsPct, awpKillsPct | Sniper Kills %, AWP Kills % | exact | Share of kills |
| smokesPR, flashesPR, molotovsPR, hesPR | Smokes, Flashbangs, Molotovs, HE Grenades Thrown per Round | exact | Throws per round (molotovs include incendiaries) |

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
| timeToShot | approx | Median time from sighting to the first shot, leaving out sightings with a shot in the previous 0.3 s (the recoil asset's reset spacing) |
| crosshairPlacement | approx | Median angle between the view and the victim's eye at sighting |
| crosshairMoved | approx | Median angle the view turned from sighting to the first damage (Leetify reports it beside the static error) |
| preAim | approx | Share of sightings with placement 2 degrees or less (ours: about a player's width at 1,000 units). Its percentile against the pros is the "better or worse than baseline" reading. |
| flickOvershoot | approx | Median distance past the head, along the flick's direction, during the reaction flick |
| microCorrections | approx | Movements (view speed rising through 20 deg/s) between the flick's end and the first shot, or 0.5 s without one, per flick. Ours, no fit. |
| trackingError | approx | Mean angle to the eye while tracking: from 2 degrees or less until 10 degrees or lost sight, on ticks where the sightline turns at 10 deg/s or more. Ours, no fit. |
| accuracy | exact | Gun shots with an enemy hit on the same tick, over gun shots. Per gun with the weapon filter. |
| sightAccuracy | approx | Hits per shot fired while an enemy was visible within 30 degrees of the shot (the extractor's shot trigger) |
| firstBulletAccuracy | approx | Hits per first bullet at a visible enemy. A first bullet has recoil index 0 to 0.01 and comes 0.3 s or more after the previous shot (the recoil asset's reset rule). |
| counterStrafe | approx | Rifle and sniper first bullets fired on the ground at or under 34% of the gun's max speed (NextFrag via `research-data-sources.md`; max speed is `m_flMaxSpeed` from the weapons vdata, scoped speed for scoped guns) |
| csTooEarly, csLateReversal, csNoStop | approx, identity | Among inaccurate first bullets: no stop when at or above the peak speed of the previous 0.25 s or above 90% of it; late reversal when moving against the peak's direction; too early otherwise. 0.25 s and 0.9: ours. |
| sprayDeviation | approx, identity | Mean per-bullet distance between your view change from bullet 1 and the recoil asset's median pro compensation path, bullets 2 to the asset's supported limit. Segmentation and filters are the asset's. Not a grade: the asset is marked `scoringApproved: false`. On plugin recordings (no recoil index, ammo count or view angles) a spray is shots of one gun each within one tick of its cycle time (the AK's 0.1 s lands 6 or 7 ticks apart), from a shot 0.3 s or more after the previous one, and only speed and scope filter its bullets. There the view change is the change in aim error to bullet 1's target since bullet 1 (`aimErr`: the turn from the view to the eye of the alive enemy nearest the view within 10 degrees), counted while that target is on screen by the plugin's `aim.los` (line-of-sight files) or `visTarget` (spotted mask). That change includes the target's own movement, so those sprays are shown relative to the target (`Summary.aim.relPath`) and never compared with the pro path. Plugin 1.2.0 records absolute view angles per shot; a spray whose bullets all carry them uses the view's change from bullet 1, as extractor sprays do, and is compared. |
| sprayPull | approx, identity | Mean pitch residual per bullet against the same path; positive is more pull-down than pros. Plugin recordings: as sprayDeviation. |
| sprayTransfers | approx, identity | Sprays whose target changes: each bullet aims at the visible enemy nearest its direction within 5 degrees, and a switch holds for 2 bullets. Ours. Plugin recordings: sprays as in sprayDeviation, and the enemy is the shot's `target` when on screen and within 5 degrees of the view. |
| transferHits | approx | Switches after which the rest of the spray hit the new target. Plugin recordings: as sprayTransfers. |

The recoil reference is `aim-ref.ts`, generated by `pnpm aim-ref` from
`cs2-stats-data/derived/recoil_patterns.json` and the decoded weapons vdata (hashes in its header).

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
`ownBuy` or `oppBuy`.

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
| Role blend (`roleBlend`) | Per side, a Gaussian naive Bayes over Jamie Packer's six features (time alive per death, opening attempts, traded deaths %, trade kills %, and team-relative ranks of distance to the nearest teammate and to the team's centre), fitted on his labelled pros (CS2 Playstyle & Roles Dataset 2024, CC BY 4.0; labels from Harry Richards' Positions Database). The blend is the posterior over Entry, Lurker, Half-lurker (T) or Anchor, Rotator, Mixed (CT). AWPer share is the rounds you carried an AWP. Spacing samples: every 3 s from 10 s after freeze end, before the plant, with all five alive; ranks per sample, ties sharing the mean rank. |
| Support tendency | Mean percentile of flashes and smokes thrown, trade kills % and assisted kills %. Reported beside the blend because no labelled source for support exists. |
| Populations | Style attributes and "plays like" rank the user against the bot careers in their own matches (`careerBaselines`; careers with 150 or more rounds, provisional until 15 qualify) and each pro against pros. Performance metrics and "Work on" rank against the pros. `design/identity.md`. |
| Plays like | Cosine similarity, as a percentage, of twelve scores: the six style attributes on T and on CT, each taken as its distance from the pool middle (score minus 50). The user and the pros are scored against different populations, so only the profile's shape compares (`design/identity.md`): 100 is the same shape, 0 unrelated, -100 the opposite. Keys either player lacks are left out. |
| Performs like | The same over the percentiles of KPR, ADR, DPR, KAST, multi-kill % and swing, on T and on CT |
| Gun proficiency | Familiarity (rounds used over 100, capped at 1; ours) times consistency (1 minus the coefficient of variation of per-match accuracy over matches with 20 or more shots, at least 3 matches; ours). Not performance. |
| Opponents | Each metric against the mean of the opponents in the same matches, with your rank for performance metrics |
| Trends | Per-match series, least-squares slope over match order, Pearson correlations between metrics and with winning |
