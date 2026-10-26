// Bot Mode: the mod's state in the game folder, the user's Bot Mode settings, the install, update
// and repair actions, and the supervised launch, over the backend in src-tauri/src/botmode (typed in
// src/botmode/commands.ts). Every figure and sentence about the game comes from those commands.
//
// Nothing here changes the game folder or starts CS2 except an action the user confirms in a dialog
// that says what it changes. The backend refuses those writes while CS2 runs or a session holds the
// game; the page disables them in the same cases and says why. Paths, command lines and errors pass
// through the privacy layer (data/privacy.ts).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BotModeApi, Catalog, Change, Checked, Cosmetics, Difficulty, GithubRelease, ReleaseIndex, SessionView, Status } from "../../botmode/commands";
import { Card } from "../components/Card";
import { Segmented } from "../components/controls";
import { GameIcon } from "../components/GameIcon";
import { toast } from "../components/overlay";
import { botModeApi, cosmeticsSupport, damaged, errorText, installState, kitChoices, KNIVES, modPresent, writeBlocker, type InstallState } from "../data/botmode";
import { hideText, useHidePersonal } from "../data/privacy";
import { CheckIcon, ChevronIcon, DownloadIcon, PlayIcon, RefreshIcon, SearchIcon } from "../icons/ui";
import { plural } from "../lib/format";
import { BarContent } from "../shell/Bar";

const stampFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const stamp = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : stampFmt.format(d); };
const day = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : dayFmt.format(d); };

/** Text that can name a folder, a command line or a SteamID, as the privacy setting allows. */
function useShown() {
  const hide = useHidePersonal();
  return useCallback((s: string) => (hide ? hideText(s) : s), [hide]);
}

// ---------------------------------------------------------------- data

interface Loaded {
  status: Status | null;
  statusError: string | null;
  session: SessionView | null;
  catalog: { data: Catalog | null } | { error: string } | null;
  checking: boolean;
  /** why the last read of a running session failed; cleared by the next read that works */
  pollError: string | null;
}

/** GitHub's release list, once per backend for the app's life: it is a network call. */
const releaseCache = new WeakMap<BotModeApi, Promise<GithubRelease[]>>();
function releasesOf(api: BotModeApi, again = false): Promise<GithubRelease[]> {
  let p = releaseCache.get(api);
  if (!p || again) { p = api.releases(); releaseCache.set(api, p); }
  return p;
}

