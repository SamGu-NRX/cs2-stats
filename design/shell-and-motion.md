# Shell, visual system and motion

Direction: a broadcast analyst's desk. HLTV night-mode warmth, the chrome and density of a real Windows tool (VS Code / Figma grade), with the player and the map as atmosphere, never as decoration. Direction-h failed as an app because it is a centred web page inside a window; this spec replaces that structure and keeps its tokens.

## 1. Desktop shell

### Window layout

| Region | Spec |
| --- | --- |
| Min window | 1024 × 680. Open hidden (`visible: false`), `show()` after first React paint, so there is never a white flash. |
| Sidebar | 232 px expanded, 56 px icon rail collapsed. Toggle: bottom button or Ctrl+B. Auto-rail below 1100 px window width. Persist state. Contents, top to bottom: player identity (avatar 28, name, current rating in cream), nav (Home, Matches, Profile, Career aim), spacer, Data & settings, sync dot + last scan time. Active item: 2 px cream bar on the left edge, `--bg2` fill. No section headers. |
| Top bar | 44 px, is the title bar (`decorations: false`, `data-tauri-drag-region`, double-click maximises). Left: breadcrumb (`exzotikgaming6 / Matches / Dust II · Oct 24`), each segment clickable. Right: view-scoped filters (map, time, side), search button (`Ctrl K`), then three caption buttons 46 × 44 using Segoe Fluent Icons glyphs (E921, E922/E923, E8BB); close hover `#C42B1C`. Snap-layout flyout is lost with a custom bar; accept it. |
| Content pane | Full bleed with a 24 px gutter. Matches table, Rounds grid, Positions radar and all charts run edge to edge. Home, Profile, Career aim and Settings cap at 1360 px, left-anchored, never centred. |
| Match view | Hero (score, teams, map) 128 px, then the round rail (section 4), then the tab bar; tab panels scroll independently beneath a sticky rail + tabs. |
| Round drawer | Right-hand pane inside the Rounds tab, 420 px default, drag-resizable 360–640 via a 6 px handle with a 12 px hit area, persisted. Below 1280 px content width it becomes an overlay with a 40 % scrim. Resizing is 1:1, no transition. The grid scroller shrinks; cells never shrink (fixed 28 px cells, horizontal scroll). |

### Native on Windows 11

