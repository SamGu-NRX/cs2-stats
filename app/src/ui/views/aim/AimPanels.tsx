// Aim panels, shared by a match's Aim tab and Career aim. Every number is an aim metric (METRIC,
// group "aim") over a Summary narrowed by side and weapon.
// - The hero shows accuracy as a ring over an agent backdrop, beside three groups (hitting, spray
//   and flicks, movement); each group opens inline to its finer stats.
// - Accuracy by gun rolls up each gun on its own.
// - Time to damage, reaction and crosshair placement need view angles and mesh line of sight; for a
//   match file without them the card says what will appear and why.
import { useId, useMemo, useState, type ReactNode } from "react";
import { METRIC } from "../../../stats/metrics";
import type { Summary } from "../../../stats/rollup";
import type { Side } from "../../../stats/tables";
import { weaponClass, weaponLabel } from "../../../stats/weapons";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { AgentImg } from "../../components/Agent";
import { fmtMetric, WEAPON_CLASS_LABEL } from "../../data/engine";
import { useScoped, type Scope } from "../../data/hooks";
import { WeaponClassIcon, WeaponIcon } from "../../icons/game";
import { ChevronIcon, HeadHitIcon, SprayIcon, StrafeIcon } from "../../icons/ui";
import { plural } from "../../lib/format";
import { BENCH, verdictOf } from "../../lib/verdict";

type SideFilter = "all" | "t" | "ct";
const GUN_CLASSES = ["rifle", "sniper", "smg", "heavy", "pistol"] as const;
type ClassFilter = "all" | (typeof GUN_CLASSES)[number];

const sidesFor = (s: SideFilter): { sides?: Side[] } => (s === "all" ? {} : { sides: [s === "t" ? "T" : "CT"] });
const value = (id: string, s: Summary | null) => (s ? METRIC[id].value(s) : null);
const text = (id: string, s: Summary | null) => fmtMetric(id, value(id, s));

export function AimPanels({ scope, label, visibility }: { scope: Scope; label: string; visibility: boolean }) {
  const [side, setSide] = useState<SideFilter>("all");
  const [cls, setCls] = useState<ClassFilter>("all");
  const base = useScoped(scope, [sidesFor(side)])?.[0] ?? null;
  const guns = useMemo(() => Object.keys(base?.weapons ?? {}).filter((w) => (GUN_CLASSES as readonly string[]).includes(weaponClass(w))), [base]);
  const inClass = cls === "all" ? guns : guns.filter((w) => weaponClass(w) === cls);
  const s = useScoped(scope, [{ ...sidesFor(side), ...(cls === "all" ? {} : { weapons: inClass }) }])?.[0] ?? null;
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
      {guns.length > 0 && <GunTable scope={scope} side={side} guns={guns} base={base!} />}
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

function Fig({ id, s }: { id: string; s: Summary | null }) {
  return (
    <div className="fig" data-tip={METRIC[id].def}>
      <b className="fig__v num"><Num v={text(id, s)} /></b>
      <span className="fig__l">{METRIC[id].label}</span>
    </div>
  );
}

function Row({ id, s }: { id: string; s: Summary | null }) {
  return <div className="drow" data-tip={METRIC[id].def}><span>{METRIC[id].label}</span><b className="num"><Num v={text(id, s)} /></b></div>;
}

function AimHero({ s, side, visibility }: { s: Summary | null; side: SideFilter; visibility: boolean }) {
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
        {!visibility && <p className="meta">Stats that need view angles or mesh line of sight show a dash: this match file does not carry them.</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- per gun

interface GunRow { weapon: string; cls: string; shots: number; kills: number; rounds: number; s: Summary | null }

function GunTable({ scope, side, guns, base }: { scope: Scope; side: SideFilter; guns: string[]; base: Summary }) {
  const per = useScoped(scope, guns.map((w) => ({ ...sidesFor(side), weapons: [w] })));
  const rows: GunRow[] = guns.map((w, i) => ({ weapon: w, cls: weaponClass(w), shots: base.weapons[w].shots, kills: base.weapons[w].kills, rounds: base.weapons[w].rounds, s: per?.[i] ?? null }));
  const byClass = GUN_CLASSES.map((c) => ({ key: c, label: <span className="classcell"><WeaponClassIcon cls={c} size={12} />{WEAPON_CLASS_LABEL[c]}</span>, rows: rows.filter((g) => g.cls === c && (g.shots || g.kills)) })).filter((g) => g.rows.length);
  return (
    <Card title="Accuracy by gun" aside={<span className="meta">{plural(rows.filter((g) => g.shots).length, "gun")} fired</span>} flush>
      <DataTable<GunRow>
        label="Accuracy by gun"
        groups={byClass}
        rowKey={(g) => g.weapon}
        defaultSort={{ key: "shots", dir: "desc" }}
        columns={[
          { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <span className="guncell"><WeaponIcon name={g.weapon} size={12} label={undefined} />{weaponLabel(g.weapon)}</span>, width: 190 },
          { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
          { key: "acc", label: "Accuracy", sort: (g) => value("accuracy", g.s), render: (g) => <span className="cellbar"><span className="hbar"><i style={{ width: `${Math.min(100, 2 * (value("accuracy", g.s) ?? 0))}%`, background: "var(--cream)" }} /></span><Num v={text("accuracy", g.s)} /></span>, width: 160, tip: `${METRIC.accuracy.def} The bar fills at 50%.` },
          { key: "first", label: "First bullet", sort: (g) => value("firstBulletAccuracy", g.s), render: (g) => <Num v={text("firstBulletAccuracy", g.s)} />, tip: METRIC.firstBulletAccuracy.def },
          { key: "kills", label: "Kills", sort: (g) => g.kills, render: (g) => g.kills },
          { key: "rounds", label: "Rounds", tip: "Rounds in which you fired it, hit with it or killed with it", sort: (g) => g.rounds, render: (g) => g.rounds },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- timings

const TIMINGS = ["timeToDamage", "reactionTime", "crosshairPlacement", "timeToShot"] as const;

function TimingsCard({ s, visibility }: { s: Summary | null; visibility: boolean }) {
  if (visibility) {
    return (
      <Card title="When an enemy appears" aside={<span className="meta">{plural(s?.aim.sightings ?? 0, "sighting")}</span>}>
        <div className="grid-3">
          {TIMINGS.map((id) => <Fig key={id} id={id} s={s} />)}
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
          <p>These need your view angles and mesh line of sight to each enemy. Plugin match files carry neither.</p>
          <p className="meta">They appear for matches recorded as demos and run through the extractor, which computes visibility on the map's mesh.</p>
        </div>
      </div>
    </Card>
  );
}
