// The human across all matches, after CS Demo Manager's player page: an overview (average profile
// card, attribute groups, form), splits, aim and "where you play".
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { GROUPS, type GroupScore } from "../../stats/attributes";
import { formatMetric, METRICS, tooltip } from "../../stats/metrics";
import type { ProfileView } from "../../stats/profile";
import { useData } from "../data";
import { fmtDate, mapName, ratingClass, swingPct } from "../format";
import { Chevron } from "../icons";
import { go, matchHref, type ProfileTab } from "../router";
import { Segmented } from "../Segmented";
import { ModelBadge } from "../ModelBadge";
import { UTILITY_MORE } from "./utility";
import { shotsFor } from "../../stats/aim";
import { AIM_STATS } from "../match/aimStats";
import { AimTile } from "../match/AimTile";

export interface ProfileTabProps { p: ProfileView }

const LAZY: Record<Exclude<ProfileTab, "overview">, ComponentType<ProfileTabProps>> = {
  splits: lazy(() => import("./Splits")),
  aim: lazy(() => import("./ProfileAim")),
  positions: lazy(() => import("./WhereYouPlay")),
};

function Radar({ groups }: { groups: GroupScore[] }) {
  const n = groups.length;
  const R = 70;
  const c = 104;
  const at = (i: number, r: number): [number, number] => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const poly = (f: (i: number) => number) => groups.map((_, i) => at(i, f(i)).map((x) => x.toFixed(1)).join(",")).join(" ");
  return (
    <svg viewBox="-34 4 276 200" width="100%" role="img" aria-label={groups.map((g) => `${g.label} ${g.score === null ? "no data" : Math.round(g.score)}`).join(", ")}>
      {[0.25, 0.5, 0.75, 1].map((k) => <polygon key={k} points={poly(() => R * k)} fill="none" stroke="rgba(60,60,67,.12)" />)}
      {groups.map((_, i) => { const [x, y] = at(i, R); return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="rgba(60,60,67,.1)" />; })}
      <polygon points={poly((i) => (R * (groups[i].score ?? 0)) / 100)} fill="rgba(0,122,255,.18)" stroke="var(--c-blue)" strokeWidth="1.5" strokeLinejoin="round" />
      {groups.map((g, i) => {
        const [x, y] = at(i, R + 14);
        return <text key={g.id} x={x} y={y} fontSize="9.5" fontWeight="600" fill="var(--text-3)" textAnchor={Math.abs(x - c) < 4 ? "middle" : x > c ? "start" : "end"} dominantBaseline="middle">{g.label}</text>;
      })}
    </svg>
  );
}

function SubRow({ id, value, score, open }: { id: string; value: number | null; score: number | null; open: boolean }) {
  const m = METRICS[id];
  return (
    <div className="sub">
      <span className="has-tip" data-tip={tooltip(m)} tabIndex={open ? 0 : -1}>{m.label}</span>
      <b>{formatMetric(m, value)}</b>
      <span className="bar" aria-hidden><i style={{ width: `${score ?? 0}%`, opacity: score === null ? 0 : 0.75 }} /></span>
    </div>
  );
}

