# Extractor

`extract.py` turns one CS2 demo (HLTV GOTV or Valve matchmaking) into the schema v1 parquet tables described in `SCHEMA-v1.md`, and fails the map unless the tables reproduce the demo's own scoreboard. `demo_pipeline.py` runs it over downloaded HLTV archives (see the comment at the top of `start_pipeline.ps1` for starting and stopping it). `stitch.py` joins a map HLTV recorded as several demos into one map, or holds it back; the pipeline runs it on each archive, and `python -I stitch.py --data <folder>` reports on (or with `--apply`, joins or withdraws) parts published by earlier versions.

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

## Pro demos from OpenCS2

The OpenCS2 dataset (`blanchon/opencs2_dataset_demo` on Hugging Face, CC BY 4.0) holds HLTV pro maps as loose `.dem` files. The pipeline takes them from a second folder, `CS2_DEMO_INBOX` (off when unset): each `<match id>/<name>.dem` there needs a sidecar `<name>.meta.json` naming its `source` (`opencs2`), `hltv_match_id`, `hltv_map_index` and `map_name`, or it is refused with a ledger row saying why. Such a demo skips extraction, must have the map its sidecar names, and is parsed under the same disk budget, free-space floor, ledger and retry rules as an archive. Its map is published as `<team1>-vs-<team2>-opencs2-<match id>-m<index>/<map>`, with the sidecar in `match.extra`, which is how `model/rating3/join_demos.py` joins it to its HLTV scoreboard.

`fetch_opencs2.py` fills the inbox. It picks the maps whose HLTV scoreboard is saved in `<data>/hltv`, leaves out those the ledger already holds, and downloads the rest with resume, two at a time at most, while the pipeline's `/pending` has room and the inbox's volume stays above the free-space floor:

```sh
.venv/Scripts/python -I fetch_opencs2.py --inbox <folder> --dry-run      # list what it would fetch
.venv/Scripts/python -I fetch_opencs2.py --inbox <folder> --limit 3      # fetch three maps
```

A demo appears in the inbox, with its sidecar, only once it is whole. Ctrl+C stops it; the next run resumes the partial files. `CS2_PIPELINE_PORT` moves the pipeline's status port (default 8766), and `--status` points the fetcher at it.

## Import Valve matchmaking demos

`valve_import.py` extracts the user's own matchmaking demos (`match730_*.dem`) with source `valve`. The app runs it from Data & settings, "Import Valve matches", into `%APPDATA%\BotMatchStats\valve` (see "The app" below).

```sh
.venv/Scripts/python -I valve_import.py --out <cs2-stats-data>/valve-matches --mapdata <cs2-stats-data>/mapdata/2000935
.venv/Scripts/python -I valve_import.py --out <dir> path/to/match730_x.dem path/to/match730_y.dem
```

With no demo arguments it imports every `match730_*.dem` in the CS2 `replays` folder. It finds that folder through the Steam install (registry, then the usual paths, or `--steam`) and `steamapps/libraryfolders.vdf`. Each demo goes to `<out>/<demo name>/` in the same versioned layout, and it must validate exactly against its own scoreboard. A demo whose current tables already came from the same file, extractor version and importer version is skipped; `--force` re-extracts it.

A demo has no date, so `match.extra` gets one, as `date` and `started_at` in UTC: the match time Steam writes into the `.dem.info` beside the demo, else the demo's file time (`date_source` says which). The app shows `started_at` in local time. `--progress` writes one JSON line to stderr as each demo starts and ends; the app shows them. `valve-user.local.json` is replaced whole through a staged copy, and only when it changes, because the app reads it while it lists matches.

The user is identified by SteamID64. The importer uses `--user` if given, else the id already saved in `<out>/valve-user.local.json`, else the most recent account in Steam's `config/loginusers.vdf`, and saves the choice in that file. The file holds a real account id, so the importer refuses an `--out` inside a git work tree unless you pass `--allow-in-repo`, and `.gitignore` lists the file name.

The importer prints a JSON summary, also written to `--result <file>`. It has one entry per demo, with `ok`, any errors or failed checks, and `user_in_match`. Exit codes:
- 0: every demo validated.
- 1: at least one demo failed.
- 2: bad arguments, an `--out` inside a repository, or no demo to import.

Valve demos differ from HLTV GOTV demos in ways the extractor handles (details in `SCHEMA-v1.md`, Validation):
- They have no clan names, so teams are `ct_start` and `t_start`.
- They skip 1 to 3 ticks at round transitions.
- Players disconnect, rejoin or abandon. An abandoner is checked against his counters at the moment he disconnected.
- They do carry `player_blind`, so the rebuilt `blinds` are checked against it.

### The app

The app reads the folder through the same host layer as plugin matches: `list_valve` and `read_valve` in `app/src-tauri/src/lib.rs` on the desktop, `/__valve/*` in `app/vite.config.ts` for `vite dev` and `vite preview`. A match is the version folder its `CURRENT` names, and it is seen from the SteamID64 in `valve-user.local.json`. Wingman matches are listed but left out of career views, because the rating and win-probability models and the pro baselines are 5v5.

Until the extractor is packaged as a sidecar binary, the app runs the importer from a Python checkout. These variables set where things are:

| Variable | Default | Used for |
|---|---|---|
| `CS2_VALVE_MATCHES` | `%APPDATA%\BotMatchStats\valve` | the folder the app reads and the importer writes |
| `CS2_EXTRACTOR_DIR` | this folder in `vite dev`; none in the desktop app, which then says the importer is not installed | where `valve_import.py` is |
| `CS2_EXTRACTOR_PYTHON` | the extractor folder's `.venv` Python | the interpreter |
| `CS2_MAPDATA` | none (no mesh visibility) | the awpy-data release, such as `<cs2-stats-data>/mapdata/2000935` |
