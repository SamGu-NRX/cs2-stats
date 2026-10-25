// The round drawer: a right-hand pane inside the Rounds tab (420 px, drag to 360–640, remembered).
// It always docks beside the grid and never covers it (the user found the overlay hid the rounds);
// the grid scrolls sideways instead. It opens with the drawer spring (320 ms) and only then narrows
// the grid, so cells never jump; it closes in 200 ms. Stepping rounds swaps the content instantly.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Measure } from "../../../stats/facts";
import { METRIC } from "../../../stats/metrics";
import { rollup } from "../../../stats/rollup";
import { Num } from "../../components/bits";
import { fmtMetric } from "../../data/engine";
import { killSwing, roundSlice, sideOf, type MatchModel as MatchView } from "../../data/match";
import { BUY_LABEL, BuyIcon, FirstKillIcon, KillFlags, NadeIcon, NADE_LABEL, WeaponIcon, WIN_LABEL, WinIcon, type Nade } from "../../icons/game";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "../../icons/ui";
import { fmtClock, fmtMoney, fmtSwing } from "../../lib/format";
import { roundSwingScore, scoreText } from "../../lib/scale";
import { PlayerName } from "../shared";

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
          aria-label={`Round ${v.rounds[shown].number}`}
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

/** Grenades a player threw, by the measure that counts them. */
const NADES: [Nade, Measure][] = [["flash", "flashes"], ["smoke", "smokes"], ["he", "hes"], ["molotov", "molotovs"]];

