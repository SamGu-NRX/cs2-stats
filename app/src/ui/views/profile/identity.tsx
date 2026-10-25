// Profile's Identity half: how you play, not how well. Role per side and per spawn, where you play on
// the title bar's map, spotting, and the pros whose style shape matches yours. No red or green here:
// a style has no better or worse.
import { useMemo, useState } from "react";
import type { RoleBlend } from "../../../stats/identity";
import { CELL, cellCentre } from "../../../stats/positions";
import type { Query, Rolled } from "../../../worker/protocol";
import { Initials, RemoteImg } from "../../components/bits";
import { Card } from "../../components/Card";
import { frameFor, RadarView } from "../../components/MapArt";
import { ApproxMark } from "../../components/Percentile";
import { attrsOf, BOTS_TIP, botPoolName, fmtMetric, hasMetric, mapsIn } from "../../data/engine";
import { useCall, useRollups } from "../../data/hooks";
import type { MatchEntry } from "../../data/match";
import { metric, styleIds } from "../../data/meta";
import { ATTRIBUTE_ORDER, HLTV_ORIGIN, usePros, type AttributeId, type Pro } from "../../data/packs";
import { useData } from "../../data/provider";
import { PACKS_FOLDER } from "../../../host/host";
import { AttrIcon } from "../../icons/attributes";
import { fmtPct, mapName, plural } from "../../lib/format";
import { Provisional } from "../shared";
import { MetricSlot, splitUnit } from "./parts";

// ---------------------------------------------------------------- role

/** What a top role means, for the side heading; Mixed says plainly that no CT role fits. */
const ROLE_WHAT: Record<string, string> = {
  Entry: "Takes space first.",
  Lurker: "Plays away from the team.",
  "Half-lurker": "Starts with the team, then splits off.",
  Anchor: "Holds a bombsite.",
  Rotator: "Moves between sites.",
  Mixed: "No CT role fits: you neither anchor nor rotate in most rounds.",
  AWPer: "Carries the AWP.",
};

const ROLE_TIP = "Fit comes from a model trained on labelled pro roles (Jamie Packer's CS2 roles dataset) over opening duels, death timing, trades and spacing. The AWPer fit is how often you carried an AWP.";

const ranked = (b: RoleBlend) => (b.blend ? Object.entries(b.blend).sort((x, y) => y[1] - x[1]) : []);