| Concern | Decision |
| --- | --- |
| Mica / acrylic | No Mica. It tints the warm charcoal with the wallpaper and forces a transparent window, which costs GPU under big tables. In-app acrylic only (`backdrop-filter: blur(20px) saturate(1.2)` over the app's own content) on the command palette and context menus. |
| Scrollbars | `::-webkit-scrollbar` 10 px, thumb `--line2` with 3 px transparent border (`background-clip: padding-box`), radius 5, hover `--track`, track transparent. `scrollbar-gutter: stable` on every table. |
| Focus | `:focus-visible` only: 2 px `--cream` outline, offset 2, radius matches element. Never on `:focus`. |
| Context menus | Custom, Fluent metrics: 32 px items, 4 px padding, radius 8, 1 px `--line2`, acrylic. Match row: Open, Copy share code, Show demo in Explorer, Delete match. Round cell: Open round, Copy round summary. Stat: Copy value. |
| Tooltips | 12 px `--ink`, bg `--bg0`, 1 px `--line2`, radius 6, max 280 px. 400 ms delay on first; instant while another tooltip closed < 300 ms ago. Never restate the label; tooltips carry the definition or the sample size. |
| Shortcuts | `Ctrl K` palette · `Ctrl 1–4` views · `Ctrl B` sidebar · `Ctrl ,` settings · `Ctrl R` rescan demos · `J/K` row move · `Enter` open · `Esc` close drawer or palette · `← →` previous/next round when the drawer is open · `[ ]` previous/next match · `Alt 1–7` match tabs · `/` focus table filter. Show them in tooltips as `Ctrl K` chips. |
| Command palette | Matches ("dust2 oct 24"), players, views, actions (Rescan demos, Export match JSON, Open demo folder). 560 px wide, top-anchored at 96 px, opens and closes with zero animation. |

### Density

8 px base, 4 px half-steps. Row heights: table 36, dense grid cell 28, sidebar and menu items 32, palette items 36. Card padding 16, grid gap 12, section gap 24. Body 13 px; nothing in the UI is 14–16 px except row primary names (14). Numbers right-aligned, tabular. One density; no comfortable/compact toggle.

## 2. Visual system

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--bg-side` | `#161413` | Sidebar, title bar |
| `--bg0` | `#1A1817` | Content canvas |
| `--bg1` | `#242220` | Cards, table body |
| `--bg2` | `#2C2825` | Table header, nested panels, popovers |
| `--pill` / `--raise` | `#36312D` / `#3B3631` | Chips; hover raise |
| `--line` / `--line2` / `--track` | `#36322E` / `#45403A` / `#4A443D` | Hairline; strong; bar tracks |
| `--cream` | `#FFD7AD` | Hero numbers, selection, links, focus |
| `--ink` / `--ink2` / `--ink3` / `--tan` | `#E6E2DC` / `#A3A7A4` / `#6B6A66` / `#AC957A` | Primary; secondary (cool grey on warm, keep the tension); muted; caps labels |
| `--t` / `--t-soft` | `#DB881C` / `rgba(219,136,28,.16)` | Terrorist text and fills |
| `--ct` / `--ct-soft` | `#2BA3E0` / `rgba(43,163,224,.16)` | CT text and fills |
| `--poor` / `--poor-text` | `#E83128` / `#F67F74` | Bars; small text |
| `--below` | `#C25A4F` | Bars only |
| `--avg` | `#7D7A74` | Bars only, no label rendered |
| `--good` / `--good-text` | `#11960E` / `#2DBA2A` | Bars; small text (`--good` is 4.3:1 on `--bg1`, text-unsafe) |
| `--great` | `#43D13F` | Bars; text uses `--good-text` |
| `--hover` | `rgba(255,255,255,.04)` | Row hover |
| `--shadow-float` | `0 8px 24px rgba(0,0,0,.45), 0 0 0 1px #45403A` | Popover, palette, toast, overlay drawer only |

Elevation is surface step + hairline, never a shadow, up to `--bg2`. Only floating layers get `--shadow-float`. Win badges are cream, loss badges are outlined `--ink3`; red means poor performance, never a lost match. Radius scale 4 (chips, cells), 6 (buttons, inputs), 8 (cards, menus), 10 (palette).

### Type

Self-host two families as woff2, `font-display: block`.

- **Schibsted Grotesk** variable 400–800: all UI and all numbers. The HLTV card the user chose makes the numbers the display face; ExtraBold cream numerals carry the personality. Confirm the build exposes `tnum`; if not, serve Archivo for numeric cells. There is no evidence yet either way.
- **IBM Plex Mono** 400/500: round clocks (`1:55`), killfeed timestamps, share codes, file paths, tick labels.

| Step | Size / weight / tracking | Where |
| --- | --- | --- |
| Caps | 11 / 600 / 0.08em, `--tan` | Column headers, stat labels, eyebrows. Nothing larger is ever uppercase. |
| Meta | 12 / 400 | Secondary cells, tooltips |
| Body | 13 / 400 | Cells, controls |
| Name | 14 / 600 | Row primary |
| Section | 16 / 600 / -0.01em | Card titles |
| Sub-hero | 20 / 700 / -0.01em | Team names |
| Tile | 28 / 800 / -0.02em, cream | Stat tiles, six HLTV cells |
| Hero | 40 / 800 / -0.02em, cream | Rating 3.0 (approx.), form numbers |
| Score | 56 / 800 / -0.03em | Match score (loser in `--ink3`) |

Line height 1.3 up to 14, 1.2 to 28, 1.0 from 40. `font-variant-numeric: tabular-nums` on every numeric container.

### Icons

16 px grid, 14 px live area, 1.5 px stroke, round caps and joins, `currentColor`. 20 px in the sidebar, same stroke. At 12 px (badges, round-rail cells) use filled glyphs; strokes crumble.

| Icon | Drawing |
| --- | --- |
| Firepower | Three upright cartridges, middle one taller |
| Entrying | Arrow entering an open bracket from the left |
| Trading | Two opposed horizontal arrows, offset vertically |
| Opening | Crosshair ring with a single tick at 12 o'clock (first contact) |
| Closing | Shield outline |
| Sniping | Scope reticle: ring, four ticks, centre dot |
| Utility | Grenade body with lever |
| Elimination | Filled crosshair diamond |
| Bomb exploded | Eight-point starburst |
| Defused | Defuse kit: wire cutters |
| Time | Clock, hand at 1:55 |
| Pistol / Eco / Force / Full | Pistol silhouette; one, two, three ascending bars |

### Background

Flat `--bg0`. One fixed atmosphere layer per view, `pointer-events: none`, never full-page:

- Home and Profile: the player's agent portrait (extracted at runtime from the user's own CS2 install, never committed to the repo) at 100 % in the hero only, plus the ghosted T and CT heads from the HLTV card at 18 %, radial-masked; the head on the active side brightens to 30 %.
- Match: the map's radar overview, desaturated, 6 % opacity, 1400 px, pinned top-right of the hero, masked to transparent by 420 px. Crossfades 240 ms when the match changes.
- Rounds, Positions, Economy, Aim, Career aim, Settings: nothing. No noise, no vignette, no gradients.

