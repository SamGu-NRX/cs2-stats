// Aim panels, shared by a match's Aim tab and Career aim.
// - The hero shows accuracy as a ring over an agent backdrop, beside three groups (hitting, spray
//   control, movement); each group opens inline to its finer stats.
// - Spray: pick a gun (the five most fired as buttons, every gun in a menu, thin samples marked),
//   see the pattern and a per-bullet control chart.
// - Time to damage, reaction and crosshair placement depend on the game's visibility signal, which
//   the engine found unreliable; they stay gated and the card shows what will appear and when.
import { useId, useMemo, useState, type ReactNode } from "react";
import { aimVisibility, engFor, GUN_CLASSES, shotsFor, sprayControl, type AimAgg, type ClassFilter, type ShotStats, type SideFilter, type SprayStep } from "../../../stats/aim";
import { weaponLabel } from "../../../stats/weapons";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { Histogram, SprayPattern, useWidth } from "../../components/charts";
import { Segmented, Select } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { AgentImg } from "../../components/Agent";
import { AIM_STATS, CLASS_LABEL } from "../../data/aimStats";
import { BODY_PARTS, type HitMap, type WeaponTally } from "../../data/interim";
import { WeaponClassIcon, WeaponIcon } from "../../icons/game";
import { AimIcon, ChevronIcon, HeadHitIcon, SprayIcon, StrafeIcon } from "../../icons/ui";
import { fmtDeg, fmtPct, fmtRatio, plural } from "../../lib/format";
import { scoreFill, scoreText, toScore } from "../../lib/scale";
import { BENCH, verdictOf } from "../../lib/verdict";
import { Empty } from "../shared";
import { BodyFigure } from "./BodyFigure";

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const stat = (id: string) => AIM_STATS.find((s) => s.id === id)!;
/** Bursts with fewer samples per bullet than this are marked thin in the gun menu. */
const THIN_SPRAY = 30;

