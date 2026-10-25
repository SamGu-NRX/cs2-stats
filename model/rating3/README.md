# Rating 3.02 model artifacts

This directory contains the public Rating 3.02 approximation, its fitting entry point, and bounded research scripts. HLTV rows, demo joins, player identities, derived metrics, and fitted win-probability tables stay outside the repository.

## Refit the public parameters

Use the model virtual environment and isolated Python mode. The fitter reads the private HLTV files and strict joins, then emits every public block in `params.json`; it does not read a base parameter file.

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\fit_params.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --hltv C:\Users\<user>\Programming Projects\cs2-stats-data\hltv --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\params.json --date 2026-10-25
```

The command fits the six-term rating block, Swing event-credit block, duel/economy block, dataset metadata, input definitions, and win-probability source declaration. It prints a readable formula from the emitted coefficients; the formula is not duplicated as a string in `params.json`.

The public rating inputs are HLTV displayed eKPR, eADR, eDPR, and eKAST, raw multi-kill percentage, and displayed Round Swing. The rating remains labeled an approximation.

## Refresh private research outputs

All commands below write only to the sibling private data directory.

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\winprob_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data\hltv
```

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\join_demos.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --metrics C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\winprob_metrics.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json
```

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\postplant_analysis.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\postplant_metrics.json
```

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\demo_round_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_round_metrics.json
```

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\swing_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\swing_metrics.json
```

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\eco_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\eco_metrics.json
```

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\hypothesis_fit.py --hltv C:\Users\<user>\Programming Projects\cs2-stats-data\hltv --data C:\Users\<user>\Programming Projects\cs2-stats-data --joins C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_joins.json --demo-metrics C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\demo_round_metrics.json --out C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3\hypothesis_metrics.json
```

The win-probability fitter writes `winprob-hltv.json` and `winprob_metrics.json` under `C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3`, and copies the lookup to `%APPDATA%\BotMatchStats\packs\winprob-hltv.json`. It never edits `params.json`. Do not add private reports, joins, identities, or lookup data to this directory.
