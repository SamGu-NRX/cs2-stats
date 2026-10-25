# Extractor

`extract.py` turns one CS2 demo (HLTV GOTV or Valve matchmaking) into the schema v1 parquet tables described in `SCHEMA-v1.md`, and fails the map unless the tables reproduce the demo's own scoreboard. `demo_pipeline.py` runs it over downloaded HLTV archives (see the comment at the top of `start_pipeline.ps1` for starting and stopping it).

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

## Import Valve matchmaking demos

`valve_import.py` extracts the user's own matchmaking demos (`match730_*.dem`) with source `valve`. The app's sidecar calls it.

```sh
.venv/Scripts/python -I valve_import.py --out <cs2-stats-data>/valve-matches --mapdata <cs2-stats-data>/mapdata/2000935
.venv/Scripts/python -I valve_import.py --out <dir> path/to/match730_x.dem path/to/match730_y.dem
```

With no demo arguments it imports every `match730_*.dem` in the CS2 `replays` folder. It finds that folder through the Steam install (registry, then the usual paths, or `--steam`) and `steamapps/libraryfolders.vdf`. Each demo goes to `<out>/<demo name>/` in the same versioned layout, and it must validate exactly against its own scoreboard. A demo whose current tables already came from the same file and extractor version is skipped; `--force` re-extracts it.

The user is identified by SteamID64. The importer uses `--user` if given, else the id already saved in `<out>/valve-user.local.json`, else the most recent account in Steam's `config/loginusers.vdf`, and saves the choice in that file. The file holds a real account id, so keep it next to the outputs and never commit it.

The importer prints a JSON summary, also written to `--result <file>`. It has one entry per demo, with `ok`, any errors or failed checks, and `user_in_match`. The exit code is 0 only if every demo validated.

Valve demos differ from HLTV GOTV demos in ways the extractor handles (details in `SCHEMA-v1.md`, Validation):
- They have no clan names, so teams are `ct_start` and `t_start`.
- They skip 1 to 3 ticks at round transitions.
- Players disconnect, rejoin or abandon. An abandoner is checked against his counters at the moment he disconnected.
- They do carry `player_blind`, so the rebuilt `blinds` are checked against it.
