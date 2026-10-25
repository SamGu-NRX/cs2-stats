// Profile sections added in round 2: the round-swing card, the identity section (role signals in
// plain words, signature stats) and the two similarity views ("plays like" compares the shape of
// your attribute scores, "plays as well as" compares their level).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Counters } from "../../../stats/counters";
import { SUBSTAT_BY_ID } from "../../../stats/hltv";
import type { ProfileView as PV } from "../../../stats/profile";
import type { Role } from "../../../stats/role";
import type { LightSummary } from "../../../worker/protocol";
import { Delta, Initials, RemoteImg } from "../../components/bits";
import { Card } from "../../components/Card";
import { AttrRadar, FormBars } from "../../components/charts";
import { attrVector, counterLine, summaryRating, type Attr } from "../../data/engine";
import { ATTRIBUTE_ORDER, HLTV_ORIGIN, usePros, type Pro } from "../../data/packs";
import { PACKS_FOLDER } from "../../../host/host";
import { AttrIcon } from "../../icons/attributes";
import { fmtDate, fmtPct, fmtSwing, mapName, plural } from "../../lib/format";
import { scoreText, swingScore } from "../../lib/scale";
import { rankSimilar } from "../../lib/similarity";
import { BENCH, verdictOf } from "../../lib/verdict";
import { matchHref, openMatch, setQuery } from "../../router";

export function SectionHead({ title, sub, id }: { title: string; sub: string; id?: string }) {
  return (
    <div className="shead" id={id}>
      <h2 className="shead__t">{title}</h2>
      <p className="shead__s">{sub}</p>
    </div>
  );
}

// ---------------------------------------------------------------- swing

