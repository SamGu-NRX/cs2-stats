// Head to head: your team's players down, the opponents across, each cell what the row player did to the
// column player and what came back. The measure switches between kills (the match's kill facts),
// damage, opening kills and blinds (worker headToHead). A cell opens its pair below the grid: every
// measure each way and the weapon classes each side killed with. The pair starts on you and the
// opponent you fought most. Choosing a pair or a measure changes the grid at once, without motion.
import { useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { useCall } from "../../data/hooks";
import { killMatrix, type MatchModel, type MPlayer } from "../../data/match";
import { WeaponClassIcon } from "../../icons/game";
import { fmtDiff, fmtSecs, plural } from "../../lib/format";
import { diffScore, scoreText, scoreTint, toScore } from "../../lib/scale";
import { PlayerName, SectionAside } from "../shared";
import { Hint } from "./glyphs";
import { LoadFailed } from "./LoadFailed";
import { measureOf, mostFought, orient, weaponsByKills, type Oriented, type PairMeasure } from "./parity";

const MEASURES: { value: PairMeasure; label: string; noun: string; tip: string }[] = [
  { value: "kills", label: "Kills", noun: "Kills", tip: "Kills on that opponent, then theirs back" },
  { value: "damage", label: "Damage", noun: "Damage", tip: "Damage to that opponent, then theirs back" },
  { value: "openings", label: "Openings", noun: "First kills", tip: "Rounds' first kills on that opponent, then theirs back" },
  { value: "flashes", label: "Blinds", noun: "Blinds", tip: "Flashes that blinded that opponent over 1.1 s, then theirs back" },
];

/** How far apart a cell's two numbers are before its tint is full; picked by eye, not fitted. */
const SPAN: Record<PairMeasure, number> = { kills: 4, damage: 300, openings: 2, flashes: 3 };

export function HeadToHead({ v }: { v: MatchModel }) {
  const us = v.players.filter((p) => p.team === "us");
  const them = v.players.filter((p) => p.team === "them");
  const km = useMemo(() => killMatrix(v), [v]);
  const loaded = useCall("headToHead", [v.file]);
  const h2h = loaded.data;
  const [measure, setMeasure] = useState<PairMeasure>("kills");
  // the viewer's most-fought enemy opens the pair; a pro demo seen through nobody opens on none
  const me = v.human === null ? null : v.players[v.human];
  const [pick, setPick] = useState<{ x: string; y: string } | null>(null);
  const pair = pick ?? (h2h && me ? (() => { const y = mostFought(h2h, me.key, them.map((q) => q.key)); return y ? { x: me.key, y } : null; })() : null);
  const live = measure === "kills" || !!h2h;
  const cell = (p: MPlayer, q: MPlayer): [number, number] | null => {
    if (measure === "kills") return [km[p.pi][q.pi], km[q.pi][p.pi]];
    const o = h2h ? orient(h2h, p.key, q.key) : null;
    return o ? measureOf(o, measure) : null;
  };
  const sum = (f: (c: [number, number]) => number) => us.reduce((a, p) => a + them.reduce((b, q) => b + f(cell(p, q) ?? [0, 0]), 0), 0);
  const m = MEASURES.find((x) => x.value === measure)!;
  const byKey = new Map(v.players.map((p) => [p.key, p]));

  return (
    <Card
      title={<>Head to head <Hint tip="Each cell: your player's number on that opponent, then the opponent's back. Pick a cell to compare the pair." /></>}
      aside={<span className="h2x__aside">
        <Segmented label="Measure" value={measure} onChange={setMeasure} options={MEASURES.map((x) => { const off = x.value !== "kills" && !h2h; return { value: x.value, label: x.label, disabled: off, tip: off ? undefined : x.tip }; })} />
        <SectionAside label={m.noun} value={live ? <><span className="cream">{sum((c) => c[0])}</span><span className="faint">–</span>{sum((c) => c[1])}</> : "–"} />
      </span>}
    >
      <div className="h2x-c">
      <div className="h2x">
      <div className="tbl-wrap">
        <table className="tbl h2h">
          <thead>
            <tr>
              <th className="l"><span className="th">Your team ↓ vs →</span></th>
              {them.map((q) => <th key={q.key}><span className="th"><PlayerName v={v} pi={q.pi} /></span></th>)}
              <th><span className="th">Total</span></th>
            </tr>
          </thead>
          <tbody>
            {us.map((p) => {
              const net = them.reduce((a, q) => { const c = cell(p, q); return a + (c ? c[0] - c[1] : 0); }, 0);
              return (
                <tr key={p.key} className={p.isHuman ? "is-you" : undefined}>
                  <td className="l name-cell"><PlayerName v={v} pi={p.pi} /></td>
                  {them.map((q) => {
                    const c = cell(p, q);
                    const on = pair?.x === p.key && pair.y === q.key;
                    const t = c && c[0] + c[1] ? toScore(c[0] - c[1], 0, SPAN[measure]) : 0;
                    const off = !c;
                    return (
                      <td key={q.key} className="h2x__td" style={{ background: t ? scoreTint(t, 0.4) : undefined }}>
                        <button
                          className={`h2x__cell ${on ? "is-on" : ""}`}
                          aria-pressed={on}
                          disabled={off}
                          onClick={() => setPick({ x: p.key, y: q.key })}
                          aria-label={`${p.name} against ${q.name}: ${m.noun.toLowerCase()} ${c ? `${c[0]} to ${c[1]}` : "loading"}`}
                          data-tip={off ? undefined : `${m.noun}: ${p.name} ${c[0]}, ${q.name} ${c[1]}`}
                        >
                          <span className="num">{c ? <><b>{c[0]}</b><span className="faint">–</span>{c[1]}</> : "–"}</span>
                        </button>
                      </td>
                    );
                  })}
                  <td><b className="num" style={{ color: live ? scoreText(measure === "kills" ? diffScore(net) : toScore(net, 0, SPAN[measure] * 2)) : undefined }}>{live ? fmtDiff(net) : "–"}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {loaded.error && <LoadFailed what="Damage, first kills and blinds" error={loaded.error} />}
      {h2h && pair && (() => {
        const o = orient(h2h, pair.x, pair.y);
        const a = byKey.get(pair.x), b = byKey.get(pair.y);
        return o && a && b ? <PairDetail v={v} a={a} b={b} o={o} /> : null;
      })()}
      </div>
      </div>
    </Card>
  );
}

/** One pair, every measure each way (views.css .pair), and the weapon classes each killed the other with. */
function PairDetail({ v, a, b, o }: { v: MatchModel; a: MPlayer; b: MPlayer; o: Oriented }) {
  const rows: { label: string; tip: string; x: number; y: number; fmt?: (n: number) => string }[] = [
    { label: "Kills", tip: "Kills on each other", x: o.kills[0], y: o.kills[1] },
    { label: "Damage", tip: "Damage to each other", x: o.damage[0], y: o.damage[1] },
    { label: "First kills", tip: "Rounds where one made the round's first kill on the other", x: o.openings[0], y: o.openings[1] },
    { label: "Blinds", tip: "Flashes that blinded the other over 1.1 s", x: o.flashes[0].count, y: o.flashes[1].count },
    { label: "Blind time", tip: "Seconds those flashes blinded the other", x: o.flashes[0].secs, y: o.flashes[1].secs, fmt: (n) => fmtSecs(n) },
  ];
  const guns = (w: Oriented["weapons"][0], who: string) => {
    const list = weaponsByKills(w);
    return list.length ? (
      <ul className="h2x__guns" aria-label={`${who}'s kills by weapon type`}>
        {list.map(([cls, n]) => <li key={cls} data-tip={`${plural(n, "kill")} with a ${cls}`} tabIndex={0}><WeaponClassIcon cls={cls} height={13} /><span className="num">{n}</span></li>)}
      </ul>
    ) : <span className="faint">No kills</span>;
  };
  return (
    <section className="h2x__pair" aria-label={`${a.name} against ${b.name}`}>
      <header className="h2x__names">
        <b className="cream"><PlayerName v={v} pi={a.pi} /></b>
        <span className="caps">against</span>
        <b><PlayerName v={v} pi={b.pi} /></b>
      </header>
      <div className="pairs h2x__rows">
        {rows.map((r) => {
          const total = r.x + r.y;
          const f = r.fmt ?? String;
          return (
            <div key={r.label} className="pair" data-tip={r.tip} tabIndex={0}>
              <span className="pair__l">{r.label}</span>
              <b className="num pair__us">{f(r.x)}</b>
              <span className="pair__bar">{total > 0 && <><i style={{ width: `${(100 * r.x) / total}%` }} /><em style={{ width: `${(100 * r.y) / total}%` }} /></>}</span>
              <b className="num pair__them">{f(r.y)}</b>
            </div>
          );
        })}
        <div className="pair h2x__gunrow">
          <span className="pair__l">Killed with</span>
          <span className="h2x__gunside">{guns(o.weapons[0], a.name)}</span>
          <span className="h2x__gunside">{guns(o.weapons[1], b.name)}</span>
        </div>
      </div>
    </section>
  );
}
