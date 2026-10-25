// Data & settings: where matches come from, what each source supports, import, and which model and
// rating versions the numbers use.
import { useRef, useState } from "react";
import { DERIVE_VERSION } from "../../stats/facts";
import { isBundled, PACKS_FOLDER, samplesShown, setSamplesShown, VALVE_FOLDER, type ValveImport, type ValveProgress } from "../../host/host";
import { useAgents, usePros } from "../data/packs";
import { SourceBadge } from "../components/bits";
import { Card } from "../components/Card";
import { copyText, toast } from "../components/overlay";
import { rating3Note, ratingHeadline, winProbText } from "../data/engine";
import { useData } from "../data/provider";
import { sourceOf, SUPPORT, SUPPORT_NOTE, SOURCE_LABEL, type SourceId } from "../data/sources";
import { CheckIcon, CloseIcon, CopyIcon, FolderIcon, RefreshIcon, UploadIcon } from "../icons/ui";
import { fmtMatchDay, plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { SHORTCUTS } from "../shell/Palette";

export default function Settings() {
  const { host, matches, fileErrors, baselines, baselinesError, refresh, lastSync } = useData();
  const input = useRef<HTMLInputElement>(null);
  const [showSamples, setShow] = useState(samplesShown());
  const counts: Record<SourceId, number> = { recorded: 0, converted: 0, synthetic: 0, valve: 0 };
  for (const s of matches) counts[sourceOf(s).id]++;
  const bundled = matches.filter((s) => isBundled(s.file)).length;
  const newest = (id: SourceId) => matches.find((s) => sourceOf(s).id === id);

  const onImport = async (files: FileList | null) => {
    if (!files || !host) return;
    const r = await host.importFiles([...files]);
    if (r.imported.length) toast(`Imported ${plural(r.imported.length, "match file")}`, "good");
    for (const s of r.skipped) toast(`${s.name} was not imported: ${s.reason}`, "poor", 6000);
    refresh();
    if (input.current) input.current.value = "";
  };

  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Data & settings" }]} />
      <div className="view__in settings">
        <Card title="Sources" aside={<button className="btn btn--sm press" onClick={() => { refresh(); toast("Scanning the match folder"); }}><RefreshIcon size={14} />Rescan</button>}>
          <div className="sources">
            <div className="source">
              <div className="source__head"><SourceBadge s={{ id: "recorded", label: SOURCE_LABEL.recorded, missing: [] }} compact /><b className="num source__n">{counts.recorded}</b></div>
              <p className="meta">Written by the capture plugin while you play: aim, movement, economy and utility.</p>
              <div className="source__path">
                <FolderIcon size={14} />
                <span className="mono selectable">{host?.folder ?? "%APPDATA%\\BotMatchStats\\matches"}</span>
                {host?.folder && <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(host.folder!, "Folder path copied")} aria-label="Copy the folder path"><CopyIcon size={14} /></button>}
              </div>
              <p className="meta">{newest("recorded") ? `Newest ${fmtMatchDay(newest("recorded")!.match)}.` : "None yet."} {lastSync ? `Scanned ${new Date(lastSync).toLocaleTimeString()}.` : ""}</p>
            </div>
            <div className="source">
              <div className="source__head"><SourceBadge s={{ id: "converted", label: SOURCE_LABEL.converted, missing: [] }} compact /><b className="num source__n">{counts.converted}</b></div>
              <p className="meta">Older matches converted from the game's console log. No aim or movement; rounds held as totals only are left out.</p>
              <label className="check">
                <input type="checkbox" checked={showSamples} onChange={(e) => { setSamplesShown(e.target.checked); setShow(e.target.checked); refresh(); }} />
                <span>Show the {plural(bundled || 5, "bundled converted match", "bundled converted matches")}</span>
              </label>
            </div>
            <div className="source">
              <div className="source__head"><span className="src"><UploadIcon size={14} /><span>Import</span></span></div>
              <p className="meta">{host?.kind === "tauri" ? "Copies .json.gz match files into the match folder, under imported." : "Adds .json.gz match files for this session."}</p>
              <input ref={input} type="file" accept=".gz,application/gzip" multiple hidden onChange={(e) => onImport(e.target.files)} />
              <button className="btn press" onClick={() => input.current?.click()}><UploadIcon size={14} />Choose match files</button>
            </div>
            <ValveSource n={counts.valve} />
          </div>
        </Card>

        <Packs />

        <div className="grid-2">
          <Card title="What each source supports" flush>
            <table className="tbl">
              <thead><tr><th className="l"><span className="th">Stat</span></th><th className="c"><span className="th">Recorded</span></th><th className="c"><span className="th">Converted log</span></th></tr></thead>
              <tbody>
                {SUPPORT.map((s) => (
                  <tr key={s.stat}>
                    <td className="l" data-tip={SUPPORT_NOTE[s.stat]}>{s.stat}{SUPPORT_NOTE[s.stat] && <span className="faint"> *</span>}</td>
                    <td className="c"><CheckIcon size={14} className="good-text" /></td>
                    <td className="c">{s.converted === true ? <CheckIcon size={14} className="good-text" /> : s.converted === "partial" ? <span className="meta">Partly</span> : <CloseIcon size={14} className="faint" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Models and versions">
            <dl className="facts facts--wide">
              <dt>Round win probability</dt>
              <dd className="meta">{winProbText()}</dd>
              <dt>Rating</dt>
              <dd><span data-tip={rating3Note()}>{ratingHeadline()}</span></dd>
              <dt>Pro baselines</dt>
              <dd className="meta">{baselines ? `${baselines.source}. Built ${baselines.built}.` : baselinesError ?? "Loading"}</dd>
              <dt>Visibility timings</dt>
              <dd className="meta">Time to damage, reaction and crosshair placement need view angles and mesh line of sight; plugin match files carry neither.</dd>
              <dt>Stats engine</dt>
              <dd className="meta num">Derive version {DERIVE_VERSION}</dd>
              <dt>Map images</dt>
              <dd className="meta">Radars and emblems from the game's files, loaded from github.com/MurkyYT/cs2-map-icons.</dd>
            </dl>
          </Card>
        </div>

        {fileErrors.length > 0 && (
          <Card title="Files that could not be read" aside={<span className="meta">{plural(fileErrors.length, "file")}</span>}>
            <ul className="errors">
              {fileErrors.map((e) => <li key={e.file}><span className="mono selectable">{e.file}</span><span className="meta selectable">{e.message}</span></li>)}
            </ul>
          </Card>
        )}

        <Card title="Keyboard" collapsible id="settings-keys">
          <dl className="keys">
            {SHORTCUTS.map(([k, l]) => (
              <div key={k} className="keys__row"><dt>{l}</dt><dd className="kbd">{k.split(" ").map((p) => <kbd key={p}>{p}</kbd>)}</dd></div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}

type ImportState =
  | { phase: "idle" }
  | { phase: "running"; at: ValveProgress | null }
  | { phase: "done"; r: ValveImport }
  | { phase: "failed"; message: string };

/** What an import's end says, by the importer's exit code (extractor/valve_import.py). */
function importOutcome(r: ValveImport): { text: string; tone: "good" | "poor" } {
  const s = r.summary;
  if (r.code === 0 && s) return { text: `${plural(s.demos, "demo")} imported; every one matches its scoreboard.`, tone: "good" };
  if (r.code === 1 && s) {
    const bad = s.results.filter((x) => !x.ok).map((x) => x.demo);
    return { text: `${bad.length} of ${s.demos} failed validation and are not shown: ${bad.join(", ")}.`, tone: "poor" };
  }
  return { text: r.error ?? `The importer stopped with exit code ${r.code ?? "none"}.`, tone: "poor" };
}

/** The user's Valve matchmaking matches: where they are, whose they are, and the importer. */
function ValveSource({ n }: { n: number }) {
  const { host, refresh } = useData();
  const [state, setState] = useState<ImportState>({ phase: "idle" });
  const folder = host?.valve?.folder ?? VALVE_FOLDER;
  const run = async () => {
    if (!host || state.phase === "running") return;
    setState({ phase: "running", at: null });
    try {
      const r = await host.importValve((at) => setState({ phase: "running", at }));
      setState({ phase: "done", r });
    } catch (e) {
      // the desktop app's commands reject with a string, the web host with an Error
      setState({ phase: "failed", message: e instanceof Error ? e.message : String(e) });
    }
    refresh();
  };
  const outcome = state.phase === "done" ? importOutcome(state.r) : null;
  return (
    <div className="source">
      <div className="source__head"><SourceBadge s={{ id: "valve", label: "Valve matchmaking", missing: [] }} compact /><b className="num source__n">{n}</b></div>
      <p className="meta">Your matchmaking demos from the game's replays folder, with aim, movement and line of sight. Wingman matches are listed but left out of career views.</p>
      <div className="source__path">
        <FolderIcon size={14} />
        <span className="mono selectable">{folder}</span>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(folder, "Folder path copied")} aria-label="Copy the Valve folder path"><CopyIcon size={14} /></button>
      </div>
      <p className="meta">
        {host?.valve?.error ? <span className="poor-text selectable">{host.valve.error}</span>
          : host?.valve?.userError ? <span className="poor-text selectable">{host.valve.userError}. Matches are listed without you until it is fixed.</span>
          : host?.valve?.user ? <>Your SteamID64 <span className="mono selectable">{host.valve.user}</span>.</>
          : "The first import takes your SteamID64 from Steam's most recent login."}
        {host?.valve?.skipped.length ? ` ${plural(host.valve.skipped.length, "folder")} without a complete match.` : ""}
      </p>
      <button className="btn press" onClick={() => void run()} disabled={!host || state.phase === "running"} aria-busy={state.phase === "running"}>
        <RefreshIcon size={14} />{state.phase === "running" ? "Importing" : "Import Valve matches"}
      </button>
      <p className="meta" role="status" aria-live="polite">
        {state.phase === "running" && (state.at ? `Demo ${state.at.i} of ${state.at.n}${state.at.event === "done" ? (state.at.ok ? ", done" : ", failed") : ""}` : "Starting the importer")}
        {outcome && <span className={outcome.tone === "good" ? "good-text" : "poor-text"}>{outcome.text}</span>}
        {state.phase === "failed" && <span className="poor-text">{state.message}</span>}
      </p>
    </div>
  );
}

/** The optional packs: pro scores for "Plays like" and agent art for the player card. */
function Packs() {
  const pros = usePros();
  const agents = useAgents();
  const proText = pros.state === "ready" ? `${pros.pros.length} pros. ${pros.source}` : pros.state === "missing" ? "Not installed: Plays like shows how to add it." : pros.state === "error" ? pros.message : "Loading";
  const agentText = !agents ? "Loading" : agents.t && agents.ct ? "T and CT renders" : agents.t || agents.ct ? "One side only; the other draws a silhouette" : "Not installed: the card draws silhouettes";
  return (
    <Card title="Packs" aside={<span className="meta">Kept out of the open-source repository</span>}>
      <div className="source__path">
        <FolderIcon size={14} />
        <span className="mono selectable">{PACKS_FOLDER}</span>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(PACKS_FOLDER, "Folder path copied")} aria-label="Copy the packs folder path"><CopyIcon size={14} /></button>
      </div>
      <dl className="facts facts--wide packs">
        <dt>Pro pack <span className="mono faint">pros.json</span></dt>
        <dd><span className={`packdot ${pros.state === "ready" ? "is-on" : ""}`} />{proText}</dd>
        <dt>Agent art <span className="mono faint">agents/*.png</span></dt>
        <dd><span className={`packdot ${agents?.t && agents?.ct ? "is-on" : ""}`} />{agentText}</dd>
      </dl>
    </Card>
  );
}