export function SwingCard({ p, list, bots }: { p: PV; list: LightSummary[]; bots: Counters | null }) {
  const c = p.total;
  const swing = c.swingRounds ? c.swing / c.swingRounds : null;
  const botSwing = bots && bots.swingRounds ? bots.swing / bots.swingRounds : null;
  const per = [...list].reverse().map((s) => ({ s, v: counterLine(s.human.c, "both").swing }));
  const known = per.filter((x) => x.v !== null) as { s: LightSummary; v: number }[];
  const best = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v > b.v ? x : b), null);
  const worst = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v < b.v ? x : b), null);
  const positive = known.filter((x) => x.v > 0).length;
  const v = verdictOf(swing === null ? null : 100 * swing, BENCH.swing);
  return (
    <Card title="Round swing" aside={<span className="meta">{plural(c.swingRounds, "round")} with swing</span>} className="swingcard">
      <div className="swingcard__grid">
        <div className="swingcard__big">
          <b className="num" style={{ color: swing === null ? undefined : scoreText(swingScore(swing)) }}>{fmtSwing(swing)}</b>
          <span className="verdict" data-v={v}>{v === "good" ? "Good" : v === "poor" ? "Poor" : v === "avg" ? "Average" : ""}</span>
          <p className="swingcard__say">
            {swing === null ? "No round in these matches has swing data."
              : `Each round you ${swing >= 0 ? "add" : "take"} ${Math.abs(100 * swing).toFixed(2)} percentage points ${swing >= 0 ? "to" : "from"} your team's chance of winning it, through your kills and deaths.`}
          </p>
          {botSwing !== null && <p className="meta">Bots in the same matches: <b className="num">{fmtSwing(botSwing)}</b>. <Delta d={swing === null ? null : 100 * (swing - botSwing)} span={3} fmt={(x) => `${x.toFixed(2)} pts`} /> against them.</p>}
        </div>
        <div className="swingcard__chart">
          <FormBars height={150} refValue={0} fmt={(x) => fmtSwing(x / 100)} score={(x) => swingScore(x / 100)} bars={per.map((x) => ({
            key: x.s.file, value: x.v === null ? null : 100 * x.v, label: fmtDate(x.s.startUtc), sub: x.s.result, result: x.s.result,
            onClick: () => openMatch(matchHref(x.s.file)), tip: `${mapName(x.s.map)} ${x.s.score.us}:${x.s.score.them}: ${fmtSwing(x.v)} per round`,
          }))} />
          <div className="swingcard__facts">
            <span><b className="num">{positive}</b><span className="faint">/{known.length}</span> matches with positive swing</span>
            {best && <a href={matchHref(best.s.file)}>Best <b className="num good-text">{fmtSwing(best.v)}</b> {fmtDate(best.s.startUtc)}</a>}
            {worst && <a href={matchHref(worst.s.file)}>Worst <b className="num poor-text">{fmtSwing(worst.v)}</b> {fmtDate(worst.s.startUtc)}</a>}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- role signals in plain words

const UNIT_M = 0.0254; // one Source unit is one inch

function explain(f: Role["flavours"][number]): { what: string; you: string; bar: string } {
  const v = f.value;
  switch (f.flavour) {
    case "Entry":
      return { what: "Takes the first duel of the round.", you: v === null ? "Needs rounds with a kill log." : `You are in the first duel of ${fmtPct(100 * v, 0)} of rounds.`, bar: "Entry players: 25% or more (the average is 20%)." };
    case "Support":
      return { what: "Plays off teammates: trades and assists rather than first kills.", you: v === null ? "Needs kills or assists." : `${fmtPct(100 * v, 0)} of your kills and assists are trades or assists.`, bar: "Support players: 45% or more." };
    case "Lurker":
      return { what: "Plays away from the team on T, before the bomb is planted.", you: v === null ? "Needs recorded positions on Dust II." : `You stand ${Math.round(v)} units (about ${Math.round(v * UNIT_M)} m) from your nearest teammate.`, bar: `Lurkers: 1,100 units (about ${Math.round(1100 * UNIT_M)} m) or more.` };
    case "Anchor":
      return { what: "Holds a bombsite alone or with one teammate on CT.", you: v === null ? "Needs recorded positions on Dust II." : `15 s into your CT rounds you hold a site with at most one teammate in ${fmtPct(100 * v, 0)} of them.`, bar: "Anchors: half their CT rounds or more." };
  }
}

export function RoleCard({ role }: { role: Role }) {
  const ev = role.evidence;
  return (
    <Card title="Role" aside={<span className="meta">{role.provisional ? "Provisional, under 20 rounds" : `${ev.rounds} rounds`}</span>} className="rolecard">
      <div className="rolecard__head">
        <b className="role__label">{role.label}</b>
        <p className="meta">{role.primary === "AWPer" ? `${fmtPct(100 * (ev.sniperShare ?? 0), 0)} of your kills are with sniper rifles (AWPers: 35% or more).` : `Sniper rifles make ${ev.sniperShare === null ? "–" : fmtPct(100 * ev.sniperShare, 0)} of your kills, under the 35% that makes an AWPer, so you play as a rifler.`}</p>
      </div>
      <ul className="signals2">
        {role.flavours.map((f) => {
          const e = explain(f);
          const ok = f.score !== null && f.score >= 1;
          return (
            <li key={f.flavour} className={ok ? "is-on" : f.value === null ? "is-na" : ""}>
              <div className="signals2__top"><b>{f.flavour}</b><span className="meta">{e.what}</span>{ok && <span className="chip chip--outline">You fit</span>}</div>
              <div className="signals2__track" aria-hidden>
                <i style={{ width: `${Math.min(100, ((f.score ?? 0) / 2) * 100)}%` }} />
                <em style={{ left: "50%" }} />
              </div>
              <p className="signals2__you">{e.you} <span className="faint">{e.bar}</span></p>
            </li>
          );
        })}
      </ul>
      <p className="meta">The tick on each bar is the threshold; the bar fills to twice it. Thresholds are chosen by hand in the engine; finer archetypes arrive with the metrics update.</p>
    </Card>
  );
}

// ---------------------------------------------------------------- similarity

function ProFace({ pro, className }: { pro: Pro; className: string }) {
  return <RemoteImg src={pro.photo} alt={`${pro.name}`} className={className} fallback={<Initials name={pro.name} className={`${className}--init`} />} />;
}

function ProMarks({ pro }: { pro: Pro }) {
  return (
    <span className="promarks">
      {pro.flag && <RemoteImg src={pro.flag} alt={pro.country} className="promarks__flag" fallback={<span className="promarks__code">{pro.code}</span>} />}
      <RemoteImg src={pro.logo} alt={pro.team} className="promarks__logo" fallback={null} />
      <span>{pro.team}</span>
    </span>
  );
}

/** The six style attributes, Firepower left out (design/identity.md). */
const STYLE = ATTRIBUTE_ORDER.map((id, i) => ({ id, i })).filter((x) => x.id !== "firepower");
const styleOf = (v: (number | null)[]) => STYLE.map((x) => v[x.i]);

/**
 * "Plays like": the shape of your six style attributes against each pro's (correlation), as HLTV
 * computes similarity over style attributes without Firepower. HLTV compares T and CT separately;
 * your attributes are not split by side yet, so this uses both sides until the engine supplies them.
 */
export function PlaysLike({ attrs, initial }: { attrs: Attr[]; initial: string | null }) {
  const pack = usePros();
  if (pack.state === "ready") return <PlaysLikeBody attrs={attrs} initial={initial} pros={pack.pros} />;
  return (
    <Card title="Plays like" aside={<span className="meta">Six style attributes</span>}>
      {pack.state === "loading" ? <div className="skel" style={{ height: 220 }} /> : (
        <div className="packmiss">
          <svg viewBox="0 0 120 80" width="120" height="80" aria-hidden className="packmiss__art">
            <circle cx="40" cy="30" r="14" fill="none" stroke="var(--line2)" strokeWidth="1.5" /><path d="M16 74c3-14 13-22 24-22s21 8 24 22" fill="none" stroke="var(--line2)" strokeWidth="1.5" />
            <circle cx="84" cy="30" r="14" fill="none" stroke="var(--tan)" strokeWidth="1.5" strokeDasharray="3 3" /><path d="M60 74c3-14 13-22 24-22s21 8 24 22" fill="none" stroke="var(--tan)" strokeWidth="1.5" strokeDasharray="3 3" />
          </svg>
          <div>
            <b>{pack.state === "missing" ? "Add the pro pack to compare with pros" : "The pro pack could not be read"}</b>
            <p className="meta">{pack.state === "missing" ? <>Put <span className="mono">pros.json</span> in <span className="mono">{PACKS_FOLDER}</span> and this compares your six style attributes with each pro's.</> : pack.message}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function PlaysLikeBody({ attrs, initial, pros }: { attrs: Attr[]; initial: string | null; pros: Pro[] }) {
  const you = styleOf(attrVector(attrs));
  const ranked = useMemo(() => rankSimilar(you, pros, (x) => styleOf(x.both)), [you.join(","), pros]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState<string | null>(initial);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (initial) ref.current?.scrollIntoView({ block: "start" }); }, [initial]);
  const top = ranked.slice(0, 6);
  const pick = (sel && ranked.find((x) => x.item.slug === sel)) || top[0];
  if (!pick) return null;
  const labels = STYLE.map((x) => attrs.find((a) => a.id === x.id)!.label);
  return (
    <div ref={ref} id="similar">
      <Card title="Plays like" aside={<span className="meta" data-tip="HLTV compares T and CT separately; your attributes are not split by side yet, so both sides are compared.">Six style attributes, both sides</span>} foot={<><span>Your scores rank you against bots and a pro's rank them against pros, so this compares the shape of your style, not its level.</span><span>Pro scores and photos: HLTV</span></>}>
        <div className="likes">
          <div className="likes__left">
            <a className="probanner" href={`${HLTV_ORIGIN}${pick.item.hltv}`} target="_blank" rel="noreferrer" data-tip="Opens the player's HLTV page">
              <ProFace pro={pick.item} className="probanner__face" />
              <div className="probanner__body">
                <ProMarks pro={pick.item} />
                <b className="probanner__name">{pick.item.name}</b>
                <span className="meta">Rating 3.0 {pick.item.rating3.toFixed(2)} against top-20 teams</span>
              </div>
              <b className="probanner__pct num">{pick.pct}<small>%</small></b>
            </a>
            <ul className="prolist" role="radiogroup" aria-label="Pros by shape match">
              {top.map((x) => (
                <li key={x.item.slug}>
                  <button role="radio" aria-checked={x.item.slug === pick.item.slug} className="prorow" onClick={() => { setSel(x.item.slug); setQuery("pro", x.item.slug); }}>
                    <span className="prorow__face"><ProFace pro={x.item} className="prorow__img" /></span>
                    <span className="prorow__name"><b>{x.item.name}</b><ProMarks pro={x.item} /></span>
                    <b className="num prorow__pct">{x.pct}%</b>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="likes__right">
            <AttrRadar labels={labels} you={you} other={styleOf(pick.item.both)} otherLabel={pick.item.name} size={380} />
            <div className="legend likes__legend"><span><i className="swatch" style={{ background: "var(--cream)" }} />You</span><span><i className="swatch swatch--dash" />{pick.item.name}</span></div>
            <VsTable attrs={attrs} pro={pick.item} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function VsTable({ attrs, pro }: { attrs: Attr[]; pro: Pro }) {
  return (
    <div className="vs vs--wide">
      <div className="vs__head"><span className="caps">You</span><span /><span className="vs__pro">{pro.name}</span><span className="caps">Diff</span></div>
      {STYLE.map(({ id, i }) => {
        const a = attrs.find((x) => x.id === id)!;
        const pv = pro.both[i];
        const d = a.score === null || pv === null ? null : a.score - pv;
        return (
          <div key={id} className="vs__row">
            <span className="num cream">{a.score === null ? "–" : Math.round(a.score)}</span>
            <span className="vs__lbl"><AttrIcon id={id} size={13} />{a.label}</span>
            <span className="num">{pv ?? "–"}</span>
            <Delta d={d} span={30} fmt={(x) => Math.round(x).toString()} />
          </div>
        );
      })}
    </div>
  );
}

export function RatingLegend({ children }: { children?: ReactNode }) {
  return (
    <div className="legend">
      <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--cream)" strokeWidth="1.75" /></svg>Rating per match</span>
      <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--cream)" strokeDasharray="2 4" /></svg>Your pooled rating</span>
      <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink3)" strokeDasharray="3 3" /></svg>1.00, an average player</span>
      <span><svg width="8" height="8" aria-hidden><circle cx="4" cy="4" r="3.5" fill="var(--good-text)" /></svg>Best</span>
      <span><svg width="8" height="8" aria-hidden><circle cx="4" cy="4" r="3.5" fill="var(--poor-text)" /></svg>Worst</span>
      {children}
    </div>
  );
}

export { summaryRating };

// ---------------------------------------------------------------- how good

/**
 * The performance tables HLTV pairs with Rating 3.0. Values the counters already hold are shown;
 * the swing-based ones wait for the engine's new metrics and say so.
 */
export function HowGood({ c }: { c: Counters }) {
  const rows: { label: string; value: string; of: string; def: string }[] = [];
  if (c.hl.tradeOpps) rows.push({ label: "Trade kill success", value: fmtPct((100 * c.hl.tradeOppsTaken) / c.hl.tradeOpps), of: `${c.hl.tradeOppsTaken} of ${c.hl.tradeOpps}`, def: `${SUBSTAT_BY_ID.tradeOppsTaken?.def ?? ""} Counts teammate deaths within 1,000 units of you, so only recorded matches with positions count.` });
  if (c.fullDeaths) rows.push({ label: "Deaths traded", value: fmtPct((100 * c.tradedDeaths) / c.fullDeaths), of: `${c.tradedDeaths} of ${c.fullDeaths}`, def: "Your deaths a teammate avenged within 5 s." });
  if (c.clutchN[0]) rows.push({ label: "1v1 win rate", value: fmtPct((100 * c.clutchW[0]) / c.clutchN[0]), of: `${c.clutchW[0]} of ${c.clutchN[0]}`, def: "1v1 clutches won, of those played." });
  return (
    <Card title="How good" aside={<span className="meta">HLTV's performance tables</span>}>
      <ul className="howgood">
        {rows.map((r) => (
          <li key={r.label} data-tip={r.def}>
            <span>{r.label}</span>
            <span className="howgood__v"><span className="meta num">{r.of}</span><b className="num">{r.value}</b></span>
          </li>
        ))}
      </ul>
      <p className="meta howgood__next">Opening, clutch, AWP and flash swing and AWP duel wins arrive with the metrics update.</p>
    </Card>
  );
}
