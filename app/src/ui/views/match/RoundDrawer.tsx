// The round drawer: a right-hand pane inside the Rounds tab (420 px, drag to 360–640, remembered).
// It always docks beside the grid and never covers it (the user found the overlay hid the rounds);
// the grid scrolls sideways instead. It opens with the drawer spring (320 ms) and only then narrows
// the grid, so cells never jump; it closes in 200 ms. Stepping rounds swaps the content instantly.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { aimVisibility, angleBetweenDeg } from "../../../stats/aim";
import type { MatchView } from "../../../stats/derive";
import type { HumanRoundAim } from "../../../stats/rounds";
import { Num } from "../../components/bits";
import { playerSide } from "../../data/engine";
import { NADE_TYPES } from "../../data/interim";
import { BUY_LABEL, BuyIcon, FirstKillIcon, KillFlags, NadeIcon, NADE_LABEL, WeaponIcon, WIN_LABEL, WinIcon } from "../../icons/game";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "../../icons/ui";
import { fmtClock, fmtDeg, fmtMoney, fmtMs, fmtPct, fmtRatio, fmtSecs, fmtSwing } from "../../lib/format";
import { roundSwingScore, scoreText } from "../../lib/scale";
import { killSwing, PlayerName } from "../shared";

const W_KEY = "cs2stats.drawerW";
const MIN = 360;
const MAX = 640;

export function RoundDrawer({ v, ri, onClose, onStep, children }: {
  v: MatchView; ri: number | null; onClose: () => void; onStep: (d: number) => void; children: ReactNode;
}) {
  const [w, setW] = useState(() => Math.max(MIN, Math.min(MAX, Number(localStorage.getItem(W_KEY)) || 420)));
  const [shown, setShown] = useState<number | null>(ri);
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "closing">(ri === null ? "closed" : "open");
  const firstOpen = useRef(true);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (ri !== null) {
      setShown(ri);
      if (phase === "closed" || phase === "closing") {
        opener.current = document.activeElement as HTMLElement | null;
        setPhase("opening");
        const t = window.setTimeout(() => setPhase("open"), reduce ? 120 : 320);
        return () => clearTimeout(t);
      }
    } else if (phase === "open" || phase === "opening") {
      setPhase("closing");
      // back to the cell or round header that opened the drawer
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      const t = window.setTimeout(() => { setPhase("closed"); setShown(null); firstOpen.current = false; }, reduce ? 120 : 200);
      return () => clearTimeout(t);
    }
  }, [ri]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (x: number) => { localStorage.setItem(W_KEY, String(x)); return x; };
  // drag to resize, 1:1 with the pointer, no transition
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = w;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setW(Math.max(MIN, Math.min(MAX, startW + (startX - ev.clientX))));
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setW((x) => save(x));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const gridPad = phase === "open" ? w + 12 : 0;
  return (
    <div className="dhost">
      <div className="dhost__main" style={{ paddingRight: gridPad }}>{children}</div>
      {phase !== "closed" && shown !== null && (
        <aside
          className={`drawer drawer--${phase}`}
          style={{ width: w }}
          role="dialog"
          aria-label={`Round ${shown + 1}`}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        >
          <div
            className="drawer__handle"
            onPointerDown={drag}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the round panel"
            aria-valuemin={MIN}
            aria-valuemax={MAX}
            aria-valuenow={w}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); setW((x) => save(Math.min(MAX, x + 20))); }
              if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setW((x) => save(Math.max(MIN, x - 20))); }
            }}
          />
          <RoundDetail v={v} ri={shown} onClose={onClose} onStep={onStep} stagger={firstOpen.current && phase === "opening"} />
        </aside>
      )}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="dsec">
      <div className="dsec__head"><h3 className="caps">{title}</h3>{aside && <span className="meta">{aside}</span>}</div>
      {children}
    </section>
  );
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

/** Mean angle between bullet and target for bullets 4+ over the round's bursts, degrees. */
function sprayError(bursts: HumanRoundAim["spray"]): number | null {
  let n = 0;
  let sum = 0;
  for (const b of bursts) for (const p of b.points) {
    if (p.idx < 4 || !p.impact || !p.aimErr) continue;
    n++;
    sum += angleBetweenDeg(p.impact, p.aimErr);
  }
  return n ? sum / n : null;
}

