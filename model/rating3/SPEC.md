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

A strict demo join requires the map, archive date, both five-player rosters, every round winner, and every enemy-kill sequence to agree. Kills after the demo round end are excluded because the HLTV event graph stops at round end. The current join command produces **318 accepted joins, 198 rejected folders, 6,928 joined rounds, and 45,055 joined enemy kills** in `demo_joins.json`.

The shared resolver accepts flat legacy `meta.parquet`/`economy.parquet` folders and versioned schema-v1 folders selected by `CURRENT`. A current version is usable only when its `COMPLETE` filename-to-size manifest matches every listed file; incomplete versions are skipped by discovery, and an unsupported resolved folder fails loudly. The joiner stores join references and checks, not player identities or derived tables in the public repository.

## Win probability

The private lookup uses the most specific available state table. Its selected model includes `last_kill_side` in addition to map, alive counts, plant state, and round-start buy labels. Terminal bomb outcomes return the terminal winner; unknown states are an error during strict validation and `null` in a general engine adapter. The public `params.json` contains only the preferred private-pack path and the existing fallback model path; it does not contain the lookup.

The current lookup fit contains **135,628 events across 503 matches**. On its chronological test split, the selected `last_kill_side` model has **20,235 events**, **0.15259069454690377 percentage-point MAE** overall, and **0.0018920528807220588 percentage-point MAE over 15,064 pre-plant events**. The lookup remains approximate: post-plant timing is not fully identified.

Those values come from the win-probability command above and `C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\winprob_metrics.json`.

The separate post-plant join analysis produces **14,243 aligned event rows over 3,474 rounds**; **8,914 events change after the plant**. This is evidence that post-plant graph values continue to move, not a validated defuse-time threshold. Those values come from the post-plant command above and `postplant_metrics.json`.

## Swing credits

For a valued event, `delta` is the change in the probability of the side helped by the event. A kill gives the victim `-delta`; positive credit is allocated on the killer's side.

The current event model follows this order:

- an unpreventable post-bomb kill has zero swing;
- damage credit uses enemy HP-capped damage at or before the kill and excludes team and self damage; unattributed, health-reconstructed, and reconstructed-ambiguous rows do not receive share credit;
- an eligible enemy flash can receive residual credit, excluding the killer, team flashes, and ambiguous flashes;
- without a flash candidate, positive credit follows the damage ledger, or the killer receives all credit when the ledger is empty;
- a trade death keeps the full victim debit;
- the round-end remainder uses the weights stored in `params.json`.

The Swing fit consumes **318 joins** (**315 schema-v1**, **3 legacy**) with no skipped joins and produces **58,391 valued events**. It excludes **293 health-reconstructed, ambiguous, or unattributed damage rows** from damage-share credit; reported unattributed game damage is **0 HP**. The emitted flash anchor uses the validated three-join legacy calibration baseline: exactly **20 no-damage, exactly-one-flash, no-trade observations**. Their median killer credit ratio is **0.8460031840295292**, which yields the emitted provisional flash residual fraction **0.15399681597047077**. All v1 events remain in the event buckets and held-out diagnostic. The five-fold match-disjoint diagnostic covers **1,447 observations across 155 matches** with **MAE 0.028531040762445**, **p95 0.15407653440795147**, and **maximum 0.2962218825166375**. The round-end remainder and mixed cases are still provisional; the fit status in `params.json` says so.

## Economy adjustment

The duel fit groups weapons as `sniper`, `rifle1`, `rifle2`, `smg`, `pistolPlus`, and `pistol`, strongest first. It fits fractional kill and death points to HLTV eco-adjusted K/D/ADR cells using a Bradley-Terry-style probability and a side edge. Published anchors remain marked as published in `params.json`; fit-derived strengths and scale remain marked as fit-derived.

The current duel fit consumes **318 joins** (**315 schema-v1**, **3 legacy**) with no skipped joins, producing **45,319 recognized duel events** and **3,180 HLTV target rows**. Its fitted strengths are `sniper=0.6211831642060697`, `rifle1=0.5237915968519881`, `rifle2=0.5302156525681799`, `smg=0.40147567806345835`, `pistolPlus=0.15259719869919514`, and `pistol=0`; the kill-points scale is **1.6618416540532308**. Full-fit objective MAE is **0.8004568082803943**. Match-disjoint held-out error is **MAE 0.803752909530498**, **p95 2.0884243605910955**, and **maximum 4.113072563022001** over **3,180 targets and 161 matches**. These values come from `eco_fit.py` and `eco_metrics.json`.

## Shipped approximation

The public rating block is a six-term ordinary-least-squares approximation over HLTV's displayed eKPR, eADR, eDPR, eKAST, raw multi-kill percentage, and displayed Round Swing. The coefficients are stored only in `params.json`; `fit_params.py` prints readable formula text from those coefficients rather than storing a duplicate formula string.

The shipped fit uses **733 HLTV maps, 503 matches, and 7,330 player-map rows**. Its five-fold held-out split is `GroupKFold` by **match**, not by map file. The current held-out result is **MAE 0.04619985241532808**, **p95 error 0.11833462115735568**, **maximum error 0.4568360585830392**, and **correlation 0.9871073278291704**. The block is labeled `approximation`; this is not a recovered HLTV formula.

These values come from the shipped-fit command above and the `rating.fit` object in `params.json`.

The public parameter file also defines every rating input with a definition and unit. It declares the private HLTV lookup as preferred and the existing CS2RB logistic model as fallback. No private lookup, demo join, identity, or formula string is embedded in the public file.

## Demo-round probe

The demo-round probe uses strict joins and fits research-only round models. The current run produces **69,280 player-round rows** and **8,850 total/CT/T equations**. Its final `side_identity_expanded_interactions` stage has **MAE 0.06345268721212202**, **p95 0.16563799997223458**, **maximum error 1.5880659961763595**, and **correlation 0.9836252393287469**. This is not a production fit and no demo-derived coefficients are accepted into `params.json`.

These values come from the demo-round command above and `demo_round_metrics.json`.

## Held-out structural hypotheses

`hypothesis_fit.py` uses five outer `GroupKFold` splits by match and three inner grouped splits to select Ridge alpha. The match grouping prevents maps from the same match appearing in different outer folds. The fit uses the current HLTV set and current strict joins.

| Hypothesis | Rows | Matches | Held-out MAE | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Displayed eco baseline | 7,330 | 503 | 0.046193640980563715 | 0.11843299347110106 | 0.4556835305654009 |
| All map features plus CT/T | 7,330 | 503 | 0.03878783710901304 | 0.10004827514472744 | 0.28515025855072607 |
| All map features plus CT/T and exact demo | 2,950 | 161 | 0.034830608267179305 | 0.09230991774771795 | 0.23688756116976628 |

The strongest all-map hypothesis adds displayed traditional scoreboard columns, result-conditioned and nonlinear terms, and displayed CT/T features. The strongest joined-demo hypothesis adds exact demo damage, actions, outcomes, equipment interactions, and side features. Neither is accepted as the production formula: the demo model covers only the joined subset, and both remain well above the display-level target.

These values come from the hypothesis command above and `hypothesis_metrics.json`. The complete tested hypothesis set remains in that private report.

## Open conclusions

The current evidence supports a public six-term approximation and a private approximate win-probability pack. It does not identify HLTV's exact Rating 3.02 formula, the eKAST transformation, the complete economy function, or the final mixed-case Swing allocation. Those unresolved parts remain explicit in `params.json` and are not replaced with unmeasured constants.
