// Data & settings: where matches come from, what each source supports, import, the Leetify connection
// (leetify/LeetifyConnect.tsx), the optional packs,
// hiding personal info, and which models the numbers use. It stays usable when the match folder cannot
// be read (App.tsx), since Rescan, Import and the converted-log switch are the ways out; the failure
// shows on Sources. It is the one view that shows the host's folders, the Valve user and the
// importer's output, so it hides those itself while personal info is hidden (data/privacy.ts).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DERIVE_VERSION } from "../../stats/facts";
import { isBundled, PACKS_FOLDER, samplesShown, setSamplesShown, VALVE_FOLDER, type ValveImport } from "../../host/host";
import type { ImportStatus } from "../../host/import-store";
import { useIconManifest } from "../data/icons";
import { knownMaps, radarIcon } from "../data/maps";
import { useAgents, usePros } from "../data/packs";
import { SourceBadge } from "../components/bits";
import { Card } from "../components/Card";
import { copyText, toast } from "../components/overlay";
import { rating3Note, ratingHeadline, winProbText } from "../data/engine";
import { ratingInfo } from "../data/meta";
import { FOLDER_HIDDEN, hideTextAndFiles, privacyForced, setHidePersonal, STEAMID_HIDDEN, useHidePersonal, useSavedHidePersonal } from "../data/privacy";
import { useData } from "../data/provider";
import { scanErrorText, sourceOf, SUPPORT, SUPPORT_NOTE, SOURCE_LABEL, type SourceId } from "../data/sources";
import { CheckIcon, CloseIcon, CopyIcon, FolderIcon, RefreshIcon, UploadIcon } from "../icons/ui";
import { fmtWhen, plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { poolLabel } from "../../worker/pool-names";
import { KeyChips, SHORTCUTS } from "../shell/Palette";
import { LeetifyConnect } from "./leetify/LeetifyConnect";

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
/** A build date, read as a local day when it is a bare YYYY-MM-DD; the raw text when it does not parse. */
const builtText = (s: string) => {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s);
  return Number.isNaN(d.getTime()) ? s : dayFmt.format(d);
};

/** A folder path that keeps its end visible (the part that names the folder) and truncates the middle. */
function PathText({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf("\\", path.length - 2), path.lastIndexOf("/", path.length - 2));
  const parent = path.lastIndexOf("\\", cut - 1);
  const at = parent > 0 ? parent : cut;
  return (
    <span className="path mono selectable" data-tip={path}>
      <span className="path__head">{at > 0 ? path.slice(0, at) : path}</span>
      {at > 0 && <span className="path__tail">{path.slice(at)}</span>}
    </span>
  );
}

function Support({ v }: { v: boolean | string }) {
  if (v === true) return <CheckIcon size={14} className="muted" aria-label="Yes" />;
  if (v === false) return <CloseIcon size={14} className="faint" aria-label="No" />;
  return <span className="meta has-def" tabIndex={0} data-tip={v}>Partly</span>;
}


