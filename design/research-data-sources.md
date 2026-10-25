# Data sources and metric definitions: research notes (2026-10-25)

Read by whoever builds real-match import, the metrics library and the clipping service. Confidence levels come from a web survey; verify before relying on them.

## Importing real matches
- **Leetify public API** (`https://api-public.cs-prod.leetify.com`, key from leetify.com/app/developer, Bearer auth): returns per-player per-match **aggregates only** (no rounds, events or positions). Fine for cross-checks and rank history; not a data source for our metrics. Its guidelines require attribution and no implied affiliation. A third-party wrapper mentions a `replay_url`; the official spec does not show one, so check it against the live OpenAPI.
- **Valve demos via the Game Coordinator** (what CS Demo Manager does): only the last 8 matches, and links expire after about 1 month. `.dem.bz2` files are about 30–80 MB. This is the full-fidelity path; the demos go through our demoparser2 pipeline.
- **FACEIT:** demo URLs now need the Downloads API (approval takes about 30 days). Manual download from the match room works.
- **Decision direction:** demos are the full-fidelity input. Leetify is optional metadata.

## Valve "identity" feature
Not found in patch notes or Steam Replay. The closest things are Leetify's "Top Stats" (which it calls player identity) and Scope.gg's percentile buckets. **Ask the user what the feature is called.**

## Metric definitions
- **Counter-strafe:** velocity at the fire tick against about 34% of max speed (about 40 u/s for rifles). Error classes (NextFrag): shooting too early, late reversal, no counter-strafe. Demos record key presses, so strafe overlap is measurable.
- **Peeks:** shoulder (about 50 ms exposure, then reversal), jiggle (repeated shoulder peeks), wide (committed). These are informal, so we define the thresholds ourselves.
- **Utility (Leetify):** an enemy counts as flashed at more than 1.1 s of blind. A flash-to-kill is a flashed enemy dying to the team. Quality is z-scores of flash assists, enemies and friends flashed, blind time and HE damage. Smokes and molotovs have **no published quality definition**: our own design. Use awpy `VisibilityChecker` over `.tri` meshes (about 65 µs per call, static geometry only) plus our own smoke-sphere occlusion. Build the `.tri` files locally with `awpy tri`, because `awpy get` downloads are broken.
- **Information and spotting:** no public definitions. The inputs are demoparser2's spotted fields and our `spotted` change table.
- **Movement:** no open-source path-efficiency or bhop metric code exists, and there's no authoritative "best movers" list (donk is cited for counter-strafing and crouches).

## Ideal spray patterns
The source is the game's `scripts/weapons.vdata_c` (already decoded once at `%TEMP%\pr220\loc\weapons_out`). The recoil seed-to-pattern algorithm is undocumented. cs2spraylab (GPL-3.0) is not bit-exact. Plan: extract the recoil tables ourselves, then validate against recorded sprays (our plugin records the human's per-shot view angles).

## Clipping, later
- **CS2-povforge** already does demoparser2 round selection, then HLAE recording, then ffmpeg. Evaluate it first.
- **HLAE in CS2:** `mirv_streams` replaces `startmovie`; `mirv_cmd addAtTick`; `spec_player`; an ffmpeg preset.
- **Local match recording:** `tv_enable 1` plus `tv_autorecord 1`, or `tv_record`. Unconfirmed on a listen server; demo size is to be measured.
