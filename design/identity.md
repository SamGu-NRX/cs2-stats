# Identity vs performance (binding)

The user's definition is HLTV's (news 45755, "HLTV Attributes receive an overhaul with 29 new metrics", 2026-10-19): "While rating covers performance, attributes cover style."

## Performance (how well)
Rating 3.0 (approx.) and its six sub-ratings: Kills, Damage, Survival, KAST, Multi-Kill, Round Swing. Plus the "how good" tables: Trade Kill Success %, Traded Death Success %, Opening Swing, Clutch Swing, AWP Swing, AWP Duel Win %, Flash Swing, 1v1 win rate. **Firepower** sits on the performance side.

## Identity (how you play): HLTV's six style attributes
**Entrying, Trading, Opening, Closing, Sniping, Utility**, built from stylistic metrics that **separate intent from outcome**:
- tradeable deaths, not traded deaths;
- opening attempts, not opening kills;
- alive for post-plant and last alive, not clutches won.

Scores are **role-relative by default**: compared with Riflers, or with AWPers for players above **0.20 AWP kills per round** in the sample. Sniping keeps its own treatment. The user can switch to "compare to everyone".

The four contributing metrics per attribute are the ones HLTV now shows; they are recorded in the private reference screenshots and scraped scores, which stay in the local data folder and are never committed.

**The role classifier** that decides which population a player is scored against: AWPer when AWP kills per round ≥ 0.20 in the sample, otherwise Rifler; Sniping is always scored against everyone, because few players pick up the AWP. The engine's `METRICS.md` carries the exact inputs per attribute and the Sniping rule. Our extra role blend (entry, support, lurker, anchor, rotator) is a separate, finer layer and is defined there too.

**The 29 new metrics:** Round Win Shares, Perfect KPR, Trade Denials, Net Kills, Net Damage, Tradeable Deaths, Trade Opportunities, Bait Kills %, First Duel Rank, First Duel Time, Weapon Attacks, Alive for Post Plant, Last Alive in Team, Rounds with a Sniper, Rounds with an AWP, AWP Kills %, Smokes Thrown, Molotovs Thrown, HE Grenades Thrown, Traded Death Success %, Trade Kill Success %, Opening Swing, Clutch Swing, AWP Duel Win %, AWP Swing, Flash Swing, Assists per Flash, Grenade Damage Received, Damage per HE Thrown.

## Similarity
Both similarities compare profile **shape**, because the user's and the pros' scores are on different populations. The method is fixed here; earlier notes (`research-c.md`) that used a seven-score Pearson correlation on bot-career-normalized scores are **superseded** by this.
- **"Plays like" (identity):** over the **six style attributes, excluding Firepower, on T and CT separately** (twelve numbers). Each population is scored role-relative to its own population (the user versus bot careers, the pros versus pros), then the two twelve-vectors are compared by cosine similarity, reported as a percentage. Shape, not level. Source: per-side scores in the locally generated pro pack (`%APPDATA%\BotMatchStats\packs\pros.json`, never committed); HLTV compares against top-30 teams over six months.
- **"Performs like" (performance):** separate, cosine similarity over the Rating 3.0 sub-ratings.

## Beyond HLTV, ours
- **Role blend:** entry, support, lurker, anchor, rotator, AWPer, per side, map, spawn and round type, with plain-language evidence for every signal. HLTV's planned award roles are opener, anchor and closer.
- **Positions and rotations**, aggression by round type and economy, spotting and information, utility quality, movement style.

All of these stay on the identity side.
