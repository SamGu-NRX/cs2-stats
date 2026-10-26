// Aim panels, shared by a match's Aim tab and Career aim. Every number is an aim metric or an aim
// measure over a summary the worker rolled up, narrowed by side and weapon class.
// - The stat strip: accuracy as a ring in the lead, then the headline aim metrics, each with its
//   percentile against the pros of your role (compare), shown for all guns only: pros are pooled over
//   every gun.
// - Spray: one gun with a pro path at a time, your mean view path with its spread against the pros'
//   and where the target's head was (SprayPath), then distance from the pros and from the target.
// - Where you hit: gun hits on the agent figure by hit group, then the hitting figures: head accuracy,
//   headshot kills, accuracy at visible enemies and adjusted, wallbang and smoke kills.
// - Counter-strafing: first shots by how you stopped; flicks and spray: the finer aim metrics.
//   Headshot kills and counter-strafing carry verdict colours; spray path vs pros does not, because
//   the engine defines it as a comparison, not a grade.
// - Guns: on a match, accuracy by gun; on Career aim, every gun as Weapons judges it.
// - Time to damage, reaction, first shot and crosshair placement need view angles and mesh line of
//   sight; their distributions draw only for matches with mesh visibility, and otherwise the card
//   says why for each match file.
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ACCURATE_FRAC, SIGHT_CONE_DEG } from "../../../stats/aim-geometry";
import { RECOIL } from "../../../stats/aim-ref";
import type { SideKey as PoolSide } from "../../../stats/compare";
import { HIT_GROUPS } from "../../../stats/facts";
import type { Side } from "../../../stats/tables";
import { weaponClass, weaponLabel } from "../../../stats/weapons";
import type { CompareResult, Query, Rolled } from "../../../worker/protocol";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { binSamples, Histogram } from "../../components/charts";
import { rovingIndex, Segmented } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { HitFigure } from "../../components/HitFigure";
import { ApproxMark, percentilePhrase } from "../../components/Percentile";
import { MIN_SPRAYS, SprayDistance, SprayOnTarget, SprayPath, type PlayerPath } from "../../components/SprayPath";
import { StatStrip, type StripItem } from "../../components/StatStrip";
import { fmtMetric, WEAPON_CLASS_LABEL } from "../../data/engine";
import { useCall, useScoped } from "../../data/hooks";
import type { MatchEntry } from "../../data/match";
import { metric, metrics } from "../../data/meta";
import { useData } from "../../data/provider";
import { tipOf } from "../../data/tips";
import { AimIcon } from "../../icons/ui";
import { fmtDeg, fmtInt, fmtPct, fmtRatio, plural } from "../../lib/format";
import { scoreText, toScore } from "../../lib/scale";
import { BENCH, verdictOf } from "../../lib/verdict";
import { Hint } from "../match/glyphs";
import { Empty, NeedsDemo } from "../shared";
import { bestAndWorst, ClassIcon, EDGE_TIP, edgeText, edgeTip, GunCell, GunHero, GunIcon, HEAD_TIP, type Judged, MIN_SHOTS, PROF_TIP, SplitCell, useGuns } from "./guns";

type SideFilter = "all" | "t" | "ct";
const GUN_CLASSES = ["rifle", "sniper", "smg", "heavy", "pistol"] as const;
type ClassFilter = "all" | (typeof GUN_CLASSES)[number];
const isGun = (w: string) => (GUN_CLASSES as readonly string[]).includes(weaponClass(w));

const sidesFor = (s: SideFilter): { sides?: Side[] } => (s === "all" ? {} : { sides: [s === "t" ? "T" : "CT"] });
const poolSide = (s: SideFilter): PoolSide => (s === "all" ? "both" : s === "t" ? "T" : "CT");
const value = (id: string, s: Rolled | null) => (s ? s.v[id] : null);
const text = (id: string, s: Rolled | null) => fmtMetric(id, value(id, s));
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

/** Metrics that need view angles and mesh line of sight: without visibility they have no value. */
const SIGHT = new Set(["firstBulletAccuracy", "sightAccuracy", "timeToDamage", "timeToKill", "reactionTime", "timeToShot", "crosshairPlacement", "crosshairMoved", "preAim", "flickOvershoot", "microCorrections", "trackingError", "shotError"]);

/**
 * The stat strip after the accuracy ring, in reading order. shotError and movingSpray are metrics-v2
 * ids: drawn once the engine has them. Accuracy at visible enemies sits with the hitting figures, beside
 * adjusted accuracy and the Validating chip they share.
 */
const STRIP = ["firstBulletAccuracy", "timeToKill", "timeToDamage", "crosshairPlacement", "crosshairMoved", "preAim", "counterStrafe", "shotError", "movingSpray"];
const FINER = ["flickOvershoot", "microCorrections", "trackingError", "sprayDeviation", "sprayPull"];
const TRANSFERS = ["sprayTransfers", "transferHits"];

