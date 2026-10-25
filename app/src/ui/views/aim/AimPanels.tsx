// Aim panels, shared by a match's Aim tab and Career aim. Every number is an aim metric or an aim
// measure over a summary the worker rolled up, narrowed by side and weapon.
// - The hero shows accuracy as a ring over an agent backdrop, beside three groups (hitting, spray
//   and flicks, movement); each group opens inline to its finer stats.
// - Spray: pick a gun (the five most sprayed as buttons, every gun in a menu, thin samples marked),
//   see your mean view path against the pro path and a per-bullet chart.
// - Where you hit: gun hits by body part.
// - Accuracy by gun rolls up each gun on its own; head share and headshot kills come from its totals.
// - Time to damage, reaction, first shot and crosshair placement need view angles and mesh line of
//   sight; their distributions draw only for matches with mesh visibility, and the card shows the
//   visibility coverage either way.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { RECOIL } from "../../../stats/aim-ref";
import { HIT_GROUPS } from "../../../stats/facts";
import type { Side } from "../../../stats/tables";
import { weaponClass, weaponLabel } from "../../../stats/weapons";
import type { Query, Rolled } from "../../../worker/protocol";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { binSamples, Histogram, meanPath, SprayPattern, useWidth, type BodyShare, type ProPath, type SprayPath } from "../../components/charts";
import { rovingIndex, Segmented, Select } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { AgentImg } from "../../components/Agent";
import { fmtMetric, WEAPON_CLASS_LABEL } from "../../data/engine";
import { useScoped } from "../../data/hooks";
import { metric } from "../../data/meta";
import { WeaponClassIcon, WeaponIcon } from "../../icons/game";
import { AimIcon, ChevronIcon, HeadHitIcon, SprayIcon, StrafeIcon } from "../../icons/ui";
import { fmtPct, fmtRatio, plural } from "../../lib/format";
import { scoreFill, toScore } from "../../lib/scale";
import { BENCH, verdictOf } from "../../lib/verdict";
import { Empty, NeedsDemo } from "../shared";
import { BodyFigure } from "./BodyFigure";

type SideFilter = "all" | "t" | "ct";
const GUN_CLASSES = ["rifle", "sniper", "smg", "heavy", "pistol"] as const;
type ClassFilter = "all" | (typeof GUN_CLASSES)[number];
const isGun = (w: string) => (GUN_CLASSES as readonly string[]).includes(weaponClass(w));

const sidesFor = (s: SideFilter): { sides?: Side[] } => (s === "all" ? {} : { sides: [s === "t" ? "T" : "CT"] });
const value = (id: string, s: Rolled | null) => (s ? s.v[id] : null);
const text = (id: string, s: Rolled | null) => fmtMetric(id, value(id, s));
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

export function AimPanels({ query, label, visibility }: { query: Query; label: string; visibility: boolean }) {
  const [side, setSide] = useState<SideFilter>("all");
  const [cls, setCls] = useState<ClassFilter>("all");
  const base = useScoped(query, [sidesFor(side)])?.[0] ?? null;
  const guns = useMemo(() => Object.keys(base?.weapons ?? {}).filter(isGun), [base]);
  const inClass = cls === "all" ? guns : guns.filter((w) => weaponClass(w) === cls);
  const s = useScoped(query, [{ ...sidesFor(side), ...(cls === "all" ? {} : { weapons: inClass }) }])?.[0] ?? null;
  const classes = GUN_CLASSES.filter((c) => guns.some((w) => weaponClass(w) === c));
  const kills = inClass.reduce((t, w) => t + (base?.weapons[w].kills ?? 0), 0);
  return (
    <div className="aimp">
      <div className="toolbar">
        <Segmented label="Side" value={side} onChange={setSide} options={[{ value: "all", label: "Both sides" }, { value: "t", label: "T", side: "t" }, { value: "ct", label: "CT", side: "ct" }]} />
        <Segmented label="Weapon class" value={cls} onChange={setCls} options={[{ value: "all" as ClassFilter, label: "All guns" }, ...GUN_CLASSES.map((c) => ({ value: c as ClassFilter, label: WEAPON_CLASS_LABEL[c], disabled: !classes.includes(c) }))]} />
        <span className="toolbar__end meta">{plural(s?.aim.shots ?? 0, "shot")}, {plural(kills, "kill")}, {label}</span>
      </div>
      <AimHero s={s} side={side} visibility={visibility} />
      <div className="aim-grid">
        <SprayCard s={s} />
        <HitsCard s={s} />
      </div>
      {guns.length > 0 && base && <GunTable query={query} side={side} guns={guns} base={base} />}
      <TimingsCard s={s} visibility={visibility} />
    </div>
  );
}

