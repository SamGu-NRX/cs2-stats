# Third-party notices

cs2-stats is under GPL-3.0-only (`LICENSE`), the whole repository including the capture plugin. The GPL does not cover the numbers taken from the game (see "Numbers taken from the game"). This file lists the third-party code, fonts and data the project uses, with each one's licence. Each licence comes from the project's own metadata: `package.json` or `package-lock.json` for npm packages, `cargo metadata` for crates, the `.nuspec` for NuGet packages, the release's PyPI record for Python packages, and the project's repository where a package declares none. The full licence texts ship inside each package.

## Compatibility with GPL-3.0-only

Every licence listed below lets its code or data be used in a GPL-3.0-only project:

- MIT, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, 0BSD, CC0-1.0, Unicode-3.0 and the Unlicense are permissive and GPL-compatible. A dual or multiple licence (MIT OR Apache-2.0, MIT OR Apache-2.0 OR LGPL-2.1-or-later) is used under one of these.
- Apache-2.0, and Apache-2.0 WITH LLVM-exception, are compatible with GPL version 3.
- MPL-2.0 (five Rust crates and part of tqdm) is compatible with the GPL as a "Secondary License". None of those packages applies MPL's "Incompatible With Secondary Licenses" notice: the phrase appears only in the licence text itself.
- CDLA-Permissive-2.0 (webpki-roots' certificate data) only asks that its licence text accompany the data.
- CC BY 4.0 (the CS2RB and CS2 Playstyle datasets) permits use in GPL-3.0 adaptations, with the attribution given below.
- CounterStrikeSharp.API is GPL-3.0-only, the same licence. This is why the repository is version 3 only.
- The two fonts are under OFL-1.1. OFL does not let the fonts themselves be relicensed under the GPL, but it allows them to be bundled with software under any licence, so the app ships them as separate font files that stay under OFL-1.1.

Several things the app uses are not distributed with it, so their licences place no conditions on this repository: Bot Mode downloads CS2-Bot-Improver (AGPL-3.0, which GPL-3.0 section 13 would also allow combining with), the icon pack script runs Source2Viewer-CLI (MIT), and the clips render through HLAE (MIT) and FFmpeg, which you install yourself. They are listed under "Used at run time, not included".

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

`app/src/clips/director.template.js`, the script HLAE runs inside CS2 to record the clips, is adapted from [CS2-povforge](https://github.com/Chester-chs/CS2-povforge)'s `povforge/director.js` (MIT, Copyright (c) 2026 Chester-chs); `app/src-tauri/src/clips/job.rs` follows its HLAE launch command (`povforge/hlae.py`). The notice is in the script's header.

`app/src/ui/icons/ui.tsx` copies path data from Lucide 1.61.0 (ISC, Copyright 2026 Lucide Icons and Contributors) and Feather (MIT, Copyright 2013-present Cole Bemis). Both notices are in that file.

The Rust side (`app/src-tauri/Cargo.toml`) depends directly on:

| Crate | Licence |
|---|---|
| tauri, tauri-build | Apache-2.0 OR MIT |
| serde, serde_json | MIT OR Apache-2.0 |
| sha2 | MIT OR Apache-2.0 |
| ureq | MIT OR Apache-2.0 |
| zip | MIT |
| tauri-plugin-dialog | Apache-2.0 OR MIT |
| windows-sys | MIT OR Apache-2.0 |

`cargo metadata --locked` resolves 447 crates besides the app's own. Every one offers a permissive licence (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0 or Unlicense) except these:

- cssparser, cssparser-macros, dtoa-short, option-ext and selectors are MPL-2.0.
- webpki-roots is CDLA-Permissive-2.0.

tauri-plugin-dialog, the pro match library's folder picker, adds four crates: itself, rfd (MIT), and tauri-plugin and tauri-plugin-fs (both Apache-2.0 OR MIT).

## In the capture plugin

The plugin compiles against CounterStrikeSharp, which is under GPL-3.0-only, the repository's own licence.

| Package | Version | Licence | Use |
|---|---|---|---|
| CounterStrikeSharp.API | 1.0.376 | GPL-3.0-only | The plugin compiles against it. `ExcludeAssets="runtime"` keeps it out of the plugin's build output, and the CounterStrikeSharp install on the server supplies it |
| xunit | 2.9.3 | Apache-2.0 | Tests only |
| xunit.runner.visualstudio | 3.1.4 | Apache-2.0 | Tests only |
| Microsoft.NET.Test.Sdk | 17.14.1 | MIT | Tests only |

## In the extractor

`extractor/requirements.txt` pins every package the extractor installs, and `requirements-dev.txt` adds the test runner. Where a release's PyPI record has no licence expression, the table gives its licence field or classifiers.

| Package | Version | Licence |
|---|---|---|
| demoparser2 ([LaihoE/demoparser](https://github.com/LaihoE/demoparser)) | 0.42.0 | MIT. The release declares no licence, so this comes from the repository |
| awpy | 3.1.1 | MIT |
| polars | 2.0.0 | MIT |
| polars-runtime-32 | 2.0.0 | MIT |
| pandas | 3.1.0 | BSD-3-Clause |
| pyarrow | 26.0.0 | Apache-2.0 |
| psutil | 7.2.2 | BSD-3-Clause |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| zstandard | 0.25.0 | BSD-3-Clause |
| tzdata | 2026.5 | Apache-2.0 |
| python-dateutil | 3.0.0 | Dual licence: Apache-2.0 and BSD (classifiers) |
| six | 1.17.0 | MIT |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |
| typer | 0.27.3 | MIT |
| annotated-doc | 0.0.5 | MIT |
| rich | 15.0.0 | MIT |
| markdown-it-py | 4.2.0 | MIT |
| mdurl | 0.1.2 | MIT |
| Pygments | 2.21.0 | BSD-2-Clause |
| shellingham | 1.5.4 | ISC |
| colorama | 0.4.6 | BSD-3-Clause. The release gives only "BSD License", so the variant comes from the repository |
| pytest (tests only) | 9.1.1 | MIT |
| pluggy (tests only) | 1.7.0 | MIT |
| iniconfig (tests only) | 2.3.1 | MIT |
| packaging (tests only) | 26.3 | Apache-2.0 OR BSD-2-Clause |

For mesh visibility the extractor reads an [awpy-data](https://github.com/pnxenopoulos/awpy-data) map release (MIT) that you download yourself. The repository does not include it.

## In the model fitting scripts

These run only when someone refits a model. Nothing ships with them.

`model/requirements.txt` (the CS2RB round model):

| Package | Version | Licence |
|---|---|---|
| catboost | 1.2.10 | Apache-2.0 (licence field: "Apache License, Version 2.0") |
| xgboost | 3.4.1 | Apache-2.0 |
| scikit-learn | 1.9.1 | BSD-3-Clause |
| threadpoolctl | 3.7.0 | BSD-3-Clause |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| pandas | 3.1.0 | BSD-3-Clause |
| pyarrow | 26.0.0 | Apache-2.0 |

`model/rating3/requirements.txt` (the rating fit):

| Package | Version | Licence |
|---|---|---|
| numpy | 2.2.6 | BSD (classifier "BSD License") |
| scipy | 1.15.3 | BSD-3-Clause. The release gives only "BSD License", so the variant comes from the repository |
| scikit-learn | 1.6.1 | BSD-3-Clause |
| pyarrow | 19.0.1 | Apache-2.0 |
| threadpoolctl | 3.6.0 | BSD-3-Clause |
| joblib | 1.4.2 | BSD-3-Clause |

`model/package.json` (the TypeScript evaluator's checks) uses typescript 7.0.2 (Apache-2.0) and vitest 4.1.12 (MIT), both for development only.

## Datasets

**CS2RB v1.0.** The coefficients in `model/export/model.json` are fitted on this dataset. The repository holds no CS2RB data. Data licence CC BY 4.0, code licence MIT, both from the dataset's `CITATION.cff` and `LICENSE-DATA.md`.

> Bishop, William (2026). *CS2RB: Aggregate and Individual-Player Models for Round-Win Prediction in Counter-Strike 2*, version 1.0. Data archive: https://doi.org/10.5281/zenodo.22970589. Code: https://github.com/williambishop-research/cs2rb.

**CS2 Playstyle & Roles Dataset (2024).** The role model in `app/src/stats/roles-params.json` is fitted on its features and labels. The repository holds no rows from it. Licence CC BY 4.0, from the repository's `LICENSE`. The attribution it asks for:

> This work uses the CS2 Playstyle & Roles Dataset (2024), created by Jamie Packer, generated using awpy; role labels adapted from Harry Richards' Positions Database. Licensed under CC BY 4.0.

Source: https://github.com/Jamie-Packer/cs2-playstyle-dataset-2024

**HLTV CS2 Demos Dataset (OpenCS2), `blanchon/opencs2_dataset_demo`.** `extractor/fetch_opencs2.py` downloads its demos to the user's own data folder, where the pipeline parses them for the rating fit. The repository holds no demos, rows or names from it. Licence CC BY 4.0, from the dataset card. The card gives no citation text, so this is the attribution:

> HLTV CS2 Demos Dataset, published by blanchon on Hugging Face, licensed under CC BY 4.0. https://huggingface.co/datasets/blanchon/opencs2_dataset_demo

The card notes that the demos are mirrored from HLTV, which hosts recordings provided by tournament organizers, and that users are responsible for respecting those tournaments' terms.

## Numbers taken from the game: not covered by the GPL

These values are Counter-Strike 2's own, read from Valve's game files or from a copy of them. The GPL grants no right to them. They are here so the code can interpret match data from the game.

| File | What it holds | Where it comes from |
|---|---|---|
| `extractor/prices_cs2_1.41.9.2.json` | Weapon and item prices | CS2 build 1.41.9.2: `scripts/weapons.vdata_c` and `scripts/items/items_game.txt` (its `source` field) |
| `app/src/stats/weapons.ts`, `PRICE` | Weapon and item store prices, for rebuilding equipment values in legacy logs | The game's store prices, the same source as the extractor's price file |
| `app/src/stats/aim-ref.ts`, `MAX_SPEED` | Each weapon's maximum speed | `scripts/weapons.vdata_c`, decoded with Source2Viewer-CLI |
| `app/src/stats/recoil.ts`, the cycle time and magazine per gun | Fire rate and magazine size | `scripts/weapons.vdata_c` decoded with Source2Viewer-CLI. The `kick`, `ideal`, and sample-count arrays in the same file are measured from pro demo shot tables by `app/tools/recoil.ts`; they are not copied from the game files |
| `app/src/ui/data/maps.ts`, `MAPS` (`posX`, `posY`, `scale`) | Each map's radar transform | The game's overview files, as copied in `data/radar_info/<map>.txt` of [MurkyYT/cs2-map-icons](https://github.com/MurkyYT/cs2-map-icons), which declares no licence. Only these numbers come from it, and no images |
| `app/src/ui/data/radar-levels.ts`, `LOWER_BELOW` | The height that splits a map's two radar floors | The same overview files |
| `app/src/ui/data/radar-levels.test.ts`, `OVERVIEW` | The same transforms, as the test's known answers | The same overview files |

## Used at run time, not included

- `scripts/extract-icon-pack.cjs` runs Source2Viewer-CLI from [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat) (MIT), which you download yourself. The art it extracts is Valve's and stays in your packs folder.
- Bot Mode downloads [ed0ard/CS2-Bot-Improver](https://github.com/ed0ard/CS2-Bot-Improver) (AGPL-3.0) from GitHub onto your machine. The app does not redistribute it.
- The clips (`app/src/clips`) record through [HLAE](https://github.com/advancedfx/advancedfx) (advancedfx, MIT), which you download and choose in the app, and edit with [FFmpeg](https://ffmpeg.org), which you install yourself (its licence depends on the build: LGPL-2.1-or-later or GPL). The app runs both as separate programs and bundles neither.