export function AimPanels({ query, label, visibility, guns, statuses = [] }: {
  query: Query;
  label: string;
  /** some match in scope has mesh visibility */
  visibility: boolean;
  /** each match's visibility status (MatchInfo.visibility), which says why the timings are gated; omitted, the gate gives no reason */
  statuses?: readonly string[];
  /** Career aim: every career match, recorded or not, for the per-gun table as Weapons builds it */
  guns?: MatchEntry[];
}) {
  const { baselines } = useData();
  const [side, setSide] = useState<SideFilter>("all");
  const [cls, setCls] = useState<ClassFilter>("all");
  const base = useScoped(query, [sidesFor(side)])?.[0] ?? null;
  const fired = useMemo(() => Object.keys(base?.weapons ?? {}).filter(isGun), [base]);
  const inClass = cls === "all" ? fired : fired.filter((w) => weaponClass(w) === cls);
  const s = useScoped(query, [{ ...sidesFor(side), ...(cls === "all" ? {} : { weapons: inClass }) }])?.[0] ?? null;
  // pros are pooled over every gun, so a class's numbers are not ranked against them
  const r = useCall("compare", baselines && cls === "all" ? [query, { side: poolSide(side) }] : null).data;
  const classes = GUN_CLASSES.filter((c) => fired.some((w) => weaponClass(w) === c));
  const kills = inClass.reduce((t, w) => t + (base?.weapons[w].kills ?? 0), 0);
  const rank = cls === "all" ? r ?? null : null;
  return (
    <div className="aimp">
      <div className="toolbar">
        <Segmented label="Side" value={side} onChange={setSide} options={[{ value: "all", label: "Both sides" }, { value: "t", label: "T", side: "t" }, { value: "ct", label: "CT", side: "ct" }]} />
        <Segmented label="Weapon class" value={cls} onChange={setCls} options={[{ value: "all" as ClassFilter, label: "All guns" }, ...GUN_CLASSES.map((c) => ({ value: c as ClassFilter, label: WEAPON_CLASS_LABEL[c], disabled: !classes.includes(c) }))]} />
        <span className="toolbar__end meta">{plural(s?.aim.shots ?? 0, "shot")}, {plural(s?.aim.hits ?? 0, "hit")}, {plural(kills, "kill")}, {label}</span>
      </div>
      <StatStrip label="Aim" lead={<AccuracyRing s={s} r={rank} />} items={stripItems(STRIP, s, rank, visibility)} />
      {!visibility && <p className="aimp__needs meta"><NeedsDemo detail="Dashed stats need view angles and mesh line of sight." /></p>}
      <div className="aim-body">
        <SprayCard s={s} query={query} side={side} guns={inClass} />
        <HitsCard s={s} r={rank} visibility={visibility} />
        <StrafeCard s={s} />
        <FinerCard s={s} r={rank} visibility={visibility} />
      </div>
      {guns ? <CareerGuns list={guns} side={side} /> : fired.length > 0 && base && <GunTable query={query} side={side} guns={fired} base={base} />}
      <TimingsCard s={s} visibility={visibility} statuses={statuses} />
    </div>
  );
}

// ---------------------------------------------------------------- strip

const population = (r: CompareResult) => (r.role === "awper" ? "pro AWPers" : "pro riflers");

/** What a metric's cell says beside its value: its percentile, the coverage it rests on, or why it has no value. */
function standing(id: string, s: Rolled | null, r: CompareResult | null, visibility: boolean) {
  const v = value(id, s);
  const p = r?.p[id] ?? null;
  const unavailable = s && v === null ? (!visibility && SIGHT.has(id) ? "Needs line of sight" : "Not measured here") : undefined;
  const coverage = p?.reason?.startsWith("Not compared: ") ? p.reason.slice("Not compared: ".length) : undefined;
  return { v, pct: p && !p.reason ? p.pct : null, unavailable, coverage };
}

function stripItems(ids: string[], s: Rolled | null, r: CompareResult | null, visibility: boolean): StripItem[] {
  const known = new Set(metrics().map((m) => m.id));
  return ids.filter((id) => known.has(id)).map((id) => {
    const m = metric(id);
    const st = standing(id, s, r, visibility);
    return {
      id, label: m.label, value: s ? fmtMetric(id, st.v) : null, pct: st.pct, kind: m.kind === "performance" ? "performance" : "style",
      population: r ? population(r) : "", unavailable: st.unavailable, coverage: st.coverage, approx: m.status === "approx", def: tipOf(id),
    };
  });
}

/** The ring's circumference: radius 21 in a 52 px box. */
const RING_R = 21;
const RING_LEN = 2 * Math.PI * RING_R;
const VERDICT_WORD = { good: "Good", avg: "Average", poor: "Poor" } as const;

