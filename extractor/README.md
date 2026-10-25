# Extractor

`extract.py` turns one CS2 GOTV demo into the schema v1 parquet tables described in `SCHEMA-v1.md`, and fails the map unless the tables reproduce the demo's own scoreboard. `demo_pipeline.py` runs it over downloaded HLTV archives (see the comment at the top of `start_pipeline.ps1` for starting and stopping it).

## Set up the environment

The pins were frozen on Python 3.12.3. From this folder, on Windows:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
```

On macOS or Linux:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
```

`requirements.txt` has only what the extractor and the pipeline import at run time. `requirements-dev.txt` adds pytest.

## Run the tests

```sh
.venv/Scripts/python -m pytest -q        # .venv/bin/python on macOS or Linux
```

The snapshot tests in `tests/test_snapshot.py` need the private fixture demos and the awpy map data. They read them from `cs2-stats-data` (set `CS2_STATS_DATA` to another folder), expecting `fixtures/fixture-a.dem`, `fixtures/fixture-b.dem` and `mapdata/2000935/`. Without them those tests skip with a `PRIVATE FIXTURE MISSING` message, and the rest still run. After a change that is meant to alter output, regenerate the snapshots with `UPDATE_SNAPSHOTS=1` and review the diff before committing it.

## Extract one demo

```sh
.venv/Scripts/python extract.py match.dem out/ --source hltv --mapdata <cs2-stats-data>/mapdata/2000935
```

The tables land in `out/v-<version>-<hash>/`, and `out/CURRENT` names that folder (see "Finding a map's tables" in `SCHEMA-v1.md`). Without `--mapdata` the map still extracts, but `match.visibility_status` is `no_mapdata`, mesh visibility is null, and only damage and kills open engagements.