const capitalised = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
export default function Settings() {
  const { host, matches, fileErrors, baselines, baselinesError, refresh, lastSync, status, error } = useData();
  const input = useRef<HTMLInputElement>(null);
  const [showSamples, setShow] = useState(samplesShown());
  const hide = useHidePersonal();
  const counts: Record<SourceId, number> = { recorded: 0, converted: 0, pro: 0, synthetic: 0, valve: 0 };
  for (const s of matches) counts[sourceOf(s).id]++;
  const bundled = matches.filter((s) => isBundled(s.file)).length;
  const newest = (id: SourceId) => matches.find((s) => sourceOf(s).id === id);
  const rescan = () => { refresh(); toast("Scanning the match folder"); };
  // during the first scan the counts are unknown, not zero
  const reading = !matches.length && (status === "starting" || status === "syncing");
  const count = (id: SourceId) => (reading ? "–" : counts[id]);

  const onImport = async (files: FileList | null) => {
    if (!files || !host) return;
    const r = await host.importFiles([...files]);
    if (r.imported.length) toast(`Imported ${plural(r.imported.length, "match file")}`, "good");
    // the file names are hidden as the toast draws, so turning the setting on hides them in a toast already showing
    for (const s of r.skipped) toast(`${s.name} was not imported: ${s.reason}`, "poor", 6000, [s.name]);
    refresh();
    if (input.current) input.current.value = "";
  };

  const notes = SUPPORT.filter((s) => SUPPORT_NOTE[s.stat]);
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Data & settings" }]} />
      <div className="view__in settings">
        <Card title="Sources" aside={<button className="btn btn--sm press" onClick={rescan} aria-keyshortcuts="Control+R"><RefreshIcon size={14} />Rescan</button>}>
          {status === "error" && (
            <div className="settings__failed" role="alert">
              <p><b>The last scan failed.</b> {scanErrorText(error ?? "")}</p>
              {error && <details><summary>Details</summary><p className="mono selectable">{error}</p></details>}
            </div>
          )}
          <div className="sources">
            <div className="source">
              <div className="source__head"><SourceBadge s={{ id: "recorded", label: SOURCE_LABEL.recorded, missing: [] }} compact /><b className="num source__n">{count("recorded")}</b></div>
              <p className="meta">Written by the capture plugin while you play: aim, movement, economy and utility.</p>
              <div className="source__path">
                <FolderIcon size={14} />
                <PathText path={host?.folder ? (hide ? FOLDER_HIDDEN.data : host.folder) : "%APPDATA%\\BotMatchStats\\matches"} />
                {host?.folder && <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(host.folder!, "Folder path copied", FOLDER_HIDDEN.data)} aria-label="Copy the folder path"><CopyIcon size={14} /></button>}
              </div>
              <p className="meta">
                {reading ? "Reading the folder…" : newest("recorded") ? `Newest ${fmtWhen(newest("recorded")!.match)}.` : "None yet."}
                {lastSync ? <span className="nowrap"> Scanned {timeFmt.format(lastSync)}.</span> : null}
              </p>
            </div>
            <div className="source">
              <div className="source__head"><SourceBadge s={{ id: "converted", label: SOURCE_LABEL.converted, missing: [] }} compact /><b className="num source__n">{count("converted")}</b></div>
              <p className="meta">Your older matches, converted from the game's console log and shipped with the app. No aim or movement; rounds the log holds only as totals are left out.</p>
              <label className="check">
                <input type="checkbox" checked={showSamples} onChange={(e) => { setSamplesShown(e.target.checked); setShow(e.target.checked); refresh(); }} />
                <span>Show {plural(bundled || 5, "converted match", "converted matches")}</span>
              </label>
            </div>
            <div className="source">
              <div className="source__head"><span className="src"><UploadIcon size={14} /><span>Import</span></span></div>
              <p className="meta">{host?.kind === "tauri" ? "Copies .json.gz match files into the match folder, under imported." : "Adds .json.gz match files until you close the app."}</p>
              <input ref={input} type="file" accept=".gz,application/gzip" multiple hidden onChange={(e) => onImport(e.target.files)} />
              <button className="btn press" onClick={() => input.current?.click()}><UploadIcon size={14} />Choose match files</button>
            </div>
            <ValveSource n={counts.valve} />
          </div>
          {counts.pro > 0 && <p className="meta settings__pro">{plural(counts.pro, "pro demo is", "pro demos are")} listed in Matches from the development folder. They open like any match and never count toward your career.</p>}
        </Card>

        <LeetifyConnect />

        <Packs />

        <Privacy />

        <div className="settings__pair">
          <Card title="What each source supports" flush foot={notes.length ? <>{notes.map((s) => <span key={s.stat}>* {SUPPORT_NOTE[s.stat]}</span>)}</> : undefined}>
            <div className="tbl-wrap">
              <table className="tbl settings__support">
                <thead>
                  <tr>
                    <th className="l"><span className="th">Stat</span></th>
                    <th className="c"><span className="th">Recorded</span></th>
                    <th className="c"><span className="th">Converted</span></th>
                    <th className="c"><span className="th">Pro demo</span></th>
                  </tr>
                </thead>
                <tbody>
                  {SUPPORT.map((s) => (
                    <tr key={s.stat}>
                      <td className="l settings__stat">{s.stat}{SUPPORT_NOTE[s.stat] && <span className="faint"> *</span>}</td>
                      <td className="c"><Support v={s.recorded} /></td>
                      <td className="c"><Support v={s.converted} /></td>
                      <td className="c"><Support v={s.pro} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Models and versions">
            <dl className="facts facts--wide">
              <dt>Round win probability</dt>
              <dd className="meta">{winProbText()}</dd>
              <dt>Rating</dt>
              {/* main's "Calibrating" chip, now params.json's own word for the model's state: the weights are fitted */}
              <dd><span className="has-def" tabIndex={0} data-tip={rating3Note()}>{ratingHeadline()}</span><span className="chip chip--outline settings__chip">{capitalised(ratingInfo().status)}</span></dd>
              <dt>Rating 3.0 weights</dt>
              <dd className="meta">{capitalised(ratingInfo().weights)}.</dd>
              <dt>Pro percentiles</dt>
              <dd className="meta">{baselines ? (
                <>
                  <span className="settings__pool">{poolLabel(baselines.pool, baselines.model)}.</span>{" "}
                  {baselines.source}. <span className="nowrap">Built {builtText(baselines.built)}.</span>
                  {baselines.localError && <span className="poor-text selectable"> The local pool was not used: {baselines.localError}.</span>}
                </>
              ) : baselinesError ?? "Loading"}</dd>
              <dt>Stats engine</dt>
              <dd className="meta num">Version {DERIVE_VERSION}</dd>
              <dt>Map images</dt>
              <dd className="meta">Radars and emblems from the game icons pack below, which scripts/extract-icon-pack.cjs builds from your own CS2 install. Without it, maps are drawn from where players stood.</dd>
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
              <div key={k} className="keys__row"><dt>{l}</dt><dd><KeyChips keys={k} /></dd></div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}

const IDLE_IMPORT: ImportStatus = { running: false, at: null, last: null, error: null };
const noImports = () => () => {};

/** What an import's end says, by the importer's exit code (extractor/valve_import.py), and the demos it names. */
function importOutcome(r: ValveImport): { text: string; tone: "good" | "poor"; demos: string[] } {
  const s = r.summary;
  if (r.code === 0 && s) return { text: `${plural(s.demos, "demo")} imported; every one matches its scoreboard.`, tone: "good", demos: [] };
  if (r.code === 1 && s) {
    const bad = s.results.filter((x) => !x.ok).map((x) => x.demo);
    return { text: `${bad.length} of ${s.demos} failed validation and are not shown: ${bad.join(", ")}.`, tone: "poor", demos: bad };
  }
  return { text: r.error ?? `The importer stopped with exit code ${r.code ?? "none"}.`, tone: "poor", demos: s?.results.map((x) => x.demo) ?? [] };
}

/** The user's Valve matchmaking matches: where they are, whose they are, and the importer. */
function ValveSource({ n }: { n: number }) {
  const { host } = useData();
  // The import's state lives in the host, so an import keeps showing after navigating away and back.
  const status = useSyncExternalStore(host?.imports.subscribe ?? noImports, host ? host.imports.get : () => IDLE_IMPORT);
  useEffect(() => { void host?.imports.sync(); }, [host]);
  // the app shell rescans when an import ends (provider.tsx), so this page only shows the state
  const hide = useHidePersonal();
  const shown = (s: string, files: string[] = []) => (hide ? hideTextAndFiles(s, files) : s);
  const folder = host?.valve?.folder ?? VALVE_FOLDER;
  const run = () => { if (host && !status.running) void host.imports.start(); };
  const outcome = status.last && !status.running ? importOutcome(status.last) : null;
  return (
    <div className="source">
      <div className="source__head"><SourceBadge s={{ id: "valve", label: "Valve matchmaking", missing: [] }} compact /><b className="num source__n">{n}</b></div>
      <p className="meta">Your matchmaking demos from the game's replays folder, with aim, movement and line of sight. Wingman matches are listed but left out of career views.</p>
      <div className="source__path">
        <FolderIcon size={14} />
        <span className="mono selectable">{hide && host?.valve?.folder ? FOLDER_HIDDEN.valve : folder}</span>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(folder, "Folder path copied", host?.valve?.folder ? FOLDER_HIDDEN.valve : undefined)} aria-label="Copy the Valve folder path"><CopyIcon size={14} /></button>
      </div>
      <p className="meta">
        {host?.valve?.error ? <span className="poor-text selectable">{shown(host.valve.error)}</span>
          : host?.valve?.userError ? <span className="poor-text selectable">{shown(host.valve.userError)}. Matches are listed without you until it is fixed.</span>
          : host?.valve?.user ? <>Your SteamID64 <span className="mono selectable">{hide ? STEAMID_HIDDEN : host.valve.user}</span>.</>
          : "The first import takes your SteamID64 from Steam's most recent login."}
        {host?.valve?.skipped.length ? ` ${plural(host.valve.skipped.length, "folder")} without a complete match.` : ""}
      </p>
      <button className="btn press" onClick={run} disabled={!host || status.running} aria-busy={status.running}>
        <RefreshIcon size={14} />{status.running ? "Importing" : "Import Valve matches"}
      </button>
      <p className="meta" role="status" aria-live="polite">
        {status.running && (status.at ? `Demo ${status.at.i} of ${status.at.n}${status.at.event === "done" ? (status.at.ok ? ", done" : ", failed") : ""}` : "Starting the importer")}
        {status.error && !status.running ? <span className="poor-text">{shown(status.error)}</span>
          : outcome && <span className={outcome.tone === "good" ? "good-text" : "poor-text"}>{shown(outcome.text, outcome.demos)}</span>}
      </p>
    </div>
  );
}

/** The optional packs: pro scores for "Plays like", agent art for the player card, and the game's icons and map art. */
function Packs() {
  // a pack's "source" is free text its builder wrote, which can name the folder it was built from
  const hide = useHidePersonal();
  const shown = (s: string) => (hide ? hideTextAndFiles(s, []) : s);
  const pros = usePros();
  const agents = useAgents();
  const icons = useIconManifest();
  const radars = icons ? knownMaps().filter((m) => icons.icons[radarIcon(m)!]).length : 0;
  const iconText = icons === undefined ? "Loading"
    : icons ? `${Object.keys(icons.icons).length} icons, radars for ${radars} of ${knownMaps().length} maps. ${icons.source}`
    : "Not installed. Weapons and kill flags show their names, and maps are drawn from where players stood.";
  const proText = pros.state === "ready" ? `${pros.pros.length} pros for Plays like. ${pros.source}` : pros.state === "missing" ? "Not installed. Plays like stays hidden until pros.json is in the packs folder." : pros.state === "error" ? pros.message : "Loading";
  const agentText = !agents ? "Loading" : agents.t && agents.ct ? "T and CT renders" : agents.t || agents.ct ? "One side only; the other draws a silhouette." : "Not installed. The player card draws silhouettes.";
  return (
    <Card title="Packs" aside={<span className="meta">Optional files you add yourself</span>}>
      <div className="source__path">
        <FolderIcon size={14} />
        <PathText path={PACKS_FOLDER} />
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(PACKS_FOLDER, "Folder path copied")} aria-label="Copy the packs folder path"><CopyIcon size={14} /></button>
      </div>
      <dl className="facts facts--wide packs">
        <dt>Pro pack <span className="mono faint">pros.json</span></dt>
        <dd><span className="packline"><span className={`packdot ${pros.state === "ready" ? "is-on" : ""}`} />{shown(proText)}</span></dd>
        <dt>Agent art <span className="mono faint">agents/*.png</span></dt>
        <dd><span className="packline"><span className={`packdot ${agents?.t && agents?.ct ? "is-on" : ""}`} />{agentText}</span></dd>
        <dt>Game icons <span className="mono faint">icons/manifest.json</span></dt>
        <dd><span className="packline"><span className={`packdot ${icons ? "is-on" : ""}`} />{shown(iconText)}</span></dd>
      </dl>
    </Card>
  );
}

/**
 * Hide personal info: names, SteamIDs and paths become placeholders on every page (data/privacy.ts).
 * The capture switch holds it on for the session, so the box shows that and cannot be cleared.
 */
function Privacy() {
  const hide = useHidePersonal();
  const saved = useSavedHidePersonal();
  const forced = privacyForced();
  return (
    <Card title="Privacy">
      <div className="privacy">
        <label className="check">
          <input type="checkbox" checked={hide} disabled={forced} aria-describedby="privacy-what" onChange={(e) => { const problem = setHidePersonal(e.target.checked); if (problem) toast(problem, "poor", 6000); }} />
          <span>Hide personal info</span>
        </label>
        <p className="meta" id="privacy-what">
          For screenshots and screen sharing. Your name shows as You, other people in your matches as Teammate 1 or Opponent 3, and SteamIDs and folder paths as placeholders. Bots and players in pro demos keep their names. Every number stays as it is.
        </p>
        {forced && <p className="meta">On for this session: the app was started with the privacy switch, <span className="mono nowrap">VITE_PRIVACY=1</span> or <span className="mono nowrap">?privacy=1</span>.{saved ? "" : " Your saved setting is off."}</p>}
      </div>
    </Card>
  );
}
