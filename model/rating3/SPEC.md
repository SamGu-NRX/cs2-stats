# Rating 3.02 reference specification

This document describes the public approximation and the private research outputs that support it. The production engine reads `params.json`; Python fits coefficients and validates hypotheses. No Python research model is a second production implementation.

## Reproducibility

The commands below use the current private data root and isolated Python mode. They are the producers for the counts and metrics retained in this specification.

### Strict joins

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\join_demos.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --metrics C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\winprob_metrics.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json
```

### Win-probability lookup

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\winprob_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data\hltv
```

### Post-plant analysis

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\postplant_analysis.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\postplant_metrics.json
```

### Demo-round probe

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\demo_round_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_round_metrics.json
```

### Swing and duel fits

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\swing_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\swing_metrics.json
```

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\eco_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\eco_metrics.json
```

### Shipped fit

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\fit_params.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --hltv C:\Users\<user>\Programming Projects\cs2-stats-data\hltv --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\params.json --date 2026-10-25
```

### Held-out hypothesis fits

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\hypothesis_fit.py --hltv C:\Users\<user>\Programming Projects\cs2-stats-data\hltv --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --demo-metrics C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_round_metrics.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\hypothesis_metrics.json
```

## Data contract

HLTV map files with `v: 3` provide the rating and graph targets. The graph target uses the full-precision `performance.rounds.*.events[].y`; display-rounded team text is not used for fitting.

A strict demo join requires the map, archive date, both five-player rosters, every round winner, and every enemy-kill sequence to agree. Kills after the demo round end are excluded because the HLTV event graph stops at round end. The current join command produces **304 accepted joins, 185 rejected folders, 6,630 joined rounds, and 43,138 joined enemy kills** in `demo_joins.json`. Fourteen previously accepted demo inputs remain unavailable after the extractor refresh; the stale 318-join result is retained only where it is explicitly identified as historical below.

The shared resolver accepts flat legacy `meta.parquet`/`economy.parquet` folders and versioned schema-v1 folders selected by `CURRENT`. A current version is usable only when its `COMPLETE` filename-to-size manifest matches every listed file; incomplete versions are skipped by discovery, and an unsupported resolved folder fails loudly. The joiner stores join references and checks, not player identities or derived tables in the public repository.

## Win probability

The private lookup uses the most specific available state table. Its selected model includes `last_kill_side` in addition to map, alive counts, plant state, and round-start buy labels. Terminal bomb outcomes return the terminal winner; unknown states are an error during strict validation and `null` in a general engine adapter. The public `params.json` contains only the preferred private-pack path and the existing fallback model path; it does not contain the lookup.

The current lookup fit contains **135,628 events across 503 matches**. On its chronological test split, the selected `last_kill_side` model has **20,235 events**, **0.15259069454690377 percentage-point MAE** overall, and **0.0018920528807220588 percentage-point MAE over 15,064 pre-plant events**. The lookup remains approximate: post-plant timing is not fully identified.

Those values come from the win-probability command above and `C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\winprob_metrics.json`.

The separate post-plant join analysis produces **13,577 aligned event rows over 3,550 rounds**; **9,115 events change after the plant**. This is evidence that post-plant graph values continue to move, not a validated defuse-time threshold. Those values come from the post-plant command above and `postplant_metrics.json`.

## Swing credits

For a valued event, `delta` is the change in the probability of the side helped by the event. A kill gives the victim `-delta`; positive credit is allocated on the killer's side.

The current event model follows this order:

- an unpreventable post-bomb kill has zero swing;
- damage credit uses enemy HP-capped damage at or before the kill and excludes team and self damage; unattributed, health-reconstructed, and reconstructed-ambiguous rows do not receive share credit;
- an eligible enemy flash can receive residual credit, excluding the killer, team flashes, and ambiguous flashes;
- without a flash candidate, positive credit follows the damage ledger, or the killer receives all credit when the ledger is empty;
- a trade death keeps the full victim debit;
- the round-end remainder uses the weights stored in `params.json`.

The final refreshed Swing fit consumes **304 joins** (**301 schema-v1**, **3 legacy**) with no skipped joins and produces **55,875 valued events**. It excludes **280 health-reconstructed, ambiguous, or unattributed damage rows** from damage-share credit; reported unattributed game damage is **103 HP**. Fourteen older accepted-demo inputs remain unavailable after the extractor refresh, so the earlier **318-join**, **1,447-observation** result is stale and is not emitted. The final flash anchor uses all consumed joins: **1,360 no-damage, exactly-one-flash, no-trade observations** across **155 matches**. Their median killer credit ratio is **0.8460793011826139**, which yields the emitted provisional flash residual fraction **0.15392069881738613**. The layout comparison is **1,340 schema-v1 observations** with fraction **0.15392045885128347** across **155 matches**, versus **20 legacy observations** with fraction **0.15399681597047077** from **one match**. The legacy and schema-v1 estimates differ by **0.00007635711918730**. The legacy sample is much smaller and comes from one match, so this is a population-composition difference; these fits do not show that the extractor schema itself causes a systematic credit shift. The five-fold match-disjoint diagnostic covers **1,360 observations across 155 matches** with **MAE 0.028853675207456905**, **p95 0.15407414621631704**, and **maximum 0.2962288051667772**. The round-end remainder and mixed cases are still provisional; the fit status in `params.json` says so.

