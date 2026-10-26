# Third-party notices

cs2-stats is under the MIT licence (`LICENSE`). This file lists the third-party code, fonts and data the project uses, with each one's licence. Each licence comes from the project's own metadata: `package.json` for npm packages, `cargo metadata` for crates, the `.nuspec` for NuGet packages, the installed package metadata or PyPI record for Python packages, and the project's repository where a package declares none. The full licence texts ship inside each package.

## In the desktop app

These are bundled into the app that `pnpm tauri build` produces.

| Package | Version | Licence |
|---|---|---|
| react, react-dom | 18.3.1 | MIT |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT |
| hyparquet | 1.31.5 | MIT |
| hyparquet-compressors | 1.1.2 | MIT |
| @fontsource-variable/schibsted-grotesk (Schibsted Grotesk, Copyright 2023 The Schibsted-Grotesk Project Authors) | 5.3.0 | OFL-1.1 |
| @fontsource/ibm-plex-mono (IBM Plex Mono, Copyright 2017 IBM Corp.) | 5.3.0 | OFL-1.1 |

`app/src/ui/icons/ui.tsx` copies path data from Lucide 1.61.0 (ISC, Copyright 2026 Lucide Icons and Contributors) and Feather (MIT, Copyright 2013-present Cole Bemis). Both notices are in that file.

The Rust side (`app/src-tauri/Cargo.toml`) depends directly on:

| Crate | Licence |
|---|---|
| tauri, tauri-build | Apache-2.0 OR MIT |
| serde, serde_json | MIT OR Apache-2.0 |
| sha2 | MIT OR Apache-2.0 |
| ureq | MIT OR Apache-2.0 |
| zip | MIT |
| windows-sys | MIT OR Apache-2.0 |

`cargo metadata` resolves 432 crates in all. Every one offers a permissive licence (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0 or Unlicense) except these:

- cssparser, cssparser-macros, dtoa-short, option-ext and selectors are MPL-2.0.
- webpki-roots is CDLA-Permissive-2.0.

## In the capture plugin

| Package | Version | Licence | Use |
|---|---|---|---|
| CounterStrikeSharp.API | 1.0.376 | GPL-3.0-only | The plugin compiles against it. `ExcludeAssets="runtime"` keeps it out of the plugin's build output, and the CounterStrikeSharp install on the server supplies it |
| xunit | 2.9.3 | Apache-2.0 | Tests only |
| xunit.runner.visualstudio | 3.1.4 | Apache-2.0 | Tests only |
| Microsoft.NET.Test.Sdk | 17.14.1 | MIT | Tests only |

## In the extractor

`extractor/requirements.txt` pins these direct dependencies:

| Package | Version | Licence |
|---|---|---|
| demoparser2 ([LaihoE/demoparser](https://github.com/LaihoE/demoparser)) | 0.42.0 | MIT. The wheel declares no licence, so this comes from the repository |
| awpy | 3.1.1 | MIT |
| polars | 2.0.0 | MIT |
| pandas | 3.1.0 | BSD-3-Clause |
| pyarrow | 26.0.0 | Apache-2.0 |
| psutil | 7.2.2 | BSD-3-Clause |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| pytest (tests only) | 9.1.1 | MIT |

For mesh visibility the extractor reads an [awpy-data](https://github.com/pnxenopoulos/awpy-data) map release (MIT) that you download yourself. The repository does not include it.

## In the model fitting scripts

These run only when someone refits a model. Nothing ships with them.

| Package | Licence |
|---|---|
| catboost | Apache-2.0 |
| xgboost | Apache-2.0 |
| scikit-learn | BSD-3-Clause |
| scipy | BSD-3-Clause |
| numpy | BSD-3-Clause |
| pyarrow | Apache-2.0 |

## Datasets

**CS2RB v1.0.** The coefficients in `model/export/model.json` are fitted on this dataset. The repository holds no CS2RB data. Data licence CC BY 4.0, code licence MIT, both from the dataset's `CITATION.cff` and `LICENSE-DATA.md`.

> Bishop, William (2026). *CS2RB: Aggregate and Individual-Player Models for Round-Win Prediction in Counter-Strike 2*, version 1.0. Data archive: https://doi.org/10.5281/zenodo.22970589. Code: https://github.com/williambishop-research/cs2rb.

**CS2 Playstyle & Roles Dataset (2024).** The role model in `app/src/stats/roles-params.json` is fitted on its features and labels. The repository holds no rows from it. Licence CC BY 4.0, from the repository's `LICENSE`. The attribution it asks for:

> This work uses the CS2 Playstyle & Roles Dataset (2024), created by Jamie Packer, generated using awpy; role labels adapted from Harry Richards' Positions Database. Licensed under CC BY 4.0.

Source: https://github.com/Jamie-Packer/cs2-playstyle-dataset-2024

## Numbers taken from the game

- `extractor/prices_cs2_1.41.9.2.json` holds weapon and item prices read from the CS2 game files. Its `source` field says which files.
- The radar transforms in `app/src/ui/data/maps.ts` and the floor heights in `app/src/ui/data/radar-levels.ts` are numbers from the game's overview files, read from the copies in [MurkyYT/cs2-map-icons](https://github.com/MurkyYT/cs2-map-icons). That repository declares no licence. Only these numbers come from it, and no images.

## Used at run time, not included

- `scripts/extract-icon-pack.cjs` runs Source2Viewer-CLI from [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat) (MIT), which you download yourself. The art it extracts is Valve's and stays in your packs folder.
- Bot Mode downloads [ed0ard/CS2-Bot-Improver](https://github.com/ed0ard/CS2-Bot-Improver) (AGPL-3.0) from GitHub onto your machine. The app does not redistribute it.
