# Research for direction C

> **Superseded in part (2026-10-25).** The "Decisions for C" and "Decisions for H" below are historical. Where they conflict with `architecture.md` or `identity.md` (the rating label, the comparison population, the similarity formula, the use of game assets), those documents win.


hltv.org returned 403 to every direct fetch, so the HLTV evidence comes from HLTV's own news articles and from a maintained scraper. Leetify's match page renders on the client and fetched empty. Each finding below is marked **verified** (read on a page) or **inferred**.

## HLTV scoreboard
- **Columns (verified):** `K - D | Swing | ADR | KAST | Rating3.0`, one table per team. Eco-adjusted columns (eK-eD, eADR, eKAST) appear only behind a toggle. HLTV removed the `+/-` column as redundant with K-D. Sources: [PGL Bucharest table](https://www.hltv.org/news/45791/upsets-continue-at-pgl-masters-bucharest-as-betboom-defeat-spirit), [Rating 3.0 adjustments](https://www.hltv.org/news/43047/rating-30-adjustments-go-live).
- **Formats (verified from the article table):**

  | Column | Format | Example |
  |---|---|---|
  | K-D | integers, no sign | `57 - 37` (`13-9` on match pages, inferred) |
  | Swing | signed percent, 2 decimals | `+5.03%`, `-3.52%` |
  | ADR | 1 decimal | `86.2` |
  | KAST | percent, 1 decimal | `71.0%` |
  | Rating | 2 decimals | `1.46` |

- **Swing (verified):** the average change in round win probability per round, as a percentage. Season values run from about −1.5% to +4%, and single maps go higher. Source: [Introducing Rating 3.0](https://www.hltv.org/news/42485/introducing-rating-30).

## HLTV round history
- **Verified from the [HLTV scraper](https://github.com/gigobyte/HLTV/blob/master/src/endpoints/getMatchMapStats.ts):**
  - There are two rows, one per team. Each round's outcome icon sits in the winner's row, and the loser's row holds a placeholder (`emptyHistory`).
  - The icons are `t_win` / `ct_win` (elimination), `bomb_exploded`, `bomb_defused` and `stopwatch` (time).
  - A bar marks halftime.
- **Inferred:** the icon takes the colour of the side that won the round.

## Leetify
- **Verified, from a search summary of a match page:**
  - The winning and losing teams sit in separate tables.
  - A top-players strip sits above the tables.
  - Detail lives in tabs (Overview, Utility and others), not on one long page.
  - Green and red are used for ratings relative to the average.
- I found no evidence on its type or on how it mutes secondary text.

## Table guideline: Schwabish, "Ten Guidelines for Better Tables" (JBCA 2020)
Rule names are quoted in [Mock's write-up](https://themockup.blog/posts/2020-09-04-10-table-rules-in-r/). The ones that apply here:
- Offset the headers from the body.
- Use subtle dividers, not heavy gridlines.
- Right-align numbers and use tabular figures.
- Left-align text.
- Use one or two decimals.
- Group with white space.
- Use colour to highlight outliers, not every value.

## Decisions for C
1. **Scoreboard:** Player, K-D, Swing, ADR, KAST, Rating, in HLTV's order and formats. Assists, `+/-` and HS% are dropped; K-D already carries `+/-`. The header reads "Rating 2.0" because the app computes HLTV's public 2.0 approximation, not 3.0.
2. **Round history:** HLTV's two rows.
   - The icon goes in the winner's row, coloured by the side that won. A muted dot fills the loser's row.
   - The win-type icons are elimination, bomb exploded, defused and time.
   - A gap marks halftime.
   - Your kills sit in a third row as counts.
3. **Win-probability chart:** B's chart, drawn on the same round columns as the round history so each round lines up vertically, with a labelled 0/50/100% axis.
4. **Colour:**
   - T and CT hues mark sides only.
   - Green and red appear only where the delta is the point: the rating change and the Versus delta.
   - Swing keeps its sign but is not coloured. In a sortable table its sign already reads as the delta.
5. **Layout and type:**
   - Each team gets its own table, as in Leetify.
   - Headers are bold and sentence case over a rule, with light row rules.
   - Numbers are right-aligned in Schibsted Grotesk with `tnum`.
   - The content sits in a single column of about 640 px, so the eye travels no more than that.

## Player page (for direction H)
hltv.org and web.archive.org refused direct fetches from this machine. Two separate research passes read the HLTV articles below through a fetch tool that summarises pages, so the quotes are close but not guaranteed word-for-word. The live 2025–26 stats page itself was not seen: no screenshot, no DOM.

### Player card
- **Verified:** Rating 3.0 redesigned the page, "with T and CT rating visible alongside rating at the top", and "a splash of team color behind a player's bodyshot on the left". Source: [Introducing Rating 3.0](https://www.hltv.org/news/42485/introducing-rating-30).
- **Verified:** six sub-ratings, "Kills, Damage, Survival, KAST, Multi-Kills, and Round Swing". Each shows a red-yellow-green bar driven by the sub-rating, not the raw number. Same source.
- **Verified:** the embedded player widget reads "Past 3 months", "Age", "Team", "Rating 3.0", "Maps played", "KPR", "DPR". Source: [Rating 3.0 adjustments](https://www.hltv.org/news/43047/rating-30-adjustments-go-live).
- **Verified:** the stats links filter by `startDate`/`endDate` and `rankingFilter=Top20`/`Top30`. Same source, plus [gigobyte/HLTV getPlayerStats.ts](https://github.com/gigobyte/HLTV/blob/master/src/endpoints/getPlayerStats.ts).
- **Unknown:** box order, exact box labels, and the number formats on the card.

### T side / CT side
- **Verified:** T and CT ratings sit next to the overall rating (42485 above).
- **Verified:** the attributes have a side filter "with toggles for Terrorist, Counter-Terrorist, and both sides", plus per round or per 24 rounds. Source: [Introducing HLTV Attributes](https://www.hltv.org/news/39672/introducing-hltv-attributes).
- **Inferred:** the same side filter applies to the stat boxes. I could not see the control type.

### Attributes
- **Verified:** seven groups scored 0–100. "50 is the average score for a top-tier professional player". Each has a bar and a number, and clicking opens a dropdown of sub-stats. Source: 39672.
- **Verified:** the October 2026 overhaul renamed Clutching to Closing and added 29 metrics. The dropdown "usually show[s] just four", the ones that make up the score. A "Compared to: Riflers" (or "AWPers") indicator sits top right. Source: [HLTV attributes receive an overhaul](https://www.hltv.org/news/45755/hltv-attributes-receive-an-overhaul-with-29-new-metrics), dated 19-10-2026.
- **Unknown:** how the sub-stats are drawn, and whether they carry their own bars.

### Recent matches and form
- **Verified (pre-3.0 parser):** the matches table holds date, team, opponent, map, K-D and rating. Source: getPlayerStats.ts above.
- **Unknown:** any form graph, and 3.0-era changes to the table.

### Dark mode
- **Verified:** HLTV has a night mode, toggled from the settings menu (search result for [A new beginning for HLTV.org](https://www.hltv.org/news/20530/a-new-beginning-for-hltvorg)).
- **Unknown:** its colours. No source documented them.

### Live page (verified in a browser by the lead, 2026-10-25)
Screenshots: `design/hltv-ref/` (day theme, attributes expanded, night-mode card). Pro scores: `design/data/pros.json`.
- **Card:** one panel. The photo column holds flag, team logo, name, real name and age, and a "Player profile" button. The right side holds "1729 maps" and a "Show player average" checkbox. A semicircle gauge sits around the rating, with "GOOD" above it, T rating on an orange band to the left and CT rating on a blue band to the right. Below: six cells in two rows (Round swing, DPR, KAST / Multi-kill, ADR, KPR). Each cell has a value, a caps label, a bar with a coloured segment and an "Avg." tick, and GOOD, POOR or N/A.
- **Under the card:** Side (Both | Counter-Terrorist | Terrorist) and "Compared to".
- **Attributes:** Firepower full width, then pairs. Clutching is now **Closing**. Each box has an icon, a name, "?", "92/100", a caret and a blue bar. Expanded, Firepower has 8 sub-stats and the others 4. The names are listed in `extract.mjs` (`SUBS`).
- **Night palette, sampled:** card `#2F2F2E`, pill `#343330`, numbers `#FFD7AD`, labels `#767B79`, gauge and GOOD bar `#11960E`, POOR bar `#E83128`, T `#DB881C`, CT `#0B78B0`, bar track `#4A443D`, button `#325D70`.

### Decisions for H
1. **Card:** HLTV's night card. A CS2 agent render (512×384 from `pak01_dir.vpk`, the largest the game ships) replaces the player photo, with a T/CT toggle. Faint Phoenix and SAS renders sit behind the gauge.
2. **Comparison:** verdicts, the "Avg." tick and attribute scores compare with bot careers, not pros. A cell is GOOD or POOR when it is at least half a standard deviation from the bot-career mean. An attribute score is the mean of the sub-stat percentiles.
3. **Contrast:** text colours that failed 4.5:1 were lifted along the same hue. Labels go `#767B79` → `#A3A7A4`, GOOD `#138511` → `#2DBA2A`, POOR `#D64D3F` → `#F67F74`, CT `#0B78B0` → `#2BA3E0`.
4. **Side:** one switch for the whole app, covering card, attributes, similar players, form, recent matches, match list and match scoreboard. The per-side counters come from the app's own `countMatch`, run on each side's rounds.
5. **Sub-stats:** HLTV's names where the data computes the same thing. Otherwise the closest app metric under its own name, marked ≈.
6. **Similar players:** Pearson correlation of the seven scores, shown as (r + 1) / 2. Your scores are scaled against bots and the pros' against pros, so only the shape compares.
