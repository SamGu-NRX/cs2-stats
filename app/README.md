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

## Bot Mode

The app installs ed0ard's CS2-Bot-Improver release, overlays your own plugin builds, and starts CS2 with the mod. The code is in `src-tauri/src/botmode/`; the same operations run from a terminal as `cs2-stats botmode <command>` (`cs2-stats botmode --help` lists them).

Bot Mode is on only while a session runs. Launching from the app or with `cs2-stats botmode launch` starts a separate supervisor process. It turns Bot Mode on, starts CS2 through Steam with `-insecure`, watches CS2 until it exits, and then turns Bot Mode off again. While it watches, any CS2 of this install that runs without `-insecure`, or with an option that turns VAC back on, is ended. Closing the app or the terminal does not stop the supervisor.

If Bot Mode is found on with no supervisor running, the next app start or Bot Mode command turns it off once CS2 has exited, and starts a supervisor to watch a CS2 that is still running. That includes Bot Mode left on by the mod's own Panel.

**Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.** What Bot Mode cannot cover:

- The supervisor is killed (a crash, a reboot) between turning Bot Mode on and turning it off, and CS2 is then started from Steam before the app or a Bot Mode command runs again.
- A Steam launch of CS2 that was already queued when the session turned Bot Mode on. It is watched, but it runs with whatever options Steam had.
- A CS2 that starts in the moment between the supervisor's last check and its turning Bot Mode off.
- Another tool, such as the mod's Panel, turning Bot Mode on later. The next app start or Bot Mode command turns it off again and says so.

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
- **What it is fed, per kill:** alive counts and HP come from the kill's `state` column, before and after the kill.
  - Equipment is the sum of `rounds.equip` over every player on each side. That matches CS2RB's `ct_equip`/`t_equip`: post-buy value at freeze end, constant for the round. The per-kill `state` equipment, which counts only living players, is not used.
  - `secondsSinceFreezeEnd` is `(tick − freezeTick) / 64`, and `secondsSincePlant` comes from `rounds.plantTick`.
- **Unknown swing:** if any player's equipment is null in a round, or the model rejects a state in it (RangeError), that round's swing is unknown and shows "–". It is never a partial sum, and the rest of the match is unaffected.
- **Attribution:** the swing tooltip cites WPA (Xenopoulos et al. 2020) and CS2RB (Bishop 2026, CC BY 4.0), as in `../model/README.md`.
- **Check at startup:** the worker calls the function once on a 5v5 start. A missing export, or an answer that is not a probability, keeps the placeholder, and the badge's tooltip shows the error.
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