## 3. Motion

Tokens: `--ease-out: cubic-bezier(.23,1,.32,1)` (enter), `--ease-in-out: cubic-bezier(.77,0,.175,1)` (on-screen move), `--ease-drawer: cubic-bezier(.32,.72,0,1)` (panes). Springs via Motion: `drawer { duration: .45, bounce: .08 }`. Exits use `--ease-out` at roughly 60 % of the enter duration.

| Moment | Trigger | Animates | Duration | Easing | Interrupt | Reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| App launch | First paint | Content pane opacity 0→1, translateY 6→0 (shell is static) | 160 ms | `--ease-out` | n/a | Opacity only |
| Sidebar collapse | Button click | Sidebar `width`; labels opacity 100 ms | 180 ms | `--ease-in-out` | Retargets | Instant |
| Sidebar collapse | Ctrl+B | Nothing | 0 | – | – | – |
| View change | Nav click | Out: opacity 80 ms. In: opacity + translateY 6→0. Active bar translateY between items | 180 / 200 ms | `--ease-out` / `--ease-in-out` | New route skips pending | Crossfade; bar jumps |
| Tab switch | Click | Underline translateX + scaleX only; panel swaps instantly; charts do not replay reveals | 200 ms | `--ease-in-out` | Retargets | Jump |
| Open match | Row click | View Transition: `view-transition-name` `match-score` and `match-map` set on the clicked row only, morph into the hero; root crossfade 160 ms. Feature-detect `startViewTransition` (WebView2 ≥ 111), else crossfade | 280 ms | `--ease-drawer` | `skipTransition()` on new nav | Crossfade only |
| Round drawer open | Cell click | translateX 100 %→0 over the grid; grid width set after the transition ends behind the opaque edge | 320 ms | spring .45 / .08 | Spring reverses | Opacity 120 ms |
| Round drawer close | Close button | translateX 0→100 % | 200 ms | `--ease-out` | Reverses | Opacity |
| Any keyboard action | Ctrl+N, Alt+N, Enter, Esc, arrows, palette commands | Nothing: the change is instant | 0 | – | – | – |
| Drawer content | First open | Killfeed rows opacity + translateY 4, stagger 20 ms, max 12 | 120 ms each | `--ease-out` | – | None |
| Drawer content | ← → or another cell | Instant swap | 0 | – | – | – |
| Attribute expand | Row click | `grid-template-rows 0fr→1fr`; sub-stats opacity after 60 ms; chevron rotate 180° | 220 ms | `--ease-in-out` | Retargets | Instant height, fade |
| Gauge and numbers | Hero enters viewport, first time per session | Arc `stroke-dashoffset`; rating counts 0.00→value via rAF; six bars scaleX from left, stagger 40 ms; Good/Poor labels fade last | 600 ms | `cubic-bezier(.2,.8,.2,1)` | Not interruptible, never replays | All static |
| Row hover | Pointer, `(hover:hover)` | `background-color` | 80 ms | `ease` | – | Same |
| Row / card press | `:active` | Background to `--raise`; no scale on wide rows | 0 | – | – | Same |
| Button press | `:active` | `scale(.97)` | 120 ms | `--ease-out` | – | None |
| Tooltip | Hover 400 ms | Opacity, `scale(.97→1)` from anchor origin | 125 ms | `--ease-out` | Instant when chained | Opacity |
| Popover / select | Click | Opacity, `scale(.96→1)` from anchor; exit 100 ms | 150 ms | `--ease-out` | Retargets | Opacity |
| Context menu | Right-click | Opacity | 100 ms | `--ease-out` | – | Same |
| Command palette | Ctrl+K | Nothing | 0 | – | – | – |
| Select pro | Row click | Banner: incoming image opacity 0→1 with `filter: blur(2px)→0`; radar polygon points lerp (store current points, lerp from there); table values swap instantly | 240 / 320 ms | `ease` / `--ease-in-out` | Lerps from current | Crossfade; polygon jumps |
| Side switch | Segmented control | `--side` variable swap; `color, background-color, fill, stroke` transition; ghost head opacity; thumb translateX 160 ms | 200 ms | `ease` | Retargets | Same (colour is allowed) |
| Skeleton | Load > 150 ms | Opacity pulse .5↔1; content replaces with 120 ms crossfade | 1.2 s loop | `ease-in-out` | – | Static |
| Toast | Event | translateY 16→0 + opacity; exit 150 ms; stack of 3 with 8 px offset and `scale(.96)`; swipe-right dismiss at velocity > 0.11 px/ms; timers pause on window blur | 220 ms | `--ease-out` | Retargets | Opacity |
| Map atmosphere | Match change | Opacity crossfade | 240 ms | `ease` | Retargets | Same |

