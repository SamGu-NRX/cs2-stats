// Clips: your best moments, ranked across your matches (stats/moments.ts), each with the demo it
// needs and where it stands: needs a demo, ready to render, recorded by HLAE, or rendered. Choosing
// moments and pressing Render shows the plan the host built (clips/plan.ts) and asks before anything
// starts CS2; recorded takes are finished and joined into a reel with FFmpeg, whose commands the host
// builds (src-tauri/src/clips/ffmpeg.rs). design/clips.md.
//
// Only the desktop app checks demos and renders; the browser lists the moments and says so.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clipsHost, savedHlae, saveHlae, type ClipsEnv, type ClipsHost, type DemoOnDisk, type Take } from "../../clips/host";
import { jobRequest, type RenderPlan } from "../../clips/plan";
import { clipState, demoSource, ROUND_IMPACT_TIP, STATE_LABEL, type ClipState, type DemoSource, type Lookup } from "../../clips/state";
import type { MomentRow } from "../../worker/protocol";
import { ClutchBadge, MapThumb, MultiBadge } from "../components/bits";
import { Segmented } from "../components/controls";
import { copyText, toast } from "../components/overlay";
import { careerEntries } from "../data/engine";
import { useCall, useYourQuery } from "../data/hooks";
import type { MatchEntry } from "../data/match";
import { hideText, hidingPersonal, useHidePersonal } from "../data/privacy";
import { useData } from "../data/provider";
import { FlagIcon, WeaponIcon } from "../icons/game";
import { ChevronRightIcon, ClipsIcon, CloseIcon, CopyIcon, PlayIcon, RefreshIcon } from "../icons/ui";
import { fmtMatchDay, mapName, plural } from "../lib/format";
import { matchHref } from "../router";
import { BarContent } from "../shell/Bar";
import { LoadFailed } from "./match/LoadFailed";
import { Empty } from "./shared";

type Show = "all" | "ready" | "needs" | "done";
/**
 * Rows the list shows before "Show more", and how many each press adds. A moment is one player-round,
 * so the list grows with the rounds played (30 from the seven matches on the dev machine,
 * 2026-10-26); paging keeps a long career from rendering thousands of rows at once.
 */
const PAGE = 50;
interface Item { row: MomentRow; rank: number; entry: MatchEntry | undefined; src: DemoSource; state: ClipState }

/** Seconds as m:ss, rounded to the second once before splitting, so 59.6 s reads 1:00, never 0:60. */
export const clock = (s: number) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const durationOf = (r: Pick<MomentRow, "startTick" | "endTick" | "tickRate">) => (r.endTick - r.startTick) / r.tickRate;
/** The lower third's second line: where and when. */
const subline = (r: MomentRow, e: MatchEntry | undefined) => [mapName(r.map), `Round ${r.round}`, e ? fmtMatchDay(e.match) : null].filter(Boolean).join(" · ");
const isNeeds = (s: ClipState) => s.kind === "no-demo" || s.kind === "unchecked";
const isDone = (s: ClipState) => s.kind === "recorded" || s.kind === "rendered";
const choosable = (s: ClipState) => s.kind === "ready" || isDone(s);

// ---------------------------------------------------------------- the host's view of the clips

interface Tools { host: ClipsHost | null; env: ClipsEnv | null; lookup: Lookup; error: string | null; checking: boolean }

/** The clips host, the tools it found, which demos are on disk and what the clips folder holds; `recheck` asks again. */
function useClipTools(names: string[], hlae: string | null): Tools & { recheck: () => void } {
  const [n, setN] = useState(0);
  const [st, setSt] = useState<Tools>({ host: null, env: null, lookup: { demos: null, scan: null, why: null }, error: null, checking: true });
  const key = names.join("|");
  useEffect(() => {
    let alive = true;
    setSt((s) => ({ ...s, checking: true }));
    (async () => {
      const host = await clipsHost();
      if (!host) return { host, env: null, lookup: { demos: null, scan: null, why: "Demos are checked by the desktop app." }, error: null };
      const [env, scan] = await Promise.all([host.env(hlae), host.scan()]);
      let demos: Map<string, DemoOnDisk> | null = null, why: string | null = null;
      if (names.length) {
        try { demos = new Map((await host.demos(names)).map((d) => [d.name, d])); } catch (e) { why = `Demos could not be checked: ${String(e)}`; }
      } else demos = new Map();
      return { host, env, lookup: { demos, scan, why }, error: null };
    })().then(
      (r) => alive && setSt({ ...r, checking: false }),
      (e) => alive && setSt((s) => ({ ...s, error: String(e), checking: false })),
    );
    return () => { alive = false; };
  }, [key, hlae, n]);
  return { ...st, recheck: () => setN((x) => x + 1) };
}