## Economy adjustment

The duel fit groups weapons as `sniper`, `rifle1`, `rifle2`, `smg`, `pistolPlus`, and `pistol`, strongest first. It fits fractional kill and death points to HLTV eco-adjusted K/D/ADR cells using a Bradley-Terry-style probability and a side edge. Published anchors remain marked as published in `params.json`; fit-derived strengths and scale remain marked as fit-derived.

The final refreshed duel fit consumes **304 joins** (**301 schema-v1**, **3 legacy**) with no skipped joins, producing **43,387 recognized duel events** and **3,040 HLTV target rows**. It predicts HLTV eco-adjusted kills, deaths, and ADR cells per player-map. Kills and deaths are **kills or deaths per map**; ADR is **HP per round**. The residual weights are **0.2** for kill and death errors and **0.05** for ADR errors, so every reported MAE is in **weighted residual units**, not kills, deaths, or HP. Its fitted strengths are `sniper=0.765624192288676`, `rifle1=0.6028113291326643`, `rifle2=0.2988708070663434`, `smg=0.4258512403690258`, `pistolPlus=0.23895079722688078`, and `pistol=0`; the kill-points scale is **2.0250745163650965**. Full-fit objective MAE is **0.17693824100640804**. Match-disjoint held-out error is **MAE 0.18501190527342595**, **p95 0.39309350845304275**, and **maximum 5.054612324100318** over **3,040 targets and 161 matches**. The no-duel baseline predicts the training-fold mean of each target under the same five-fold match-grouped split. Its held-out error is **MAE 0.7251211422305132**, **p95 1.8612345679012348**, and **maximum 6.9497119341563796**, in the same weighted residual units. The previous 318-join fit reported **MAE 0.803752909530498** in those units, but its 14 unavailable demo inputs make it stale. These values come from `eco_fit.py` and `eco_metrics.json`.

## Shipped approximation

The public rating block is a six-term ordinary-least-squares approximation over HLTV's displayed eKPR, eADR, eDPR, eKAST, raw multi-kill percentage, and displayed Round Swing. The coefficients are stored only in `params.json`; `fit_params.py` prints readable formula text from those coefficients rather than storing a duplicate formula string.

The shipped fit uses **733 HLTV maps, 503 matches, and 7,330 player-map rows**. Its five-fold held-out split is `GroupKFold` by **match**, not by map file. The current held-out result is **MAE 0.04619985241532808**, **p95 error 0.11833462115735568**, **maximum error 0.4568360585830392**, and **correlation 0.9871073278291704**. The block is labeled `approximation`; this is not a recovered HLTV formula.

These values come from the shipped-fit command above and the `rating.fit` object in `params.json`.

The public parameter file also defines every rating input with a definition and unit. It declares the private HLTV lookup as preferred and the existing CS2RB logistic model as fallback. No private lookup, demo join, identity, or formula string is embedded in the public file.

## Demo-round probe

The demo-round probe uses strict joins and fits research-only round models. The current run produces **66,300 player-round rows** and **9,060 total/CT/T equations**. Its final `side_identity_expanded_interactions` stage has **MAE 0.06305474113300961**, **p95 0.16687552328770758**, **maximum error 1.6084772348686291**, and **correlation 0.9837171294075339**. This is not a production fit and no demo-derived coefficients are accepted into `params.json`.

These values come from the demo-round command above and `demo_round_metrics.json`.

## Held-out structural hypotheses

`hypothesis_fit.py` uses five outer `GroupKFold` splits by match and three inner grouped splits to select Ridge alpha. The match grouping prevents maps from the same match appearing in different outer folds. The fit uses the current HLTV set and current strict joins.

| Hypothesis | Rows | Matches | Held-out MAE | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Displayed eco baseline | 7,330 | 503 | 0.046193640980563715 | 0.11843299347110106 | 0.4556835305654009 |
| All map features plus CT/T | 7,330 | 503 | 0.03878783710901304 | 0.10004827514472744 | 0.28515025855072607 |
| All map features plus CT/T and exact demo | 3,020 | 161 | 0.0345957065705249 | 0.09227092820783779 | 0.23073380994966453 |

The strongest all-map hypothesis adds displayed traditional scoreboard columns, result-conditioned and nonlinear terms, and displayed CT/T features. The strongest joined-demo hypothesis adds exact demo damage, actions, outcomes, equipment interactions, and side features. Neither is accepted as the production formula: the demo model covers only the joined subset, and both remain well above the display-level target.

These values come from the hypothesis command above and `hypothesis_metrics.json`. The complete tested hypothesis set remains in that private report.

## Open conclusions

The current evidence supports a public six-term approximation and a private approximate win-probability pack. It does not identify HLTV's exact Rating 3.02 formula, the eKAST transformation, the complete economy function, or the final mixed-case Swing allocation. Those unresolved parts remain explicit in `params.json` and are not replaced with unmeasured constants.