Never animate: sorting, filtering, reordering rows; keyboard focus or selection moves; data refresh and number updates (filters change values in the same frame); window resize; drawer resize drag; radar pan and zoom (1:1); tab panel content; scroll position (no smooth scroll).

Performance: transform and opacity only, with these named exceptions: sidebar `width`, attribute `grid-template-rows`, gauge stroke, colour transitions. No `transition: all`. Matches table virtualised past 200 rows with fixed `table-layout`. `will-change` only during an animation. Motion props use `transform` strings, not `x`/`y`. Verify at 4× slow-mo in DevTools; a dropped frame on the drawer open is a bug.

## 4. Signature moments

1. **Score handoff.** Clicking a match carries its score and map label from the row into the hero as one object, the radar ghost fades in behind, and the round rail draws left to right (`clip-path: inset(0 100% 0 0)` → `0`, 400 ms, same curve as the gauge), once per match open. Home, Matches and Match become one surface.
2. **The round rail is the spine.** The round-history strip from direction-h sits under the hero on every match tab, with a 2 px cream playhead on the selected round. Clicking a round anywhere switches to Rounds and opens that round's drawer; `← →` step the playhead with no animation; the Rounds grid's column highlight is the same cream, so rail and grid read as one cursor.
3. **The card wakes once, then lights per side.** The HLTV gauge draws, the rating counts up, six bars extend in a 40 ms cascade, then everything is still for the rest of the session. Switching T/CT is a lighting change: numbers, bars and the ghosted head recolour together in 200 ms, numbers themselves swap instantly.

## 5. Anti-slop

- No centred container; no page that could be a website in a window.
- No glass cards, gradient borders, glows on numbers, neon, noise or vignette.
- No shimmer skeletons; no spinner before the shell paints.
- No hover lift or scale on cards; no shadows on resting surfaces.
- No stagger on tables; no reveal replay on tab switch, filter or refresh.
- No animation on keyboard-triggered actions; palette opens dead.
- Radius never above 10 px; no pill buttons except chips.
- Red only for poor performance; losses are grey.
- One icon set, one stroke. No emoji, no sparkles.
- No "Dashboard", "Analytics", "Insights" headings; sections are named by content: "Last match", "Form", "Attributes".
- No uppercase above 12 px, no proportional numerals, no body text above 13 px.
- Empty states are one sentence and one action, no illustration. Errors say what failed and what to do.
- Tooltips never repeat the label.
- Do not recolour T/CT to brand colours; do not change the accent per view.

## Checklist

1. 1440 × 900 screenshot: 232 px sidebar, content runs to 24 px of the right edge, no centred column.
2. Title bar: 46 px caption buttons, close hover `#C42B1C`, drag and double-click maximise work.
3. Profile first open: gauge draws and rating counts up; leave and return: nothing replays.
4. Recording: match row click → score morphs into the hero within 300 ms, hero never empty.
5. Drawer opens in 320 ms with no grid jump; resize handle tracks the pointer 1:1; Esc closes in 200 ms.
6. Ctrl+K and Ctrl+B produce no motion; the sidebar button animates 180 ms.
7. Sorting any column reorders rows in one frame.
8. First tooltip waits 400 ms; the adjacent one is instant.
9. Windows "Animation effects" off: no translate or scale anywhere, only fades and colour.
10. Every numeric column aligns on the decimal; `--good-text` and `--poor-text` pass 4.5:1 on `--bg1`; no uppercase text above 12 px.