function useBotMode(api: BotModeApi) {
  const [d, setD] = useState<Loaded>({ status: null, statusError: null, session: null, catalog: null, checking: true, pollError: null });
  const [releases, setReleases] = useState<{ list: GithubRelease[] } | { error: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(async () => {
    setD((x) => ({ ...x, checking: true }));
    const [st, se, ca] = await Promise.allSettled([api.status(), api.session(), api.catalog()]);
    if (!alive.current) return;
    setD({
      status: st.status === "fulfilled" ? st.value : null,
      statusError: st.status === "rejected" ? errorText(st.reason) : null,
      session: se.status === "fulfilled" ? se.value : null,
      catalog: ca.status === "fulfilled" ? { data: ca.value } : { error: errorText(ca.reason) },
      checking: false,
      pollError: null,
    });
  }, [api]);

  const loadReleases = useCallback((again = false) => {
    setReleases(null);
    releasesOf(api, again).then((list) => alive.current && setReleases({ list }), (e) => alive.current && setReleases({ error: errorText(e) }));
  }, [api]);

  useEffect(() => { void reload(); loadReleases(); }, [reload, loadReleases]);

  // A session reports through its status file; follow it every two seconds while it runs, and read
  // the whole state again once it ends (Bot Mode off, CS2 closed).
  const supervised = d.session?.supervised ?? false;
  useEffect(() => {
    if (!supervised) return;
    const t = window.setInterval(() => {
      api.session().then((s) => {
        if (!alive.current) return;
        setD((x) => ({ ...x, session: s, pollError: null }));
        if (!s.supervised) void reload();
      }, (e) => alive.current && setD((x) => ({ ...x, pollError: errorText(e) })));
    }, 2000);
    return () => clearInterval(t);
  }, [api, supervised, reload]);

  const setSession = useCallback((s: SessionView) => setD((x) => ({ ...x, session: s })), []);
  return { ...d, releases, reload, loadReleases, setSession };
}

type Dialog =
  | { kind: "install"; tag: string; mode: "install" | "update" | "repair" | "adopt"; instant: boolean }
  | { kind: "overlay"; instant: boolean }
  | { kind: "rollback"; change: Change; instant: boolean }
  | { kind: "launch"; instant: boolean };

/** A click from the keyboard (Enter or Space on a focused button) opens its dialog without motion. */
const fromKeyboard = (e: MouseEvent) => e.detail === 0;

// ---------------------------------------------------------------- the view

export default function BotModeView() {
  const api = botModeApi();
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Bot Mode" }]} />
      {api ? <BotMode api={api} /> : (
        <div className="view__in">
          <Card>
            <div className="empty">
              <p>Bot Mode runs in the desktop app. It installs the mod into your CS2 folder and starts the game, which a browser can't reach.</p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function BotMode({ api }: { api: BotModeApi }) {
  const bm = useBotMode(api);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** builds the last install replaced, until they are applied again: an install never removes them silently */
  const [replaced, setReplaced] = useState<string[]>([]);
  const shown = useShown();
  const { status, session } = bm;
  const releases = bm.releases && "list" in bm.releases ? bm.releases.list : null;
  const state = status ? installState(status, releases) : null;
  const supervised = session?.supervised ?? false;
  const blocker = status ? writeBlocker(status, supervised) : null;

  if (!status || !state) {
    return (
      <div className="view__in bm">
        <section className="card hero bm-hero" aria-busy={bm.checking || undefined} aria-labelledby="bm-state">
          <h1 id="bm-state" className="disp disp--s bm-hero__state">{bm.checking ? "Checking" : "Not available"}</h1>
          {bm.checking ? <p className="meta" role="status">Reading the CS2 folder and hashing the mod's files.</p> : (
            <div className="bm-problem" role="alert">
              <p className="selectable">{shown(bm.statusError ?? "")}</p>
              <button className="btn btn--sm press" onClick={() => void bm.reload()}><RefreshIcon size={14} />Try again</button>
            </div>
          )}
        </section>
      </div>
    );
  }

  const close = () => setDialog(null);
  const done = () => { setDialog(null); void bm.reload(); };
  return (
    <div className="view__in bm">
      <Hero status={status} session={session} state={state} blocker={blocker} checking={bm.checking} onCheck={() => void bm.reload()}
        onLaunch={(e) => setDialog({ kind: "launch", instant: fromKeyboard(e) })}
        onRollback={(e) => { if (status.unfinished) setDialog({ kind: "rollback", change: status.unfinished, instant: fromKeyboard(e) }); }} />
      <div className="bm-cols">
        <Setup api={api} status={status} catalog={bm.catalog} blocker={blocker} reload={bm.reload} />
        <div className="bm-side">
          <Install status={status} state={state} releases={bm.releases} replaced={replaced} blocker={blocker}
            onRetryReleases={() => bm.loadReleases(true)}
            onInstall={(tag, mode, e) => setDialog({ kind: "install", tag, mode, instant: fromKeyboard(e) })}
            onOverlay={(e) => setDialog({ kind: "overlay", instant: fromKeyboard(e) })} />
          <Session session={session} pollError={bm.pollError} />
        </div>
      </div>
      {dialog?.kind === "install" && (
        <InstallDialog api={api} status={status} dialog={dialog} onClose={close} onDone={(names) => { setReplaced(names); done(); }} />
      )}
      {dialog?.kind === "overlay" && (
        <ActionDialog instant={dialog.instant} title="Apply your plugin builds?" confirm="Apply builds" busyText="Checking and copying your builds"
          onClose={close}
          run={async () => {
            const r = await api.overlay();
            setReplaced([]);
            toast(`Applied ${plural(r.entries.length, "build")}: ${r.entries.map((x) => x.name).join(", ")}`, "good");
            done();
          }}>
          <dl className="bm-facts">
            <dt>Copies</dt>
            <dd>The builds listed in <span className="mono">overlay.json</span> in the app's Bot Mode folder, over the release's plugins.{status.overlays.length > 0 && <> Last applied: {status.overlays.map((o) => o.name).join(", ")}.</>}</dd>
            <dt>Checks first</dt>
            <dd>Each local build must be a clean checkout of its branch, with its commit on GitHub. Every entry is checked before the first file is written.</dd>
            <dt>Backs up</dt>
            <dd>Every file it replaces.</dd>
          </dl>
        </ActionDialog>
      )}
      {dialog?.kind === "rollback" && (
        <ActionDialog instant={dialog.instant} title="Roll back the interrupted change?" confirm="Roll back" busyText="Restoring files from the backup"
          onClose={close}
          run={async () => {
            const r = await api.rollback(dialog.change.id);
            toast(`Rolled back ${r.operation}: ${plural(r.restored, "file")} restored`, "good");
            done();
          }}>
          <dl className="bm-facts">
            <dt>Change</dt>
            <dd><span className="mono selectable">{dialog.change.id}</span>, started {stamp(dialog.change.created)}. It stopped part-way, so the game folder may be half-written.</dd>
            <dt>Restores</dt>
            <dd>The {plural(dialog.change.files, "file")} it wrote, from the copies taken before each write.</dd>
            <dt>Stops instead</dt>
            <dd>If another program changed one of those files since. Nothing is restored then, and the error names the file.</dd>
          </dl>
        </ActionDialog>
      )}
      {dialog?.kind === "launch" && (
        <ActionDialog instant={dialog.instant} title="Start CS2 in Bot Mode?" confirm="Launch with -insecure" busyText="Turning Bot Mode on and asking Steam to start CS2"
          onClose={close}
          run={async () => {
            const s = await api.launch();
            bm.setSession(s);
            toast("Steam is starting CS2 in Bot Mode", "good");
            done();
          }}>
          <p className="bm-dialog__lead">CS2 starts with <b className="bm-flag">-insecure</b>, which turns VAC off for this session. Matchmaking and VAC-secured servers stay closed to it until you restart CS2 without Bot Mode.</p>
          <LaunchLine status={status} />
          <dl className="bm-facts">
            <dt>Turns on</dt>
            <dd>Bot Mode, by adding two search paths to <span className="mono">gameinfo.gi</span>. They come out again when CS2 exits.</dd>
            <dt>Watches</dt>
            <dd>Every CS2 of this install until it exits. One started without <span className="mono">-insecure</span> is closed.</dd>
          </dl>
        </ActionDialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- hero

function Hero({ status, session, state, blocker, checking, onCheck, onLaunch, onRollback }: {
  status: Status; session: SessionView | null; state: InstallState; blocker: string | null; checking: boolean;
  onCheck: () => void; onLaunch: (e: MouseEvent) => void; onRollback: (e: MouseEvent) => void;
}) {
  const shown = useShown();
  const supervised = session?.supervised ?? false;
  const word = status.unfinished ? "Interrupted" : supervised ? "In session" : status.cs2Running ? "CS2 is open" : state.kind === "missing" ? "Not installed" : "Ready";
  const tone = status.unfinished ? "poor" : supervised ? "live" : status.cs2Running || state.kind === "missing" ? "idle" : "ready";
  const version = state.kind === "current" || state.kind === "behind" ? state.tag : state.kind === "byHand" ? state.reference : null;
  const launchWhy = state.kind === "missing" ? "Install the mod first." : blocker;
  // the interrupted change has its own sentence and button above; its warning would repeat it
  const warnings = status.warnings.filter((w) => !status.unfinished || !w.startsWith(`Change ${status.unfinished.id} `));
  const sub = status.unfinished
    ? `Change ${status.unfinished.operation} stopped part-way, so the game folder may be half-written. Roll it back before anything else.`
    : supervised ? shown(session?.status?.message ?? "A Bot Mode session is watching CS2.")
    : status.cs2Running ? "Close CS2, then launch Bot Mode, so the game starts with -insecure."
    : state.kind === "missing" ? "The mod's loaders, Metamod and CounterStrikeSharp, aren't in the CS2 folder. Install a release to play with bots."
    : "Bot Mode starts CS2 through Steam and turns itself off when the game exits.";
  return (
    <section className="card hero bm-hero" data-tone={tone} aria-labelledby="bm-state">
      <div className="bm-hero__head">
        <span className="bm-dot" aria-hidden />
        <h1 id="bm-state" className="disp disp--s bm-hero__state">{word}</h1>
        <button className="btn btn--ghost btn--sm press bm-hero__check" onClick={onCheck} disabled={checking} aria-busy={checking || undefined}>
          <RefreshIcon size={14} />{checking ? "Checking" : "Check again"}
        </button>
      </div>
      <p className="bm-hero__sub">{sub}</p>
      <ul className="bm-hero__facts" aria-label="Game state">
        <li><span className="faint">Mod</span> <b>{version ? `CS2-Bot-Improver ${version}` : "none"}</b></li>
        <li><span className="faint">CS2</span> <b>{status.cs2Running === null ? "unknown" : status.cs2Running ? "running" : "closed"}</b></li>
        <li><span className="faint">Bot Mode in gameinfo.gi</span> <b>{status.botMode === null ? "unknown" : status.botMode ? "on" : "off"}</b></li>
        {status.buildId && <li><span className="faint">Steam build</span> <b className="num">{status.buildId}</b></li>}
      </ul>
      {status.unfinished ? (
        <div className="bm-hero__act">
          <button className="btn btn--primary press" onClick={onRollback}>Roll back the change…</button>
        </div>
      ) : (
        <div className="bm-hero__act">
          <LaunchLine status={status} />
          <button className="btn btn--primary press bm-launch" onClick={onLaunch} disabled={!!launchWhy} aria-describedby={launchWhy ? "bm-launch-why" : undefined}>
            <PlayIcon size={14} />Launch Bot Mode…
          </button>
        </div>
      )}
      {launchWhy && !status.unfinished && <p className="meta bm-hero__why" id="bm-launch-why">{launchWhy}</p>}
      {(session?.notice || warnings.length > 0) && (
        <ul className="bm-notes">
          {session?.notice && <li className="selectable">{shown(session.notice)}</li>}
          {warnings.map((w, i) => <li key={i} className="selectable" data-tone="poor">{shown(w)}</li>)}
        </ul>
      )}
      {state.kind !== "missing" && <p className="meta bm-hero__notice">{status.notice}</p>}
    </section>
  );
}

/** The command a launch runs, as the backend builds it: -insecure always first, then the app's options; Steam adds CS2's own. */
function LaunchLine({ status }: { status: Status }) {
  const shown = useShown();
  return (
    <p className="bm-line mono selectable" aria-label="Launch command">
      <span className="faint">steam.exe -applaunch 730</span> <b className="bm-flag">-insecure</b>
      {status.launchOptions && <> <span>{shown(status.launchOptions)}</span></>}
      {status.steamLaunchOptions && <> <span className="bm-line__steam"><span className="faint">then Steam's own</span> {shown(status.steamLaunchOptions)}</span></>}
    </p>
  );
}

// ---------------------------------------------------------------- settings

interface Draft { skins: boolean; premium: boolean; kit: number; difficulty: Difficulty | null; launch: string }
const draftOf = (s: Status): Draft => ({ skins: s.cosmetics.droppedKnifeSkins, premium: s.cosmetics.droppedKnifePremium, kit: s.cosmetics.musicKit, difficulty: s.difficulty, launch: s.launchOptions });
const DIFFICULTY: { value: Difficulty; label: string }[] = [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }];

function Setup({ api, status, catalog, blocker, reload }: {
  api: BotModeApi; status: Status; catalog: { data: Catalog | null } | { error: string } | null; blocker: string | null; reload: () => Promise<void>;
}) {
  const shown = useShown();
  const base = draftOf(status);
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const draft = { ...base, ...edits };
  const changed = (Object.keys(edits) as (keyof Draft)[]).filter((k) => edits[k] !== base[k]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setEdits((e) => ({ ...e, [k]: v }));
  const cat = catalog && "data" in catalog ? catalog.data : null;
  const support = cosmeticsSupport(status);
  const installed = modPresent(status);
  const launchHidden = shown(draft.launch) !== draft.launch;

  const apply = async () => {
    setSaving(true);
    setProblem(null);
    const drop = (...keys: (keyof Draft)[]) => setEdits((e) => { const n = { ...e }; for (const k of keys) delete n[k]; return n; });
    try {
      if (changed.some((k) => k === "skins" || k === "premium" || k === "kit")) {
        const want: Cosmetics = { droppedKnifeSkins: draft.skins, droppedKnifePremium: draft.premium, musicKit: draft.kit };
        const seen: Cosmetics = { droppedKnifeSkins: base.skins, droppedKnifePremium: base.premium, musicKit: base.kit };
        await api.setCosmetics(want, seen);
        drop("skins", "premium", "kit");
      }
      if (changed.includes("difficulty") && draft.difficulty) { await api.setDifficulty(draft.difficulty); drop("difficulty"); }
      if (changed.includes("launch")) { await api.setLaunchOptions(draft.launch.trim()); drop("launch"); }
      toast("Changes applied", "good");
    } catch (e) {
      const text = errorText(e);
      setProblem(text.includes("changed since it was read")
        ? `Something else changed these settings after the page read them, so nothing was saved (${text}). The page now shows the current values; apply again to keep your change.`
        : text);
    }
    await reload();
    setSaving(false);
  };

  const n = changed.length;
  const foot = installed ? (
    <>
      <span className="bm-foot__state" role="status">{saving ? "Applying" : blocker ?? (n ? plural(n, "unsaved change") : "Saved in the game folder")}</span>
      <span className="bm-foot__btns">
        <button className="btn btn--ghost btn--sm press" onClick={() => { setEdits({}); setProblem(null); }} disabled={!n || saving}>Discard</button>
        <button className="btn btn--primary btn--sm press" onClick={() => void apply()} disabled={!n || saving || !!blocker}>Apply changes</button>
      </span>
    </>
  ) : undefined;

  return (
    <Card title="Your setup" className="bm-setup" foot={foot} aside={<span className="meta">Read when a competitive map loads</span>}>
      {!installed ? (
        <p className="meta">Install the mod to set your music kit, knife drops and bot difficulty here.</p>
      ) : (
        <div className="bm-rows">
          {problem && <p className="bm-problem selectable" role="alert">{shown(problem)}</p>}
          {support === "official" && (
            <p className="bm-note">The installed BotRandomizer is the official build, which ignores the music kit and knife settings. Apply your builds to use them.</p>
          )}
          <div className="bm-row">
            <div className="bm-row__label"><span id="bm-kit-l">Music kit</span><span className="mono faint">br_player_music_kit</span></div>
            <div className="bm-row__ctl">
              <KitPicker labelId="bm-kit-l" value={draft.kit} catalog={cat} onChange={(v) => set("kit", v)} />
              <p className="meta">{catalog && "error" in catalog ? <span className="poor-text selectable">{shown(catalog.error)}</span>
                : !cat ? "BotRandomizer's catalog isn't in the game folder, so only Off and Random are offered."
                : "Your MVP anthem and round music in Bot Mode. Random picks a new kit each map."}</p>
            </div>
          </div>
          <div className="bm-row">
            <div className="bm-row__label"><span>Dropped knives</span><span className="mono faint">br_dropped_knife_skins</span></div>
            <div className="bm-row__ctl">
              <label className="check bm-check"><input type="checkbox" checked={draft.skins} onChange={(e) => set("skins", e.target.checked)} /><span>Give dropped knives a random finish</span></label>
              <p className="meta">Knives you spawn with <span className="mono">subclass_create</span>, as the mod's knife binds do. Your bots' own knives don't change.</p>
              {cat && cat.knives.length > 0 && (
                <ul className="bm-knives" data-on={draft.skins} aria-label={`${cat.knives.length} knives a finish can land on`}>
                  {cat.knives.map((d, i) => {
                    const k = KNIVES[d];
                    const name = k?.name ?? `Knife ${d}`;
                    return <li key={d} data-tip={name} style={{ ["--i" as string]: i }}><GameIcon id={k?.icon ?? null} name={name} width={46} height={18} /></li>;
                  })}
                </ul>
              )}
            </div>
          </div>
          <div className="bm-row">
            <div className="bm-row__label"><span>Finish odds</span><span className="mono faint">br_dropped_knife_premium</span></div>
            <div className="bm-row__ctl">
              <label className="check bm-check"><input type="checkbox" checked={draft.premium} onChange={(e) => set("premium", e.target.checked)} /><span>Strongly favor expensive finishes</span></label>
              {cat && cat.knifeFinishes.length > 0 && <FinishOdds finishes={cat.knifeFinishes} premium={draft.premium} />}
            </div>
          </div>
          <div className="bm-row">
            <div className="bm-row__label"><span>Bot difficulty</span><span className="mono faint">overrides/botprofile.vpk</span></div>
            <div className="bm-row__ctl">
              <Segmented label="Bot difficulty" options={DIFFICULTY} value={(draft.difficulty ?? "custom") as Difficulty} onChange={(v) => set("difficulty", v)} />
              <p className="meta">{draft.difficulty ? "Copies the mod's bot profile for this level. Takes effect on the next map." : "Your bot profile matches none of the three levels. Choosing one replaces it; the current one is backed up."}</p>
            </div>
          </div>
          <div className="bm-row">
            <div className="bm-row__label"><label htmlFor="bm-launch-opts">Launch options</label><span className="mono faint">after -insecure</span></div>
            <div className="bm-row__ctl">
              {/* a path in the options is hidden like any other; editing the hidden text would save the placeholder */}
              <input id="bm-launch-opts" className="input mono bm-input" value={launchHidden ? shown(draft.launch) : draft.launch} readOnly={launchHidden} aria-describedby={launchHidden ? "bm-launch-hidden" : undefined}
                spellCheck={false} autoComplete="off" placeholder="+exec botmode" onChange={(e) => set("launch", e.target.value)} />
              <p className="meta">
                {launchHidden && <span id="bm-launch-hidden">Hidden while personal info is hidden; turn that off in Data &amp; settings to edit. </span>}
                Added when Bot Mode starts CS2. Options that turn VAC back on, such as <span className="mono">-secure</span>, are refused.
              </p>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/** The finishes the catalog weights most, with the weight premium gives each (BotRandomizer squares it). */
function FinishOdds({ finishes, premium }: { finishes: { finish: string; weight: number }[]; premium: boolean }) {
  const top = [...finishes].sort((a, b) => b.weight - a.weight || a.finish.localeCompare(b.finish)).slice(0, 5);
  return (
    <div className="bm-odds" data-premium={premium}>
      <p className="meta">The most likely finishes. Each weight is against an unlisted finish's 1; premium squares it.</p>
      <table aria-label="Knife finish weights">
        <thead><tr><th className="caps" scope="col">Finish</th><th className="caps" scope="col">Normal</th><th className="caps" scope="col">Premium</th></tr></thead>
        <tbody>
          {top.map((f) => <tr key={f.finish}><td>{f.finish}</td><td className="num">{f.weight}</td><td className="num">{f.weight * f.weight}</td></tr>)}
        </tbody>
      </table>
      {finishes.length > top.length && <p className="meta">and {finishes.length - top.length} more</p>}
    </div>
  );
}

/** Type to filter, arrows to move, Enter to pick, Escape to close (WAI-ARIA combobox with a listbox popup). */
function KitPicker({ labelId, value, catalog, onChange }: { labelId: string; value: number; catalog: Catalog | null; onChange: (id: number) => void }) {
  const choices = useMemo(() => {
    const all = kitChoices(catalog);
    // a kit id the catalog does not list stays visible as what the cfg holds
    return all.some((c) => c.id === value) ? all : [...all, { id: value, artist: null, title: `Kit ${value}` }];
  }, [catalog, value]);
  const current = choices.find((c) => c.id === value)!;
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 340 });
  const id = useId();
  const q = query.trim().toLowerCase();
  const listed = q ? choices.filter((c) => `${c.title} ${c.artist ?? ""}`.toLowerCase().includes(q)) : choices;

  const show = () => {
    const r = btn.current!.getBoundingClientRect();
    const width = Math.max(r.width, 340);
    setPos({ left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), top: r.bottom + 4, width });
    setQuery("");
    setActive(Math.max(0, choices.findIndex((c) => c.id === value)));
    setOpen(true);
  };
  const hide = useCallback((focus = true) => { setOpen(false); if (focus) btn.current?.focus(); }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!pop.current?.contains(t) && !btn.current?.contains(t)) hide(false); };
    // the list is placed once, under the button: a scroll of the page or a resize closes it rather than leaving it behind
    const away = (e: Event) => { if (!(e.target instanceof Node && pop.current?.contains(e.target))) hide(false); };
    addEventListener("pointerdown", down, true);
    addEventListener("scroll", away, true);
    addEventListener("resize", away);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("scroll", away, true); removeEventListener("resize", away); };
  }, [open, hide]);
  useLayoutEffect(() => { if (open) pop.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [open, active]);

  const pick = (i: number) => { const c = listed[i]; if (!c) return; onChange(c.id); hide(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(listed.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (e.key === "Tab") hide(false);
  };
  return (
    <>
      <button ref={btn} className="bm-kit press" aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${labelId} ${id}-v`}
        onClick={() => (open ? hide() : show())} onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); show(); } }}>
        <span className="bm-kit__text" id={`${id}-v`}>
          <span className="bm-kit__title">{current.title}</span>
          {current.artist && <span className="bm-kit__artist">{current.artist}</span>}
        </span>
        <ChevronIcon size={14} className="bm-kit__chev" />
      </button>
      {open && createPortal(
        <div ref={pop} className="pop bm-kitpop" style={{ left: pos.left, top: pos.top, width: pos.width, ["--origin" as string]: "top left" }}>
          <div className="bm-kitpop__search">
            <SearchIcon size={14} className="ico" />
            <input ref={input} className="bm-kitpop__input" role="combobox" aria-expanded aria-controls={`${id}-list`} aria-autocomplete="list"
              aria-activedescendant={listed[active] ? `${id}-o${active}` : undefined} aria-label="Find a music kit" placeholder="Find a kit or artist"
              value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} />
          </div>
          <ul id={`${id}-list`} role="listbox" aria-label="Music kits" className="bm-kitpop__list">
            {listed.map((c, i) => (
              <li key={c.id} id={`${id}-o${i}`} data-i={i} role="option" aria-selected={c.id === value} data-active={i === active} className="opt bm-kitopt"
                onPointerMove={() => setActive(i)} onClick={() => pick(i)}>
                <span className="bm-kitopt__text"><span>{c.title}</span>{c.artist && <small>{c.artist}</small>}</span>
                {c.id === value && <CheckIcon size={14} className="opt__check" />}
              </li>
            ))}
            {!listed.length && <li className="bm-kitpop__none" role="presentation">No kit matches “{query}”.</li>}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------- install

const STATE_LABEL: Record<string, string> = { official: "Release", overlay: "Your build", modified: "Changed", missing: "Missing", notInRelease: "Not in the release", unknown: "Unknown" };

function Install({ status, state, releases, replaced, blocker, onRetryReleases, onInstall, onOverlay }: {
  status: Status; state: InstallState; releases: { list: GithubRelease[] } | { error: string } | null; replaced: string[]; blocker: string | null;
  onRetryReleases: () => void; onInstall: (tag: string, mode: "install" | "update" | "repair" | "adopt", e: MouseEvent) => void; onOverlay: (e: MouseEvent) => void;
}) {
  const shown = useShown();
  const latest = state.latest;
  // the mod's cfgs differ by design once the user edits them; reinstalling would not change that
  const broken = damaged(status).filter((c) => c.name !== "Mod cfgs");
  const others = status.components.filter((c) => c.state !== "official");
  const official = status.components.length - others.length;
  const r = status.release;
  const pct = r.total ? r.matching / r.total : 0;
  const tag = state.kind === "current" || state.kind === "behind" ? state.tag : null;
  const headline = state.kind === "missing" ? "Not installed" : tag ?? (state.kind === "byHand" ? state.reference : "Unknown version");
  const chip = state.kind === "behind" ? `${state.latest.tag_name} is out` : state.kind === "current" && latest ? "Latest" : state.kind === "byHand" ? "Installed by hand" : null;

  return (
    <Card title="Install" className="bm-install">
      <div className="bm-ver">
        <span className="disp disp--m bm-ver__tag">{headline}</span>
        {chip && <span className="chip" data-tone={state.kind === "behind" ? "new" : undefined}>{chip}</span>}
      </div>
      <p className="meta">
        {r.installed ? <>CS2-Bot-Improver, installed by this app {day(r.installed.installedAt)}. <a className="link" href={r.installed.source.url} target="_blank" rel="noreferrer">Source</a></>
          : state.kind === "byHand" ? "Not installed by this app; the files match a release it downloaded."
          : state.kind === "missing" ? "The mod isn't in the CS2 folder."
          : "Not installed by this app, and no downloaded release to compare with."}
      </p>
      {r.total > 0 && (
        <div className="bm-match">
          <div className="hbar" aria-hidden><i style={{ width: "100%", transform: `scaleX(${pct})`, transformOrigin: "left" }} /></div>
          <p className="meta"><b className="num">{r.matching}</b> of <b className="num">{r.total}</b> files match {r.reference}. The rest are your builds and your edited cfgs.</p>
        </div>
      )}
      {others.length > 0 && (
        <ul className="bm-comps" aria-label="Components that differ from the release">
          {others.map((c) => (
            <li key={c.name} data-state={c.state}>
              <span className="bm-comps__dot" aria-hidden />
              <span className="bm-comps__name">{c.name}</span>
              <span className="bm-comps__what">
                {STATE_LABEL[c.state]}
                {c.overlay && <> · <a className="link" href={c.overlay.url} target="_blank" rel="noreferrer" data-tip={`${c.overlay.repo} at ${c.overlay.commit?.slice(0, 12) ?? c.overlay.reference}`}>{c.overlay.reference}</a></>}
                {c.differs.length > 0 && <> · <span className="has-def" tabIndex={0} data-tip={c.differs.join("\n")}>{plural(c.differs.length, "file differs", "files differ")}</span></>}
                {c.missing.length > 0 && <> · {plural(c.missing.length, "file")} missing</>}
              </span>
            </li>
          ))}
          {official > 0 && <li className="bm-comps__rest meta">{plural(official, "other component matches", "other components match")} the release</li>}
        </ul>
      )}
      {replaced.length > 0 && (
        <p className="bm-note" role="status">The install replaced your builds of {replaced.join(", ")}. Apply your builds to put them back.</p>
      )}
      <div className="bm-actions">
        {state.kind === "missing" && latest && <button className="btn btn--primary press" disabled={!!blocker} onClick={(e) => onInstall(latest.tag_name, "install", e)}><DownloadIcon size={14} />Install {latest.tag_name}…</button>}
        {state.kind === "behind" && <button className="btn btn--primary press" disabled={!!blocker} onClick={(e) => onInstall(state.latest.tag_name, "update", e)}><DownloadIcon size={14} />Update to {state.latest.tag_name}…</button>}
        {(state.kind === "byHand" || state.kind === "unknown") && latest && <button className="btn press" disabled={!!blocker} onClick={(e) => onInstall(latest.tag_name, "adopt", e)}><DownloadIcon size={14} />Install {latest.tag_name} with this app…</button>}
        {tag && broken.length > 0 && <button className="btn press" disabled={!!blocker} onClick={(e) => onInstall(tag, "repair", e)}>Repair: reinstall {tag}…</button>}
        {state.kind !== "missing" && (replaced.length > 0 || status.overlays.length > 0 || cosmeticsSupport(status) === "official") && (
          <button className="btn press" disabled={!!blocker} onClick={onOverlay}>Apply your builds…</button>
        )}
        {blocker && <span className="meta">{blocker}</span>}
      </div>
      {releases && "error" in releases && (
        <p className="meta bm-releases" role="alert">
          <span className="selectable">GitHub's release list didn't load: {shown(releases.error)}</span>{" "}
          <button className="link" onClick={onRetryReleases}>Try again</button>
        </p>
      )}
      {!releases && <p className="meta" role="status">Checking GitHub for releases</p>}
      <p className="meta bm-folder"><span className="faint">CS2 folder</span> <span className="mono selectable">{shown(status.csgo)}</span></p>
    </Card>
  );
}

const MODE_TITLE = { install: "Install", update: "Update to", repair: "Reinstall", adopt: "Install" } as const;

/**
 * Downloads and checks the release first (the app's folder only), then says what the install would
 * write, keep and replace, and installs on confirmation.
 */
function InstallDialog({ api, status, dialog, onClose, onDone }: {
  api: BotModeApi; status: Status; dialog: Extract<Dialog, { kind: "install" }>; onClose: () => void; onDone: (replaced: string[]) => void;
}) {
  const shown = useShown();
  const [index, setIndex] = useState<ReleaseIndex | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setIndex(null);
    setFetchError(null);
    api.download(dialog.tag).then((i) => alive && setIndex(i), (e) => alive && setFetchError(errorText(e)));
    return () => { alive = false; };
  }, [api, dialog.tag, attempt]);
  // builds this install would overwrite: an applied overlay file the release also ships
  const replaces = index ? status.overlays.filter((o) => Object.keys(o.files).some((f) => f in index.files)).map((o) => o.name) : [];
  const n = index ? Object.keys(index.files).length : 0;
  return (
    <ActionDialog instant={dialog.instant} title={`${MODE_TITLE[dialog.mode]} ${dialog.tag}?`} confirm={`${MODE_TITLE[dialog.mode]} ${dialog.tag}`} busyText={`Installing ${dialog.tag}`}
      ready={!!index} onClose={onClose}
      run={async () => {
        const r = await api.install(dialog.tag);
        toast(`Installed ${r.tag}: ${plural(r.written, "file")} written, ${r.unchanged} already matched`, "good");
        onDone(r.overlaysReplaced);
      }}>
      {!index ? (
        fetchError ? (
          <div className="bm-problem" role="alert">
            <p className="selectable">{shown(fetchError)}</p>
            <button className="btn btn--sm press" onClick={() => setAttempt((a) => a + 1)}><RefreshIcon size={14} />Try again</button>
          </div>
        ) : (
          <p className="meta" role="status">Downloading {dialog.tag} and checking it against GitHub's SHA-256. This writes only to the app's folder.</p>
        )
      ) : (
        <dl className="bm-facts">
          <dt>Writes</dt>
          <dd>Up to {plural(n, "file")} from {index.asset} into the CS2 folder. Files that already match are left as they are.{dialog.mode === "repair" && " The ones that differ or are missing are put back."}</dd>
          <dt>Backs up</dt>
          <dd>Every file it replaces, first. If a write fails, the whole install is undone.</dd>
          <dt>Leaves alone</dt>
          <dd>Your <span className="mono">autoexec</span> cfgs and the skeleton override. It only adds missing lines to <span className="mono">gamemode_competitive_server.cfg</span>, keeps your values in the mod's bot cfgs, and keeps your bot difficulty.</dd>
          {replaces.length > 0 && <><dt className="poor-text">Replaces</dt><dd>Your builds of {replaces.join(", ")} with the release's. Apply your builds afterwards to put them back.</dd></>}
          {index.skipped.length > 0 && <><dt>Skips</dt><dd>{index.skipped.map((s) => s.path).join(", ")}. Bot Mode stays off: <span className="mono">gameinfo.gi</span> changes only while a launched session runs.</dd></>}
          <dt>Checked</dt>
          <dd className="mono selectable bm-sha">SHA-256 {index.sha256}</dd>
        </dl>
      )}
    </ActionDialog>
  );
}

// ---------------------------------------------------------------- session

const VERDICT: Record<Checked["verdict"], { label: string; tone: "good" | "poor" }> = {
  safe: { label: "Started with -insecure", tone: "good" },
  ended: { label: "Closed: no -insecure", tone: "poor" },
  endFailed: { label: "Could not be closed", tone: "poor" },
  unverified: { label: "Could not be checked", tone: "poor" },
};
const STATE_WORD: Record<string, string> = { starting: "Starting", ready: "Starting", waiting: "Waiting for CS2", running: "Running", cannotSee: "Can't see CS2", closing: "Turning off", done: "Ended", failed: "Failed" };

function Session({ session, pollError }: { session: SessionView | null; pollError: string | null }) {
  const shown = useShown();
  const s = session?.status ?? null;
  const live = session?.supervised ?? false;
  const checked = s ? (s.outcome && "checked" in s.outcome ? s.outcome.checked : s.verdicts) : [];
  return (
    <Card title={live ? "This session" : "Last session"} className="bm-session" aside={s ? <span className="chip" data-tone={live ? "live" : s.state === "failed" || s.leftOn ? "poor" : undefined}>{STATE_WORD[s.state] ?? s.state}</span> : undefined}>
      {!s ? <p className="meta">No session yet. Launch Bot Mode to start one; what it checks on the running game shows here.</p> : (
        <div className="bm-sess">
          <p className="selectable" role="status">{shown(s.message)}</p>
          {pollError && <p className="bm-problem selectable" role="alert">The session's state could not be read, so what shows here may be out of date: {shown(pollError)}. It is read again every two seconds.</p>}
          {s.leftOn && <p className="bm-problem selectable" role="alert">Bot Mode is still on: {shown(s.leftOn)}. Close CS2 now.</p>}
          {checked.length > 0 && (
            <ul className="bm-checks" aria-label="Each CS2 the session checked">
              {checked.map((c, i) => (
                <li key={`${c.pid}-${i}`} data-tone={VERDICT[c.verdict].tone}>
                  <span className="bm-comps__dot" aria-hidden />
                  <span><b>{VERDICT[c.verdict].label}</b> <span className="faint num">pid {c.pid}</span></span>
                  <span className="mono selectable bm-checks__detail">{shown(c.verdict === "safe" ? c.commandLine : c.verdict === "endFailed" ? `${c.why}: ${c.error}` : c.why)}</span>
                </li>
              ))}
            </ul>
          )}
          {s.outcome?.outcome === "noStart" && <p className="meta">CS2 didn't start{s.outcome.lastError ? `: ${shown(s.outcome.lastError)}` : "."}</p>}
          {s.errors.length > 0 && <ul className="bm-notes">{s.errors.map((e, i) => <li key={i} data-tone="poor" className="selectable">{shown(e)}</li>)}</ul>}
          <p className="meta">
            {s.botModeOn && <>Bot Mode on {stamp(s.botModeOn.created)}</>}
            {s.botModeOff && <>, off {stamp(s.botModeOff.created)}</>}
            {live && s.heartbeat > 0 && <> · last check {stampFmt.format(new Date(s.heartbeat * 1000))}</>}
          </p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- dialogs

/**
 * A modal confirmation (native <dialog>: focus stays inside, Escape cancels, the page behind is
 * inert). Cancel has the focus when it opens. `run` does the action; while it runs the dialog stays
 * open and cannot be dismissed, and its error, if any, shows inside.
 */
function ActionDialog({ title, confirm, busyText, children, run, onClose, instant, ready = true }: {
  title: string; confirm: string; busyText: string; children: ReactNode; run: () => Promise<void>; onClose: () => void; instant: boolean; ready?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useShown();
  const headId = useId();
  useEffect(() => {
    const d = ref.current!;
    // the button that opened the dialog gets the focus back when it closes
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    cancel.current?.focus();
    return () => {
      if (d.open && typeof d.close === "function") d.close();
      if (opener?.isConnected && !opener.matches(":disabled")) opener.focus();
    };
  }, []);
  const go = async () => {
    setBusy(true);
    setError(null);
    try { await run(); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <dialog ref={ref} className={`bm-dialog ${instant ? "is-instant" : ""}`} aria-labelledby={headId} aria-busy={busy || undefined}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <h2 id={headId} className="bm-dialog__title">{title}</h2>
      <div className="bm-dialog__body">{children}</div>
      {error && <p className="bm-problem selectable" role="alert">{shown(error)}</p>}
      <div className="bm-dialog__foot">
        {busy && <span className="meta bm-dialog__busy" role="status">{busyText}…</span>}
        <button ref={cancel} className="btn press" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn--primary press" onClick={() => void go()} disabled={busy || !ready}>{confirm}</button>
      </div>
    </dialog>
  );
}
