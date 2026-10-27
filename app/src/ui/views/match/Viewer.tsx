// Seeing a pro demo through one player. Nobody recorded a pro demo, so the panels that read one player
// (aim, utility, luck, positions, a player's rounds) have no one to read until the user picks a player
// on the scoreboard or here: ?as= holds the player's position on the scoreboard, never a SteamID, and
// router.ts keeps it on every link within the match. The user's own
// matches are always seen through the recording player and never reach the picker.
import type { ReactNode } from "react";
import type { MatchModel, ViewedMatch } from "../../data/match";
import { teamLabel } from "../../data/match";
import { setQuery } from "../../router";

/** `children` with the match narrowed to its viewer, or the picker when there is none yet. */
export function Viewed({ v, what, children, pad = true }: { v: MatchModel; what: string; children: (v: ViewedMatch) => ReactNode; pad?: boolean }) {
  if (v.human !== null) return <>{children(v as ViewedMatch)}</>;
  return <ViewerNeeded v={v} what={what} pad={pad} />;
}

/** What a panel shows for a pro demo before a player is picked: the reason, and the players to pick from. */
export function ViewerNeeded({ v, what, pad }: { v: MatchModel; what: string; pad: boolean }) {
  const body = (
    <div className="viewer-need" role="group" aria-label={`Pick a player to see ${what}`}>
      <p className="viewer-need__lead">Pick a player to see {what}.</p>
      {(["us", "them"] as const).map((t) => (
        <div key={t} className="viewer-need__team">
          <span className="caps">{teamLabel(v, t)}</span>
          <div className="viewer-need__players">
            {v.players.filter((p) => p.team === t).map((p) => (
              <button key={p.key} type="button" className="chip chip--outline press" onClick={() => setQuery("as", String(p.pi))}>{p.name}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
  return pad ? <div className="tabpad">{body}</div> : body;
}

/** "You" on the user's own match; the picked player's name on a pro demo. */
export const viewerName = (v: ViewedMatch) => (v.pro ? v.players[v.human].name : "You");
