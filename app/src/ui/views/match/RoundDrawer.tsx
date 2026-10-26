// The round drawer: a right-hand pane inside the Rounds tab (420 px, drag to 360–640, remembered).
// It always docks beside the grid and never covers it (the user found the overlay hid the rounds);
// the grid scrolls sideways instead. It opens with the drawer spring (320 ms) and only then narrows
// the grid, so cells never jump; it closes in 200 ms. Stepping rounds swaps the content instantly.
// It steps over the inspector's columns (roundColumns), so a round the file holds only as totals
// opens too: the game's recorded totals per player, and a dash for what the file does not hold.
// A round's "Your rating" section splits your Rating 3.0 for the round into its terms and its swing
// into sources (worker ratingBreakdown, which Rounds reads once for the grid's chart and this pane).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Measure } from "../../../stats/facts";
import type { RatingBreakdown } from "../../../worker/protocol";
import { Num } from "../../components/bits";
import { fmtMetric } from "../../data/engine";
import { useCall } from "../../data/hooks";
import { placesNamed, roundSecs, sideOf, totalsWinner, usSideAt, type MatchModel as MatchView, type RoundColumn } from "../../data/match";
import { metric } from "../../data/meta";
import { feedFor } from "../../data/rounds";
import { BUY_LABEL, BuyIcon, NADE_LABEL, NadeIcon, WIN_LABEL, WinIcon, type Nade } from "../../icons/game";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "../../icons/ui";
import { fmtClock, fmtMoney, fmtRating, fmtRatio, fmtSecs, fmtSwing } from "../../lib/format";
import { NeedsDemo, PlaceList, PlayerName } from "../shared";
import { Killfeed } from "./Killfeed";
import { SwingSourcesChart } from "../profile/v2";
import { RatingWaterfall, roundSteps } from "./RatingByRound";
import { signedIn } from "./parity";
import { LoadFailed } from "./LoadFailed";

const W_KEY = "cs2stats.drawerW";
const MIN = 360;
const MAX = 640;