function Attribute({ g, open, onToggle, total }: { g: GroupScore; open: boolean; onToggle: () => void; total: ProfileView["total"] }) {
  const id = `attr-${g.id}`;
  return (
    <div className="attr" data-open={open}>
      <button className="attr__btn" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="attr__label">{g.label}</span>
        <span className="bar"><i style={{ width: `${g.score ?? 0}%` }} /></span>
        <span className="attr__score">{g.score === null ? "–" : Math.round(g.score)}</span>
        <span className="chev"><Chevron /></span>
      </button>
      <div className="attr__body" id={id} hidden={!open}>
        <div>
          <div className="subs">
            {g.subs.map((s) => <SubRow key={s.id} {...s} open={open} />)}
          </div>
          {g.id === "utility" && (
            <>
              <p className="eyebrow subs__more">More</p>
              <div className="subs">
                {UTILITY_MORE.map((mid) => <SubRow key={mid} id={mid} value={METRICS[mid].value(total)} score={null} open={open} />)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Form({ p }: { p: ProfileView }) {
  const max = Math.max(2, ...p.form.map((f) => f.rating));
  return (
    <section className="glass card" aria-label="Form">
      <div className="card__head">
        <h2 className="card__title">Form</h2>
        <span className="note">Rating in your last {p.form.length} matches · select a bar to open the match</span>
      </div>
      <div className="form">
        <span className="form__base" style={{ bottom: `${100 / max}%` }} aria-hidden><i>1.00</i></span>
        {p.form.map((f) => (
          <button key={f.file} className={`form__bar is-${f.result}`} style={{ height: `${Math.max(3, (100 * f.rating) / max)}%` }}
            onClick={() => go(matchHref(f.file))}
            data-tip={`${mapName(f.map)} · ${fmtDate(f.startUtc)} · ${f.result === "W" ? "won" : f.result === "L" ? "lost" : "tied"} ${f.score.us}–${f.score.them} · rating ${f.rating.toFixed(2)}`}
            aria-label={`${mapName(f.map)}, ${fmtDate(f.startUtc)}, rating ${f.rating.toFixed(2)}`} />
        ))}
      </div>
    </section>
  );
}

function Overview({ p }: ProfileTabProps) {
  const [open, setOpen] = useState<string | null>("firepower");
  const t = p.total;
  const stat = (id: string) => formatMetric(METRICS[id], METRICS[id].value(t));
  const a = p.attributes;
  return (
    <>
      <section className="glass pcard" style={{ borderRadius: "var(--r-lg)" }} aria-label="Average profile">
        <div>
          <p className="eyebrow">Average profile</p>
          <h1 className="pcard__name selectable">{p.name}</h1>
          <p className="note">{p.matches} matches · {p.wins} won · {p.losses} lost · {t.rounds} rounds{t.fullRounds < t.rounds ? ` (${t.fullRounds} with full detail)` : ""}</p>
          <div className="pcard__rating">
            <b className={ratingClass(p.rating)} tabIndex={0} data-tip={tooltip(METRICS.rating)}>{p.rating.toFixed(2)}</b>
            <span className="note">Rating 2.0<br />(public approximation)</span>
          </div>
          {a.provisional ? (
            <p className="note" style={{ marginTop: 12 }}>
              <span className="pill pill--warn has-tip" tabIndex={0} data-tip={`Attribute scores use fixed reference ranges until 15 bots each have 150+ rounds across your matches; then they become percentiles against those bots. ${a.careers} bot${a.careers === 1 ? " has" : "s have"} enough so far.`}>Provisional</span>
              <span style={{ marginLeft: 8 }}>Scores from reference ranges</span>
            </p>
          ) : (
            <p className="note" style={{ marginTop: 12 }}>Scores are percentiles against {a.careers} bot careers.</p>
          )}
        </div>
        <Radar groups={a.groups} />
        <div className="pcard__stats">
          {[["kpr", "KPR"], ["adr", "ADR"], ["kast", "KAST"], ["hs", "HS%"], ["impact", "Impact"], ["dpr", "DPR"]].map(([id, label]) => (
            <div key={id} className="stat has-tip" tabIndex={0} data-tip={tooltip(METRICS[id])}><b>{stat(id)}</b><span>{label}</span></div>
          ))}
          <div className="stat has-tip" tabIndex={0} data-tip={tooltip(METRICS.swing)}><b>{swingPct(t.swingRounds ? t.swing / t.swingRounds : null)}</b><span>Swing per round</span><ModelBadge /></div>
          <div className="stat"><b className="num">{t.kills}–{t.deaths}</b><span>K–D</span></div>
        </div>
      </section>
      <section className="glass attrs" aria-label="Attributes">
        <div className="card__head" style={{ padding: "10px 10px 2px" }}>
          <h2 className="card__title">Attributes</h2>
          <span className="note">{GROUPS.length} groups after HLTV · 0–100 · select one for its stats{t.fullRounds < t.rounds ? ` · opening, trading, clutching, sniping and utility use the ${t.fullRounds} rounds with full detail` : ""}</span>
        </div>
        {a.groups.map((g) => <Attribute key={g.id} g={g} total={t} open={open === g.id} onToggle={() => setOpen(open === g.id ? null : g.id)} />)}
      </section>
      {p.aim && <AimCard p={p} />}
      <Form p={p} />
    </>
  );
}

/** Aim as its own Leetify-style group, apart from HLTV's seven attributes. */
function AimCard({ p }: { p: ProfileView }) {
  const s = shotsFor(p.aim!, "all", "all");
  return (
    <section className="glass card" aria-label="Aim">
      <div className="card__head">
        <div>
          <h2 className="card__title">Aim</h2>
          <p className="note">Leetify-style, separate from the HLTV attributes · {p.aimMatches} match{p.aimMatches === 1 ? "" : "es"} with aim data</p>
        </div>
        <button className="btn btn--ghost" onClick={() => go("#/profile/aim")}>Splits and charts</button>
      </div>
      <div className="tiles tiles--aim">
        {AIM_STATS.slice(0, 10).map((st) => <AimTile key={st.id} st={st} s={s} validated={p.aim!.validated} />)}
      </div>
    </section>
  );
}

export function ProfilePage({ tab }: { tab: ProfileTab }) {
  const { client, version, summaries, status } = useData();
  const [p, setP] = useState<ProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    client.profile({}).then((x) => alive && setP(x), (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [client, version]);

  if (error) {
    return <div className="page"><div className="glass card empty" role="alert"><h2>The profile could not be built</h2><p className="selectable">{error}</p></div></div>;
  }
  if (status !== "ready" && !summaries.length) return <div className="page"><div className="skeleton" style={{ height: 260 }} /></div>;
  if (!summaries.length) {
    return <div className="page"><div className="glass card empty"><h2>No profile yet</h2><p>Your profile builds from finished matches.</p><button className="btn" onClick={() => go("#/matches")}>Go to matches</button></div></div>;
  }
  if (!p) return <div className="page"><div className="skeleton" style={{ height: 260 }} /></div>;

  const Tab = tab === "overview" ? Overview : LAZY[tab];
  return (
    <div className="page fade-in">
      <div className="tabs">
        <Segmented kind="tabs" panelId="profile-panel" label="Profile views" value={tab} onChange={(t) => go(`#/profile/${t}`)} options={[
          { value: "overview", label: "Overview" },
          { value: "splits", label: "Splits" },
          { value: "aim", label: "Aim", disabled: !p.aim, tip: p.aim ? undefined : "None of your matches has aim data yet" },
          { value: "positions", label: "Where you play" },
        ]} />
      </div>
      <Suspense fallback={<div className="skeleton" style={{ height: 320 }} />}>
        <div id="profile-panel" role="tabpanel" aria-labelledby={`profile-panel-tab-${tab}`} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Tab p={p} />
        </div>
      </Suspense>
    </div>
  );
}