export function AimPanels({ a, hits, guns, scope }: { a: AimAgg; hits: HitMap | null; guns: WeaponTally[] | null; scope: string }) {
  const [side, setSide] = useState<SideFilter>("all");
  const [cls, setCls] = useState<ClassFilter>("all");
  const s = shotsFor(a, side, cls);
  const classes = GUN_CLASSES.filter((c) => shotsFor(a, side, c).shots > 0);
  return (
    <div className="aimp">
      <div className="toolbar">
        <Segmented label="Side" value={side} onChange={setSide} options={[{ value: "all", label: "Both sides" }, { value: "t", label: "T", side: "t" }, { value: "ct", label: "CT", side: "ct" }]} />
        <Segmented label="Weapon class" value={cls} onChange={setCls} options={[{ value: "all" as ClassFilter, label: "All guns" }, ...GUN_CLASSES.map((c) => ({ value: c as ClassFilter, label: CLASS_LABEL[c], disabled: !classes.includes(c) }))]} />
        <span className="toolbar__end meta">{plural(s.shots, "shot")}, {plural(s.kills, "kill")}, {scope}</span>
      </div>
      <AimHero a={a} s={s} side={side} />
      <div className="aim-grid">
        <SprayCard a={a} />
        <Card title="Where you hit" aside={hits ? <span className="meta">{plural(hits.total, "hit")}</span> : undefined}>
          <HitsBody hits={hits} />
        </Card>
      </div>
      {guns && guns.length > 0 && <GunTable guns={guns} />}
      <TimingsCard a={a} side={side} />
      <p className="meta aim-next">Spray transfer, pre-aim, mouse control and time to first shot arrive with the metrics update.</p>
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

function Fig({ label, value, tip, verdict }: { label: string; value: string; tip: string; verdict?: number | null }) {
  return (
    <div className="fig" data-tip={tip}>
      <b className="fig__v num" style={verdict === undefined || verdict === null ? undefined : { color: scoreText(verdict) }}><Num v={value} /></b>
      <span className="fig__l">{label}</span>
    </div>
  );
}

function Row({ label, value, tip, chip }: { label: string; value: string; tip: string; chip?: ReactNode }) {
  return <div className="drow" data-tip={tip}><span>{label}{chip}</span><b className="num"><Num v={value} /></b></div>;
}

function AimHero({ a, s, side }: { a: AimAgg; s: ShotStats; side: SideFilter }) {
  const gate = aimVisibility(a);
  const acc = pct(s.hits, s.shots);
  const R = 62;
  const len = 2 * Math.PI * R;
  const v = verdictOf(acc, BENCH.acc);
  const ring = v === "good" ? "var(--good)" : v === "poor" ? "var(--poor)" : "var(--avg)";
  const control = sprayControl(s);
  const validating = !gate.validated ? <span className="chip chip--outline" data-tip={gate.reason}>Validating</span> : null;
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
          <b className="num"><Num v={fmtPct(acc)} /></b>
          <span className="meta">accuracy</span>
        </div>
        <p className="aimhero__note meta">{plural(s.hits, "hit")} from {plural(s.shots, "shot")}. The ring fills at 50%.</p>
      </div>
      <div className="aimhero__groups">
        <div className="agroup">
          <div className="agroup__head"><HeadHitIcon size={18} /><b>Hitting</b></div>
          <div className="agroup__figs">
            <Fig label="Head accuracy" value={stat("head").value(s)} tip={stat("head").tip} />
            <Fig label="Headshot kills" value={stat("hsk").value(s)} tip={stat("hsk").tip} verdict={s.kills ? toScore((100 * s.hsKills) / s.kills, 45, 25) : null} />
          </div>
          <Disclose label="Spotted, adjusted, wallbangs">
            <Row label="Spotted accuracy" value={stat("spotted").value(s)} tip={stat("spotted").tip} chip={validating} />
            <Row label="Adjusted accuracy" value={stat("adjusted").value(s)} tip={stat("adjusted").tip} chip={validating} />
            <Row label="Wallbang kills" value={stat("wbKills").value(s)} tip={stat("wbKills").tip} />
            <Row label="Smoke kills" value={stat("smokeKills").value(s)} tip={stat("smokeKills").tip} />
            <Row label="Shots through smoke" value={stat("smokeSpam").value(s)} tip={stat("smokeSpam").tip} />
          </Disclose>
        </div>
        <div className="agroup">
          <div className="agroup__head"><SprayIcon size={18} /><b>Control</b></div>
          <div className="agroup__figs">
            <Fig label="First bullet" value={stat("first").value(s)} tip={stat("first").tip} />
            <Fig label="Spray error" value={fmtDeg(control, 2)} tip={stat("control").tip} verdict={control === null ? null : toScore(control, 2.5, 1.5, true)} />
          </div>
          <Disclose label="Spray accuracy, by bullet">
            <Row label="Spray accuracy (bullet 4+)" value={stat("spray").value(s)} tip={stat("spray").tip} />
            <Row label="First bullets on target" value={String(s.firstOnTarget)} tip="First bullets fired with an enemy within 10° of your aim." />
            <Row label="Spray bullets on target" value={String(s.sprayOnTarget)} tip="Bullets 4 and later fired with an enemy within 10° of your aim." />
          </Disclose>
        </div>
        <div className="agroup">
          <div className="agroup__head"><StrafeIcon size={18} /><b>Movement</b></div>
          <div className="agroup__figs">
            <Fig label="Counter-strafed" value={stat("strafe").value(s)} tip={stat("strafe").tip} verdict={s.firstStrafeKnown ? toScore((100 * s.firstStrafed) / s.firstStrafeKnown, 60, 30) : null} />
          </div>
          <Disclose label="What counts as counter-strafed">
            <p className="meta disclose__p">A burst's first bullet counts when you fired at no more than 34% of the weapon's top speed, so your shot was accurate. {s.firstStrafeKnown} first bullets had a known speed; {s.firstStrafed} of them were counter-strafed.</p>
          </Disclose>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- spray

function SprayCard({ a }: { a: AimAgg }) {
  const weapons = useMemo(() => Object.entries(a.spray)
    .map(([w, st]) => ({ w, n: st.reduce((t, x) => t + x.n, 0), bursts: st[0]?.n ?? 0, deep: st[3]?.n ?? 0 }))
    .filter((x) => x.n > 2).sort((x, y) => y.n - x.n), [a]);
  const [pick, setPick] = useState<string | null>(null);
  const w = pick && a.spray[pick] ? pick : weapons[0]?.w ?? null;
  const [bands, setBands] = useState(true);
  const top = weapons.slice(0, 5);
  const more = weapons.slice(5);
  const cur = weapons.find((x) => x.w === w);
  if (!w || !cur) {
    return <Card title="Spray"><Empty icon={<SprayIcon size={32} />} text="No bursts with recorded impacts yet. Record a match with the capture plugin to see your spray." /></Card>;
  }
  return (
    <Card title="Spray" aside={<span className="meta">{plural(cur.bursts, "burst")} {cur.deep < THIN_SPRAY ? <span className="chip chip--outline" data-tip={`Fewer than ${THIN_SPRAY} bursts reached bullet 4, so the pattern past the first bullets is noisy.`}>Few sprays</span> : null}</span>}>
      <div className="gunpick">
        <div className="gunpick__btns" role="radiogroup" aria-label="Gun">
          {(top.some((x) => x.w === w) ? top : [...top.slice(0, 4), cur]).map((x) => (
            <button key={x.w} role="radio" aria-checked={x.w === w} className="gunbtn" onClick={() => setPick(x.w)} data-tip={`${plural(x.bursts, "burst")}${x.deep < THIN_SPRAY ? ", few sprays" : ""}`}>
              <WeaponIcon name={x.w} size={13} label={undefined} />
              <span>{weaponLabel(x.w)}</span>
              {x.deep < THIN_SPRAY && <i className="gunbtn__thin" aria-label="few sprays" />}
            </button>
          ))}
        </div>
        {more.length > 0 && (
          <Select label="More guns" prefix="More" value={more.some((x) => x.w === w) ? w : "_"} onChange={(v) => v !== "_" && setPick(v)}
            options={[{ value: "_", label: `${more.length} guns` }, ...more.map((x) => ({ value: x.w, label: `${weaponLabel(x.w)}${x.deep < THIN_SPRAY ? " (few sprays)" : ""}` }))]} />
        )}
        <label className="check gunpick__bands"><input type="checkbox" checked={bands} onChange={(e) => setBands(e.target.checked)} /><span>Spread bands</span></label>
      </div>
      <SprayBody steps={a.spray[w]} bands={bands} />
    </Card>
  );
}

function SprayBody({ steps, bands }: { steps: SprayStep[]; bands: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>(420);
  const size = Math.max(300, Math.min(480, width - 230));
  return (
    <div className="spray-body" ref={ref}>
      <div className="spray-main">
        <SprayPattern steps={steps} size={size} bands={bands} />
        <div className="legend spray-legend">
          <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="var(--cream)" /></svg>Your average impact, bullet by bullet</span>
          {bands && <span><svg width="14" height="10" aria-hidden><ellipse cx="7" cy="5" rx="6" ry="4" fill="rgba(255,215,173,.14)" stroke="rgba(255,215,173,.55)" /></svg>That bullet's spread, one standard deviation each way</span>}
          <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="2.5" fill="var(--ct)" /></svg>Where the target's head was</span>
          <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="var(--bg1)" stroke="var(--cream)" strokeWidth="1.5" /></svg>Bullet 1; numbers mark every fifth bullet</span>
          <span className="faint">The ideal pattern for each gun arrives with the game's recoil tables.</span>
        </div>
      </div>
      <BulletControl steps={steps} />
    </div>
  );
}

/** Controlled when your average impact sits within this many degrees of the target. */
const CONTROL_DEG = 1.5;

function BulletControl({ steps }: { steps: SprayStep[] }) {
  const [ref, w] = useWidth<HTMLDivElement>(600);
  const rows = steps.map((st, i) => {
    if (st.n < 3 || !st.en) return { i, dev: null, n: st.n };
    const dx = -st.sy / st.n - -st.ey / st.en;
    const dy = st.sp / st.n - st.ep / st.en;
    return { i, dev: Math.hypot(dx, dy), n: st.n };
  }).filter((r) => r.dev !== null && r.i < 20) as { i: number; dev: number; n: number }[];
  if (rows.length < 2) return <p className="meta">Not enough bursts to judge bullet by bullet.</p>;
  let controlled = 0;
  for (const r of rows) { if (r.i === controlled && r.dev <= CONTROL_DEG) controlled++; else break; }
  const max = Math.max(CONTROL_DEG * 2, ...rows.map((r) => r.dev));
  const h = 130;
  const bw = Math.max(8, Math.min(40, (w - 24) / rows.length - 4));
  const Y = (d: number) => h - 18 - (d / max) * (h - 30);
  return (
    <div className="bctl" ref={ref}>
      <div className="bctl__head"><span className="caps">Bullet by bullet</span><b className="num">{controlled ? `Controlled through bullet ${controlled}` : "First bullet off target"}</b></div>
      <svg width={w} height={h} role="img" aria-label={`Distance from the target by bullet: ${rows.map((r) => `${r.i + 1}: ${r.dev.toFixed(1)} degrees`).join(", ")}`}>
        <line x1="0" x2={w} y1={Y(CONTROL_DEG)} y2={Y(CONTROL_DEG)} stroke="var(--ink3)" strokeDasharray="3 3" />
        <text x={w} y={Y(CONTROL_DEG) - 4} textAnchor="end" className="ax">{CONTROL_DEG}° on target</text>
        {rows.map((r, j) => {
          const x = 12 + j * (bw + 4);
          const t = toScore(r.dev, CONTROL_DEG, CONTROL_DEG, true);
          return (
            <g key={r.i}>
              <rect x={x} y={Y(r.dev)} width={bw} height={Math.max(2, h - 18 - Y(r.dev))} rx="2" fill={scoreFill(t)} opacity={0.45 + 0.55 * Math.abs(t)}><title>{`Bullet ${r.i + 1}: ${r.dev.toFixed(2)}° from the target, ${r.n} samples`}</title></rect>
              <text x={x + bw / 2} y={h - 4} textAnchor="middle" className="ax">{r.i + 1}</text>
            </g>
          );
        })}
      </svg>
      <p className="meta">Each bar is how far your average impact for that bullet landed from the target's head. Under the line counts as controlled.</p>
    </div>
  );
}

// ---------------------------------------------------------------- hits

function HitsBody({ hits }: { hits: HitMap | null }) {
  if (!hits || !hits.total) return <Empty icon={<AimIcon size={32} />} text={hits === null ? "Hits by body part load from the match files." : "No gun hits recorded."} />;
  const share = Object.fromEntries(BODY_PARTS.map((b) => [b.id, hits.counts[b.id] / hits.total])) as Record<(typeof BODY_PARTS)[number]["id"], number>;
  return (
    <div className="bodymap-wrap">
      <BodyFigure share={share} height={270} />
      <ul className="bodymap-list">
        {BODY_PARTS.filter((b) => b.id !== "neck" || share.neck > 0).map((b) => (
          <li key={b.id}><span>{b.label}</span><span className="hbar"><i style={{ width: `${share[b.id] * 100}%`, background: "var(--cream)" }} /></span><b className="num"><Num v={fmtPct(100 * share[b.id], 0)} /></b><span className="faint num">{hits.counts[b.id]}</span></li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- per gun

function GunTable({ guns }: { guns: WeaponTally[] }) {
  const byClass = GUN_CLASSES.map((c) => ({ key: c, label: <span className="classcell"><WeaponClassIcon cls={c} size={12} />{CLASS_LABEL[c]}</span>, rows: guns.filter((g) => g.cls === c && (g.shots || g.kills)) })).filter((g) => g.rows.length);
  return (
    <Card title="Accuracy by gun" aside={<span className="meta">{plural(guns.filter((g) => g.shots).length, "gun")} fired</span>} flush>
      <DataTable<WeaponTally>
        label="Accuracy by gun"
        groups={byClass}
        rowKey={(g) => g.weapon}
        defaultSort={{ key: "shots", dir: "desc" }}
        columns={[
          { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <span className="guncell"><WeaponIcon name={g.weapon} size={12} label={undefined} />{weaponLabel(g.weapon)}</span>, width: 190 },
          { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
          { key: "acc", label: "Accuracy", sort: (g) => pct(g.hits, g.shots), render: (g) => <span className="cellbar"><span className="hbar"><i style={{ width: `${Math.min(100, 2 * (pct(g.hits, g.shots) ?? 0))}%`, background: "var(--cream)" }} /></span><Num v={fmtRatio(g.hits, g.shots)} /></span>, width: 160, tip: "Hits divided by shots; the bar fills at 50%" },
          { key: "head", label: "Head share", sort: (g) => pct(g.headHits, g.hits), render: (g) => <Num v={fmtRatio(g.headHits, g.hits)} />, tip: "Share of your hits that landed on the head, not of your shots" },
          { key: "first", label: "First bullet", sort: (g) => pct(g.firstHits, g.firstOnTarget), render: (g) => <Num v={fmtRatio(g.firstHits, g.firstOnTarget)} />, tip: "First bullets of a burst with an enemy within 10° that hit" },
          { key: "kills", label: "Kills", sort: (g) => g.kills, render: (g) => g.kills },
          { key: "hsk", label: "HS kills", sort: (g) => pct(g.hsKills, g.kills), render: (g) => <Num v={fmtRatio(g.hsKills, g.kills)} /> },
          { key: "rounds", label: "Rounds", tip: "Rounds in which you fired it or killed with it", sort: (g) => g.rounds, render: (g) => g.rounds },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- timings

function TimingsCard({ a, side }: { a: AimAgg; side: SideFilter }) {
  const gate = aimVisibility(a);
  const eng = engFor(a, side);
  if (gate.validated) {
    return (
      <Card title="When an enemy appears" aside={<span className="meta">{plural(eng.n, "engagement")}</span>}>
        <div className="grid-3">
          <div><div className="hist-title"><span className="caps">Time to damage</span></div><Histogram h={eng.ttd} unit=" ms" bench={BENCH.ttd.good} benchLabel="good" lowerIsBetter /></div>
          <div><div className="hist-title"><span className="caps">Reaction</span></div><Histogram h={eng.react} unit=" ms" bench={BENCH.reaction.good} benchLabel="good" lowerIsBetter /></div>
          <div><div className="hist-title"><span className="caps">Crosshair placement</span></div><Histogram h={eng.xhair} unit="°" bench={BENCH.xhair.good} benchLabel="good" lowerIsBetter /></div>
        </div>
      </Card>
    );
  }
  const cov = gate.hitCoverage;
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
          <div className="gated__meter" aria-label={`Visibility check at ${cov === null ? "unknown" : Math.round(100 * cov)}% of 90% needed`}>
            <div className="gated__track"><i style={{ width: `${Math.min(100, ((cov ?? 0) / 0.9) * 100)}%` }} /><em style={{ left: "100%" }} /></div>
            <span className="meta">Visibility check {cov === null ? "not run" : `${Math.round(100 * cov)}%`} of the 90% needed</span>
          </div>
          <p>{gate.reason}</p>
          <p className="meta">These appear once the capture plugin traces line of sight from your eyes to each enemy. Then the check above reaches 90% and the three distributions draw here, per match and over your career.</p>
        </div>
      </div>
    </Card>
  );
}