/** The strip's lead: accuracy as a ring that fills at 50%, coloured by the accuracy verdict (BENCH.acc), with its percentile. */
function AccuracyRing({ s, r }: { s: Rolled | null; r: CompareResult | null }) {
  const acc = value("accuracy", s);
  const v = verdictOf(acc, BENCH.acc);
  const stroke = v === "good" ? "var(--good)" : v === "poor" ? "var(--poor)" : "var(--avg)";
  const p = r?.p.accuracy ?? null;
  return (
    <div className="strip__item strip__lead">
      <svg width="52" height="52" viewBox="0 0 52 52" className="ring" aria-hidden>
        <circle cx="26" cy="26" r={RING_R} fill="none" stroke="var(--track)" strokeWidth="5" />
        {acc !== null && <circle cx="26" cy="26" r={RING_R} fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round" strokeDasharray={RING_LEN} strokeDashoffset={RING_LEN * (1 - Math.min(1, acc / 50))} transform="rotate(-90 26 26)" />}
      </svg>
      <div className="strip__leadtext">
        <dt className="caps" data-tip="Gun shots that hit an enemy, the ring full at 50%." tabIndex={0}>Accuracy</dt>
        <dd className="strip__val num">{text("accuracy", s)}{v === "na" ? null : <span className="sr-only">, {VERDICT_WORD[v]}</span>}</dd>
        <dd className="strip__ph">{p && !p.reason && p.pct !== null && r ? <><b>{percentilePhrase(p.pct, "performance")}</b> of {population(r)}</> : ""}</dd>
      </div>
    </div>
  );
}

/** A metric's row in the card lists: its label, its percentile or why it has none, and its value. */
function MetricRow({ id, s, r, visibility, label, chip }: { id: string; s: Rolled | null; r: CompareResult | null; visibility: boolean; label?: string; chip?: ReactNode }) {
  const m = metric(id);
  const st = standing(id, s, r, visibility);
  const phrase = st.unavailable ?? st.coverage ?? (m.kind !== "performance" ? "Style, not ranked" : st.pct === null || !r ? "" : <><b>{percentilePhrase(st.pct, "performance")}</b> of {population(r)}</>);
  return (
    <li className="amrow" data-id={id}>
      <MetricLabel id={id} label={label} chip={chip} />
      <span className="amrow__ph">{phrase}</span>
      <b className="num"><Num v={text(id, s)} /></b>
    </li>
  );
}

/** A row for a count or share that is not an engine metric: label with its tooltip, an optional note, the value. */
function PlainRow({ label, tip, value: v, note, color }: { label: string; tip: string; value: string; note?: ReactNode; color?: string }) {
  return (
    <li className="amrow">
      <span className="amrow__l"><span data-tip={tip} tabIndex={0}>{label}</span></span>
      <span className="amrow__ph">{note}</span>
      <b className="num" style={color ? { color } : undefined}><Num v={v} /></b>
    </li>
  );
}

/** A count the source may not record: "–" when no row in the summary recorded it. */
const knownCount = (n: number, known: number) => (known > 0 ? String(n) : "–");

/** Enemy kills and headshot kills with guns, summed over the summary's weapons (the per-gun table's HS kills, pooled). */
function gunKills(s: Rolled | null): { kills: number; hsKills: number } {
  const out = { kills: 0, hsKills: 0 };
  for (const [w, t] of Object.entries(s?.weapons ?? {})) if (isGun(w)) { out.kills += t.kills; out.hsKills += t.hsKills; }
  return out;
}

// ---------------------------------------------------------------- spray

/** Below this many sprays a gun's pattern is still noisy: its row fades and its tooltip says so. */
const THIN_SPRAY = 30;

interface SprayGun {
  w: string;
  /** the view path to draw: absolute view angles when there are any, else the target-relative path (plugin files); null without per-bullet angles */
  path: PlayerPath | null;
  relative: boolean;
  /** every spray of three or more bullets with this gun (AimAgg.sprays) */
  sprays: number;
  /** each spray's mean distance from bullet 1's target, in degrees (AimAgg.sprayDist); empty without a tracked target */
  dist: number[];
  /** the gun's own summary, for its spread, head and on-target sums */
  own: Rolled;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Every gun with at least one spray of three or more bullets, most sprayed first, each read from its
 * own rollup (`per[i]` is gun `guns[i]` alone). A gun without per-bullet angles (plugin files) still
 * lists, with its spray count and its distance from the target.
 */
export function sprayGuns(guns: string[], per: Rolled[] | null): SprayGun[] {
  if (!per || per.length !== guns.length) return [];
  return guns.flatMap((w, i) => {
    const a = per[i].aim;
    if (!a.sprays) return [];
    const abs = a.path[w], rel = a.relPath[w];
    const path = abs?.n.length ? abs : rel?.n.length ? rel : null;
    return [{ w, path, relative: !abs?.n.length && !!path, sprays: a.sprays, dist: a.sprayDist, own: per[i] }];
  }).sort((x, y) => y.sprays - x.sprays);
}

const thinTip = (n: number) => `${plural(n, "spray")}, the pattern settles at ${THIN_SPRAY}.`;

function SprayCard({ s, query, side, guns }: { s: Rolled | null; query: Query; side: SideFilter; guns: string[] }) {
  const per = useScoped(query, guns.map((w) => ({ ...sidesFor(side), weapons: [w] })));
  const list = useMemo(() => sprayGuns(guns, per), [guns, per]);
  const [pick, setPick] = useState<string | null>(null);
  const [showSpread, setShowSpread] = useState(true);
  const [showPro, setShowPro] = useState(true);
  const group = useRef<HTMLDivElement>(null);
  const cur = list.find((x) => x.w === pick) ?? list[0];
  if (!s || !per) return <Card className="aim-spray" title="Spray"><div className="skel" style={{ height: 320 }} /></Card>;
  if (!cur) return <Card className="aim-spray" title="Spray"><Empty icon={<AimIcon size={32} />} text="No sprays of three bullets or more." /></Card>;
  // one tab stop, the picked gun; arrows pick and move focus, as Segmented does
  const onKey = (e: KeyboardEvent) => {
    const to = rovingIndex(e.key, list.findIndex((x) => x.w === cur.w), list.length, true);
    if (to === null) return;
    e.preventDefault();
    setPick(list[to].w);
    group.current?.querySelector<HTMLElement>(`[data-w="${CSS.escape(list[to].w)}"]`)?.focus();
  };
  const name = weaponLabel(cur.w);
  const ref = RECOIL[cur.w]?.path.length ? RECOIL[cur.w] : null;
  const a = cur.own.aim;
  const spread = showSpread && !cur.relative ? a.spread[cur.w] ?? null : null;
  const heads = cur.relative ? null : a.heads[cur.w] ?? null;
  const onTarget = a.onTarget[cur.w] ?? null;
  const dist = mean(cur.dist);
  // a chart needs your path or a pro path to draw; a plugin gun without angles shows its distance alone
  const chart = cur.path !== null || (ref !== null && !cur.relative);
  return (
    <Card className="aim-spray" title={<>Spray<Hint tip="Your average view path from bullet 1, against pros'." /></>} aside={
      <span className="meta spray-aside">{plural(cur.sprays, "spray")}{cur.sprays < THIN_SPRAY ? <span className="chip chip--outline" data-tip={thinTip(cur.sprays)} tabIndex={0}>Few sprays</span> : null}</span>
    }>
      <div className="sprayc">
        <div ref={group} className="gunlist" role="radiogroup" aria-label="Gun" onKeyDown={onKey}>
          {list.map((x) => {
            const thin = x.sprays < THIN_SPRAY;
            return (
              <button key={x.w} data-w={x.w} role="radio" aria-checked={x.w === cur.w} tabIndex={x.w === cur.w ? 0 : -1} className="gunlist__b" data-thin={thin || undefined}
                data-tip={thin ? thinTip(x.sprays) : undefined} onClick={() => setPick(x.w)}>
                <GunIcon weapon={x.w} height={13} />
                <span className="gunlist__n">{weaponLabel(x.w)} <span className="gunlist__c num">{x.sprays}</span></span>
                <span className="sr-only">, {plural(x.sprays, "spray")}{thin ? `, the pattern settles at ${THIN_SPRAY}` : ""}</span>
              </button>
            );
          })}
        </div>
        <div className="sprayc__fig">
          {chart && !cur.relative && (
            <div className="spray-toggles">
              <label className="check"><input type="checkbox" checked={showSpread} onChange={(e) => setShowSpread(e.target.checked)} /><span>Spread bands</span></label>
              {ref && <label className="check"><input type="checkbox" checked={showPro} onChange={(e) => setShowPro(e.target.checked)} /><span>Pro path</span></label>}
            </div>
          )}
          {chart && <SprayPath gun={name} reference={ref} path={cur.path} relative={cur.relative} pro={showPro} spread={spread} heads={heads} />}
          {chart && (
            <div className="legend spray-key" aria-hidden>
              <span><svg width="16" height="8"><line x1="0" x2="16" y1="4" y2="4" stroke="var(--cream)" strokeWidth="2" /></svg>You</span>
              {spread && <span><svg width="14" height="10"><ellipse cx="7" cy="5" rx="6" ry="4" className="spray__sd" /></svg>Your spread, one standard deviation</span>}
              {ref && !cur.relative && showPro && <span><svg width="16" height="8"><line x1="0" x2="16" y1="4" y2="4" stroke="var(--ink2)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>Pro median</span>}
              {ref && !cur.relative && showPro && <span><svg width="12" height="10"><rect width="12" height="10" rx="2" fill="rgba(163, 167, 164, 0.16)" /></svg>Pros' middle half</span>}
              {heads && <span><svg width="10" height="10"><circle cx="5" cy="5" r="2.5" className="spray__head" /></svg>Where the target's head was</span>}
              {cur.path && cur.path.n.some((n) => n < MIN_SPRAYS) ? <span className="faint">Faded: under {MIN_SPRAYS} sprays</span> : null}
            </div>
          )}
          <p className="spray__dist">
            <span className="caps" data-tip="Mean angle from your target across a spray's bullets." tabIndex={0}>Distance from target</span>
            {dist === null ? <span className="meta">No tracked target in these sprays</span> : <><b className="num">{fmtDeg(dist, 2)}</b><span className="meta">mean over {plural(cur.dist.length, "spray")}</span></>}
          </p>
          {ref && cur.path && !cur.relative ? <SprayDistance reference={ref} path={cur.path} /> : null}
          {onTarget ? <SprayOnTarget sums={onTarget} /> : null}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- hits

const PART_LABEL: Record<(typeof HIT_GROUPS)[number], string> = {
  head: "Head", neck: "Neck", chest: "Chest", stomach: "Stomach", left_arm: "Left arm", right_arm: "Right arm", left_leg: "Left leg", right_leg: "Right leg",
};

/** The visibility measures have not passed the aim acceptance test; the chip says so where they have values. */
const VALIDATING_TIP = "Line of sight not yet checked against scripted test demos.";

function HitsCard({ s, r, visibility }: { s: Rolled | null; r: CompareResult | null; visibility: boolean }) {
  // gun hits by body part, HIT_GROUPS order, summed over the guns in the summary
  const counts = HIT_GROUPS.map((_, g) => Object.entries(s?.weapons ?? {}).reduce((t, [w, x]) => t + (isGun(w) ? x.groups[g] : 0), 0));
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <Card className="aim-hits" title="Where you hit" aside={total ? <span className="meta">{plural(total, "hit")}</span> : undefined}>
      {!s ? <div className="skel" style={{ height: 270 }} /> : !total ? <Empty icon={<AimIcon size={32} />} text="No gun hits recorded." /> : (
        <div className="bodymap-wrap">
          <HitFigure groups={counts} width={112} />
          <ul className="bodymap-list">
            {HIT_GROUPS.map((g, i) => (g === "neck" && !counts[i] ? null : (
              <li key={g}><span>{PART_LABEL[g]}</span><span className="hbar"><i style={{ width: `${(100 * counts[i]) / total}%`, background: "var(--cream)" }} /></span><b className="num"><Num v={fmtPct((100 * counts[i]) / total, 0)} /></b><span className="faint num">{counts[i]}</span></li>
            )))}
          </ul>
        </div>
      )}
      {s && <HittingList s={s} r={r} visibility={visibility} />}
    </Card>
  );
}

/** Main's Hitting group: head accuracy and headshot kills, then the visibility measures and the kill flags. */
function HittingList({ s, r, visibility }: { s: Rolled; r: CompareResult | null; visibility: boolean }) {
  const gk = gunKills(s);
  const a = s.aim;
  const validating = visibility ? <span className="chip chip--outline amrow__chip" tabIndex={0} data-tip={VALIDATING_TIP}>Validating</span> : null;
  return (
    <ul className="amlist hitting">
      <MetricRow id="headAccuracy" s={s} r={r} visibility={visibility} />
      <PlainRow label="Headshot kills" tip="Gun kills that were headshots." value={fmtRatio(gk.hsKills, gk.kills)} note={gk.kills ? plural(gk.kills, "gun kill") : undefined}
        color={gk.kills ? scoreText(toScore((100 * gk.hsKills) / gk.kills, 45, 25)) : undefined} />
      <MetricRow id="sightAccuracy" s={s} r={r} visibility={visibility} chip={validating} />
      <MetricRow id="adjustedAccuracy" s={s} r={r} visibility={visibility} chip={validating} />
      <PlainRow label="Wallbang kills" tip="Gun kills through a wall or object, where the file records it." value={knownCount(a.killsWb, a.killsWbKnown)} />
      <PlainRow label="Smoke kills" tip="Gun kills through smoke, where the file records it." value={knownCount(a.killsSmoke, a.killsSmokeKnown)} />
      <MetricRow id="shotsThroughSmoke" s={s} r={r} visibility={visibility} />
    </ul>
  );
}

// ---------------------------------------------------------------- counter-strafing and the finer metrics

/** A metric's label with its tooltip and approx mark. */
function MetricLabel({ id, label, chip }: { id: string; label?: string; chip?: ReactNode }) {
  const m = metric(id);
  return <span className="amrow__l"><span data-tip={tipOf(id)} tabIndex={0}>{label ?? m.label}{m.status === "approx" ? <ApproxMark /> : null}</span>{chip}</span>;
}

function StrafeCard({ s }: { s: Rolled | null }) {
  // aim.cs: rifle and sniper first bullets on the ground as [accurate, still slowing, late reversal, no stop, too fast with the cause unknown]
  const cs = s?.aim.cs ?? [0, 0, 0, 0, 0];
  const total = cs.reduce((a, b) => a + b, 0);
  const fast = total - cs[0];
  const strafed = value("counterStrafe", s);
  const causes: { id: string | null; label?: string; n: number; tone: string }[] = [
    { id: "csTooEarly", n: cs[1], tone: "var(--tan)" },
    { id: "csLateReversal", n: cs[2], tone: "var(--ink2)" },
    { id: "csNoStop", n: cs[3], tone: "var(--ink3)" },
    { id: null, label: "Cause unknown", n: cs[4], tone: "var(--line2)" },
  ];
  return (
    <Card className="aim-strafe" title={<>Counter-strafing<Hint tip={`Ground first bullets at or under ${Math.round(ACCURATE_FRAC * 100)}% of the gun's top speed.`} /></>} aside={total ? <span className="meta">{plural(total, "first shot")}</span> : undefined}>
      {!s ? <div className="skel" style={{ height: 150 }} /> : !total ? <p className="meta">Not measured in these files.</p> : (
        <div className="strafe">
          <div className="strafe__bar" aria-hidden>
            <i style={{ flexGrow: cs[0], background: "var(--cream)" }} />
            {causes.map((c, i) => (c.n ? <i key={i} style={{ flexGrow: c.n, background: c.tone }} /> : null))}
          </div>
          <ul className="amlist">
            <li className="amrow amrow--lead"><i className="sw" style={{ background: "var(--cream)" }} /><MetricLabel id="counterStrafe" /><span className="amrow__n num">{cs[0]}</span><b className="num" style={strafed === null ? undefined : { color: scoreText(toScore(strafed, 60, 30)) }}><Num v={text("counterStrafe", s)} /></b></li>
            <li className="amrow amrow--lead"><i className="sw sw--none" /><span className="amrow__l">Too fast</span><span className="amrow__n num">{fast}</span><b className="num"><Num v={fmtRatio(fast, total)} /></b></li>
            {causes.map((c, i) => (
              <li key={i} className="amrow amrow--sub">
                <i className="sw" style={{ background: c.tone }} />
                {c.id ? <MetricLabel id={c.id} /> : <span className="amrow__l" data-tip="Too fast, without the speed history to say why." tabIndex={0}>{c.label}</span>}
                <span className="amrow__n num">{c.n}</span>
                <b className="num">{c.id ? <span data-tip="Of the too-fast shots with a known cause." tabIndex={0}><Num v={text(c.id, s)} /></span> : null}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function FinerCard({ s, r, visibility }: { s: Rolled | null; r: CompareResult | null; visibility: boolean }) {
  return (
    <Card className="aim-finer" title="Flicks and spray">
      {!s ? <div className="skel" style={{ height: 150 }} /> : (
        <ul className="amlist">
          {FINER.map((id) => <MetricRow key={id} id={id} s={s} r={r} visibility={visibility} />)}
          <MetricRow id="sprayAccuracy" s={s} r={r} visibility={visibility} label="Spray accuracy (bullet 4+)" />
          <PlainRow label="First bullets on target" tip="First bullets fired with a visible enemy near your crosshair." value={visibility ? String(s.aim.first) : "–"} />
          <PlainRow label="Spray bullets on target" tip={`Bullets 4 and later fired with a visible enemy within ${SIGHT_CONE_DEG}°.`} value={visibility ? String(s.aim.deep) : "–"} />
          {TRANSFERS.map((id) => <MetricRow key={id} id={id} s={s} r={r} visibility={visibility} />)}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- per gun: a match

interface GunRow { weapon: string; cls: string; shots: number; hits: number; kills: number; hsKills: number; rounds: number; s: Rolled | null }

const ACC_TIP = "Gun shots that hit an enemy, the bar full at 50%.";

const accBar = (v: number | null, t: string, color?: string) => (
  <span className="cellbar"><span className="hbar"><i style={{ width: `${Math.min(100, 2 * (v ?? 0))}%`, background: "var(--cream)" }} /></span><span style={color ? { color } : undefined}><Num v={t} /></span></span>
);

function GunTable({ query, side, guns, base }: { query: Query; side: SideFilter; guns: string[]; base: Rolled }) {
  const per = useScoped(query, guns.map((w) => ({ ...sidesFor(side), weapons: [w] })));
  const rows: GunRow[] = guns.map((w, i) => {
    const t = base.weapons[w];
    return { weapon: w, cls: weaponClass(w), shots: t.shots, hits: t.hits, kills: t.kills, hsKills: t.hsKills, rounds: t.rounds, s: per?.[i] ?? null };
  });
  const byClass = GUN_CLASSES.map((c) => ({ key: c, label: <span className="classcell"><ClassIcon cls={c} />{WEAPON_CLASS_LABEL[c]}</span>, rows: rows.filter((g) => g.cls === c && (g.shots || g.kills)) })).filter((g) => g.rows.length);
  return (
    <Card className="guntbl guntbl--match" title="Accuracy by gun" aside={<span className="meta">{plural(rows.filter((g) => g.shots).length, "gun")} fired</span>} flush>
      <DataTable<GunRow>
        label="Accuracy by gun"
        groups={byClass}
        rowKey={(g) => g.weapon}
        defaultSort={{ key: "shots", dir: "desc" }}
        columns={[
          { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <span className="guncell"><GunIcon weapon={g.weapon} />{weaponLabel(g.weapon)}</span>, width: 170 },
          { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
          { key: "acc", label: "Accuracy", sort: (g) => value("accuracy", g.s), render: (g) => accBar(value("accuracy", g.s), text("accuracy", g.s)), width: 130, tip: ACC_TIP },
          { key: "head", label: "Head share", sort: (g) => value("headAccuracy", g.s), render: (g) => <Num v={text("headAccuracy", g.s)} />, tip: HEAD_TIP },
          { key: "first", label: "First bullet", sort: (g) => value("firstBulletAccuracy", g.s), render: (g) => <Num v={text("firstBulletAccuracy", g.s)} />, tip: tipOf("firstBulletAccuracy") },
          { key: "kills", label: "Kills", sort: (g) => g.kills, render: (g) => g.kills },
          { key: "hsk", label: "HS kills", sort: (g) => pct(g.hsKills, g.kills), render: (g) => <Num v={fmtRatio(g.hsKills, g.kills)} />, tip: tipOf("hs") },
          { key: "rounds", label: "Rounds", tip: "Rounds you fired, hit or killed with it.", sort: (g) => g.rounds, render: (g) => g.rounds },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- per gun: a career

/** Every gun over every career match, as Weapons judges it, with the aim columns beside it. */
function CareerGuns({ list, side }: { list: MatchEntry[]; side: SideFilter }) {
  const guns = useGuns(list, sidesFor(side));
  if (!guns) return <div className="skel" style={{ height: 320 }} />;
  if (!guns.length) return null;
  const { best, worst } = bestAndWorst(guns);
  const byClass = GUN_CLASSES.map((c) => ({ key: c, label: <span className="classcell"><ClassIcon cls={c} />{WEAPON_CLASS_LABEL[c]}</span>, rows: guns.filter((g) => g.cls === c) })).filter((g) => g.rows.length);
  const recorded = list.filter((e) => e.hasAim).length;
  return (
    <>
      {best && (
        <div className="grid-2">
          <GunHero g={best} tone="best" />
          {worst && <GunHero g={worst} tone="worst" />}
        </div>
      )}
      <Card className="guntbl" title={<>Every gun<Hint tip={`Accuracy is judged from ${MIN_SHOTS} or more recorded shots.`} /></>} aside={<span className="meta">Kills from {plural(list.length, "match", "matches")}, shots from {recorded}</span>} flush>
        <DataTable<Judged>
          label="Every gun"
          groups={byClass}
          rowKey={(g) => g.weapon}
          defaultSort={{ key: "kills", dir: "desc" }}
          columns={[
            { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <GunCell g={g} />, width: 250 },
            { key: "kills", label: "Kills", sort: (g) => g.kills.n, render: (g) => <SplitCell s={g.kills} what="kills" /> },
            { key: "hsk", label: "HS kills", sort: (g) => pct(g.hsKills, g.kills.n), render: (g) => <Num v={fmtRatio(g.hsKills, g.kills.n)} />, tip: tipOf("hs") },
            { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
            { key: "acc", label: "Accuracy", colored: true, sort: (g) => g.acc, render: (g) => accBar(g.acc, fmtMetric("accuracy", g.acc), g.edge === null ? undefined : scoreText(toScore(g.edge, 0, 8))), width: 130, tip: "Coloured against your accuracy with your other guns." },
            { key: "first", label: "First bullet", sort: (g) => g.first, render: (g) => <Num v={fmtMetric("firstBulletAccuracy", g.first)} />, tip: tipOf("firstBulletAccuracy") },
            { key: "head", label: "Head share", sort: (g) => pct(g.head, g.hits), render: (g) => <Num v={fmtRatio(g.head, g.hits)} />, tip: HEAD_TIP },
            { key: "ttd", label: "Time to damage", sort: (g) => g.own.v.timeToDamage, render: (g) => <Num v={fmtMetric("timeToDamage", g.own.v.timeToDamage)} />, tip: tipOf("timeToDamage") },
            { key: "rounds", label: "Rounds used", sort: (g) => g.rounds.n, render: (g) => <SplitCell s={g.rounds} what="rounds" /> },
            { key: "prof", label: "Proficiency", tip: PROF_TIP, sort: (g) => g.prof?.proficiency ?? null, render: (g) => (g.prof ? <span className="profcell" data-tip={g.prof.evidence} tabIndex={0}><Num v={fmtInt(g.prof.proficiency)} /></span> : <Num v={fmtInt(null)} />) },
            {
              key: "edge", label: "Vs other guns", colored: true, sort: (g) => g.edge, tip: EDGE_TIP,
              render: (g) => (g.edge === null ? <span className="faint">–</span> : <span className="num" style={{ color: scoreText(toScore(g.edge, 0, 8)) }} data-tip={edgeTip(g)} tabIndex={0}>{edgeText(g.edge)}</span>),
            },
          ]}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- timings

/** The four sighting timings: the samples (seconds or degrees) and the engine's median metric. */
const TIMINGS: { id: string; label: string; samples: (s: Rolled) => number[]; unit: string; bench?: number }[] = [
  { id: "timeToDamage", label: "Time to damage", samples: (s) => s.aim.ttd.map((x) => 1000 * x), unit: " ms", bench: BENCH.ttd.good },
  { id: "reactionTime", label: "Reaction", samples: (s) => s.aim.react.map((x) => 1000 * x), unit: " ms", bench: BENCH.reaction.good },
  { id: "timeToShot", label: "Time to first shot", samples: (s) => s.aim.shot.map((x) => 1000 * x), unit: " ms" },
  { id: "crosshairPlacement", label: "Crosshair placement", samples: (s) => s.aim.place, unit: "°", bench: BENCH.xhair.good },
];

/** The visibility coverage meter: how much of your shooting the mesh visibility explains. */
function Coverage({ s }: { s: Rolled | null }) {
  const cov = s?.coverage ?? null;
  return (
    <div className="gated__meter" tabIndex={0} aria-label={`Visibility coverage ${cov === null ? "not measurable" : `${Math.round(100 * cov)}%`}`} data-tip="Share of your gun hits fired at a mesh-visible enemy.">
      <div className="gated__track"><i style={{ width: `${Math.min(100, 100 * (cov ?? 0))}%` }} /></div>
      <span className="meta">Visibility coverage {cov === null ? "not measurable here" : `${Math.round(100 * cov)}% of your hits`}</span>
    </div>
  );
}

/** The extractor keeps a map's mesh when it gives line of sight at this share of non-wallbang kills (extractor/SCHEMA-v1.md, "Mismatch guard"). */
const MESH_AGREEMENT = 90;

/**
 * Why the timings are gated: one line per match.visibility_status among the matches in scope
 * (statuses: one per match), each with a one-sentence tooltip, from the statuses the extractor and the
 * plugin adapter write. "ok" needs no line.
 */
export function gateReasons(statuses: readonly string[]): { text: string; tip: string }[] {
  const count = new Map<string, number>();
  for (const st of statuses) if (st !== "ok") count.set(st, (count.get(st) ?? 0) + 1);
  const one = statuses.length === 1;
  const lead = (n: number) => (one ? "This match file" : n === 1 ? "One match file" : `${n} match files`);
  return [...count].map(([st, n]) => {
    const has = one || n === 1 ? "has" : "have";
    switch (st) {
      case "no_mapdata": return { text: `${lead(n)} ${has} no map data`, tip: "Plugin recordings never carry it, nor do demos extracted without it." };
      case "no_mesh": return { text: `${lead(n)} ${has} no collision mesh`, tip: "The extractor has no collision mesh for the map." };
      case "mesh_mismatch": return { text: `${lead(n)} failed the mesh check`, tip: `The mesh saw under ${MESH_AGREEMENT}% of non-wallbang kills, so it was dropped.` };
      default: return { text: `${lead(n)} ${has} no line of sight`, tip: `Visibility status "${st}".` };
    }
  });
}

function TimingsCard({ s, visibility, statuses }: { s: Rolled | null; visibility: boolean; statuses: readonly string[] }) {
  if (visibility) {
    return (
      <Card title="When an enemy appears" aside={<span className="meta">{plural(s?.aim.sightings ?? 0, "sighting")}</span>}>
        <Coverage s={s} />
        <div className="grid-2" style={{ marginTop: 14 }}>
          {TIMINGS.map((t) => (
            <div key={t.id}>
              <div className="hist-title"><span className="caps" data-tip={tipOf(t.id)} tabIndex={0}>{t.label}</span></div>
              {s ? <Histogram h={binSamples(t.samples(s))} med={value(t.id, s)} unit={t.unit} bench={t.bench} benchLabel="good" lowerIsBetter /> : <div className="skel" style={{ height: 120 }} />}
            </div>
          ))}
        </div>
      </Card>
    );
  }
  return (
    <Card title={<>When an enemy appears<Hint tip={`Needs recorded demos whose map mesh sees ${MESH_AGREEMENT}% of kills.`} /></>} aside={<span className="chip chip--outline">Needs line of sight</span>}>
      <div className="gated">
        <ul className="gated__list">
          {TIMINGS.map((t) => <li key={t.id}><span className="caps" data-tip={tipOf(t.id)} tabIndex={0}>{t.label}</span><b className="num faint">–</b></li>)}
        </ul>
        <Coverage s={s} />
        <div className="gated__why">
          {gateReasons(statuses).map((g) => <p key={g.text} className="meta"><span className="gated__reason" data-tip={g.tip} tabIndex={0}>{g.text}</span></p>)}
          <NeedsDemo detail="Needs view angles and mesh line of sight to each enemy." />
        </div>
      </div>
    </Card>
  );
}