// ---------------------------------------------------------------- one moment

/** The clip as a track: its length, the pre-roll and post-roll dimmed, a mark at each of your kills. */
function ClipTrack({ r }: { r: MomentRow }) {
  const len = r.endTick - r.startTick;
  const at = (tick: number) => Math.min(100, Math.max(0, (100 * (tick - r.startTick)) / len));
  const first = r.kills.length ? at(r.kills[0].tick) : 0, last = r.kills.length ? at(r.kills[r.kills.length - 1].tick) : 100;
  const secs = r.kills.map((k) => Math.round((k.tick - r.startTick) / r.tickRate));
  const label = `${clock(len / r.tickRate)} clip${secs.length ? `, ${plural(secs.length, "kill")} at ${secs.map((s) => `${s} s`).join(", ")}` : ""}`;
  return (
    <span className="ctrack" role="img" aria-label={label} data-tip={label}>
      <span className="ctrack__bar">
        <i className="ctrack__core" style={{ left: `${first}%`, width: `${Math.max(0, last - first)}%` }} />
        {r.kills.map((k, i) => <i key={i} className="ctrack__kill" data-hs={k.headshot || undefined} style={{ left: `${at(k.tick)}%` }} />)}
      </span>
      <span className="ctrack__len mono">{clock(len / r.tickRate)}</span>
    </span>
  );
}

const BEFORE = [{ key: "blind", id: "blind", label: "Killer was flashed" }, { key: "inAir", id: "inair", label: "Killer was in the air" }] as const;
const AFTER = [{ key: "noscope", id: "noscope", label: "No scope" }, { key: "smoke", id: "smoke", label: "Through smoke" }, { key: "wallbang", id: "wallbang", label: "Through a wall" }, { key: "headshot", id: "headshot", label: "Headshot" }] as const;

/** Your kills as the killfeed draws them, in the game's own icons. */
function Feed({ r }: { r: MomentRow }) {
  return (
    <span className="clip__feed" aria-hidden>
      {r.kills.map((k, i) => (
        <span key={i} className="hlr__kill">
          {BEFORE.filter((f) => k[f.key] === true).map((f) => <FlagIcon key={f.key} id={f.id} label={f.label} size={12} />)}
          <WeaponIcon name={k.weapon} height={12} />
          {AFTER.filter((f) => k[f.key]).map((f) => <FlagIcon key={f.key} id={f.id} label={f.label} size={12} />)}
        </span>
      ))}
    </span>
  );
}

function StateCell({ s, clipsDir }: { s: ClipState; clipsDir: string | null }) {
  const hide = useHidePersonal();
  if (s.kind === "rendered") {
    const name = s.path.slice(s.path.search(/[^\\/]+$/));
    const shown = hide ? `<clips folder>\\${name}` : s.path;
    return (
      <span className="clip__state">
        <span className="cstate" data-s="rendered">{STATE_LABEL.rendered}</span>
        <button className="clip__path mono" onClick={() => copyText(s.path, "Path copied", clipsDir ? s.path.replace(clipsDir, "<clips folder>") : undefined)} data-tip={`${shown}\nCopy the path`} aria-label={`Copy the path of the rendered clip, ${name}`}>
          <CopyIcon size={12} />{name}
        </button>
      </span>
    );
  }
  const tip = s.kind === "no-demo" || s.kind === "unchecked" ? s.why : s.kind === "recorded" ? "HLAE recorded this clip. Finish it to trim it and add the lower third." : "The demo is in CS2's replays folder.";
  return (
    <span className="clip__state">
      <span className="cstate" data-s={s.kind} data-tip={hide ? hideText(tip) : tip} tabIndex={isNeeds(s) ? 0 : undefined}>{STATE_LABEL[s.kind]}</span>
    </span>
  );
}

