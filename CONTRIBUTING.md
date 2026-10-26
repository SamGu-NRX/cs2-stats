# Contributing

## Licence

The repository is under GPL-3.0-only (`LICENSE`), and contributions are accepted under the same licence. By opening a pull request, you agree that your contribution is licensed under GPL-3.0-only. Don't add numbers or art copied from the game unless `THIRD_PARTY_NOTICES.md` lists the file and its source.

## Private data

This repository is public. Some of what the tools read and write must never be committed:

- SteamIDs and player names. Every extracted table holds them, from every source, and `valve-user.local.json` holds the user's own.
- HLTV's rows, and anything derived from the private HLTV win-probability pack, even as quantiles or correlations.
- Absolute paths from a developer's machine.

Two layers keep them out.

**Every writer is guarded.** Each tool output goes through one function: `writeOutput` in `app/tools/outputs.ts` for the TypeScript tools, and `check_output` or `write_json` in `extractor/repo_guard.py` for the extractor and `model/`. Both apply the same rules:

- A private output is refused anywhere in the repository. Paths are compared as real paths, so a different case on Windows, a `..` detour, a link or a junction doesn't get through.
- A public output may land in the repository only at the one path it declares, such as `app/public/baselines.json` or `model/rating3/params.json`.
- A private output carries a marker. In a JSON object that is a first key `_private` whose value is `do not commit`. Any other file is named `*.private.*`. Parquet can't take a key, and tracked `.parquet` files are refused outright.

When you add a script that writes a file, use these functions and choose the kind of output. Don't call `writeFileSync` or `open(..., "w")` on a path the user supplies.

**CI checks the tree.** `scripts/check-public-tree.mjs` runs on every pull request (`.github/workflows/hygiene.yml`). It fails when the tracked tree holds any of these:

- a SteamID64 that isn't in `scripts/steamid-allowlist.txt`;
- an absolute developer path such as `C:\Users\<name>\` or `/Users/<name>/`, in either slash style;
- `hltv` anywhere under `app/public/`;
- HLTV's image host, `img-cdn.hltv.org`, in a test or fixture file (code may name it: the CSP and the pro pack's origin allowlist do);
- a file carrying the private marker, or a parquet table.

It decodes gzip files first. Run it before you push with `node scripts/check-public-tree.mjs`.

The allowlist holds only IDs that aren't a real person's: bots in the plugin fixtures, synthetic test IDs, and named constants. Each line gives its reason. Add one only with a reason that holds.

`.gitignore` drops `*.private.*` and `*.local.json`, so a marked file isn't committed by accident in the first place.

## Checks

Each pull request runs these workflows. The job name is the status name on the pull request.

| Workflow | Job | Command |
|---|---|---|
| `tests.yml` | App typecheck, vitest and build | in `app/`: `pnpm install --frozen-lockfile`, `pnpm exec tsc -p tsconfig.app.json --noEmit`, `pnpm exec tsc -p tsconfig.node.json --noEmit`, `pnpm test`, `pnpm build` |
| `tests.yml` | Rust tests (cargo test --lib) | in `app/src-tauri/`: `cargo test --lib --locked`, on Windows |
| `tests.yml` | Extractor tests (pytest) | in `extractor/`: `python -m pytest -q` |
| `tests.yml` | Model tests (unittest) | `python -m unittest discover -s model/rating3 -p "test_*.py"` |
| `tests.yml` | Plugin build and tests (dotnet) | `dotnet build plugin/BotMatchStats.csproj -c Release`, `dotnet test plugin/BotMatchStats.Tests` |
| `hygiene.yml` | Check the public tree | `node scripts/check-public-tree.mjs` |

A test that needs the private data folder or the packs must skip with a message saying what is missing, because CI has neither. No check is required by a branch rule yet. A green run shows that these suites passed, and nothing more.

## PR screenshots

Take every screenshot with personal info hidden, so nothing has to be blurred afterwards. The app then shows your name as You, other people in your matches as Teammate 1 or Opponent 3, and SteamIDs, resolved folder paths and match file names as `<SteamID>`, `<data folder>`, `<path>` or `<file>`. Bots and players in pro demos keep their names, and every number stays as it is. `app/src/ui/data/privacy.ts` lists the rules.

Turn it on with the capture switch, which overrides the saved setting for the session:

- `pnpm capture` in `app/` starts the dev server with `VITE_PRIVACY=1` (from `app/.env.capture`).
- On a dev server that is already running, add `?privacy=1` before the hash: `http://localhost:1420/?privacy=1#/matches`.
- For the desktop window, set the variable for the run: `VITE_PRIVACY=1 pnpm tauri dev` in bash, or `$env:VITE_PRIVACY = "1"; pnpm tauri dev` in PowerShell.

Data & settings shows "On for this session" under Hide personal info when the switch took effect. A script or agent that takes captures uses one of these rather than the checkbox, which would change the saved setting. Before you attach an image, open it at full size and check that no real name, SteamID or folder path shows, including in tooltips and the window title.