function RoundDetail({ v, ri, onClose, onStep, stagger }: { v: MatchView; ri: number; onClose: () => void; onStep: (d: number) => void; stagger: boolean }) {
  const r = v.rounds[ri];
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
  const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : null;
  const team = (t: "us" | "them") => v.players.filter((p) => p.team === t);
  const opening = r.kills.find((k) => k.opening);
  const pr = (pi: number) => r.pr[pi];
  const dmgMax = Math.max(1, ...v.players.map((p) => pr(p.pi)?.m.dmg ?? 0));
  const sideCls = (pi: number) => (sideOf(v, r, pi) === "T" ? "t" : "ct");
  const thrown = (pi: number) => NADES.filter(([, m]) => (pr(pi)?.m[m] ?? 0) > 0);
  const anyNades = v.players.some((p) => thrown(p.pi).length > 0);
  // your numbers this round: the match's facts cut to the round, rolled up
  const aim = useMemo(() => rollup([roundSlice(v.facts, ri)], { player: v.players[v.human].key }), [v, ri]);
  const metric = (id: string) => fmtMetric(id, METRIC[id].value(aim));
  return (
    <div className="drawer__in">
      <header className="drawer__head">
        <WinIcon how={r.how} size={18} className={side ? `${side}-text` : "faint"} />
        <div className="drawer__title">
          <b>Round {r.number}</b>
          <span className="meta">{r.winner === "us" ? "Won" : r.winner === "them" ? "Lost" : "Unknown"}{r.how ? `, ${WIN_LABEL[r.how].toLowerCase()}` : ""}{r.plantSite ? `, site ${r.plantSite}` : ""}{r.durSecs !== null ? `, ${fmtClock(r.durSecs)}` : ""}</span>
        </div>
        {r.scoreAfter && <span className="drawer__score num"><span className={r.winner === "us" ? "cream" : ""}>{r.scoreAfter.us}</span><span className="faint">:</span><span className={r.winner === "them" ? "cream" : ""}>{r.scoreAfter.them}</span></span>}
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
                    <span className="mono faint kf__t">{fmtClock(k.t)}</span>
                    <span className={`kf__p ${k.killer !== null ? sideCls(k.killer) : ""}`}>{k.killer === null ? "World" : <PlayerName v={v} pi={k.killer} />}</span>
                    <span className="kf__w">
                      {opening === k && <FirstKillIcon size={11} className="cream" label="Opening kill" />}
                      <WeaponIcon name={k.weapon} size={13} />
                      <KillFlags kill={k} size={12} />
                    </span>
                    <span className={`kf__p ${sideCls(k.victim)}`}><PlayerName v={v} pi={k.victim} /></span>
                    <span className="kf__tags">{k.tradeKill && <span className="chip chip--outline" data-tip="Killed an enemy who had just killed a teammate">trade</span>}</span>
                    <b className="kf__sw num" style={{ color: sw === null ? "var(--ink3)" : scoreText(roundSwingScore(sw)) }} data-tip="Swing credited to the killer">{sw === null ? "" : fmtSwing(sw)}</b>
                  </li>
                );
              })}
            </ol>
          ) : <p className="meta">No kills.</p>}
        </Section>

        <Section title="Economy">
          <div className="deco">
            {(["us", "them"] as const).map((t) => {
              const buy = r.buy[t];
              const saves = team(t).filter((p) => (pr(p.pi)?.m.saves ?? 0) > 0).length;
              return (
                <div key={t} className="deco__team">
                  <div className="deco__head">
                    <BuyIcon buy={buy} size={16} className={t === "us" ? "cream" : "muted"} />
                    <b>{buy ? BUY_LABEL[buy] : "Unknown buy"}</b>
                    <span className="num faint" data-tip="Team equipment value at freeze end">{fmtMoney(r.equip[t])}</span>
                  </div>
                  <ul className="deco__players">
                    {team(t).map((p) => {
                      const x = pr(p.pi);
                      return (
                        <li key={p.key}>
                          <span className={`kf__p ${sideCls(p.pi)}`}>{p.name}</span>
                          <span className="deco__buy">{x?.ownBuy && <BuyIcon buy={x.ownBuy} size={11} />}</span>
                          <span className="num" data-tip="Equipment value at freeze end">{fmtMoney(x?.equip)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {saves > 0 && <div className="deco__foot meta"><span>{saves} saved</span></div>}
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Utility thrown">
          <ul className="dutil">
            {v.players.filter((p) => thrown(p.pi).length > 0 || (pr(p.pi)?.m.heDmg ?? 0) > 0).map((p) => {
              const x = pr(p.pi)!;
              return (
                <li key={p.key}>
                  <span className={`kf__p ${sideCls(p.pi)}`}>{p.name}</span>
                  <span className="dutil__icons">{thrown(p.pi).map(([n, m]) => <span key={n} className="dutil__n" data-tip={NADE_LABEL[n]}><NadeIcon type={n} size={13} />{(x.m[m] ?? 0) > 1 && <small>{x.m[m]}</small>}</span>)}</span>
                  <span className="meta">{x.m.flashAssists ? `${x.m.flashAssists} flash ${x.m.flashAssists === 1 ? "assist" : "assists"}` : ""}</span>
                  <span className="num" data-tip="HE grenade damage to enemies">{x.m.heDmg ? `${x.m.heDmg} dmg` : ""}</span>
                </li>
              );
            })}
            {!anyNades && <li className="meta">No grenades thrown this round.</li>}
          </ul>
        </Section>

        <Section title="Damage" aside="To enemies">
          <ul className="ddmg">
            {[...v.players].sort((a, b) => (pr(b.pi)?.m.dmg ?? 0) - (pr(a.pi)?.m.dmg ?? 0)).map((p) => {
              const d = pr(p.pi)?.m.dmg ?? 0;
              return (
                <li key={p.key} className={p.isHuman ? "is-you" : undefined}>
                  <span className={`kf__p ${sideCls(p.pi)}`}>{p.name}</span>
                  <span className="hbar"><i style={{ width: `${(d / dmgMax) * 100}%`, background: sideCls(p.pi) === "t" ? "var(--t)" : "var(--ct)", opacity: 0.8 }} /></span>
                  <b className="num">{d}</b>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Your aim this round">
          {v.entry.hasAim ? (
            <>
              <div className="daim">
                <div className="stat"><span className="stat__l">Shots</span><span className="stat__v num">{aim.aim.shots}</span></div>
                <div className="stat"><span className="stat__l">Hits</span><span className="stat__v num">{aim.aim.hits}</span></div>
                <div className="stat" data-tip={METRIC.accuracy.def}><span className="stat__l">Accuracy</span><span className="stat__v num"><Num v={metric("accuracy")} /></span></div>
                <div className="stat" data-tip={METRIC.firstBulletAccuracy.def}><span className="stat__l">First bullet</span><span className="stat__v num"><Num v={metric("firstBulletAccuracy")} /></span><span className="stat__s">{aim.aim.firstHits}/{aim.aim.first}</span></div>
              </div>
              {!v.visibility ? (
                <p className="gate"><span className="chip chip--outline">Gated</span> Time to damage, reaction and crosshair placement need view angles and mesh line of sight, which this match file does not carry.</p>
              ) : (
                <div className="daim">
                  <div className="stat" data-tip={METRIC.timeToDamage.def}><span className="stat__l">TTD</span><span className="stat__v num"><Num v={metric("timeToDamage")} /></span></div>
                  <div className="stat" data-tip={METRIC.reactionTime.def}><span className="stat__l">Reaction</span><span className="stat__v num"><Num v={metric("reactionTime")} /></span></div>
                  <div className="stat" data-tip={METRIC.crosshairPlacement.def}><span className="stat__l">Crosshair</span><span className="stat__v num"><Num v={metric("crosshairPlacement")} /></span></div>
                </div>
              )}
            </>
          ) : <p className="meta">Aim needs a recorded match; this one has no shot data.</p>}
        </Section>
      </div>
    </div>
  );
}