function RoundDetail({ v, ri, onClose, onStep, stagger }: { v: MatchView; ri: number; onClose: () => void; onStep: (d: number) => void; stagger: boolean }) {
  const r = v.rounds[ri];
  const rd = v.roundDetails[ri];
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
  const side = r.winSide === 2 ? "t" : r.winSide === 3 ? "ct" : null;
  const team = (t: "us" | "them") => v.players.filter((p) => p.team === t);
  const opening = r.kills.find((k) => !k.teamKill && !k.suicide);
  const pr = (pi: number) => rd.players[pi];
  const dmgMax = Math.max(1, ...v.players.map((p) => pr(p.pi)?.dmg ?? 0));
  const sideOf = (pi: number) => ((pr(pi)?.side ?? playerSide(v, r, pi)) === 2 ? "t" : "ct");
  const teamOf = (t: "us" | "them") => (rd.teams.t.team === t ? rd.teams.t : rd.teams.ct);
  const aim = rd.human;
  const gate = v.aim ? aimVisibility(v.aim) : null;
  const anyNades = v.players.some((p) => { const x = pr(p.pi); return x && NADE_TYPES.some((n) => x.utilThrown[n] > 0); });
  return (
    <div className="drawer__in">
      <header className="drawer__head">
        <WinIcon how={r.how} size={18} className={side ? `${side}-text` : "faint"} />
        <div className="drawer__title">
          <b>Round {ri + 1}</b>
          <span className="meta">{r.winner === "us" ? "Won" : r.winner === "them" ? "Lost" : "Unknown"}{r.how ? `, ${WIN_LABEL[r.how].toLowerCase()}` : ""}{rd.bomb.site ? `, site ${rd.bomb.site}` : ""}{r.durSecs !== null ? `, ${fmtClock(r.durSecs)}` : ""}</span>
        </div>
        <span className="drawer__score num"><span className={r.winner === "us" ? "cream" : ""}>{r.scoreAfter.us}</span><span className="faint">:</span><span className={r.winner === "them" ? "cream" : ""}>{r.scoreAfter.them}</span></span>
        <button className="btn btn--ghost btn--icon btn--sm press" onClick={() => onStep(-1)} disabled={ri === 0} aria-label="Previous round" data-tip="Previous round  ←"><ChevronLeftIcon size={16} /></button>
        <button className="btn btn--ghost btn--icon btn--sm press" onClick={() => onStep(1)} disabled={ri === v.nRounds - 1} aria-label="Next round" data-tip="Next round  →"><ChevronRightIcon size={16} /></button>
        <button ref={close} className="btn btn--ghost btn--icon btn--sm press" onClick={onClose} aria-label="Close the round panel" data-tip="Esc"><CloseIcon size={16} /></button>
      </header>
      <div className="drawer__body">
        <Section title="Killfeed" aside={r.kills.length ? `${r.kills.length} kills` : undefined}>
          {r.kills.length ? (
            <ol className="kf">
              {r.kills.map((k, i) => {
                const sw = killSwing(k, k.killer);
                const anim = stagger && i < 12;
                return (
                  <li key={i} className={anim ? "kf__in" : undefined} style={anim ? { animationDelay: `${i * 20}ms` } : undefined}>
                    <span className="mono faint kf__t">{fmtClock(k.secs)}</span>
                    <span className={`kf__p ${k.killer !== null ? sideOf(k.killer) : ""}`}>{k.killer === null ? "World" : <PlayerName v={v} pi={k.killer} />}</span>
                    <span className="kf__w">
                      {opening === k && <FirstKillIcon size={11} className="cream" label="Opening kill" />}
                      <WeaponIcon name={k.weapon} size={13} />
                      <KillFlags flags={k.flags} size={12} />
                    </span>
                    <span className={`kf__p ${sideOf(k.victim)}`}><PlayerName v={v} pi={k.victim} /></span>
                    <span className="kf__tags">{k.tradeKill && <span className="chip chip--outline" data-tip="Killed an enemy who had made a kill less than 5 s earlier">trade</span>}</span>
                    <b className="kf__sw num" style={{ color: sw === null ? "var(--ink3)" : scoreText(roundSwingScore(sw)) }} data-tip="Swing credited to the killer">{sw === null ? "" : fmtSwing(sw)}</b>
                  </li>
                );
              })}
            </ol>
          ) : <p className="meta">{rd.lite ? "Only the game's round totals exist for this round." : "No kills."}</p>}
        </Section>

        <Section title="Economy">
          <div className="deco">
            {(["us", "them"] as const).map((t) => {
              const tr = teamOf(t);
              return (
                <div key={t} className="deco__team">
                  <div className="deco__head">
                    <BuyIcon buy={tr.buy} size={16} className={t === "us" ? "cream" : "muted"} />
                    <b>{tr.buy ? BUY_LABEL[tr.buy] : "Unknown buy"}</b>
                    <span className="num faint" data-tip="Team equipment value at freeze end">{fmtMoney(tr.equip)}</span>
                  </div>
                  <ul className="deco__players">
                    {team(t).map((p) => {
                      const x = pr(p.pi);
                      return (
                        <li key={p.key}>
                          <span className={`kf__p ${sideOf(p.pi)}`}>{p.name}</span>
                          <span className="deco__buy">{x?.buy && <BuyIcon buy={x.buy} size={11} />}</span>
                          <span className="num" data-tip="Equipment value at freeze end">{fmtMoney(x?.equip)}</span>
                          <span className="num faint" data-tip="Money left after buying">{fmtMoney(x?.money)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="deco__foot meta">
                    <span>Bank {fmtMoney(tr.money)}</span>
                    {tr.spent !== null && <span data-tip="Estimated: freeze-end equipment minus what was carried in">Spent {fmtMoney(tr.spent)}</span>}
                    {tr.saves.length > 0 && <span>{tr.saves.length} saved</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Utility thrown">
          <ul className="dutil">
            {v.players.filter((p) => { const x = pr(p.pi); return x && (NADE_TYPES.some((n) => x.utilThrown[n] > 0) || x.utilDmg > 0); }).map((p) => {
              const x = pr(p.pi)!;
              return (
                <li key={p.key}>
                  <span className={`kf__p ${sideOf(p.pi)}`}>{p.name}</span>
                  <span className="dutil__icons">{NADE_TYPES.map((n) => x.utilThrown[n] > 0 && <span key={n} className="dutil__n" data-tip={NADE_LABEL[n]}><NadeIcon type={n} size={13} />{x.utilThrown[n] > 1 && <small>{x.utilThrown[n]}</small>}</span>)}</span>
                  <span className="meta">{x.enemiesFlashed ? `${x.enemiesFlashed} blinded, ${fmtSecs(x.enemyBlindSecs)}` : ""}</span>
                  <span className="num" data-tip="Grenade and fire damage to enemies">{x.utilDmg ? `${x.utilDmg} dmg` : ""}</span>
                </li>
              );
            })}
            {!anyNades && <li className="meta">No grenades thrown this round.</li>}
          </ul>
        </Section>

        <Section title="Damage" aside="To enemies">
          <ul className="ddmg">
            {[...v.players].sort((a, b) => (pr(b.pi)?.dmg ?? 0) - (pr(a.pi)?.dmg ?? 0)).map((p) => {
              const d = pr(p.pi)?.dmg ?? 0;
              return (
                <li key={p.key} className={p.isHuman ? "is-you" : undefined}>
                  <span className={`kf__p ${sideOf(p.pi)}`}>{p.name}</span>
                  <span className="hbar"><i style={{ width: `${(d / dmgMax) * 100}%`, background: sideOf(p.pi) === "t" ? "var(--t)" : "var(--ct)", opacity: 0.8 }} /></span>
                  <b className="num">{d}</b>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Your aim this round">
          {aim ? (
            <>
              <div className="daim">
                <div className="stat"><span className="stat__l">Shots</span><span className="stat__v num">{aim.shots}</span></div>
                <div className="stat"><span className="stat__l">Hits</span><span className="stat__v num">{aim.hits}</span><span className="stat__s">{aim.headHits} head</span></div>
                <div className="stat"><span className="stat__l">Accuracy</span><span className="stat__v num"><Num v={aim.accuracy === null ? "–" : fmtPct(100 * aim.accuracy)} /></span></div>
                <div className="stat"><span className="stat__l">HS hits</span><span className="stat__v num"><Num v={fmtRatio(aim.headHits, aim.hits)} /></span></div>
                <div className="stat" data-tip="First bullets of a burst with an enemy within 10° of your aim that hit"><span className="stat__l">First bullet</span><span className="stat__v num"><Num v={aim.firstAccuracy === null ? "–" : fmtPct(100 * aim.firstAccuracy)} /></span><span className="stat__s">{aim.firstHits}/{aim.firstOnTarget}</span></div>
                <div className="stat" data-tip="Mean distance from the target for bullets 4 and later"><span className="stat__l">Spray</span><span className="stat__v num"><Num v={fmtDeg(sprayError(aim.spray), 2)} /></span></div>
              </div>
              {gate && !gate.validated ? (
                <p className="gate"><span className="chip chip--outline">Gated</span> Time to damage, reaction and crosshair placement are hidden. {gate.reason}</p>
              ) : (
                <div className="daim">
                  <div className="stat"><span className="stat__l">TTD</span><span className="stat__v num"><Num v={fmtMs(median(aim.ttdMs))} /></span></div>
                  <div className="stat"><span className="stat__l">Reaction</span><span className="stat__v num"><Num v={fmtMs(median(aim.reactMs))} /></span></div>
                  <div className="stat"><span className="stat__l">Crosshair</span><span className="stat__v num"><Num v={fmtDeg(median(aim.xhairDeg))} /></span></div>
                </div>
              )}
            </>
          ) : <p className="meta">Aim needs a recorded match; this one has no shot data.</p>}
        </Section>
      </div>
    </div>
  );
}