/** col: the open column of `cols` (Rounds' roundColumns), or null when the drawer is closed; rb: your rating by round, null while it loads. */
export function RoundDrawer({ v, cols, col: ri, rb, rbError, onClose, onStep, children }: {
  v: MatchView; cols: RoundColumn[]; col: number | null; rb: RatingBreakdown | null; rbError: string | null; onClose: () => void; onStep: (d: number) => void; children: ReactNode;
}) {
  const [w, setW] = useState(() => Math.max(MIN, Math.min(MAX, Number(localStorage.getItem(W_KEY)) || 420)));
  const [shown, setShown] = useState<number | null>(ri);
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "closing">(ri === null ? "closed" : "open");
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
      const t = window.setTimeout(() => { setPhase("closed"); setShown(null); }, reduce ? 120 : 200);
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
          aria-label={`Round ${cols[shown].number}`}
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
          {(() => {
            const c = cols[shown];
            const ends = { first: shown === 0, last: shown === cols.length - 1 };
            return c.kind === "round"
              ? <RoundDetail key="round" v={v} ri={c.r.ri} rb={rb} rbError={rbError} {...ends} onClose={onClose} onStep={onStep} />
              : <TotalsDetail key="totals" v={v} col={c} {...ends} onClose={onClose} onStep={onStep} />;
          })()}
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

/**
 * A round held only as totals: its number and winner when the totals name a side, the killfeed's
 * "totals only" line, and each player's recorded kills, deaths, assists and damage; a dash for a
 * player the file holds no totals for.
 */
function TotalsDetail({ v, col, first, last, onClose, onStep }: {
  v: MatchView; col: Extract<RoundColumn, { kind: "totals" }>; first: boolean; last: boolean; onClose: () => void; onStep: (d: number) => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
  const w = totalsWinner(v, col);
  const us = usSideAt(v, col.number);
  const sideCls = (pi: number) => (us === null ? "" : (v.players[pi].team === "us") === (us === "T") ? "t" : "ct");
  const byPi = new Map((col.totals?.players ?? []).map((t) => [t.pi, t]));
  const max = Math.max(1, ...[...byPi.values()].map((t) => t.dmg));
  const rows = [...v.players].sort((a, b) => (byPi.get(b.pi)?.dmg ?? -1) - (byPi.get(a.pi)?.dmg ?? -1));
  return (
    <div className="drawer__in">
      <header className="drawer__head">
        <span className="faint" />
        <div className="drawer__title">
          <b>Round {col.number}</b>
          <span className="meta">{w === "us" ? "Won" : w === "them" ? "Lost" : "Result unknown"}, totals only</span>
        </div>
        <button className="btn btn--ghost btn--icon btn--sm press" onClick={() => onStep(-1)} disabled={first} aria-label="Previous round" data-tip={first ? undefined : "Previous round  ←"}><ChevronLeftIcon size={16} /></button>
        <button className="btn btn--ghost btn--icon btn--sm press" onClick={() => onStep(1)} disabled={last} aria-label="Next round" data-tip={last ? undefined : "Next round  →"}><ChevronRightIcon size={16} /></button>
        <button ref={close} className="btn btn--ghost btn--icon btn--sm press" onClick={onClose} aria-label="Close the round panel" data-tip="Esc"><CloseIcon size={16} /></button>
      </header>
      <div className="drawer__body">
        <Section title="Killfeed"><p className="meta">Only the game's round totals exist for this round.</p></Section>
        <Section title="Players" aside="Game totals: K–D, assists, damage">
          <ul className="ddmg dtotals">
            {rows.map((p) => {
              const t = byPi.get(p.pi) ?? null;
              const s = sideCls(p.pi);
              return (
                <li key={p.key} className={p.isHuman ? "is-you" : undefined}>
                  <span className={`kf__p ${s}`}>{p.name}</span>
                  <span className="num">{t ? `${t.kills}–${t.deaths}` : "–"}</span>
                  <span className="num">{t ? t.assists : "–"}</span>
                  <span className="hbar"><i style={{ width: `${t ? (t.dmg / max) * 100 : 0}%`, background: s === "t" ? "var(--t)" : s === "ct" ? "var(--ct)" : "var(--ink3)", opacity: 0.8 }} /></span>
                  <b className="num">{t ? t.dmg : "–"}</b>
                </li>
              );
            })}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function RoundDetail({ v, ri, rb, rbError, first, last, onClose, onStep }: { v: MatchView; ri: number; rb: RatingBreakdown | null; rbError: string | null; first: boolean; last: boolean; onClose: () => void; onStep: (d: number) => void }) {
  const r = v.rounds[ri];
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
  // every round's numbers per player, rolled up once in the worker when the drawer first opens, so
  // stepping rounds swaps the content without waiting
  const all = useCall("rounds", [v.file]).data;
  const rd = all?.[ri] ?? null;
  const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : null;
  const team = (t: "us" | "them") => v.players.filter((p) => p.team === t);
  const feed = useMemo(() => feedFor(v.facts, ri, v.human), [v, ri]);
  const m = (pi: number) => rd?.players[pi]?.m ?? null;
  const dmgMax = Math.max(1, ...v.players.map((p) => m(p.pi)?.dmg ?? 0));
  const sideCls = (pi: number) => (sideOf(v, r, pi) === "T" ? "t" : "ct");
  const thrown = (pi: number) => NADES.filter(([, k]) => (m(pi)?.[k] ?? 0) > 0);
  const anyNades = v.players.some((p) => thrown(p.pi).length > 0);
  const econ = v.b.economy.rounds[ri];
  const you = rd?.players[v.human] ?? null;
  // one round's places come from the match's tables, which the worker reads again for the open match
  const raw = useCall("places", v.entry.hasPos ? [v.file] : null).data?.[r.number];
  const spent = useMemo(() => placesNamed(raw ?? {}), [raw]);
  const f = r.fact;
  const name = (pi: number | null) => (pi === null ? "someone" : v.players[pi].name);
  return (
    <div className="drawer__in">
      <header className="drawer__head">
        <span className={side ? `${side}-text` : "faint"}><WinIcon how={r.how} size={18} /></span>
        <div className="drawer__title">
          <b>Round {r.number}</b>
          <span className="meta">{r.winner === "us" ? "Won" : r.winner === "them" ? "Lost" : "Unknown"}{r.how ? `, ${WIN_LABEL[r.how].toLowerCase()}` : ""}{r.plantSite ? `, site ${r.plantSite}` : ""}{r.durSecs !== null ? `, ${fmtClock(r.durSecs)}` : ""}</span>
        </div>
        {r.scoreAfter && <span className="drawer__score num"><span className={r.winner === "us" ? "cream" : ""}>{r.scoreAfter.us}</span><span className="faint">:</span><span className={r.winner === "them" ? "cream" : ""}>{r.scoreAfter.them}</span></span>}
        <button className="btn btn--ghost btn--icon btn--sm press" onClick={() => onStep(-1)} disabled={first} aria-label="Previous round" data-tip={first ? undefined : "Previous round  ←"}><ChevronLeftIcon size={16} /></button>
        <button className="btn btn--ghost btn--icon btn--sm press" onClick={() => onStep(1)} disabled={last} aria-label="Next round" data-tip={last ? undefined : "Next round  →"}><ChevronRightIcon size={16} /></button>
        <button ref={close} className="btn btn--ghost btn--icon btn--sm press" onClick={onClose} aria-label="Close the round panel" data-tip="Esc"><CloseIcon size={16} /></button>
      </header>
      <div className="drawer__body">
        <Section title="Killfeed" aside={r.kills.length ? `${r.kills.length} kills` : undefined}>
          <Killfeed kills={feed} name={(pi, name) => <PlayerName v={v} pi={pi}>{name}</PlayerName>} />
          {f.plantTick !== null && (
            <p className="meta" data-tip="Round clock: time since freeze time ended" tabIndex={0}>
              Bomb planted{f.plantSite ? ` on ${f.plantSite}` : ""} by {name(f.planter)} at {fmtClock(roundSecs(v, r, f.plantTick))}
              {f.defused ? `; defused by ${name(f.defuser)} at ${fmtClock(roundSecs(v, r, f.endTick))}` : f.exploded ? `; exploded at ${fmtClock(roundSecs(v, r, f.endTick))}` : ""}.
            </p>
          )}
        </Section>

        <Section title="Economy">
          <div className="deco">
            {(["us", "them"] as const).map((t) => {
              const tr = econ[t];
              return (
                <div key={t} className="deco__team">
                  <div className="deco__head">
                    <BuyIcon buy={tr.buy} size={16} beside className={t === "us" ? "cream" : "muted"} />
                    <b>{tr.buy ? BUY_LABEL[tr.buy] : "Unknown buy"}</b>
                    <span className="num faint" data-tip="Team equipment value at freeze end" tabIndex={0}>{fmtMoney(tr.equip)}</span>
                  </div>
                  <ul className="deco__players">
                    {team(t).map((p) => {
                      const x = r.pr[p.pi];
                      return (
                        <li key={p.key}>
                          <span className={`kf__p ${sideCls(p.pi)}`}>{p.name}</span>
                          <span className="deco__buy">{x?.ownBuy && <BuyIcon buy={x.ownBuy} size={11} />}</span>
                          <span className="num" data-tip="Equipment value at freeze end" tabIndex={0}>{fmtMoney(x?.equip)}</span>
                          <span className="num faint" data-tip="Money left after buying" tabIndex={0}>{fmtMoney(x?.money)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="deco__foot meta">
                    <span>Bank {fmtMoney(tr.money)}</span>
                    {tr.spent !== null && <span data-tip="Money the team spent in the buy time" tabIndex={0}>Spent {fmtMoney(tr.spent)}</span>}
                    {tr.saves > 0 && <span>{tr.saves} saved</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Utility thrown">
          {!rd ? <SkeletonLines n={3} /> : (
            <ul className="dutil">
              {v.players.filter((p) => thrown(p.pi).length > 0 || (m(p.pi)?.utilDmg ?? 0) > 0).map((p) => {
                const x = m(p.pi)!;
                return (
                  <li key={p.key}>
                    <span className={`kf__p ${sideCls(p.pi)}`}>{p.name}</span>
                    <span className="dutil__icons">{thrown(p.pi).map(([n, k]) => <span key={n} className="dutil__n" data-tip={NADE_LABEL[n]} tabIndex={0}><NadeIcon type={n} size={13} />{x[k] > 1 && <small>{x[k]}</small>}</span>)}</span>
                    <span className="meta">{x.enemiesFlashed ? `${x.enemiesFlashed} blinded, ${fmtSecs(x.enemyBlindSecs)}` : ""}</span>
                    <span className="num" data-tip="Grenade and fire damage to enemies" tabIndex={0}>{x.utilDmg ? `${x.utilDmg} dmg` : ""}</span>
                  </li>
                );
              })}
              {!anyNades && <li className="meta">No grenades thrown this round.</li>}
            </ul>
          )}
        </Section>

        <Section title="Damage" aside="To enemies">
          {!rd ? <SkeletonLines n={5} /> : (
            <ul className="ddmg">
              {[...v.players].sort((a, b) => (m(b.pi)?.dmg ?? 0) - (m(a.pi)?.dmg ?? 0)).map((p) => {
                const d = m(p.pi)?.dmg ?? 0;
                const own = m(p.pi)?.teamDmg ?? 0;
                const rm = m(p.pi);
                const sw = rm && rm.swingRounds ? rm.swing : null;
                return (
                  <li key={p.key} className={p.isHuman ? "is-you" : undefined} data-tip={`${p.name}: swing ${fmtSwing(sw)} this round${own ? `, ${own} damage to teammates` : ""}`} tabIndex={0}>
                    <span className={`kf__p ${sideCls(p.pi)}`}>{p.name}</span>
                    <span className="hbar"><i style={{ width: `${(d / dmgMax) * 100}%`, background: sideCls(p.pi) === "t" ? "var(--t)" : "var(--ct)", opacity: 0.8 }} /></span>
                    <b className="num">{d}{own > 0 && <small className="poor-text"> +{own} team</small>}</b>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <YourRating rb={rb} error={rbError} number={r.number} />

        {Object.keys(spent).length > 0 && (
          <Section title="Where you spent the round" aside="Seconds alive">
            <PlaceList places={spent} n={5} />
          </Section>
        )}

        <Section title="Your aim this round">
          {!v.entry.hasAim ? <p className="meta"><NeedsDemo detail="This match has no shot data." /></p> : !rd ? <SkeletonLines n={2} /> : !you ? <p className="meta">You have no stats this round.</p> : (
            <>
              <div className="daim">
                <div className="stat"><span className="stat__l">Shots</span><span className="stat__v num">{you.aim.shots}</span></div>
                <div className="stat"><span className="stat__l">Hits</span><span className="stat__v num">{you.aim.hits}</span><span className="stat__s">{you.headHits} head</span></div>
                <div className="stat" data-tip={metric("accuracy").def} tabIndex={0}><span className="stat__l">Accuracy</span><span className="stat__v num"><Num v={fmtMetric("accuracy", you.v.accuracy)} /></span></div>
                <div className="stat" data-tip="Share of your gun hits that landed on the head" tabIndex={0}><span className="stat__l">HS hits</span><span className="stat__v num"><Num v={fmtRatio(you.headHits, you.aim.hits)} /></span></div>
                <div className="stat" data-tip={metric("firstBulletAccuracy").def} tabIndex={0}><span className="stat__l">First bullet</span><span className="stat__v num"><Num v={fmtMetric("firstBulletAccuracy", you.v.firstBulletAccuracy)} /></span><span className="stat__s">{you.aim.firstHits}/{you.aim.first}</span></div>
                <div className="stat" data-tip={metric("sprayDeviation").def} tabIndex={0}><span className="stat__l">Spray</span><span className="stat__v num"><Num v={fmtMetric("sprayDeviation", you.v.sprayDeviation)} /></span></div>
              </div>
              {!v.visibility ? (
                <p className="gate">Time to damage, reaction, crosshair: <NeedsDemo detail="This file lacks view angles and line of sight." /></p>
              ) : (
                <div className="daim">
                  <div className="stat" data-tip={metric("timeToDamage").def} tabIndex={0}><span className="stat__l">TTD</span><span className="stat__v num"><Num v={fmtMetric("timeToDamage", you.v.timeToDamage)} /></span></div>
                  <div className="stat" data-tip={metric("reactionTime").def} tabIndex={0}><span className="stat__l">Reaction</span><span className="stat__v num"><Num v={fmtMetric("reactionTime", you.v.reactionTime)} /></span></div>
                  <div className="stat" data-tip={metric("crosshairPlacement").def} tabIndex={0}><span className="stat__l">Crosshair</span><span className="stat__v num"><Num v={fmtMetric("crosshairPlacement", you.v.crosshairPlacement)} /></span></div>
                </div>
              )}
            </>
          )}
        </Section>
      </div>
    </div>
  );
}

/**
 * Your Rating 3.0 for this round split into its terms, and its swing into sources; one line when you
 * did not play the round or it is not rated.
 */
function YourRating({ rb, error, number }: { rb: RatingBreakdown | null; error: string | null; number: number }) {
  const row = rb?.rows.find((x) => x.number === number) ?? null;
  const steps = row ? roundSteps(row) : null;
  const avg = rb?.match.value ?? null;
  return (
    <Section title="Your rating" aside={row && row.rating !== null && avg !== null && row.counts ? `${signedIn(fmtRating, row.rating - avg)} against your match ${fmtRating(avg)}` : undefined}>
      {error ? <LoadFailed what="Your rating" error={error} /> : !rb ? <SkeletonLines n={4} /> : !row ? <p className="meta">You have no stats this round.</p> : !steps ? <p className="meta">Not rated: this round's swing or eco value is unknown.</p> : (
        <>
          <RatingWaterfall {...steps} />
          {row.swing && (
            <div className="rbr__swing">
              <h4 className="caps">Swing by source</h4>
              <SwingSourcesChart you={row.swing} bots={null} />
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** Placeholder rows while the worker rolls the rounds up, shaped like the list they stand in for. */
function SkeletonLines({ n }: { n: number }) {
  return <div className="skel-rows" aria-hidden>{Array.from({ length: n }, (_, i) => <div key={i} className="skel" style={{ height: 14, opacity: 1 - i * 0.12 }} />)}</div>;
}
