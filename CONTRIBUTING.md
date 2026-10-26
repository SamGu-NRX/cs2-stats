# Contributing

## Private data

This repository is public. Some of what the tools read and write must never be committed:

- SteamIDs and player names. Every extracted table holds them, from every source, and `valve-user.local.json` holds the user's own.
- HLTV's rows, and anything derived from the private HLTV win-probability pack, even as quantiles or correlations.
- Absolute paths from a developer's machine.

Two layers keep them out.

**Every writer is guarded.** Each tool output goes through one function: `writeOutput` in `app/tools/outputs.ts` for the TypeScript tools, and `check_output` or `write_json` in `extractor/repo_guard.py` for the extractor and `model/`. Both apply the same rules:

- A private output is refused anywhere in the repository. Paths are compared as real paths, so a different case on Windows, a `..` detour, a link or a junction doesn't get through.
- A public output may land in the repository only at the one path it declares, such as `app/public/baselines.json` or `model/rating3/params.json`.
- A private output carries a marker. In a JSON object that is a first key, `"_private": "do not commit"`. Any other file is named `*.private.*`. Parquet can't take a key, and tracked `.parquet` files are refused outright.

When you add a script that writes a file, use these functions and choose the kind of output. Don't call `writeFileSync` or `open(..., "w")` on a path the user supplies.

**CI checks the tree.** `scripts/check-public-tree.mjs` runs on every pull request (`.github/workflows/hygiene.yml`). It fails when the tracked tree holds any of these:

- a SteamID64 that isn't in `scripts/steamid-allowlist.txt`;
- an absolute developer path such as `C:\Users\<name>\` or `/Users/<name>/`, in either slash style;
- `hltv` anywhere under `app/public/`;
- a file carrying the private marker, or a parquet table.

It decodes gzip files first. Run it before you push with `node scripts/check-public-tree.mjs`.

The allowlist holds only IDs that aren't a real person's: bots in the plugin fixtures, synthetic test IDs, and named constants. Each line gives its reason. Add one only with a reason that holds.

`.gitignore` drops `*.private.*` and `*.local.json`, so a marked file isn't committed by accident in the first place.
