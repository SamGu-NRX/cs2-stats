// The flash tool (Utility): your flashbangs on the radar where they detonated, and as a list with
// whom each blinded, for how long, and the kills it led to (worker flashes, stats/flashes.ts). Side
// and round filters; each flash links to its round. The list is the keyboard path: a radar dot is a
// pointer shortcut to its row. Nothing moves; picking a flash steps the other dots back at once. Only
// a mouse lights a row from the map and back, so a tap does not leave a row lit.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FlashRow } from "../../../stats/flashes";
import { FLASHED_MIN_S } from "../../../stats/utility";
import { Card } from "../../components/Card";
import { Segmented, Select, type Option } from "../../components/controls";
import { frameFor, RadarView, type Frame } from "../../components/MapArt";
import { useCall } from "../../data/hooks";
import { mapInfo } from "../../data/maps";
import { NadeIcon, WeaponIcon } from "../../icons/game";
import { ChevronRightIcon } from "../../icons/ui";
import { fmtClock, fmtSecs, plural } from "../../lib/format";
import { matchHref } from "../../router";
import { Empty, PlayerName } from "../shared";
import { LoadFailed } from "./LoadFailed";
import type { TabProps } from "./MatchView";

export const NO_MAP_FLASHES = "This map has no radar calibration, so its flashes can't be placed.";
const KILL_RULE = `A flash led to a kill when the game gave you a flash assist on it, or an enemy it blinded for over ${FLASHED_MIN_S} s died to your team before the blindness wore off.`;
/** A blind of this length fills its bar; CS2's longest blinds run a little over 5 s. */
const BAR_S = 5;

type SideKey = "both" | "t" | "ct";

const enemiesOf = (f: FlashRow) => f.blinded.filter((b) => !b.team && b.flashed);
const matesOf = (f: FlashRow) => f.blinded.filter((b) => b.team && b.flashed);
/** The dot's outcome: a kill beats an enemy blinded beats a teammate blinded. */
const outcome = (f: FlashRow) => (f.kills.length ? "kill" : enemiesOf(f).length ? "enemy" : matesOf(f).length ? "team" : "none");

