# Rating 3.02 model artifacts

This directory contains the public Rating 3.02 approximation, its fitting entry point, and the bounded research scripts used to test alternatives. HLTV rows, demo joins, player identities, and fitted win-probability tables stay outside the repository.

## Refit the shipped parameters

Use the model virtual environment and isolated Python mode. Run from a trusted checkout, passing the private data directory explicitly:

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\fit_params.py --hltv C:\Users\<user>\Programming Projects\cs2-stats-data\hltv --base C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\params.json --out C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\params.json --date 2026-10-25
```

`fit_params.py` recomputes the six-term OLS rating block and grouped holdout metrics. It copies the published `swing`, `duel`, and `ecoAdjustment` blocks from the base file, then writes only the public shipped blocks and dataset size/date metadata. It does not write the private lookup or derived rows.

## Fit the private win-probability pack

```text
C:\Users\<user>\Programming Projects\cs2-stats-rating\model\.venv\Scripts\python.exe -I C:\Users\<user>\Programming Projects\cs2-stats-rating3\model\rating3\winprob_fit.py --data C:\Users\<user>\Programming Projects\cs2-stats-data\hltv
```

The fitter writes `winprob-hltv.json` and `winprob_metrics.json` under `C:\Users\<user>\Programming Projects\cs2-stats-data\model-rating3`, and copies the lookup to `%APPDATA%\BotMatchStats\packs\winprob-hltv.json`. It never edits `params.json`.

Other scripts are exploratory fits or join/analysis tools. Write every generated report, join, and metrics file under the private `model-rating3` data directory; do not add those outputs to this directory.
