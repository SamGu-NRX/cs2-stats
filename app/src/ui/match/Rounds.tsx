// Round by round: who killed whom and when, the alive count after each kill, damage, and how each
// kill moved your team's chance to win the round.
import { useEffect, useRef } from "react";
import type { KillView, MatchView, RoundView } from "../../stats/derive";
import { weaponLabel } from "../../stats/weapons";
import { HOW_TEXT, HowIcon } from "../icons";
import { swingPct } from "../format";
import { ModelBadge } from "../ModelBadge";
import { BUY_LABEL } from "./Economy";
import type { TabProps } from "./MatchPage";

const clock = (s: number | null) => (s === null ? "–" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);

/** Our win chance from a CT-based probability */
const ours = (r: RoundView, p: number | null) => (p === null ? null : r.usSide === 3 ? p : 1 - p);

function aliveAfter(v: MatchView, r: RoundView, k: KillView): [number, number] | null {
  if (!k.alive) return null;
  const [ct, t] = k.alive;
  const victimCT = r.usSide === 3 ? v.players[k.victim].team === "us" : v.players[k.victim].team === "them";
  const after: [number, number] = victimCT ? [ct - 1, t] : [ct, t - 1];
  return r.usSide === 3 ? after : [after[1], after[0]];
}

function Name({ v, pi }: { v: MatchView; pi: number | null }) {
  if (pi === null) return <span className="muted">World</span>;
  const p = v.players[pi];
  return <span className={`feed__name ${p.team === "us" ? "is-us" : "is-them"} ${p.isHuman ? "is-you" : ""}`}>{p.name}</span>;
}

function Round({ v, r, focused }: { v: MatchView; r: RoundView; focused: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [focused]);
  const won = r.winner === "us";
  const first = r.kills.find((k) => !k.teamKill);
  const start = r.kills[0]?.alive;
  const states = [start ? (r.usSide === 3 ? start : [start[1], start[0]]) : null, ...r.kills.map((k) => aliveAfter(v, r, k))].filter(Boolean) as [number, number][];
  const dmg = r.dmg.map((d, pi) => ({ d, pi })).filter((x) => x.d > 0).sort((a, b) => b.d - a.d);
  const mySwing = r.swing[v.human];
  return (
    <section ref={ref} id={`round-${r.ri + 1}`} className={`glass card round ${focused ? "is-focus" : ""}`} aria-label={`Round ${r.ri + 1}`}>
      <div className="round__head">
        <h3 className="round__no">Round {r.ri + 1}</h3>
        {r.how === null || r.winner === null
          ? <span className="pill pill--quiet">Result unknown</span>
          : <span className={`pill ${won ? "pill--win" : "pill--loss"}`}><HowIcon how={r.how} size={11} /> {won ? "Won" : "Lost"} · {HOW_TEXT[r.how]}</span>}
        <span className="note">You on <b className={`side side--${r.usSide === 3 ? "ct" : "t"}`}>{r.usSide === 3 ? "CT" : "T"}</b></span>
        {r.captured && <span className="note">{clock(r.durSecs)} · {r.buy.us ? BUY_LABEL[r.buy.us] : "?"} vs {r.buy.them ? BUY_LABEL[r.buy.them] : "?"}</span>}
        {r.captured && <span tabIndex={0} className={`round__swing num ${mySwing > 0 ? "pos" : mySwing < 0 ? "neg" : "muted"}`} data-tip="Your round swing this round: your share of your team's win-probability gains from kills, minus the loss when you died.">Your swing {swingPct(mySwing)}</span>}
        <span className="note num" style={{ marginLeft: "auto" }}>{r.scoreAfter.us}–{r.scoreAfter.them}</span>
      </div>
      {!r.captured ? (
        r.lite ? (
          <>
            <p className="note">Played before the kill-by-kill log started: only the game's round totals exist.</p>
            <p className="round__dmg">
              <span className="eyebrow" style={{ marginRight: 8 }}>Damage</span>
              {r.dmg.map((d, pi) => ({ d, pi })).filter((x) => x.d > 0).sort((a, b) => b.d - a.d).map(({ d, pi }) => <span key={pi} className={v.players[pi].isHuman ? "is-you" : ""}>{v.players[pi].name} <b className="num">{d}</b></span>)}
            </p>
          </>
        ) : <p className="note">This round was played before the capture started; only its result is known.</p>
      ) : (
        <>
          {states.length > 0 && (
            <div className="round__states" aria-label="Players alive, your team first, after each kill">
              {states.map((s, i) => <span key={i} className="state num">{s[0]}v{s[1]}</span>)}
            </div>
          )}
          <table className="feed">
            <tbody>
              {r.kills.map((k, i) => {
                const before = ours(r, k.ctWinBefore);
                const after = ours(r, k.ctWinAfter);
                const credit = k.credits.find(([p]) => p === v.human)?.[1];
                return (
                  <tr key={i}>
                    <td className="feed__t num">{clock(k.secs)}</td>
                    <td className="feed__k"><Name v={v} pi={k.killer} /></td>
                    <td className="feed__w">
                      {weaponLabel(k.weapon)}
                      {(k.flags & 1) !== 0 && <span className="tag" data-tip="Headshot" aria-label="Headshot">HS</span>}
                      {(k.flags & 2) !== 0 && <span className="tag" data-tip="Through a wall" aria-label="Through a wall">WB</span>}
                      {(k.flags & 4) !== 0 && <span className="tag" data-tip="Through smoke" aria-label="Through smoke">SM</span>}
                    </td>
                    <td className="feed__v"><Name v={v} pi={k.victim} />{k.assister !== null && k.assister !== k.killer && <span className="muted"> + {v.players[k.assister].name}{k.flashAssister !== null ? " (flash)" : ""}</span>}</td>
                    <td className="feed__b">
                      {k === first && <span className="tag tag--blue" data-tip="Opening kill: the round's first kill that is not a team kill">Opening</span>}
                      {k.tradeKill && <span className="tag" data-tip="Trade kill: the victim had made a kill less than 5 s earlier">Trade</span>}
                      {k.tradeDeath && <span className="tag" data-tip="Traded death: this victim's killer died less than 5 s later">Traded</span>}
                      {k.teamKill && <span className="tag tag--red">Team kill</span>}
                      {k.suicide && <span className="tag tag--red">Suicide</span>}
                    </td>
                    <td className="feed__p num" data-tip="Your team's chance to win the round, before → after this kill">
                      {before === null || after === null ? "" : `${Math.round(100 * before)}% → ${Math.round(100 * after)}%`}
                    </td>
                    <td className={`feed__c num ${credit === undefined ? "" : credit > 0 ? "pos" : "neg"}`}>{credit === undefined ? "" : swingPct(credit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {dmg.length > 0 && (
            <p className="round__dmg">
              <span className="eyebrow" style={{ marginRight: 8 }}>Damage</span>
              {dmg.map(({ d, pi }) => <span key={pi} className={v.players[pi].isHuman ? "is-you" : ""}>{v.players[pi].name} <b className="num">{d}</b></span>)}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default function Rounds({ v, focusRound }: TabProps) {
  return (
    <>
      {v.model.kind === "stub" && <p className="note" style={{ padding: "0 6px", display: "flex", gap: 8, alignItems: "center" }}><ModelBadge /> Win chances and swing below come from alive counts only.</p>}
      {v.rounds.map((r) => <Round key={r.ri} v={v} r={r} focused={focusRound === r.ri} />)}
    </>
  );
}