export function FlashCard({ v }: { v: TabProps["v"] }) {
  const call = useCall("flashes", [v.file, v.players[v.human].key]);
  // an answer for another match never shows, not even while this one loads
  const tool = call.stale ? null : call.data;
  const [side, setSide] = useState<SideKey>("both");
  const [round, setRound] = useState("all");
  const [picked, setPicked] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const all = tool?.flashes ?? [];
  const shown = useMemo(() => all.map((f, i) => ({ f, i })).filter(({ f }) => (side === "both" || f.side.toLowerCase() === side) && (round === "all" || f.round === Number(round))), [all, side, round]);
  const rounds = useMemo((): Option<string>[] => {
    const n = new Map<number, number>();
    for (const f of all) if (side === "both" || f.side.toLowerCase() === side) n.set(f.round, (n.get(f.round) ?? 0) + 1);
    return [{ value: "all", label: "All rounds" }, ...[...n].map(([r, k]) => ({ value: String(r), label: `Round ${r}`, tip: plural(k, "flash", "flashes") }))];
  }, [all, side]);

  const enemies = shown.reduce((a, { f }) => a + enemiesOf(f).length, 0);
  const enemySecs = shown.reduce((a, { f }) => a + enemiesOf(f).reduce((s, b) => s + b.secs, 0), 0);
  const mates = shown.reduce((a, { f }) => a + matesOf(f).length, 0);
  const led = shown.filter(({ f }) => f.kills.length).length;
  const notes = tool?.notes ?? [];

  const pick = (i: number | null) => setPicked((p) => (p === i ? null : i));
  /** a radar dot opens its row and brings it into view, as a click on the row would */
  const pickFromMap = (i: number) => {
    pick(i);
    requestAnimationFrame(() => list.current?.querySelector(`[data-flash="${i}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>(".fl-row__btn") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const title = "Your flashes";
  if (call.error && !call.stale) return <Card title={title}><LoadFailed what="Your flashes" error={call.error} /></Card>;
  if (!tool) return <Card title={title}><div className="skel" style={{ height: 320 }} /></Card>;
  if (!all.length) return <Card title={title} icon={<NadeIcon type="flash" size={16} beside />}><Empty text={notes[0] ?? "You threw no flashbangs this match."} /></Card>;

  const focus = picked ?? hover;
  // the map's own overview transform only: a frame fitted around the points would place them over nothing
  const frame = mapInfo(v.map) ? frameFor(v.map) : null;
  return (
    <Card title={title} icon={<span className="cream"><NadeIcon type="flash" size={16} beside /></span>} id="match-flashes" collapsible
      aside={<span className="meta">{shown.length === all.length ? plural(all.length, "flash", "flashes") : `${shown.length} of ${all.length} flashes`}</span>}>
      <div className="fl">
        <div className="fl__bar">
          <Segmented label="Side" value={side} onChange={(s) => { setSide(s); setRound("all"); setPicked(null); setHover(null); }}
            options={[{ value: "both", label: "Both sides" }, { value: "t", label: "T", side: "t" }, { value: "ct", label: "CT", side: "ct" }]} />
          <Select label="Round" value={round} onChange={(r) => { setRound(r); setPicked(null); setHover(null); }} options={rounds} />
        </div>
        <dl className="fl__figs" aria-label="Your flashes, as filtered">
          <div><dt className="caps">Thrown</dt><dd className="num">{shown.length}</dd></div>
          <div><dt className="caps" data-tip={`Enemies blinded for over ${FLASHED_MIN_S} s, once per flash`} tabIndex={0}>Enemies blinded</dt><dd className="num cream">{enemies}</dd></div>
          <div><dt className="caps">Per enemy</dt><dd className="num">{enemies ? fmtSecs(enemySecs / enemies) : "–"}</dd></div>
          <div><dt className="caps" data-tip={`Teammates blinded for over ${FLASHED_MIN_S} s`} tabIndex={0}>Teammates</dt><dd className={`num ${mates ? "poor-text" : ""}`}>{mates}</dd></div>
          <div><dt className="caps" data-tip={KILL_RULE} tabIndex={0}>Led to a kill</dt><dd className="num good-text">{led}<span className="faint">/{shown.length}</span></dd></div>
        </dl>
        {notes.length > 0 && <ul className="fl__notes">{notes.map((n) => <li key={n} className="meta"><span className="chip chip--approx">Missing</span>{n}</li>)}</ul>}
        <div className="fl__grid">
          <div className="fl__map">
            {frame ? (
              <FlashRadar v={v} frame={frame} shown={shown} focus={focus} onPick={pickFromMap} onHover={setHover} />
            ) : <div className="fl__nomap"><Empty text={NO_MAP_FLASHES} /></div>}
            <p className="legend fl__legend" aria-hidden>
              <span><i className="fl-key fl-key--kill" />Led to a kill</span>
              <span><i className="fl-key fl-key--enemy" />Blinded an enemy</span>
              <span><i className="fl-key fl-key--team" />Only teammates</span>
              <span><i className="fl-key fl-key--none" />Nobody</span>
            </p>
          </div>
          <div className="fl__side">
            {shown.length ? (
              <>
                <div className="fl-head caps" aria-hidden><span className="fl-head__cols"><span>Rnd</span><span>Time</span><span>Enemies</span><span>Team</span><span>Kills</span><span /></span><span /></div>
                <ol className="fl__list" ref={list} onKeyDown={onKey} aria-label="Your flashes by round. Up and down arrows move between them.">
                  {shown.map(({ f, i }) => (
                    <FlashItem key={i} v={v} f={f} i={i} open={picked === i} lit={hover === i} onToggle={() => pick(i)} onHover={setHover} />
                  ))}
                </ol>
              </>
            ) : <Empty text={round === "all" ? `No flashes on ${side.toUpperCase()}.` : "No flashes in this round."} />}
          </div>
        </div>
      </div>
    </Card>
  );
}

function FlashRadar({ v, frame, shown, focus, onPick, onHover }: {
  v: TabProps["v"]; frame: Frame; shown: { f: FlashRow; i: number }[]; focus: number | null; onPick: (i: number) => void; onHover: (i: number | null) => void;
}) {
  const placed = shown.filter(({ f }) => f.at);
  const on = placed.find(({ i }) => i === focus) ?? null;
  return (
    <RadarView map={v.map} frame={frame} label={on ? `Round ${on.f.round} flash: ${plural(enemiesOf(on.f).length, "enemy", "enemies")} blinded` : `${placed.length} flash detonations`}>
      <g className={`fl-dots ${on ? "is-dim" : ""}`}>
        {placed.map(({ f, i }) => {
          const [x, y] = frame.to(...f.at!);
          const r = 7 + 2.5 * Math.min(4, enemiesOf(f).length);
          return (
            <g key={i} className={`fl-dot fl-dot--${outcome(f)}`} transform={`translate(${x} ${y})`} onClick={() => onPick(i)} onPointerEnter={(e) => e.pointerType === "mouse" && onHover(i)} onPointerLeave={() => onHover(null)}>
              <title>{`Round ${f.round}, ${fmtClock(f.t)}: ${plural(enemiesOf(f).length, "enemy", "enemies")} blinded${f.kills.length ? `, led to ${plural(f.kills.length, "kill")}` : ""}`}</title>
              <circle className="fl-dot__hit" r={r + 10} />
              {f.kills.length > 0 && <circle className="fl-dot__ring" r={r + 6} />}
              <circle className="fl-dot__core" r={r} />
            </g>
          );
        })}
      </g>
      {on && <FlashRays v={v} f={on.f} to={frame.to} />}
    </RadarView>
  );
}

/** The picked flash over the dimmed rest: a ray to each blinded player where they stood, with the seconds. */
function FlashRays({ v, f, to }: { v: TabProps["v"]; f: FlashRow; to: Frame["to"] }) {
  const [x, y] = to(...f.at!);
  return (
    <g className="fl-rays" aria-hidden>
      {f.blinded.filter((b) => b.at).map((b) => {
        const [bx, by] = to(...b.at!);
        const side = v.rounds.find((r) => r.number === f.round)?.pr[b.pi]?.side;
        return (
          <g key={b.pi} className={`fl-ray ${b.team ? "is-team" : ""} ${b.flashed ? "" : "is-short"}`}>
            <line x1={x} y1={y} x2={bx} y2={by} />
            <circle cx={bx} cy={by} r="8" className={side === "T" ? "fl-ray__t" : "fl-ray__ct"} />
            <text x={bx + 13} y={by + 7}>{b.secs.toFixed(1)}s</text>
          </g>
        );
      })}
      <circle cx={x} cy={y} r="12" className={`fl-ray__src fl-dot--${outcome(f)}`} />
    </g>
  );
}

function FlashItem({ v, f, i, open, lit, onToggle, onHover }: {
  v: TabProps["v"]; f: FlashRow; i: number; open: boolean; lit: boolean; onToggle: () => void; onHover: (i: number | null) => void;
}) {
  const en = enemiesOf(f);
  const mates = matesOf(f);
  const secs = en.reduce((a, b) => a + b.secs, 0);
  const id = `fl-${i}`;
  return (
    <li className={`fl-row ${open ? "is-open" : ""} ${lit ? "is-lit" : ""}`} data-flash={i} onPointerEnter={(e) => e.pointerType === "mouse" && onHover(i)} onPointerLeave={() => onHover(null)}>
      <div className="fl-row__line">
        <button className="fl-row__btn" aria-expanded={open} aria-controls={id} onClick={onToggle}
          aria-label={`Round ${f.round}, ${fmtClock(f.t)} into the round: ${plural(en.length, "enemy", "enemies")} blinded, ${plural(mates.length, "teammate")}, ${plural(f.kills.length, "kill")}${f.at ? "" : ", not on the map"}`}>
          <span className={`pip pip--${f.side.toLowerCase()} num`}>{f.round}</span>
          <span className="num fl-row__t">{fmtClock(f.t)}</span>
          <span className="fl-row__en">{en.length ? <><b className="num cream">{en.length}</b><span className="meta num">{fmtSecs(secs)}</span></> : <span className="faint">–</span>}</span>
          <span className="fl-row__tm">{mates.length ? <b className="num poor-text">{mates.length}</b> : <span className="faint">–</span>}</span>
          <span className="fl-row__k">{f.kills.length ? f.kills.map((k, j) => <WeaponIcon key={j} name={k.weapon} height={12} />) : <span className="faint">–</span>}</span>
          {!f.at && <span className="chip chip--approx fl-row__np">No point</span>}
        </button>
        <a className="fl-row__go" href={matchHref(v.file, "rounds", { round: f.round })} aria-label={`Open round ${f.round}`} data-tip={`Round ${f.round}`}><ChevronRightIcon size={14} /></a>
      </div>
      {open && (
        <div id={id} className="fl-detail">
          {f.blinded.length ? (
            <ul className="fl-blinds" aria-label="Blinded">
              {f.blinded.map((b) => {
                const kill = f.kills.find((k) => k.victim === b.pi);
                return (
                  <li key={b.pi} className={`fl-blind ${b.flashed ? "" : "is-short"}`}>
                    <span className={`fl-blind__who ${b.team ? "poor-text" : ""}`}><PlayerName v={v} pi={b.pi} /></span>
                    <span className="fl-blind__bar" aria-hidden><i style={{ transform: `scaleX(${Math.min(1, b.secs / BAR_S)})` }} className={b.team ? "is-team" : ""} /></span>
                    <span className="num fl-blind__s" {...(b.flashed ? {} : { "data-tip": `Under ${FLASHED_MIN_S} s: not counted as blinded`, tabIndex: 0 })}>{fmtSecs(b.secs)}</span>
                    <span className="fl-blind__k">
                      {kill && (
                        <span className="fl-kill" tabIndex={0} data-tip={[kill.assist && "Your flash assist", kill.whileBlind && "Killed while blind"].filter(Boolean).join(", ")}>
                          <WeaponIcon name={kill.weapon} height={12} />
                          <span className="meta">{kill.killer === null ? "World" : kill.killer === v.human ? "you" : v.players[kill.killer].name}, {fmtClock(kill.t)}</span>
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="meta">Blinded nobody.</p>}
        </div>
      )}
    </li>
  );
}