export function RoleCard({ q }: { q: Query }) {
  const r = useCall("roles", [q]);
  if (!r.data) return <Card title="Role">{r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 260 }} />}</Card>;
  const sides = [r.data.T, r.data.CT];
  return (
    <Card title={<>Role<span className="help" tabIndex={0} data-tip={ROLE_TIP} aria-label="How fit is measured">?</span></>} aside={<span className="meta">{sides[0].rounds} T rounds, {sides[1].rounds} CT rounds</span>}>
      <div className="role">
        {sides.map((b) => {
          const roles = ranked(b);
          const top = roles[0]?.[0];
          return (
            <section key={b.side} className="role__side" aria-label={`${b.side} side`}>
              <h3 className="caps">{b.side} side{top ? `: ${top}` : ""}</h3>
              {top && ROLE_WHAT[top] && <p className="meta">{ROLE_WHAT[top]}</p>}
              {b.blend ? (
                <ul className="fit" aria-label={`Role fit on ${b.side}`}>
                  {roles.map(([role, share]) => (
                    <li key={role} data-top={role === top || undefined}>
                      <span>{role}</span>
                      <span className="fit__bar" aria-hidden><i style={{ width: `${100 * share}%` }} /></span>
                      <span className="num fit__v">{fmtPct(100 * share, 0)} fit</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="meta">The fit needs kills, deaths and positions on {b.side}; converted logs have no positions.</p>}
              {b.evidence.length > 0 && <ul className="evidence">{b.evidence.map((x) => <li key={x}>{x}</li>)}</ul>}
            </section>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- role by spawn

/** Areas under this many rounds say so instead of drawing a blend (design brief). */
const SPAWN_MIN_ROUNDS = 5;
/** Role colours: T roles warm, CT roles cool, so a spawn's bar reads with its side. Categorical, never good or bad. */
const ROLE_COLOR: Record<string, string> = {
  Entry: "var(--t)", Lurker: "var(--tan)", "Half-lurker": "var(--avg)", AWPer: "var(--cream)",
  Mixed: "var(--ct)", Rotator: "#6B9BB5", Anchor: "#45707F",
};

export function RolesBySpawn({ q }: { q: Query }) {
  const r = useCall("rolesBySpawn", [q]);
  if (!r.data) return <Card title="Role by spawn">{r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 200 }} />}</Card>;
  const data = r.data;
  const seen = new Set<string>();
  return (
    <Card title="Role by spawn" aside={<span className="meta">Spawns with {SPAWN_MIN_ROUNDS}+ rounds</span>}
      foot={<span>Spawns are numbered by how often you started there; the data names no callout for them.</span>}>
      <div className="spawns">
        {(["T", "CT"] as const).map((side) => {
          const all = data[side];
          const big = all.filter((s) => s.rounds >= SPAWN_MIN_ROUNDS);
          const small = all.filter((s) => s.rounds < SPAWN_MIN_ROUNDS);
          const smallRounds = small.reduce((a, s) => a + s.rounds, 0);
          return (
            <section key={side} aria-label={`${side} spawns`}>
              <h3 className="caps">{side} side</h3>
              {!all.length ? <p className="meta">No spawn recorded on {side}.</p> : (
                <ul className="spawns__list">
                  {big.map((s, i) => {
                    const roles = ranked(s.blend);
                    roles.forEach(([x]) => seen.add(x));
                    return (
                      <li key={s.spawn}>
                        <span data-tip={`Spawn point at ${s.spawn.replace(",", ", ")} (world units)`}>{side} spawn {i + 1}</span>
                        {roles.length ? (
                          <span className="spawns__bar" role="img" aria-label={roles.map(([x, v]) => `${x} ${Math.round(100 * v)}% fit`).join(", ")}>
                            {roles.map(([x, v]) => <i key={x} style={{ width: `${100 * v}%`, background: ROLE_COLOR[x] ?? "var(--avg)" }} data-tip={`${x}: ${Math.round(100 * v)}% fit`} />)}
                          </span>
                        ) : <span className="meta">No positions on these rounds</span>}
                        <span className="meta num spawns__n">{roles[0] ? `${roles[0][0]} · ` : ""}{plural(s.rounds, "round")}</span>
                      </li>
                    );
                  })}
                  {small.length > 0 && (
                    <li className="spawns__few">
                      <span>{big.length ? `${small.length} more` : plural(small.length, "spawn")}</span>
                      <span className="meta">Too few rounds to say</span>
                      <span className="meta num spawns__n">{plural(smallRounds, "round")}</span>
                    </li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {seen.size > 0 && (
        <div className="legend spawns__keys">
          {[...seen].map((x) => <span key={x}><i className="swatch" style={{ background: ROLE_COLOR[x] ?? "var(--avg)" }} />{x}</span>)}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- where you play

/** Engine place names as they read on a map: "TopofMid" → "Top of Mid", "BombsiteB" → "Bombsite B". */
export const placeName = (p: string) => p.replace(/of(?=[A-Z])/g, " of ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/\s+/g, " ").trim();

/** The radar of where you moved, killed and died on one map: the title bar's map, else your most played. */
export function WhereYouPlay({ list, map: scoped }: { list: MatchEntry[]; map: string | null }) {
  const { you } = useData();
  const map = scoped ?? mapsIn(list)[0] ?? null;
  const onMap = useMemo(() => list.filter((e) => e.match.map === map), [list, map]);
  const q = useMemo(() => (map && onMap.length && you.length ? { files: onMap.map((e) => e.file), filter: { player: you, maps: [map] } } : null), [onMap, you, map]);
  const pos = useCall("positions", q ? [q] : null).data;
  const totals = useRollups(q ? [q] : null).data?.[0] ?? null;
  const cells = useMemo(() => Object.entries(pos?.presence?.cells ?? {}).map(([c, secs]) => ({ c: +c, secs, at: cellCentre(+c) })), [pos]);
  const frame = useMemo(() => (pos && map ? frameFor(map, [...pos.kills, ...pos.deaths, ...cells.map((c) => c.at)]) : null), [map, pos, cells]);
  if (!map) return null;
  const recorded = onMap.filter((s) => s.hasPos).length;
  const maxCell = Math.max(1, ...cells.map((c) => c.secs));
  const allPlaces = Object.entries(pos?.presence?.places ?? {}).sort((a, b) => b[1] - a[1]);
  const places = allPlaces.slice(0, 8);
  const total = allPlaces.reduce((a, [, s]) => a + s, 0) || 1;
  const heat = (f: number) => 0.1 + 0.55 * Math.sqrt(f);
  return (
    <Card title="Where you play" aside={<span className="meta" data-tip={scoped ? undefined : "Pick a map in the title bar to see another"}>{mapName(map)}{scoped ? "" : ", your most played map"}</span>}>
      {!pos ? <div className="skel" style={{ height: 360 }} /> : !frame ? <p className="meta">No kill, death or movement positions on {mapName(map)} in these matches.</p> : (
        <div className="wyp">
          <div className="wyp__map">
            <RadarView map={map} frame={frame} label={`Where you moved, killed and died on ${mapName(map)}`}>
              {cells.map(({ c, secs, at }) => {
                const [x, y] = frame.to(...at);
                const s = frame.to(CELL, 0)[0] - frame.to(0, 0)[0];
                return <rect key={c} x={x - s / 2} y={y - s / 2} width={s} height={s} fill="var(--cream)" opacity={heat(secs / maxCell)} />;
              })}
              {pos.deaths.map(([x0, y0], i) => { const [x, y] = frame.to(x0, y0); return <path key={`d${i}`} transform={`translate(${x} ${y})`} d="M-6 -6L6 6M6 -6L-6 6" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />; })}
              {pos.kills.map(([x0, y0], i) => { const [x, y] = frame.to(x0, y0); return <circle key={`k${i}`} cx={x} cy={y} r="7" fill="var(--cream)" stroke="var(--bg0)" strokeWidth="2.5" />; })}
            </RadarView>
            <div className="legend">
              <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="var(--cream)" /></svg>Your kills, where you stood</span>
              <span><svg width="10" height="10" aria-hidden><path d="M1 1L9 9M9 1L1 9" stroke="var(--ink)" strokeWidth="2" /></svg>Your deaths</span>
              {cells.length > 0 && (
                <span>Time alive
                  <span className="ramp" aria-hidden>{[0.05, 0.3, 0.6, 1].map((f) => <i key={f} style={{ opacity: heat(f) }} />)}</span>
                  less to more
                </span>
              )}
            </div>
          </div>
          <div className="wyp__side">
            <p className="meta">
              <b className="num">{pos.kills.length}</b> of {plural(totals?.m.kills ?? pos.kills.length, "kill")} and <b className="num">{pos.deaths.length}</b> of {plural(totals?.m.deaths ?? pos.deaths.length, "death")} placed; movement recorded in {recorded} of {plural(onMap.length, "match", "matches")} on {mapName(map)}.
            </p>
            {places.length ? (
              <div>
                <div className="places__head"><span className="caps">Place</span><span className="caps">Time alive</span></div>
                <ul className="places" aria-label="Share of your time alive by place">
                  {places.map(([p, secs]) => <li key={p}><span>{placeName(p)}</span><span className="hbar"><i style={{ width: `${(100 * secs) / places[0][1]}%` }} /></span><b className="num">{fmtPct((100 * secs) / total, 0)}</b></li>)}
                </ul>
              </div>
            ) : <p className="meta">Where you spend your time comes from movement samples; these matches place kills and deaths only.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- information

const INFO: { id: string; sub: string }[] = [
  { id: "firstSpotPct", sub: "of rounds, first of your team to spot an enemy" },
  { id: "spotSecsPR", sub: "per round with enemies spotted, summed over enemies" },
  { id: "spotAssistsPR", sub: "per round, spots before a teammate's kill" },
  { id: "smokeBlockedSecs", sub: "per smoke, enemy sight running through it" },
];

/** Spotting and smoke sightlines: the information you gather and deny. */
export function Information({ you }: { you: Rolled }) {
  const v = you.v;
  const ids = INFO.filter((x) => hasMetric(x.id));
  const shown = ids.filter((x) => v[x.id] !== null && v[x.id] !== undefined);
  if (!ids.length) return null;
  const gap = "Spotting comes from a demo's radar spotted state and smoke sightlines from line-of-sight tracing; recorded plugin matches store neither.";
  return (
    <Card title="Information" foot={shown.length && shown.length < ids.length ? <span>{gap}</span> : undefined}>
      {shown.length ? (
        <dl className="info">
          {shown.map(({ id, sub }) => {
            const m = metric(id);
            const t = splitUnit(fmtMetric(id, v[id]));
            return (
              <div key={id}>
                <dt className="caps" data-tip={m.def}>{m.label}{m.status === "approx" && <ApproxMark />}</dt>
                <dd className="info__v num">{t.value}{t.unit && <small>{t.unit}</small>}</dd>
                <dd className="meta">{sub}</dd>
              </div>
            );
          })}
        </dl>
      ) : <p className="meta">{gap}</p>}
    </Card>
  );
}

/** Buy deviation (identity, coming from the engine): renders once the engine defines it and has a value. */
export function BuyDeviation({ q, you }: { q: Query; you: Rolled }) {
  const known = hasMetric("buyDeviation") && you.v.buyDeviation !== null && you.v.buyDeviation !== undefined;
  const style = useCall("style", known ? [q, { side: "both" }] : null).data;
  if (!known) return null;
  return (
    <Card title="Buying">
      <MetricSlot id="buyDeviation" values={you.v} ranks={style?.p ?? null} kind="style" population={style ? botPoolName(style.role) : "bots"} />
    </Card>
  );
}

// ---------------------------------------------------------------- plays like

/**
 * Below this similarity the shapes only loosely agree, so the card stays small and lists the closest
 * six; from it, the closest pro gets the banner. The figure is the mockup review's (redesign NOTES.md,
 * profile); no data run picked it.
 */
const STRONG_MATCH = 75;

function ProFace({ pro, className }: { pro: Pro; className: string }) {
  return <RemoteImg src={pro.photo} alt="" className={className} fallback={<Initials name={pro.name} className={`${className}--init`} />} />;
}

const styleOf = (v: (number | null)[]) => styleIds().map((id) => v[ATTRIBUTE_ORDER.indexOf(id as AttributeId)]);

const BASIS_TIP = `The match compares the shape of your six style attributes on T and on CT with each pro's, by cosine similarity. Yours rank against the bots in your matches, a pro's against pros, so only the shape compares, not how high the scores sit. ${BOTS_TIP}`;

export function PlaysLike({ q, initial, rounds }: { q: Query; initial: string | null; rounds: { T: number; CT: number } }) {
  const pack = usePros();
  if (pack.state === "ready") return <PlaysLikeBody q={q} pros={pack.pros} initial={initial} rounds={rounds} />;
  return (
    <Card title="Plays like">
      {pack.state === "loading" ? <div className="skel" style={{ height: 220 }} /> : (
        <p className="meta">{pack.state === "missing" ? <>Put <span className="mono">pros.json</span> in <span className="mono">{PACKS_FOLDER}</span> to compare your style with pros'.</> : pack.message}</p>
      )}
    </Card>
  );
}

function PlaysLikeBody({ q, pros, initial, rounds }: { q: Query; pros: Pro[]; initial: string | null; rounds: { T: number; CT: number } }) {
  const bySlug = useMemo(() => new Map(pros.map((p) => [p.slug, p])), [pros]);
  const packArg = useMemo(() => pros.map((p) => ({ slug: p.slug, both: p.both, ct: p.ct, t: p.t })), [pros]);
  const res = useCall("playsLike", [q, packArg]);
  const list = useMemo(() => (res.data?.ranked ?? []).flatMap((x) => { const pro = bySlug.get(x.slug); return pro ? [{ pro, pct: Math.round(x.similarity) }] : []; }), [res.data, bySlug]);
  const [sel, setSel] = useState<string | null>(initial);
  // a keyboard pick swaps the banner instantly; a click cross-fades it (design/shell-and-motion.md, select pro)
  const [instant, setInstant] = useState(false);
  const top = list[0];
  const strong = !!top && top.pct >= STRONG_MATCH;
  const chosen = (strong && sel && list.find((x) => x.pro.slug === sel)) || top;
  if (!res.data) return <Card title="Plays like">{res.error ? <p className="meta">{res.error}</p> : <div className="skel" style={{ height: 220 }} />}</Card>;
  const careers = res.data.careers;
  const title = <>Plays like<span className="help" tabIndex={0} data-tip={BASIS_TIP} aria-label="How the match is made">?</span></>;
  const aside = (
    <span className="card__aside-row">
      <Provisional c={careers} />
      {top && !strong && <span className="chip">Weak match</span>}
    </span>
  );
  if (!top) return <Card title={title} aside={aside}><p className="meta">Your style scores rank against the bots in your matches, and these matches hold too few to score.</p></Card>;
  const sample = `over ${rounds.T} T and ${rounds.CT} CT rounds`;
  if (!strong) {
    return (
      <Card title={title} aside={aside} className="likes likes--weak">
        <p className="likes__say">Your closest style is {top.pro.name} at {top.pct}%, {sample}. Below {STRONG_MATCH}% the shapes only loosely agree, so this lists the closest six.</p>
        <ul className="likes__list">
          {list.slice(0, 6).map((x) => <ProRow key={x.pro.slug} x={x} />)}
        </ul>
      </Card>
    );
  }
  const rest = list.slice(0, 7).filter((x) => x.pro.slug !== chosen.pro.slug).slice(0, 5);
  return (
    <Card title={title} aside={aside} className="likes">
      <div className="probanner">
        <span className={`probanner__face ${instant ? "is-instant" : ""}`} key={chosen.pro.slug}><ProFace pro={chosen.pro} className="probanner__img" /></span>
        <div className="probanner__body">
          {chosen !== top && <span className="caps">Selected</span>}
          <b className="probanner__name">{chosen.pro.name}</b>
          <span className="meta">{chosen.pro.team}</span>
          <a className="probanner__link" href={`${HLTV_ORIGIN}${chosen.pro.hltv}`} target="_blank" rel="noreferrer">View on HLTV ↗</a>
        </div>
        <b className="probanner__pct num">{chosen.pct}<small>%</small></b>
      </div>
      <p className="likes__say meta">Style shape match {sample}.</p>
      <ul className="likes__list" aria-label="Other close pros">
        {rest.map((x) => <ProRow key={x.pro.slug} x={x} pick={(pointer) => { setInstant(!pointer); setSel(x.pro.slug); }} />)}
      </ul>
      <VsSides q={q} pro={chosen.pro} />
    </Card>
  );
}

function ProRow({ x, pick }: { x: { pro: Pro; pct: number }; pick?: (pointer: boolean) => void }) {
  const body = (
    <>
      <span className="prorow__face" aria-hidden><ProFace pro={x.pro} className="prorow__img" /></span>
      <span className="prorow__name"><b>{x.pro.name}</b> <span className="meta">{x.pro.team}</span></span>
      <b className="num prorow__pct">{x.pct}%</b>
      <span className="prorow__bar" aria-hidden><i style={{ width: `${x.pct}%` }} /><em style={{ left: `${STRONG_MATCH}%` }} /></span>
    </>
  );
  return <li>{pick ? <button className="prorow" data-tip="Compare in the banner" onClick={(e) => pick(e.detail > 0)}>{body}</button> : <div className="prorow">{body}</div>}</li>;
}

/** Your six style scores and the pro's, on T and on CT: the twelve numbers the match is made from. */
function VsSides({ q, pro }: { q: Query; pro: Pro }) {
  const t = useCall("style", [q, { side: "T" }]).data;
  const ct = useCall("style", [q, { side: "CT" }]).data;
  if (!t || !ct) return null;
  const mine = (r: typeof t) => { const a = attrsOf(r.scores); return styleIds().map((id) => a.find((x) => x.id === id)?.score ?? null); };
  const [yt, yct, pt, pct] = [mine(t), mine(ct), styleOf(pro.t), styleOf(pro.ct)];
  const n = (v: number | null) => (v === null ? "–" : Math.round(v));
  const labels = attrsOf(t.scores);
  return (
    <table className="tbl vs2">
      <caption className="sr-only">Your style scores against bots and {pro.name}'s against pros, per side</caption>
      <thead>
        <tr><th className="l" /><th colSpan={2}><span className="th t-text">T</span></th><th colSpan={2}><span className="th ct-text">CT</span></th></tr>
        <tr><th className="l"><span className="th">Attribute</span></th><th><span className="th">You</span></th><th><span className="th">{pro.name}</span></th><th><span className="th">You</span></th><th><span className="th">{pro.name}</span></th></tr>
      </thead>
      <tbody>
        {styleIds().map((id, i) => (
          <tr key={id}>
            <td className="l"><span className="vs2__l"><AttrIcon id={id as AttributeId} size={13} />{labels.find((a) => a.id === id)?.label ?? id}</span></td>
            <td className="num">{n(yt[i])}</td><td className="num vs2__pro">{n(pt[i])}</td>
            <td className="num">{n(yct[i])}</td><td className="num vs2__pro">{n(pct[i])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
