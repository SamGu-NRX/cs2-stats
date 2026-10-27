// The match's first kills round by round (worker openingDuels): two lanes, your team's above the
// opponents', and in each round the weapon of the first kill in the killer's lane and a × in the
// victim's. Yours are cream. The round number is bright when the team with the first kill won the
// round. Beside it, your best opening weapon and how your team did after your first kills and deaths.
// Each round is a link to it on Rounds; the strip is one tab stop, stepped with the arrow keys.
import { Card } from "../../components/Card";
import { DeathMark } from "../../components/bits";
import { Fig } from "../../components/MatchSeries";
import { useCall } from "../../data/hooks";
import type { MPlayer, Team, ViewedMatch } from "../../data/match";
import { WeaponIcon } from "../../icons/game";
import { weaponLabel } from "../../../stats/weapons";
import { fmtClock, plural } from "../../lib/format";
import { matchHref } from "../../router";
import { Hint } from "./glyphs";
import { LoadFailed } from "./LoadFailed";
import { useRoving } from "./roving";

export function Openings({ v, file }: { v: ViewedMatch; file: string }) {
  const me = v.players[v.human];
  const call = useCall("openingDuels", [file, me.key]);
  const o = call.data;
  const roving = useRoving(o?.rows.length ?? 0);
  const byId = new Map(v.players.map((p) => [p.key, p]));
  const halfAt = new Set(v.rounds.filter((r) => r.halfStart).map((r) => r.number));
  const title = <>First kills, round by round <Hint tip="Each round's first kill: the weapon in the lane of the team that made it, a × in the other. A bright number: that team won the round." /></>;
  if (call.error) return <Card title={title}><LoadFailed what="First kills" error={call.error} /></Card>;
  if (!o) return <Card title={title}><div className="skel" style={{ height: 96 }} /></Card>;
  if (!o.rows.length) return <Card title={title}><p className="meta">No round in this match has a first kill.</p></Card>;

  const lane = (p: MPlayer | undefined, t: Team) => p?.team === t;
  const best = o.bestWeapon;
  return (
    <Card title={title} aside={<span className="meta">{plural(o.rows.length, "round")}</span>}>
      <div className="opn">
        <div className="opn__scroll">
          <div className="opn__strip" role="group" aria-label="First kill of each round" onKeyDown={roving.onKeyDown}>
            <div className="opn__lanes" aria-hidden>
              <span className="caps">Your team</span>
              <span className="caps">Opponents</span>
            </div>
            {o.rows.map((r, i) => {
              const killer = r.killer === null ? undefined : byId.get(r.killer);
              const victim = byId.get(r.victim);
              const mark = (t: Team) => {
                if (lane(killer, t)) return <span className={`opn__k ${killer!.isHuman ? "is-you" : r.killerSide === "T" ? "t-text" : "ct-text"}`}><WeaponIcon name={r.weapon} height={12} beside /></span>;
                if (lane(victim, t)) return <DeathMark className={`opn__x ${victim!.isHuman ? "is-you" : ""}`} />;
                return null;
              };
              const label = `Round ${r.number}: ${killer?.name ?? "the world"} killed ${victim?.name ?? "someone"} with the ${weaponLabel(r.weapon)}${r.t !== null ? ` at ${fmtClock(r.t)}` : ""}${r.traded ? ", traded" : ""}; ${r.killerWon === null ? "no result" : r.killerWon ? "their team won the round" : "their team lost the round"}`;
              return (
                <a
                  key={r.number}
                  href={matchHref(file, "rounds", { round: r.number })}
                  className={`opn__col ${halfAt.has(r.number) && i > 0 ? "is-half" : ""}`}
                  aria-label={label}
                  data-tip={label}
                  {...roving.item(i)}
                >
                  <span className="opn__cell">{mark("us")}</span>
                  <span className="opn__cell">{mark("them")}</span>
                  <span className={`opn__n num ${r.killerWon ? "is-won" : ""}`}>{r.number}</span>
                </a>
              );
            })}
          </div>
        </div>
        <dl className="figs opn__figs">
          <Fig
            label="Your best opener"
            value={best ? <span className="opn__gun"><WeaponIcon name={best.weapon} height={18} beside />{weaponLabel(best.weapon)}</span> : "–"}
            sub={best ? `${plural(best.kills, "first kill")}, won ${best.won} of ${best.decided}` : "No first kills"}
          />
          <Fig label="After your first kill" value={o.afterKill.rounds ? <>{o.afterKill.won}<small className="faint">/{o.afterKill.rounds}</small></> : "–"} sub="rounds your team won" />
          <Fig label="After your first death" value={o.afterDeath.rounds ? <>{o.afterDeath.won}<small className="faint">/{o.afterDeath.rounds}</small></> : "–"} sub="rounds your team won" />
        </dl>
      </div>
    </Card>
  );
}
