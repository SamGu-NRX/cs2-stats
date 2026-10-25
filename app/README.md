# CS2 Stats

A desktop app (Tauri 2, React, TypeScript) that reads match files written by the capture plugin and shows match pages and a profile. The data contract is `../SCHEMA.md`.

## Run

| Command | What it does |
|---|---|
| `pnpm dev` | Web build at http://localhost:1420 with the bundled sample matches. In dev, "Open files…" adds local `.json.gz` files. Add `?demo=synthetic` for a generated match with aim and position data, which is labelled as synthetic. |
| `pnpm tauri dev` | The desktop app against `%APPDATA%\BotMatchStats\matches\`. |
| `$env:CARGO_BUILD_JOBS=4; pnpm tauri build` | Release exe in `src-tauri\target\release\` and an NSIS installer in `src-tauri\target\release\bundle\nsis\`. |
| `pnpm test` | Stats tests (vitest, one process). |
| `pnpm convert` | Rebuilds `public/samples/` from `../fixtures/`. |

## Win-probability model interface

Round swing needs P(CT wins) for a round state. The model agent owns the interface, in `../model/export/winprob.ts`:

```ts
export function winProbabilityCT(state: RoundState, map: string): number; // P(CT wins), 0..1

interface RoundState {
  ctAlive: number; tAlive: number;      // living players
  ctHp: number; tHp: number;            // summed HP of the living players
  ctEquip: number; tEquip: number;      // whole-team equipment at freeze end, fixed for the round
  planted: 0 | 1;
  secondsSincePlant: number | null;     // null when not planted
  secondsSinceFreezeEnd: number;
}
```

How the app calls it:

- **When it is bundled:** at build time, only when both `winprob.ts` and its `model.json` exist (`vite.config.ts`). Otherwise `src/stats/no-model.ts` stands in, and the app shows "Placeholder model". Rebuild the app after the model changes.
- **What it is fed, per kill:** alive counts and HP come from the kill's `state` column. Equipment is the sum of `rounds.equip` over every player on each side. Times are ticks divided by the tick rate. The state after a kill takes one player off the victim's side, with HP and equipment unchanged.
- **Check at startup:** the worker calls the function once on a 5v5 start. A missing export, or an answer that is not a probability, keeps the placeholder, and the badge's tooltip shows the error.
- **Fallback for single kills:** a kill whose state has an unknown field (a bot's equipment in a legacy file), or which the model rejects by throwing, gets the placeholder's answer.
- **The placeholder** is `ct² / (ct² + t²)` on alive counts, with no evidence behind it.

## Fields the app reads beyond SCHEMA.md

These are all optional. Only `tools/convert-legacy.ts` writes the first three today, and the plugin may add any of them.

| Field | Meaning |
|---|---|
| `rounds.basic[ri][pi]` | `[kills, deaths, assists, damage, headshotKills]` from the game's own round stats. For rounds before `firstFullRound`, this is what counts toward K–D, ADR, KAST (without traded deaths) and rating. |
| `rounds.lite[ri]` | true when a round has totals only. Rounds before `firstFullRound` are treated as lite either way. |
| `rounds.aliveEnd[ri]` | `[ctAlive, tAlive]` at round end, for the "players left" number of rounds that have no kill log. |
| `aim.shots.visTarget`, `smoke`, `pen`, `cls` | Documented in SCHEMA.md. Spotted accuracy needs `visTarget = 1`. Adjusted accuracy also needs `smoke = 0` and `pen = 0`; shots where either is unknown are counted apart. `cls` sets the weapon class. Files without `visTarget` fall back to `target`. |
| `env.visibilityValidated` | When true, the visibility-based stats (spotted and adjusted accuracy, time to damage, reaction time, crosshair placement) drop their "Validating" label. |

Plugin fields from SCHEMA.md "Optional fields" that change how stats are counted:

- **`kills.flags` 64 (suicide) and 128 (freeze time):** freeze-time kills are ignored, as in CS Demo Manager. A suicide is a same-side death for KAST and opening duels.
- **`kills.kBody` / `vBody` (bot takeovers):** what a player does in a bot's body does not count for that player, as CS Demo Manager does for players controlling a bot.
- **`rounds.alive0` and `leaves`:** the clutch population. Players dead at freeze end are left out, and a player who leaves mid-round drops out like a death.
- **`pos.enc = "delta"`:** decoded to absolute positions on load.
- **Null `rounds.equip`:** the equipment is unknown. That team gets no buy type and no bar on the equipment chart.

## Damage and ADR

Matches recorded by the plugin store `player_hurt` damage capped at the victim's HP. The game counts fractional damage that the event drops, so ADR can be lower by up to 1 HP per hit. For the 18:09 fixture that is 2735 (ADR 130.2) against the game's 2750 (ADR 131.0). The converted fixtures take each hit's HP drop instead, which equals the game's figure. The app shows what the file contains.
