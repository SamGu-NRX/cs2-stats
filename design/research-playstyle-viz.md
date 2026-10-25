# Playstyle and pattern visualizations: what exists, what we build

Read by whoever builds the app's Playstyle, Positions and Pro-comparison views. A survey from 2026-10-25, based on web text only; screenshots were not viewed.

## Proven ideas, ranked
1. **Role map (NER0cs / Harry Richards Positions Database, Tableau, ~266K views):** each player is a dot coloured by role, filtered by side and map. Inputs: team-centre and nearest-teammate distance ranks (Jamie-Packer dataset, CC BY 4.0, which also has role labels to validate against).
2. **0–100 attribute bars (HLTV Attributes):** "rating covers performance, attributes cover style". We already have these.
3. **Percentile tiles with a benchmark (Leetify):** e.g. "Crosshair placement 8.69°, better than 84%". Tagged Aim, Utility, Style, Positioning.
4. **Heatmaps on the radar (GetReplay, cs2d):** presence, kills and deaths by side, round type and floor. Clicking a hot zone jumps to that moment.
5. **Pro aim percentiles with "similar aim profiles" (Nomiun):** AWPers get only the metrics that apply to them.
6. **Role clusters:** a PCA scatter plus a z-score trait heatmap (cs2-role-clustering). AWPer separates cleanly; T-side lurk, space-taking and IGL do not, because roles are graded.
7. **Utility landing maps:** throw-to-land lines, filterable, linked to the round. Scope.gg also flags mistakes, such as a molotov into your own smoke.
8. **Economy timeline per round.**
9. **Side-by-side comparison across about 20 metrics (Scope.gg Compare):** benchmarks by skill level, not a named pro.
10. **When in the round you fight:** time-of-first-contact distribution and opening-attempt rate. Defined in the Packer dataset; no polished public chart exists.

## Comparing with pros
A percentile among peers is more useful than raw pro numbers: even the worst pro beats 99.9% of players, so a pro-percentile scale demoralises. So:
- default to "vs pros in the same role", plus "your trend";
- name a pro only where it explains something (see "Build ourselves" 2).

## Build ourselves (nobody does these well)
1. **Role fit as a blend, not a label:** e.g. "62% anchor, 30% rotator" per map and side, with the evidence (positions, trades).
2. **A named-pro match that explains itself:** "Your CT positioning on Mirage is closest to X; your first-contact timing is closest to Y." This needs feature vectors per player, map and side.
3. **Rotation and first-contact flow:** callout-to-callout movement as flows (from 4 Hz place names) with timing bands, and first contact taken from spotted masks.

## Reusable code and assets
| Item | License | Use |
|---|---|---|
| akiver/cs-demo-manager (radar, heatmaps, 2D viewer; `src/ui/maps/radar-level.ts`) | MIT | Best reference for the 2D viewer and radar |
| sparkoo/csgo-2d-demo-viewer | MIT | 2D viewer reference |
| awpy (map data, plots) | Code MIT; map data licence not stated | Coordinate transforms |
| MurkyYT/cs2-map-icons (radar PNGs + pos_x/pos_y/scale/verticalsections, auto-updated) | Valve assets, no licence | Coordinate transform reference; radar images for personal local use only |
| untraded PR #104 (SVG radars drawn from the nav mesh) | CC BY 4.0 | Radars we can ship |
| Jamie-Packer cs2-playstyle-dataset-2024 | CC BY 4.0 | Role features and labels for validation |
| cs2-role-clustering | No licence | Feature list (ideas only) |
| heatmap.js, d3-contour | Check before use | Density layers |
| Boltobserv radars | GPL-3.0 | Avoid bundling |
| SimpleRadar | No licence | Avoid |
| shorebeedome/cs-demo-manager | Restrictive | Avoid |
