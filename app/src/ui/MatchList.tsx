// Match history. Rows have a fixed height and only the visible ones render, so 1,000 matches cost
// the same as 20.
import { useEffect, useRef, useState } from "react";
import { addPickedFiles, samplesShown, setSamplesShown } from "../host/host";
import type { LightSummary } from "../worker/protocol";
import { useData } from "./data";
import { fmtDate, fmtTime, mapName, ratingClass } from "./format";
import { Refresh } from "./icons";
import { go, matchHref } from "./router";

const ROW = 56;
const OVERSCAN = 6;

function useVisibleRange(list: React.RefObject<HTMLElement>, count: number) {
  const [range, setRange] = useState<[number, number]>([0, 30]);
  useEffect(() => {
    const el = list.current;
    const scroller = el?.closest(".scroll");
    if (!el || !scroller) return;
    let frame = 0;
    // Layout is read only when sizes change; the scroll handler uses scrollTop alone.
    let listTop = 0;
    let viewH = 0;
    const measure = () => {
      listTop = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      viewH = scroller.clientHeight;
    };
    const update = () => {
      frame = 0;
      const top = scroller.scrollTop - listTop;
      const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
      const last = Math.min(count, Math.ceil((top + viewH) / ROW) + OVERSCAN);
      setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    measure();
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => { measure(); onScroll(); });
    ro.observe(scroller);
    ro.observe(el);
    return () => { scroller.removeEventListener("scroll", onScroll); ro.disconnect(); cancelAnimationFrame(frame); };
  }, [list, count]);
  return range;
}

function Row({ s, top }: { s: LightSummary; top: number }) {
  const resultText = s.result === "W" ? "Win" : s.result === "L" ? "Loss" : "Tie";
  const c = s.human.c;
  return (
    <button className="list__row" style={{ transform: `translateY(${top}px)` }} onClick={() => go(matchHref(s.file))}
      aria-label={`${mapName(s.map)}, ${resultText} ${s.score.us} to ${s.score.them}, rating ${s.human.rating.toFixed(2)}, ${fmtDate(s.startUtc)}`}>
      <span className="list__bar" style={{ background: s.result === "W" ? "var(--c-green)" : s.result === "L" ? "var(--c-red)" : "var(--text-disabled)" }} />
      <span>
        <div className="list__map">{mapName(s.map)}</div>
        <div className="list__sub">
          {resultText} · {s.nRounds} rounds{s.captured < s.nRounds ? ` · kill log from round ${s.nRounds - s.captured + 1}` : ""}
        </div>
      </span>
      <span className={`list__score num ${s.result === "W" ? "pos" : s.result === "L" ? "neg" : ""}`}>{s.score.us}–{s.score.them}</span>
      <span className={`list__rating num ${ratingClass(s.human.rating)}`}>{s.human.rating.toFixed(2)}</span>
      <span className="num" style={{ textAlign: "right" }}>{c.kills}–{c.deaths} <span className="muted">· {c.rounds ? (c.dmg / c.rounds).toFixed(0) : "–"} ADR</span></span>
      <span className="list__date num">{fmtDate(s.startUtc)}, {fmtTime(s.startUtc)}</span>
    </button>
  );
}

/** Dev only: add .json.gz match files from disk to the browser session. */
function PickFiles({ onPicked }: { onPicked: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept=".gz" multiple hidden onChange={(e) => { if (e.target.files) { addPickedFiles(e.target.files); onPicked(); } }} />
      <button className="btn btn--ghost" onClick={() => input.current?.click()} data-tip="Development only: open match files from disk">Open files…</button>
    </>
  );
}

export function MatchList() {
  const { summaries, status, host, fileErrors, refresh, progress } = useData();
  const ref = useRef<HTMLDivElement>(null);
  const [first, last] = useVisibleRange(ref, summaries.length);

  if (status === "starting" || (status === "syncing" && !summaries.length)) {
    return (
      <div className="page fade-in">
        <div className="glass card empty" aria-live="polite">
          <h2>Reading matches</h2>
          <p>{progress ? `${progress.done} of ${progress.total} matches indexed` : "Looking for match files…"}</p>
        </div>
      </div>
    );
  }
  if (!summaries.length) {
    return (
      <div className="page fade-in">
        <div className="glass card empty">
          <h2>No matches yet</h2>
          <p>
            Finish a bot match with the capture plugin running and it appears here.
            {host?.folder ? <> Matches are read from <span className="selectable">{host.folder}</span>.</> : null}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={refresh}>Check again</button>
            {host?.kind === "tauri" && <button className="btn btn--primary" onClick={() => { setSamplesShown(true); refresh(); }}>Show sample matches</button>}
          </div>
        </div>
      </div>
    );
  }
  const wins = summaries.filter((s) => s.result === "W").length;
  return (
    <div className="page fade-in">
      <div className="card__head" style={{ padding: "6px 4px 0" }}>
        <div>
          <h1 className="card__title" style={{ fontSize: 20, letterSpacing: -0.3 }}>Matches</h1>
          <p className="note">{summaries.length} matches · {wins} won{host?.kind === "web" ? " · sample data" : ""}</p>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {host?.kind === "tauri" && samplesShown() && <button className="btn btn--ghost" onClick={() => { setSamplesShown(false); refresh(); }}>Hide samples</button>}
          {import.meta.env.DEV && host?.kind === "web" && <PickFiles onPicked={refresh} />}
          <button className="btn btn--ghost" onClick={refresh} data-tip="Read the matches folder again"><Refresh /> Refresh</button>
        </div>
      </div>
      {fileErrors.length > 0 && (
        <div className="glass card" role="alert">
          <p className="err">{fileErrors.length} file{fileErrors.length > 1 ? "s" : ""} could not be read:</p>
          {fileErrors.slice(0, 3).map((e) => <p key={e.file} className="note selectable">{e.message}</p>)}
        </div>
      )}
      <div className="glass" style={{ padding: "10px 6px" }}>
        <div className="list__head eyebrow">
          <span /><span>Map</span><span>Score</span><span style={{ textAlign: "right" }}>Rating</span><span>K–D · ADR</span><span>Date</span>
        </div>
        <div ref={ref} className="list" style={{ height: summaries.length * ROW }}>
          {summaries.slice(first, last).map((s, i) => <Row key={s.file} s={s} top={(first + i) * ROW} />)}
        </div>
      </div>
    </div>
  );
}
