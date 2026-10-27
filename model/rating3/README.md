# Rating 3.02 model artifacts

This directory contains the public Rating 3.02 approximation, its fitting entry point, and bounded research scripts. HLTV rows, demo joins, player identities, derived metrics, and fitted win-probability tables stay outside the repository.

## Refit the public parameters

Use the model virtual environment and isolated Python mode. The fitter reads the private HLTV files, the strict joins and the engine's rating dump (run `pnpm rating-dump` in `app/` first), then emits every public block in `params.json`; it does not read a base parameter file. Run the commands from the repository root; `<cs2-stats-data>` is the private data folder.

```text
model\.venv\Scripts\python.exe -I model\rating3\fit_params.py --data <cs2-stats-data> --hltv <cs2-stats-data>\hltv --joins <cs2-stats-data>\model-rating3\demo_joins.json --out model\rating3\params.json --date 2026-10-25
```

The command fits the per-side rating block (`side_rating_fit.py`), the Swing kill-credit weights (`swing_credit_fit.py`), the duel/economy block, dataset metadata, input definitions, and win-probability source declaration. It prints a readable formula from the emitted coefficients; the formula is not duplicated as a string in `params.json`.

Demo scripts share the extractor resolver in `demo_paths.py`. A `CURRENT` pointer is accepted only when its version folder has a valid `COMPLETE` manifest with matching file sizes; incomplete current versions are skipped during discovery, while flat legacy folders remain supported.

The rating is fitted per side on HLTV's displayed side eKPR, eADR, eDPR and eKAST, its per-round Round Swing, and the 2K to 5K round shares from its kill feed; the total is the sides' round-weighted mean. It remains labeled an approximation.

## Refresh private research outputs

All commands below write only to the sibling private data directory.

```text
model\.venv\Scripts\python.exe -I model\rating3\winprob_fit.py --data <cs2-stats-data>\hltv
```

```text
model\.venv\Scripts\python.exe -I model\rating3\join_demos.py --data <cs2-stats-data> --metrics <cs2-stats-data>\model-rating3\winprob_metrics.json --out <cs2-stats-data>\model-rating3\demo_joins.json
```

```text
model\.venv\Scripts\python.exe -I model\rating3\postplant_analysis.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\postplant_metrics.json
```

```text
model\.venv\Scripts\python.exe -I model\rating3\demo_round_fit.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\demo_round_metrics.json
```

```text
model\.venv\Scripts\python.exe -I model\rating3\swing_fit.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\swing_metrics.json
```

```text
model\.venv\Scripts\python.exe -I model\rating3\eco_fit.py --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --out <cs2-stats-data>\model-rating3\eco_metrics.json
```

```text
model\.venv\Scripts\python.exe -I model\rating3\hypothesis_fit.py --hltv <cs2-stats-data>\hltv --data <cs2-stats-data> --joins <cs2-stats-data>\model-rating3\demo_joins.json --demo-metrics <cs2-stats-data>\model-rating3\demo_round_metrics.json --out <cs2-stats-data>\model-rating3\hypothesis_metrics.json
```

The win-probability fitter writes `winprob-hltv.json` and `winprob_metrics.json` under `<cs2-stats-data>\model-rating3`, and copies the lookup to `%APPDATA%\BotMatchStats\packs\winprob-hltv.json`. It never edits `params.json`. Do not add private reports, joins, identities, or lookup data to this directory.
