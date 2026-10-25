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

The four contributing metrics per attribute are the ones HLTV now shows; see `hltv-ref/player-attributes-expanded.png` and the scraped `data/pros.json`.

**The 29 new metrics:** Round Win Shares, Perfect KPR, Trade Denials, Net Kills, Net Damage, Tradeable Deaths, Trade Opportunities, Bait Kills %, First Duel Rank, First Duel Time, Weapon Attacks, Alive for Post Plant, Last Alive in Team, Rounds with a Sniper, Rounds with an AWP, AWP Kills %, Smokes Thrown, Molotovs Thrown, HE Grenades Thrown, Traded Death Success %, Trade Kill Success %, Opening Swing, Clutch Swing, AWP Duel Win %, AWP Swing, Flash Swing, Assists per Flash, Grenade Damage Received, Damage per HE Thrown.

## Similarity
- **"Plays like" (identity):** HLTV computes it over the **six style attributes excluding Firepower, on T and CT separately**, against players from top-30 teams over the last 6 months. Ours does the same with `data/pros.json` (per-side scores).
- **"Performs like" (performance):** separate, over the Rating 3.0 sub-ratings.

## Beyond HLTV, ours
- **Role blend:** entry, support, lurker, anchor, rotator, AWPer, per side, map, spawn and round type, with plain-language evidence for every signal. HLTV's planned award roles are opener, anchor and closer.
- **Positions and rotations**, aggression by round type and economy, spotting and information, utility quality, movement style.

All of these stay on the identity side.