/** A click with no pointer behind it (detail 0) came from the keyboard: Space on a checkbox, Enter on a button. */
const fromKeyboard = (e: { detail: number }) => e.detail === 0;

function ClipRow({ it, chosen, onChoose, clipsDir }: { it: Item; chosen: boolean; onChoose: (on: boolean, keyboard: boolean) => void; clipsDir: string | null }) {
  const { row: r, entry: e, state: s } = it;
  const multi = r.kinds.find((k) => k === "ace" || k === "4k" || k === "3k");
  const where = `round ${r.round} on ${mapName(r.map)}`;
  // a reason holds no personal info today, but a place name is the map maker's text: it goes through the layer like any other
  const hide = useHidePersonal();
  const reason = hide ? hideText(r.reason) : r.reason;
  return (
    <li className="clip" data-clip={r.id} data-chosen={chosen || undefined} data-s={s.kind}>
      <label className="check clip__pick">
        <input type="checkbox" checked={chosen} disabled={!choosable(s)} onChange={() => {}} onClick={(ev) => onChoose(ev.currentTarget.checked, fromKeyboard(ev))}
          aria-label={`Choose ${reason}, ${where}`} />
      </label>
      <span className="clip__rank num" aria-label={`Rank ${it.rank}`}>{it.rank}</span>
      <span className="clip__kinds">
        {multi && <MultiBadge k={r.kills.length} />}
        {r.clutch && <ClutchBadge vs={r.clutch.opponents} won />}
      </span>
      <span className="clip__main">
        <span className="clip__reason" data-tip={r.swing !== null ? ROUND_IMPACT_TIP : undefined}>{reason}</span>
        <span className="clip__meta meta">
          <MapThumb map={r.map} size={14} />
          <span>{mapName(r.map)}</span>
          {e && <span>{fmtMatchDay(e.match)}</span>}
          <span className={r.side === "T" ? "t-text" : "ct-text"}>{r.side} round {r.round}</span>
          {r.matchRank === 1 ? <span className="clip__best">Best in match</span> : <span>#{r.matchRank} in match</span>}
          <Feed r={r} />
        </span>
      </span>
      <ClipTrack r={r} />
      <StateCell s={s} clipsDir={clipsDir} />
      <span className="clip__go">
        <a className="link" href={matchHref(r.file, "rounds", { round: r.round })} aria-label={`Open ${where} in the Rounds drawer`}>Round<ChevronRightIcon size={12} /></a>
        <a className="link" href={matchHref(r.file, "replay", { round: r.round })} aria-label={`Open ${where} in the 2D replay`}>Replay<ChevronRightIcon size={12} /></a>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------- the render dialog

function Tool({ name, f, children }: { name: string; f: { path: string | null; error: string | null } | null; children?: ReactNode }) {
  const hide = useHidePersonal();
  const text = f?.path ?? f?.error ?? "Not checked";
  return (
    <div className="rtool" data-ok={f?.path ? true : undefined}>
      <dt>{name}</dt>
      <dd>
        <span className={f?.path ? "mono selectable" : "rtool__err"}>{hide ? hideText(text) : text}</span>
        {children}
      </dd>
    </div>
  );
}

function RenderDialog({ items, tools, hlae, setHlae, instant, onClose }: { items: Item[]; tools: Tools & { recheck: () => void }; hlae: string; setHlae: (p: string) => void; instant: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const hide = useHidePersonal();
  const [draft, setDraft] = useState(hlae);
  const [busy, setBusy] = useState<"save" | "launch" | null>(null);
  const [done, setDone] = useState<{ pid: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const env = tools.env;
  // the moments chosen when the dialog opened, so the plan is asked for again only when the tools change
  const ready = useMemo(() => items.filter((i) => i.state.kind === "ready" && i.src.kind === "demo"), [items]);
  const request = useMemo(() => (env?.hlae.path
    ? jobRequest(ready.map((i) => ({ ...i.row, demo: (i.src as Extract<DemoSource, { kind: "demo" }>).name })), env.hlae.path)
    : null), [env, ready]);
  // the host builds the plan without writing anything, for the user to read before Save or Launch
  const [plan, setPlan] = useState<{ plan: RenderPlan | null; problem: string | null }>({ plan: null, problem: "Building the plan…" });
  useEffect(() => {
    if (!env) { setPlan({ plan: null, problem: "The tools are still being checked." }); return; }
    if (!env.hlae.path) { setPlan({ plan: null, problem: env.hlae.error }); return; }
    if (!env.cs2.path) { setPlan({ plan: null, problem: env.cs2.error }); return; }
    if (!request || !tools.host) return;
    let alive = true;
    tools.host.plan(request, false).then(
      (p) => alive && setPlan({ plan: p, problem: null }),
      (e) => alive && setPlan({ plan: null, problem: String(e) }),
    );
    return () => { alive = false; };
  }, [env, request, tools.host]);
  const show = (s: string) => (hide ? hideText(s) : s);
  const total = ready.reduce((s, i) => s + durationOf(i.row), 0);

  const run = async (what: "save" | "launch") => {
    if (!request || !tools.host) return;
    setBusy(what); setFailed(null);
    try {
      // the host builds the job again and saves it in a new folder; the launch builds it once more from that
      const saved = await tools.host.plan(request, true);
      toast(`Plan saved in ${show(saved.jobDir)}`, "good");
      if (what === "launch") setDone({ pid: (await tools.host.launch(saved.id)).pid });
      else close();
    } catch (e) {
      setFailed(String(e));
    } finally {
      setBusy(null);
    }
  };
  const close = () => { ref.current?.close(); };
  const p = plan.plan;

  return (
    <dialog ref={ref} className={`rdlg ${instant ? "is-instant" : ""}`} aria-labelledby="rdlg-title" onClose={onClose}>
      <header className="rdlg__head">
        <h2 id="rdlg-title">Render {plural(ready.length, "clip")} in CS2</h2>
        <span className="meta num">{clock(total)} of video</span>
        <button className="btn btn--ghost btn--icon btn--sm press" onClick={close} aria-label="Close"><CloseIcon size={16} /></button>
      </header>
      <div className="rdlg__body">
        <div className="rdlg__warn" role="note">
          <strong>This starts CS2 with -insecure.</strong>
          <p>HLAE needs it to record, and it keeps VAC off for that session. CS2 opens, plays each demo, records the clips from your view, then quits by itself. Close CS2 first, and leave the game alone until it quits.</p>
        </div>

        <dl className="rtools">
          <Tool name="HLAE" f={env?.hlae ?? null}>
            <form className="rtool__pick" onSubmit={(e) => { e.preventDefault(); setHlae(draft.trim()); }}>
              <input className="input mono" value={hide && draft ? hideText(draft) : draft} onChange={(e) => setDraft(e.target.value)} placeholder="Path to HLAE.exe" aria-label="Path to HLAE.exe" readOnly={hide} spellCheck={false} />
              <button className="btn btn--sm press" type="submit" disabled={hide}>Check</button>
            </form>
          </Tool>
          <Tool name="CS2" f={env?.cs2 ?? null} />
          <Tool name="FFmpeg" f={env?.ffmpeg ?? null} />
        </dl>

        {p ? (
          <>
            <section className="rdlg__sec">
              <h3 className="caps">What runs, as a PowerShell command</h3>
              <pre className="rdlg__cmd mono selectable">{show(p.powershell)}</pre>
              <button className="btn btn--ghost btn--sm press" onClick={() => copyText(p.powershell, "PowerShell command copied")}><CopyIcon size={12} />Copy for PowerShell</button>
            </section>
            <section className="rdlg__sec">
              <h3 className="caps">What it writes</h3>
              <ul className="rdlg__files">
                <li><span className="mono">{show(p.jobDir.replace(/[^\\/]+$/, "<new job>"))}</span><span className="meta">a new folder for the plan, the director script, and HLAE's raw takes</span></li>
                <li><span className="mono">game\csgo\cfg\{p.cfgFile}</span><span className="meta">one line that loads the director: <code className="mono">{show(p.cfgText.trim())}</code></span></li>
                <li><span className="mono">ffmpeg\ffmpeg.ini</span><span className="meta">beside HLAE.exe, only if HLAE has no FFmpeg of its own</span></li>
              </ul>
            </section>
            <section className="rdlg__sec">
              <h3 className="caps">Clips</h3>
              <ol className="rdlg__clips">
                {p.demos.flatMap((d) => d.clips.map((c) => (
                  <li key={c.id}><span>{show(c.reason)}</span><span className="meta mono">{show(d.path.slice(d.path.search(/[^\\/]+$/)))} · ticks {c.start}–{c.end} · {clock((c.end - c.start) / d.tickRate)}</span></li>
                )))}
              </ol>
            </section>
          </>
        ) : (
          <p className="rdlg__problem" role="alert">{plan.problem ? show(plan.problem) : "No plan yet."}</p>
        )}
        {failed && <p className="rdlg__problem" role="alert">{show(failed)}</p>}
        {done && (
          <p className="rdlg__done" role="status">CS2 is starting through HLAE (process {done.pid}). It quits by itself when the clips are recorded; then press Check again here or on the page, and finish the recorded clips.</p>
        )}
      </div>
      <footer className="rdlg__foot">
        {done ? (
          <button className="btn btn--primary press" onClick={close}>Close</button>
        ) : (
          <>
            <button className="btn btn--ghost press" onClick={close}>Cancel</button>
            <button className="btn press" disabled={!p || busy !== null} onClick={() => run("save")}>{busy === "save" ? "Saving…" : "Save the plan only"}</button>
            <button className="btn btn--primary press" disabled={!p || busy !== null} onClick={() => run("launch")}>
              <PlayIcon size={14} />{busy === "launch" ? "Starting…" : "Launch CS2 with -insecure"}
            </button>
          </>
        )}
      </footer>
    </dialog>
  );
}

// ---------------------------------------------------------------- the page

export default function ClipsView() {
  const { matches } = useData();
  const list = useMemo(() => careerEntries(matches, null), [matches]);
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const q = useYourQuery(list);
  const call = useCall("moments", q ? [q] : null);
  const rows = call.stale ? null : call.data;
  const sources = useMemo(() => new Map(list.map((e) => [e.file, demoSource(e)])), [list]);
  const names = useMemo(() => [...new Set([...sources.values()].flatMap((s) => (s.kind === "demo" ? [s.name] : [])))].sort(), [sources]);
  const [hlae, setHlaeState] = useState(() => savedHlae() ?? "");
  const setHlae = (p: string) => { setHlaeState(p); saveHlae(p); };
  const tools = useClipTools(names, hlae || null);
  const [show, setShow] = useState<Show>("all");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ instant: boolean; items: Item[] } | null>(null);
  const [limit, setLimit] = useState(PAGE);
  // a keyboard choice brings the bar in without motion (design/shell-and-motion.md: keyboard actions never animate)
  const [barInstant, setBarInstant] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const hide = useHidePersonal();

  const items: Item[] = useMemo(() => (rows ?? []).map((row, i) => {
    const src = sources.get(row.file) ?? { kind: "none" as const, why: "The match is no longer listed." };
    return { row, rank: i + 1, entry: byFile.get(row.file), src, state: clipState(row.id, src, tools.lookup) };
  }), [rows, sources, byFile, tools.lookup]);
  const count = { all: items.length, ready: items.filter((i) => i.state.kind === "ready").length, needs: items.filter((i) => isNeeds(i.state)).length, done: items.filter((i) => isDone(i.state)).length };
  const shown = items.filter((i) => show === "all" || (show === "ready" ? i.state.kind === "ready" : show === "needs" ? isNeeds(i.state) : isDone(i.state)));
  const picked = items.filter((i) => chosen.has(i.row.id) && choosable(i.state));
  const pick = (kind: ClipState["kind"]) => picked.filter((i) => i.state.kind === kind);
  // why moments need a demo, most common first, so the page says it once rather than on every row
  const whys = useMemo(() => {
    const n = new Map<string, number>();
    for (const i of items) if (isNeeds(i.state)) { const w = (i.state as { why: string }).why; n.set(w, (n.get(w) ?? 0) + 1); }
    return [...n].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const setOne = (id: string, on: boolean, keyboard: boolean) => {
    if (!picked.length) setBarInstant(keyboard);
    setChosen((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  };
  const env = tools.env;
  const canEdit = !!(tools.host && env?.ffmpeg.path && env.font);
  const editWhy = !tools.host ? "Needs the desktop app" : !env?.ffmpeg.path ? env?.ffmpeg.error ?? "Checking for FFmpeg" : !env.font ? "No font for the lower third was found" : undefined;

  /** The lower third's text as the clip will burn it in: with personal info hidden when the setting is on (privacy.ts). */
  const lowerThird = (t: string) => (hidingPersonal() ? hideText(t) : t);
  /** Finishes recorded takes: trimmed to the moment, the lower third, sound or silence (the host's template, ffmpeg.rs). */
  const finish = async (its: Item[]) => {
    if (!tools.host) return;
    setWorking(`Finishing ${plural(its.length, "clip")}…`);
    let ok = 0;
    try {
      for (const it of its) {
        const take = (it.state as { take: Take }).take;
        const r = await tools.host.finish({ id: it.row.id, job: take.job, take: take.take, reason: lowerThird(it.row.reason), subline: lowerThird(subline(it.row, it.entry)), durationS: durationOf(it.row) }, hlae || null);
        if (r.code === 0) ok++;
        else toast(`FFmpeg could not finish "${it.row.reason}": ${(r.error ?? "").split("\n").pop()}`, "poor");
      }
    } catch (e) {
      // the host refused or could not start FFmpeg; the toast hides any path it names (overlay.tsx)
      toast(`FFmpeg could not finish the clips: ${String(e)}`, "poor");
    } finally {
      setWorking(null);
      if (ok) toast(`Finished ${plural(ok, "clip")}`, "good");
      tools.recheck();
    }
  };
  /** Joins the chosen rendered clips, best first, into one reel (the host's template, ffmpeg.rs). */
  const reel = async (its: Item[]) => {
    if (!tools.host || !env) return;
    setWorking("Making the reel…");
    try {
      const r = await tools.host.reel(its.map((i) => i.row.id), hlae || null);
      if (r.code === 0) toast(`Reel saved: ${hide ? "<clips folder>\\reels" : r.output}`, "good");
      else toast(`FFmpeg could not make the reel: ${(r.error ?? "").split("\n").pop()}`, "poor");
    } catch (e) {
      toast(`FFmpeg could not make the reel: ${String(e)}`, "poor");
    } finally {
      setWorking(null);
      tools.recheck();
    }
  };
  // why a chosen action cannot run: a disabled button takes no focus and shows no tooltip
  // (components.css), so the reason is written beside the buttons and named by aria-describedby
  const nRecorded = pick("recorded").length, nRendered = pick("rendered").length, nReady = pick("ready").length;
  const why = [
    nReady > 0 && !tools.host ? "Rendering runs in the desktop app." : null,
    (nRecorded > 0 || nRendered > 1) && !canEdit && editWhy ? editWhy : null,
    nRendered === 1 ? "Choose two rendered clips or more to make a reel." : null,
  ].filter((x): x is string => !!x).join(" ");

  const toolDot = (name: string, f: { path: string | null; error: string | null } | undefined) => (
    <span className="ctool" data-ok={f?.path ? true : undefined} data-tip={f ? (hide ? hideText(f.path ?? f.error ?? "") : f.path ?? f.error ?? "") : "Not checked"}>
      <i aria-hidden />{name}<span className="sr-only">{f?.path ? ": found" : ": not found"}</span>
    </span>
  );

  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Clips" }]} />
      <div className="view__in clips">
        <header className="clips__head">
          <div>
            <h1 className="clips__title">Your best moments</h1>
            <p className="meta">
              Ranked by multi-kills, clutches won, round impact, flicks and opening kills across your matches. Each clip is your view, from five seconds before your first kill to three after your last, within the round. {ROUND_IMPACT_TIP}
            </p>
          </div>
          <div className="clips__tools" aria-label="Rendering tools">
            {tools.host ? (
              <>
                {toolDot("CS2", env?.cs2)}
                {toolDot("HLAE", env?.hlae)}
                {toolDot("FFmpeg", env?.ffmpeg)}
                <button className="btn btn--ghost btn--sm press" onClick={tools.recheck} disabled={tools.checking}><RefreshIcon size={12} />{tools.checking ? "Checking…" : "Check again"}</button>
              </>
            ) : (
              <span className="meta">Rendering runs in the desktop app</span>
            )}
          </div>
        </header>

        {call.error && !call.stale ? <LoadFailed what="Moments" error={call.error} /> : !rows ? <div className="skel" style={{ height: 320 }} /> : !items.length ? (
          <Empty icon={<ClipsIcon size={20} />} text="No moments yet: no 3K, won clutch, high-swing, flick or opening kill in your matches." />
        ) : (
          <>
            <div className="clips__bar">
              <Segmented label="Show" value={show} onChange={(v) => { setShow(v); setLimit(PAGE); }} options={[
                { value: "all", label: <>All <span className="hl-seg__n num">{count.all}</span></> },
                { value: "ready", label: <>Ready to render <span className="hl-seg__n num">{count.ready}</span></>, disabled: !count.ready },
                { value: "needs", label: <>Needs a demo <span className="hl-seg__n num">{count.needs}</span></>, disabled: !count.needs },
                { value: "done", label: <>Recorded or rendered <span className="hl-seg__n num">{count.done}</span></>, disabled: !count.done },
              ]} />
            </div>
            {whys.length > 0 && (show === "all" || show === "needs") && (
              <ul className="clips__whys" aria-label="Why some moments need a demo">
                {whys.map(([why, n]) => <li key={why}><span className="num">{n}</span> {n === 1 ? "moment needs" : "moments need"} a demo. {hide ? hideText(why) : why}</li>)}
              </ul>
            )}
            {tools.error && <p className="rdlg__problem" role="alert">{hide ? hideText(tools.error) : tools.error}</p>}
            <ol className="clips__list" aria-label="Moments, best first">
              {shown.slice(0, limit).map((it) => <ClipRow key={it.row.id} it={it} chosen={chosen.has(it.row.id)} onChoose={(on, kb) => setOne(it.row.id, on, kb)} clipsDir={env?.clipsDir ?? null} />)}
            </ol>
            {shown.length > limit && (
              <button className="btn btn--ghost btn--sm press clips__more" onClick={() => setLimit((n) => n + PAGE * 2)}>
                Show {Math.min(PAGE * 2, shown.length - limit)} more<span className="faint"> of {shown.length - limit}</span>
              </button>
            )}
          </>
        )}

        {picked.length > 0 && (
          <div className={`clips__act ${barInstant ? "is-instant" : ""}`} role="region" aria-label="Chosen moments">
            <span className="clips__act-n"><span className="num">{picked.length}</span> chosen · <span className="mono">{clock(picked.reduce((s, i) => s + durationOf(i.row), 0))}</span></span>
            <button className="btn btn--ghost btn--sm press" onClick={() => setChosen(new Set())}>Clear</button>
            <span className="clips__act-why meta" id="clips-act-why" role="status">{working ?? (hide ? hideText(why) : why)}</span>
            {nRecorded > 0 && (
              <button className="btn btn--sm press" disabled={!canEdit || !!working} aria-describedby="clips-act-why" onClick={() => finish(pick("recorded"))}>Finish {plural(nRecorded, "clip")}</button>
            )}
            {nRendered > 0 && (
              <button className="btn btn--sm press" disabled={!canEdit || !!working || nRendered < 2} aria-describedby="clips-act-why" onClick={() => reel(pick("rendered"))}>Make a reel of {nRendered}</button>
            )}
            {nReady > 0 && (
              <button className="btn btn--primary btn--sm press" disabled={!tools.host} aria-describedby="clips-act-why" onClick={(e) => setDialog({ instant: fromKeyboard(e), items: pick("ready") })}>
                <PlayIcon size={12} />Render {plural(nReady, "clip")}…
              </button>
            )}
          </div>
        )}
        {dialog && <RenderDialog items={dialog.items} tools={tools} hlae={hlae} setHlae={setHlae} instant={dialog.instant} onClose={() => { setDialog(null); tools.recheck(); }} />}
      </div>
    </div>
  );
}