// ---------------------------------------------------------------- hero

function Disclose({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(true);
  const id = useId();
  return (
    <div className="disclose">
      <button className="disclose__btn" aria-expanded={open} aria-controls={id} onClick={(e) => { setInstant(e.detail === 0); setOpen((o) => !o); }}>
        <span>{label}</span><ChevronIcon size={14} className="chev" />
      </button>
      <div id={id} className={`collapse ${instant ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
        <div className="collapse__in"><div className="disclose__body">{children}</div></div>
      </div>
    </div>
  );
}

function Fig({ id, s }: { id: string; s: Rolled | null }) {
  return (
    <div className="fig" data-tip={metric(id).def}>
      <b className="fig__v num"><Num v={text(id, s)} /></b>
      <span className="fig__l">{metric(id).label}</span>
    </div>
  );
}

function Row({ id, s }: { id: string; s: Rolled | null }) {
  return <div className="drow" data-tip={metric(id).def}><span>{metric(id).label}</span><b className="num"><Num v={text(id, s)} /></b></div>;
}

function AimHero({ s, side, visibility }: { s: Rolled | null; side: SideFilter; visibility: boolean }) {
  const acc = value("accuracy", s);
  const R = 62;
  const len = 2 * Math.PI * R;
  const v = verdictOf(acc, BENCH.acc);
  const ring = v === "good" ? "var(--good)" : v === "poor" ? "var(--poor)" : "var(--avg)";
  return (
    <section className="aimhero card" aria-label="Aim summary">
      <AgentImg side={side === "ct" ? "ct" : "t"} kind="ghost" className="aimhero__ghost" />
      <div className="aimhero__ring">
        <svg width="156" height="156" viewBox="0 0 156 156" aria-hidden>
          <circle cx="78" cy="78" r={R} fill="none" stroke="var(--track)" strokeWidth="9" />
          <circle cx="78" cy="78" r={R} fill="none" stroke={ring} strokeWidth="9" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - Math.min(1, (acc ?? 0) / 50))} transform="rotate(-90 78 78)" style={{ transition: "stroke var(--d-color) ease" }} />
        </svg>
        <div className="aimhero__ringin">
          <span className="verdict" data-v={v}>{v === "na" ? "" : v === "avg" ? "Average" : v === "good" ? "Good" : "Poor"}</span>
          <b className="num"><Num v={text("accuracy", s)} /></b>
          <span className="meta">accuracy</span>
        </div>
        <p className="aimhero__note meta">{plural(s?.aim.hits ?? 0, "hit")} from {plural(s?.aim.shots ?? 0, "shot")}. The ring fills at 50%.</p>
      </div>
      <div className="aimhero__groups">
        <div className="agroup">
          <div className="agroup__head"><HeadHitIcon size={18} /><b>Hitting</b></div>
          <div className="agroup__figs">
            <Fig id="firstBulletAccuracy" s={s} />
            <Fig id="sightAccuracy" s={s} />
          </div>
          <Disclose label="Spray transfers">
            <Row id="sprayTransfers" s={s} />
            <Row id="transferHits" s={s} />
          </Disclose>
        </div>
        <div className="agroup">
          <div className="agroup__head"><SprayIcon size={18} /><b>Spray and flicks</b></div>
          <div className="agroup__figs">
            <Fig id="sprayDeviation" s={s} />
            <Fig id="flickOvershoot" s={s} />
          </div>
          <Disclose label="Pull-down, corrections, tracking">
            <Row id="sprayPull" s={s} />
            <Row id="microCorrections" s={s} />
            <Row id="trackingError" s={s} />
          </Disclose>
        </div>
        <div className="agroup">
          <div className="agroup__head"><StrafeIcon size={18} /><b>Movement</b></div>
          <div className="agroup__figs">
            <Fig id="counterStrafe" s={s} />
          </div>
          <Disclose label="When the stop went wrong">
            <Row id="csTooEarly" s={s} />
            <Row id="csLateReversal" s={s} />
            <Row id="csNoStop" s={s} />
          </Disclose>
        </div>
        {!visibility && <p className="meta">Dashed stats: <NeedsDemo detail="They need view angles or mesh line of sight, which this match file does not carry." /></p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- spray

/** Sprays that reach bullet 4 below this many are marked thin in the gun menu. */
const THIN_SPRAY = 30;

function SprayCard({ s }: { s: Rolled | null }) {
  const path = s?.aim.path ?? {};
  // n[0] counts sprays reaching bullet 2 (every spray), n[2] those reaching bullet 4
  const weapons = useMemo(() => Object.entries(path)
    .map(([w, p]) => ({ w, n: p.n.reduce((t, x) => t + (x ?? 0), 0), bursts: p.n[0] ?? 0, deep: p.n[2] ?? 0 }))
    .filter((x) => x.n > 2).sort((x, y) => y.n - x.n), [path]);
  const [pick, setPick] = useState<string | null>(null);
  const w = pick && path[pick] ? pick : weapons[0]?.w ?? null;
  const [bands, setBands] = useState(true);
  const group = useRef<HTMLDivElement>(null);
  const top = weapons.slice(0, 5);
  const more = weapons.slice(5);
  const cur = weapons.find((x) => x.w === w);
  if (!w || !cur) {
    return <Card title="Spray"><Empty icon={<SprayIcon size={32} />} text="No sprays to show. A spray is three or more bullets in one burst, tracked through each shot's recoil index and ammo count, which these match files do not record." /></Card>;
  }
  const pro = RECOIL[w]?.path.length ? RECOIL[w].path : null;
  // a gun picked from the menu takes the fifth button's place
  const shown = top.some((x) => x.w === w) ? top : [...top.slice(0, 4), cur];
  // one tab stop, the picked gun; arrows pick and move focus, as Segmented does
  const onKey = (e: KeyboardEvent) => {
    const to = rovingIndex(e.key, shown.findIndex((x) => x.w === w), shown.length, true);
    if (to === null) return;
    e.preventDefault();
    setPick(shown[to].w);
    group.current?.querySelector<HTMLElement>(`[data-w="${CSS.escape(shown[to].w)}"]`)?.focus();
  };
  return (
    <Card title="Spray" aside={<span className="meta">{plural(cur.bursts, "spray")} {cur.deep < THIN_SPRAY ? <span className="chip chip--outline" data-tip={`Fewer than ${THIN_SPRAY} sprays reached bullet 4, so the pattern past the first bullets is noisy.`}>Few sprays</span> : null}</span>}>
      <div className="gunpick">
        <div ref={group} className="gunpick__btns" role="radiogroup" aria-label="Gun" onKeyDown={onKey}>
          {shown.map((x) => (
            <button key={x.w} data-w={x.w} role="radio" aria-checked={x.w === w} tabIndex={x.w === w ? 0 : -1} className="gunbtn" onClick={() => setPick(x.w)} data-tip={`${plural(x.bursts, "spray")}${x.deep < THIN_SPRAY ? ", few sprays" : ""}`}>
              <WeaponIcon name={x.w} size={13} label={undefined} />
              <span>{weaponLabel(x.w)}</span>
              {x.deep < THIN_SPRAY && <><i className="gunbtn__thin" aria-hidden /><span className="sr-only">, few sprays</span></>}
            </button>
          ))}
        </div>
        {more.length > 0 && (
          <Select label="More guns" prefix="More" value={more.some((x) => x.w === w) ? w : "_"} onChange={(v) => v !== "_" && setPick(v)}
            options={[{ value: "_", label: `${more.length} guns` }, ...more.map((x) => ({ value: x.w, label: `${weaponLabel(x.w)}${x.deep < THIN_SPRAY ? " (few sprays)" : ""}` }))]} />
        )}
        {pro && <label className="check gunpick__bands"><input type="checkbox" checked={bands} onChange={(e) => setBands(e.target.checked)} /><span>Pro path</span></label>}
      </div>
      <SprayBody path={path[w]} pro={pro} bands={bands} />
    </Card>
  );
}

function SprayBody({ path, pro, bands }: { path: SprayPath; pro: ProPath | null; bands: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>(420);
  // Beside the legend the chart gets the width less 230 px (the legend's 180 px minimum, the 20 px gap
  // and some air), down to 300 px; below that the legend drops under it and the chart takes the whole
  // width. The svg also caps itself at its container (.spray), keeping its square, before the width
  // is measured.
  const stacked = width - 230 < 300;
  const size = Math.min(480, stacked ? width : width - 230);
  return (
    <div className="spray-body" ref={ref}>
      <div className={`spray-main ${stacked ? "is-stacked" : ""}`}>
        <SprayPattern path={path} pro={pro} size={size} bands={bands} />
        <div className="legend spray-legend">
          <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="var(--cream)" /></svg>Your average view movement from the first bullet, bullet by bullet</span>
          {pro && bands && <span><svg width="14" height="10" aria-hidden><rect x="1" y="1" width="12" height="8" rx="2" fill="rgba(43,163,224,.07)" stroke="rgba(43,163,224,.4)" /></svg>The median pro path; boxes hold the middle half of pros</span>}
          <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="var(--bg1)" stroke="var(--cream)" strokeWidth="1.5" /></svg>Bullet 1; numbers mark every fifth bullet</span>
          {!pro && <span className="faint">There is no pro path for this gun in the recoil reference.</span>}
        </div>
      </div>
      {pro && <BulletControl path={path} pro={pro} />}
    </div>
  );
}

/**
 * Bullet by bullet, how far your mean view movement sat from the median pro compensation, and whether
 * it fell inside the middle half of pros for that bullet (both pitch and yaw). Display only: the
 * spray metrics themselves (sprayDeviation, sprayPull) are the engine's.
 */
function BulletControl({ path, pro }: { path: SprayPath; pro: ProPath }) {
  const [ref, w] = useWidth<HTMLDivElement>(600);
  const rows = meanPath(path).filter((p) => p.i > 0 && p.n >= 3 && p.i < pro.length && p.i < 20).map((p) => {
    const [pp, py, p25, p75, y25, y75] = pro[p.i];
    return { i: p.i, dev: Math.hypot(p.pitch - pp, p.yaw - py), inside: p.pitch >= p25 && p.pitch <= p75 && p.yaw >= y25 && p.yaw <= y75, n: p.n };
  });
  if (rows.length < 2) return <p className="meta">Not enough sprays to compare bullet by bullet.</p>;
  let held = 0;
  for (const r of rows) { if (r.i === held + 1 && r.inside) held = r.i; else break; }
  const max = Math.max(1, ...rows.map((r) => r.dev));
  const h = 130;
  const bw = Math.max(8, Math.min(40, (w - 24) / rows.length - 4));
  const Y = (d: number) => h - 18 - (d / max) * (h - 30);
  return (
    <div className="bctl" ref={ref}>
      <div className="bctl__head"><span className="caps">Bullet by bullet</span><b className="num">{held ? `Inside the pro range through bullet ${held + 1}` : "Outside the pro range from bullet 2"}</b></div>
      <svg width={w} height={h} role="img" aria-label={`Distance from the pro path by bullet: ${rows.map((r) => `${r.i + 1}: ${r.dev.toFixed(1)} degrees${r.inside ? ", inside" : ""}`).join(", ")}`}>
        {rows.map((r, j) => {
          const x = 12 + j * (bw + 4);
          const t = r.inside ? 0.6 : -toScore(r.dev, 0, max) * 0.8 - 0.2;
          return (
            <g key={r.i}>
              <rect x={x} y={Y(r.dev)} width={bw} height={Math.max(2, h - 18 - Y(r.dev))} rx="2" fill={scoreFill(t)} opacity={0.45 + 0.55 * Math.abs(t)}><title>{`Bullet ${r.i + 1}: ${r.dev.toFixed(2)}° from the pro median, ${r.inside ? "inside" : "outside"} the middle half of pros, ${r.n} sprays`}</title></rect>
              <text x={x + bw / 2} y={h - 4} textAnchor="middle" className="ax">{r.i + 1}</text>
            </g>
          );
        })}
      </svg>
      <p className="meta">Each bar is how far your average view movement for that bullet sat from the median pro's. Green bars fall inside the middle half of pros. Target movement changes the ideal path, so this compares with pros rather than grading you.</p>
    </div>
  );
}

// ---------------------------------------------------------------- hits

const BODY_PARTS: { id: keyof BodyShare; group: (typeof HIT_GROUPS)[number]; label: string }[] = [
  { id: "head", group: "head", label: "Head" }, { id: "neck", group: "neck", label: "Neck" }, { id: "chest", group: "chest", label: "Chest" }, { id: "stomach", group: "stomach", label: "Stomach" },
  { id: "leftArm", group: "left_arm", label: "Left arm" }, { id: "rightArm", group: "right_arm", label: "Right arm" }, { id: "leftLeg", group: "left_leg", label: "Left leg" }, { id: "rightLeg", group: "right_leg", label: "Right leg" },
];

function HitsCard({ s }: { s: Rolled | null }) {
  // gun hits by body part, HIT_GROUPS order, summed over the guns in the summary
  const counts = HIT_GROUPS.map((_, g) => Object.entries(s?.weapons ?? {}).reduce((t, [w, x]) => t + (isGun(w) ? x.groups[g] : 0), 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const count = (b: (typeof BODY_PARTS)[number]) => counts[HIT_GROUPS.indexOf(b.group)];
  return (
    <Card title="Where you hit" aside={total ? <span className="meta">{plural(total, "hit")}</span> : undefined}>
      {!s ? <div className="skel" style={{ height: 270 }} /> : !total ? <Empty icon={<AimIcon size={32} />} text="No gun hits recorded." /> : (() => {
        const share = Object.fromEntries(BODY_PARTS.map((b) => [b.id, count(b) / total])) as BodyShare;
        return (
          <div className="bodymap-wrap">
            <BodyFigure share={share} height={270} />
            <ul className="bodymap-list">
              {BODY_PARTS.filter((b) => b.id !== "neck" || share.neck > 0).map((b) => (
                <li key={b.id}><span>{b.label}</span><span className="hbar"><i style={{ width: `${share[b.id] * 100}%`, background: "var(--cream)" }} /></span><b className="num"><Num v={fmtPct(100 * share[b.id], 0)} /></b><span className="faint num">{count(b)}</span></li>
              ))}
            </ul>
          </div>
        );
      })()}
    </Card>
  );
}

// ---------------------------------------------------------------- per gun

interface GunRow { weapon: string; cls: string; shots: number; hits: number; head: number; kills: number; hsKills: number; rounds: number; s: Rolled | null }

function GunTable({ query, side, guns, base }: { query: Query; side: SideFilter; guns: string[]; base: Rolled }) {
  const per = useScoped(query, guns.map((w) => ({ ...sidesFor(side), weapons: [w] })));
  const rows: GunRow[] = guns.map((w, i) => {
    const t = base.weapons[w];
    return { weapon: w, cls: weaponClass(w), shots: t.shots, hits: t.hits, head: t.groups[0], kills: t.kills, hsKills: t.hsKills, rounds: t.rounds, s: per?.[i] ?? null };
  });
  const byClass = GUN_CLASSES.map((c) => ({ key: c, label: <span className="classcell"><WeaponClassIcon cls={c} size={12} />{WEAPON_CLASS_LABEL[c]}</span>, rows: rows.filter((g) => g.cls === c && (g.shots || g.kills)) })).filter((g) => g.rows.length);
  return (
    <Card title="Accuracy by gun" aside={<span className="meta">{plural(rows.filter((g) => g.shots).length, "gun")} fired</span>} flush>
      <DataTable<GunRow>
        label="Accuracy by gun"
        groups={byClass}
        rowKey={(g) => g.weapon}
        defaultSort={{ key: "shots", dir: "desc" }}
        columns={[
          { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <span className="guncell"><WeaponIcon name={g.weapon} size={12} label={undefined} />{weaponLabel(g.weapon)}</span>, width: 150 },
          { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
          { key: "acc", label: "Accuracy", sort: (g) => value("accuracy", g.s), render: (g) => <span className="cellbar"><span className="hbar"><i style={{ width: `${Math.min(100, 2 * (value("accuracy", g.s) ?? 0))}%`, background: "var(--cream)" }} /></span><Num v={text("accuracy", g.s)} /></span>, width: 130, tip: `${metric("accuracy").def} The bar fills at 50%.` },
          { key: "head", label: "Head share", sort: (g) => pct(g.head, g.hits), render: (g) => <Num v={fmtRatio(g.head, g.hits)} />, tip: "Share of your hits that landed on the head, not of your shots" },
          { key: "first", label: "First bullet", sort: (g) => value("firstBulletAccuracy", g.s), render: (g) => <Num v={text("firstBulletAccuracy", g.s)} />, tip: metric("firstBulletAccuracy").def },
          { key: "kills", label: "Kills", sort: (g) => g.kills, render: (g) => g.kills },
          { key: "hsk", label: "HS kills", sort: (g) => pct(g.hsKills, g.kills), render: (g) => <Num v={fmtRatio(g.hsKills, g.kills)} />, tip: "Share of your kills with the gun that were headshots" },
          { key: "rounds", label: "Rounds", tip: "Rounds in which you fired it, hit with it or killed with it", sort: (g) => g.rounds, render: (g) => g.rounds },
        ]}
      />
    </Card>
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
    <div className="gated__meter" aria-label={`Visibility coverage ${cov === null ? "not measurable" : `${Math.round(100 * cov)}%`}`} data-tip="Share of your gun hits fired while an enemy was mesh-visible near your view. Low coverage means the timings describe only part of your fights.">
      <div className="gated__track"><i style={{ width: `${Math.min(100, 100 * (cov ?? 0))}%` }} /></div>
      <span className="meta">Visibility coverage {cov === null ? "not measurable here" : `${Math.round(100 * cov)}% of your hits`}</span>
    </div>
  );
}

function TimingsCard({ s, visibility }: { s: Rolled | null; visibility: boolean }) {
  if (visibility) {
    return (
      <Card title="When an enemy appears" aside={<span className="meta">{plural(s?.aim.sightings ?? 0, "sighting")}</span>}>
        <Coverage s={s} />
        <div className="grid-2" style={{ marginTop: 14 }}>
          {TIMINGS.map((t) => (
            <div key={t.id} data-tip={metric(t.id).def}>
              <div className="hist-title"><span className="caps">{t.label}</span></div>
              {s ? <Histogram h={binSamples(t.samples(s))} med={value(t.id, s)} unit={t.unit} bench={t.bench} benchLabel="good" lowerIsBetter /> : <div className="skel" style={{ height: 120 }} />}
            </div>
          ))}
        </div>
      </Card>
    );
  }
  return (
    <Card title="When an enemy appears" aside={<span className="chip chip--outline">Waiting for line of sight</span>}>
      <div className="gated">
        <div className="gated__cards">
          {[
            { l: "Time to damage", d: "How long from an enemy appearing to your first damage on them.", eg: "milliseconds" },
            { l: "Reaction", d: "How long until your crosshair starts moving toward them.", eg: "milliseconds" },
            { l: "Crosshair placement", d: "How far your crosshair was from their head when they appeared.", eg: "degrees" },
          ].map((c) => (
            <div key={c.l} className="gated__card">
              <span className="caps">{c.l}</span>
              <b className="gated__eg">{c.eg}</b>
              <svg viewBox="0 0 160 36" width="100%" height="36" aria-hidden>
                {[4, 9, 15, 22, 18, 12, 8, 5, 3, 2].map((v, i) => <rect key={i} x={i * 16 + 2} y={34 - v} width="12" height={v} rx="2" fill="var(--line2)" />)}
              </svg>
              <p className="meta">{c.d}</p>
            </div>
          ))}
        </div>
        <div className="gated__why">
          <Coverage s={s} />
          <p><NeedsDemo detail="These need your view angles and mesh line of sight to each enemy. Plugin match files carry neither; the extractor computes visibility on the map's mesh for recorded demos." /></p>
        </div>
      </div>
    </Card>
  );
}
