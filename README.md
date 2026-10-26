# cs2-stats

A desktop app that shows HLTV-style stats for Counter-Strike 2 matches on your own machine. It reads four kinds of match: bot matches you record on a local server, your Valve matchmaking demos, pro demos, and a generated sample. It shows a match page (scoreboard, rounds, kill matrix, economy, aim, positions, a 2D round replay) and a profile built from your matches. Stats are computed locally from the match files. There is no account and no server.

The app runs on Windows. The plugin, the importer and the packs folder use `%APPDATA%\BotMatchStats`.

## How data reaches the app

| Part | Folder | Input | Output |
|---|---|---|---|
| Capture plugin (C#, CounterStrikeSharp) | `plugin/` | a bot match on your local CS2 server | one `.json.gz` per match in `%APPDATA%\BotMatchStats\matches\`, described in `SCHEMA.md` |
| Extractor (Python, demoparser2) | `extractor/` | a `.dem` file: your Valve matchmaking demos, or a pro GOTV demo | parquet tables per map, described in `extractor/SCHEMA-v1.md`. `valve_import.py` writes your demos to `%APPDATA%\BotMatchStats\valve\` |
| App (Tauri 2, React, TypeScript) | `app/` | both of the above | the views. A web worker turns every match into the same facts (`app/src/stats/`) before any view reads it |
| Models (Python) | `model/` | public and private training data | `model/export/model.json` (round win probability, fitted on the CS2RB dataset) and `model/rating3/params.json` (the rating approximation) |

The app opens pro demos only through `pnpm dev` with `CS2_DEV_MATCHES` set to a folder of extracted tables (`app/src/ui/data/sources.ts`).

## Build and run

You need Node 20 or later with pnpm 9, Rust 1.85 or later, Python 3.12, and the .NET 10 SDK for the plugin.

```powershell
cd app
pnpm install --frozen-lockfile
pnpm dev          # web build at http://localhost:1420 with the bundled sample matches
pnpm tauri dev    # the desktop app, reading %APPDATA%\BotMatchStats
pnpm tauri build  # release exe and NSIS installer under src-tauri\target\release\
```

To build the plugin, run `dotnet build -c Release` in `plugin/`. The app's Bot Mode can install it into CS2 together with a bot mod and start the game. `app/README.md` explains what Bot Mode changes and how it turns itself off.

To set up the extractor, follow `extractor/README.md`. The model folders have their own READMEs.

## Optional local packs

Some of what the app can show is third-party material that this repository must not hold. The app reads it from `%APPDATA%\BotMatchStats\packs\` at run time, and every view works without it. Data & settings, Packs, shows which packs the app found.

| Pack | What it adds | How to get it | Without it |
|---|---|---|---|
| `icons/` | Weapon, grenade and kill-flag icons, round-end icons, map radars and map emblems, all from the game | Run `node scripts/extract-icon-pack.cjs` from the repository root. It finds CS2 through Steam, or takes `--cs2` with the install folder or its `game\csgo\pak01_dir.vpk`. It reads the game files with Source2Viewer-CLI from [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat/releases), expected at `%TEMP%\cs2-icon-pack\vrf\Source2Viewer-CLI.exe` unless `--vrf` gives another path | Icons show the object's name as text. Radars are drawn from where players stood in your matches. Map emblems show a two-letter monogram |
| `agents/` | Agent renders on the player card: `t-portrait.png`, `t-ghost.png`, `ct-portrait.png`, `ct-ghost.png` | Add the files yourself. The repository has no tool for them | The card draws a silhouette |
| `pros.json` | "Plays like": your attributes next to named pros, with photo and flag links | The format is in `app/src/ui/data/packs.ts` and `proPack.ts`. The repository has no tool that collects it | "Plays like" stays hidden |
| `winprob-hltv.json` | A round win-probability lookup fitted to HLTV match pages | `model/rating3/winprob_fit.py` (see `model/rating3/README.md`), from HLTV data you collect yourself | Swing uses the CS2RB model in `model/export/` |
| `baselines.local.json` | Pro percentiles computed with the lookup above | `pnpm baselines` in `app/` while `winprob-hltv.json` is installed | The app ranks against `app/public/baselines.json` |

`extract-icon-pack.cjs` refuses to write inside this repository. The tools that build the other packs mark their output as private, and the repository's guards refuse it (`CONTRIBUTING.md`).

## Privacy

- Your match files, demos, imported tables and packs stay in `%APPDATA%\BotMatchStats` and in folders you choose. The app sends none of them anywhere.
- The app's content security policy (`app/src-tauri/tauri.conf.json`) allows remote images from two origins only, for the photos and flags a `pros.json` links to. Without that pack the app loads no remote content.
- Bot Mode downloads the bot mod's release from GitHub. Apart from that download and the pack's images, the app does not use the network.
- The repository holds no SteamIDs except allowlisted bots and synthetic test ids, no player names from your matches, no HLTV data and no Valve art. `scripts/check-public-tree.mjs` checks the tracked tree on every pull request. `CONTRIBUTING.md` lists the rules and the guards behind them.

## Tests

CI runs all of these on every pull request (`.github/workflows/tests.yml`):

```sh
(cd app && pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm exec tsc -p tsconfig.node.json --noEmit && pnpm test && pnpm build)
(cd app/src-tauri && cargo test --lib --locked)
(cd extractor && python -m pytest -q)
python -m unittest discover -s model/rating3 -p "test_*.py"
dotnet build plugin/BotMatchStats.csproj -c Release && dotnet test plugin/BotMatchStats.Tests
node scripts/check-public-tree.mjs
```

Tests that need private data (pro demos, HLTV files, the packs) skip with a message when it is missing.

## Licensing

The whole repository is under the GNU General Public License, version 3 only (`GPL-3.0-only`, text in `LICENSE`). It is version 3 only, not "or later", to match CounterStrikeSharp, which the capture plugin compiles against and which is GPL-3.0-only.

Some files hold numbers taken from the game: prices, weapon speeds, fire rates and magazine sizes, and the radar transforms. The GPL does not cover those numbers. `THIRD_PARTY_NOTICES.md` lists each file and where its numbers come from.

`THIRD_PARTY_NOTICES.md` also lists the libraries, fonts and datasets the project uses, with their licences.
