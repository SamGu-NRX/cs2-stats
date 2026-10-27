// Bot Mode: the mod's state in the game folder, the user's Bot Mode settings, the install, update
// and repair actions, history with undo, and the supervised launch, over the backend in
// src-tauri/src/botmode (typed in src/botmode/commands.ts). Every figure and sentence about the
// game comes from those commands.
//
// Nothing here changes the game folder or starts CS2 except an action the user confirms in a dialog
// that lists the files it changes. The backend refuses those writes while CS2 runs or a session
// holds the game; the page disables them in the same cases and says why. The page reads the state
// once when it opens and again after each action; it polls only while a session runs. Paths,
// command lines and errors pass through the privacy layer (data/privacy.ts).
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { UNREACHABLE, type BotModeApi, type Recovery, type Catalog, type Change, type Checked, type GithubRelease, type OverlayPlan, type ReleaseIndex, type RepairPlan, type RunningCs2, type ServerSettings, type SessionView, type Status, type UndoPlan } from "../../botmode/commands";
import { Card } from "../components/Card";
import { onRecoveryAnswered, recoveryAnswered } from "../components/BotModeRecovery";
import { OutsideLink } from "../components/OutsideLink";
import { toast } from "../components/overlay";
import { botModeApi, cosmeticsSupport, errorText, repairable, installState, vacState, writeBlocker, type InstallState } from "../data/botmode";
import { DownloadIcon, PlayIcon, RefreshIcon } from "../icons/ui";
import { plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { ModCommands } from "./botmode/ModCommands";
import { KNIFE_EXEC_LINE, knifeBlocksLaunch, knifeProblem, PlanList, PreviewLines, Setup, usePending, useServerPreview, type Pending } from "./botmode/Setup";
import { ActionDialog, clock, day, FileList, fromKeyboard, stamp, useShown } from "./botmode/shared";

// ---------------------------------------------------------------- data

interface Loaded {
  status: Status | null;
  statusError: string | null;
  session: SessionView | null;
  catalog: { data: Catalog | null } | { error: string } | null;
  server: ServerSettings | null;
  serverError: string | null;
  /** null when the running processes could not be read */
  running: RunningCs2[] | null;
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
  const [d, setD] = useState<Loaded>({ status: null, statusError: null, session: null, catalog: null, server: null, serverError: null, running: null, checking: true, pollError: null });
  const [releases, setReleases] = useState<{ list: GithubRelease[] } | { error: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Two sequences, so an older observation never overwrites a newer one, and a poll never throws
  // away a full read that takes longer than its interval (hashing the mod's files can):
  // - `full` counts full reads and launch results. A full read lands only if no newer full read
  //   or launch began after it.
  // - `live` counts everything that writes the session and the running CS2: full reads, polls and
  //   launch results. A poll lands only if nothing newer began after it; a full read keeps the
  //   session and running CS2 a newer poll already showed, and lands the rest.
  const full = useRef(0);
  const live = useRef(0);

  const reload = useCallback(async () => {
    const f = ++full.current;
    const l = ++live.current;
    setD((x) => ({ ...x, checking: true }));
    const [st, se, ca, sv, ru] = await Promise.allSettled([api.status(), api.session(), api.catalog(), api.serverCfg(), api.running()]);
    if (!alive.current || f !== full.current) return;
    const ownLive = l === live.current;
    setD((x) => ({
      status: st.status === "fulfilled" ? st.value : null,
      statusError: st.status === "rejected" ? errorText(st.reason) : null,
      session: ownLive ? (se.status === "fulfilled" ? se.value : null) : x.session,
      catalog: ca.status === "fulfilled" ? { data: ca.value } : { error: errorText(ca.reason) },
      server: sv.status === "fulfilled" ? sv.value : null,
      serverError: sv.status === "rejected" ? errorText(sv.reason) : null,
      running: ownLive ? (ru.status === "fulfilled" ? ru.value : null) : x.running,
      checking: false,
      pollError: ownLive ? null : x.pollError,
    }));
  }, [api]);

  const loadReleases = useCallback((again = false) => {
    setReleases(null);
    releasesOf(api, again).then((list) => alive.current && setReleases({ list }), (e) => alive.current && setReleases({ error: errorText(e) }));
  }, [api]);

  useEffect(() => { void reload(); loadReleases(); }, [reload, loadReleases]);

  // A session reports through its status file; follow it and the running CS2 every two seconds
  // while it runs, and read the whole state again once it ends (Bot Mode off, CS2 closed).
  const supervised = d.session?.supervised ?? false;
  // One poll at a time: the next is scheduled two seconds after the last one settles, so a slow
  // read is never overtaken by the next poll and dropped, poll after poll.
  useEffect(() => {
    if (!supervised) return;
    let stopped = false;
    let t = 0;
    const poll = () => {
      const l = ++live.current;
      const landed = () => alive.current && !stopped && l === live.current;
      Promise.all([api.session(), api.running().catch(() => null)]).then(([s, running]) => {
        if (!landed()) return;
        setD((x) => ({ ...x, session: s, running, pollError: null }));
        if (!s.supervised) void reload();
      }, (e) => { if (landed()) setD((x) => ({ ...x, pollError: errorText(e) })); })
        .finally(() => { if (!stopped) t = window.setTimeout(poll, 2000); });
    };
    t = window.setTimeout(poll, 2000);
    return () => { stopped = true; clearTimeout(t); };
  }, [api, supervised, reload]);

  // a launch's own result is the newest observation: reads and polls begun before it are dropped
  const setSession = useCallback((s: SessionView) => { full.current++; live.current++; setD((x) => ({ ...x, session: s })); }, []);
  return { ...d, releases, reload, loadReleases, setSession };
}

type Dialog =
  | { kind: "install"; tag: string; mode: "install" | "update" | "repair" | "adopt"; instant: boolean }
  | { kind: "overlay"; instant: boolean }
  | { kind: "rollback"; change: Change; interrupted: boolean; instant: boolean }
  | { kind: "apply"; instant: boolean }
  | { kind: "launch"; instant: boolean }
  | { kind: "recover"; recovery: Recovery; instant: boolean }
  | { kind: "serverUndo"; change: Change; instant: boolean }
  | { kind: "repair"; instant: boolean };

/** Settings changes, which Undo takes back as a change forward from their record (settings.rs undo_server). */
const SERVER_OPS = ["server-cfg", "cosmetics", "server-cfg-undo"];

/** session.rs MANAGED_BY_OTHER_TOOL: Bot Mode is on, and not by a session of this app's. */
const MANAGED = "Bot Mode is managed by another tool (left as is)";

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
  const shown = useShown();
  const { status } = bm;
  if (!status) {
    const unreachable = bm.statusError?.startsWith(UNREACHABLE);
    return (
      <div className="view__in bm">
        <section className="card hero bm-hero" aria-busy={bm.checking || undefined} aria-labelledby="bm-state">
          <h1 id="bm-state" className="disp disp--s bm-hero__state">{bm.checking ? "Checking" : unreachable ? "Library unreachable" : "Not available"}</h1>
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
  return <Ready api={api} bm={bm} status={status} />;
}

function Ready({ api, bm, status }: { api: BotModeApi; bm: ReturnType<typeof useBotMode>; status: Status }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** builds the last install replaced, until they are applied again: an install never removes them silently */
  const [replaced, setReplaced] = useState<string[]>([]);
  const { pending, keptUnread } = usePendingOrNull(api, status, bm.server, bm.reload);
  // the backend refuses a launch on a server cfg it can't read (settings.rs check_knife_file); so does the page
  const cfgUnread = bm.server === null && bm.serverError !== null
    ? `The server cfg can't be read (${bm.serverError}), so whether it runs the knife key file is unknown. Launch waits until it reads.${keptUnread ? " Your kept changes wait for it too." : ""}`
    : null;
  const { session } = bm;
  const releases = bm.releases && "list" in bm.releases ? bm.releases.list : null;
  const state = installState(status, releases);
  const supervised = session?.supervised ?? false;
  const blocker = writeBlocker(status, supervised);
  // the version the game folder holds, never a guess: by hand, the downloaded release it matches
  const tag = state.kind === "current" || state.kind === "behind" ? state.tag : state.kind === "byHand" ? state.reference.split(" (")[0] : null;
  const close = () => setDialog(null);
  const done = () => { setDialog(null); void bm.reload(); };
  // the startup prompt answered elsewhere: read the state again
  const self = useRef({}).current;
  const reload = bm.reload;
  useEffect(() => onRecoveryAnswered((from) => { if (from !== self) void reload(); }), [self, reload]);
  const [leaving, setLeaving] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const leaveOn = async () => {
    setLeaving({ busy: true, error: null });
    try {
      const r = await api.recover({ action: "leave" });
      recoveryAnswered(self);
      toast(r.message);
      setLeaving({ busy: false, error: null });
      void bm.reload();
    } catch (e) {
      setLeaving({ busy: false, error: errorText(e) });
    }
  };
  const undoable = status.backups.find((b) => b.kind === "normal" && b.status === "complete");
  // the exact lines the apply and launch confirmations list, from the backend
  const preview = useServerPreview(api, (dialog?.kind === "apply" || dialog?.kind === "launch") && pending ? pending.plan.patch : null, bm.server);
  const previewReady = preview === null || (preview !== "loading" && !("error" in preview));

  return (
    <div className="view__in bm">
      <Hero status={status} session={session} running={bm.running} state={state} blocker={blocker} checking={bm.checking} pending={pending} cfgUnread={cfgUnread} onCheck={() => void bm.reload()}
        leaving={leaving} onLeaveOn={() => void leaveOn()}
        onTurnOff={(r, e) => setDialog({ kind: "recover", recovery: r, instant: fromKeyboard(e) })}
        onLaunch={(e) => setDialog({ kind: "launch", instant: fromKeyboard(e) })}
        onRollback={(e) => { if (status.unfinished) setDialog({ kind: "rollback", change: status.unfinished, interrupted: true, instant: fromKeyboard(e) }); }} />
      <div className="bm-cols">
        <Setup status={status} catalog={bm.catalog} serverError={bm.serverError} pending={pending} blocker={blocker}
          onApply={(e) => setDialog({ kind: "apply", instant: fromKeyboard(e) })}
          onRepair={(e) => setDialog({ kind: "repair", instant: fromKeyboard(e) })} />
        <div className="bm-side">
          <Install status={status} state={state} releases={bm.releases} replaced={replaced} blocker={blocker}
            onRetryReleases={() => bm.loadReleases(true)}
            onInstall={(t, mode, e) => setDialog({ kind: "install", tag: t, mode, instant: fromKeyboard(e) })}
            onOverlay={(e) => setDialog({ kind: "overlay", instant: fromKeyboard(e) })} />
          <Session session={session} pollError={bm.pollError} />
          <History status={status} blocker={blocker} undoable={undoable ?? null}
            onUndo={(c, e) => setDialog(SERVER_OPS.includes(c.operation) ? { kind: "serverUndo", change: c, instant: fromKeyboard(e) } : { kind: "rollback", change: c, interrupted: false, instant: fromKeyboard(e) })} />
        </div>
      </div>
      {/* a new tag starts the card over, so a list loaded for the old one is never shown under the new */}
      {state.kind !== "missing" && <ModCommands key={tag ?? "unknown"} api={api} tag={tag} />}

      {dialog?.kind === "install" && (
        <InstallDialog api={api} status={status} dialog={dialog} onClose={close} onDone={(names) => { setReplaced(names); done(); }} />
      )}
      {dialog?.kind === "overlay" && (
        <OverlayDialog api={api} instant={dialog.instant} onClose={close} onDone={() => { setReplaced([]); done(); }} />
      )}
      {dialog?.kind === "rollback" && (
        <RollbackDialog api={api} change={dialog.change} interrupted={dialog.interrupted} instant={dialog.instant} onClose={close} onDone={done} />
      )}
      {dialog?.kind === "apply" && pending && (
        <ActionDialog instant={dialog.instant} title={`Apply ${plural(pending.changed.length, "change")}?`} confirm="Apply" busyText="Writing your changes"
          onClose={close} ready={previewReady}
          run={async () => {
            await pending.apply(preview && preview !== "loading" && !("error" in preview) ? preview.read : undefined);
            toast("Changes applied", "good");
            setDialog(null);
          }}>
          <PlanList plan={pending.plan} preview={preview} difficultyFrom={status.difficulty} />
        </ActionDialog>
      )}
      {dialog?.kind === "serverUndo" && (
        <ServerUndoDialog api={api} change={dialog.change} instant={dialog.instant} onClose={close} onDone={done} reload={bm.reload} />
      )}
      {dialog?.kind === "repair" && <RepairDialog api={api} instant={dialog.instant} onClose={close} onDone={done} />}
      {dialog?.kind === "recover" && (
        <TurnOffDialog api={api} recovery={dialog.recovery} instant={dialog.instant} onClose={close}
          onDone={(message) => { recoveryAnswered(self); toast(message, "good"); done(); }}
          onNothingLeft={(why) => { recoveryAnswered(self); toast(why, "poor", 6000); done(); }}
          onAskAgain={(r) => setDialog({ kind: "recover", recovery: r, instant: true })} />
      )}
      {dialog?.kind === "launch" && (
        <ActionDialog instant={dialog.instant} title="Start CS2 in Bot Mode?" confirm="Launch with -insecure" busyText="Turning Bot Mode on and asking Steam to start CS2"
          onClose={close} ready={previewReady}
          run={async () => {
            // changes kept while CS2 ran go in first; a refusal stops the launch here
            if (cfgUnread) throw cfgUnread;
            if (pending?.changed.length) await pending.apply(preview && preview !== "loading" && !("error" in preview) ? preview.read : undefined);
            const s = await api.launch();
            bm.setSession(s);
            toast("Steam is starting CS2 in Bot Mode", "good");
            done();
          }}>
          <p className="bm-dialog__lead">CS2 starts with <b className="bm-flag">-insecure</b>, which turns VAC off for this session. Matchmaking and VAC-secured servers stay closed to it until you restart CS2 without Bot Mode.</p>
          <LaunchLine status={status} options={pending?.plan.launch ?? status.launchOptions} />
          <dl className="bm-facts">
            <dt>Changes</dt>
            {status.botMode
              ? <dd>Nothing in <span className="mono">gameinfo.gi</span>: Bot Mode is already on, {status.notice === MANAGED ? "set by another tool" : "and this session did not turn it on"}. The session leaves it on when CS2 exits.</dd>
              : <dd><span className="mono">gameinfo.gi</span>: two search paths turn Bot Mode on. When CS2 exits, the session takes them out again if the file still holds what it wrote; if another tool changed the file meanwhile, it is left as that tool set it.</dd>}
            <dt>Watches</dt>
            <dd>Every CS2 of this install until it exits. One started without <span className="mono">-insecure</span> is closed.</dd>
          </dl>
          {pending && pending.changed.length > 0 && <>
            <p className="bm-dialog__lead">First, your {plural(pending.changed.length, "kept change")}:</p>
            <PlanList plan={pending.plan} preview={preview} difficultyFrom={status.difficulty} />
          </>}
        </ActionDialog>
      )}
    </div>
  );
}

/**
 * The settings draft, once the server cfg has been read. `keptUnread`: changes are kept but the
 * cfg could not be read, so they can be neither shown nor checked.
 */
function usePendingOrNull(api: BotModeApi, status: Status, server: ServerSettings | null, reload: () => Promise<void>): { pending: Pending | null; keptUnread: boolean } {
  // the hook runs on every render; without a read cfg it works on a stand-in that is not shown,
  // and never compared with the kept edits as if it were the file
  const p = usePending(api, status, server ?? EMPTY_SERVER, reload, server !== null);
  return server ? { pending: p, keptUnread: false } : { pending: null, keptUnread: p.kept > 0 };
}
const EMPTY_SERVER: ServerSettings = { cosmetics: { droppedKnifeSkins: false, droppedKnifePremium: false, musicKit: 0 }, botAim: null, botNades: null, knifeBind: null, unboundKeys: [], knifeFile: { path: "cfg/cs2stats_knife.cfg", status: "none", sha256: null, error: null, overrides: [], uncertain: [], execLast: false, runs: false, unbindall: null }, extraKnifeBinds: [], heldKeys: [] };

// ---------------------------------------------------------------- hero

function Hero({ status, session, running, state, blocker, checking, pending, cfgUnread, leaving, onCheck, onLaunch, onRollback, onTurnOff, onLeaveOn }: {
  status: Status; session: SessionView | null; running: RunningCs2[] | null; state: InstallState; blocker: string | null; checking: boolean; pending: Pending | null;
  /** why Launch waits for the server cfg to read, or null */
  cfgUnread: string | null;
  leaving: { busy: boolean; error: string | null };
  onCheck: () => void; onLaunch: (e: MouseEvent) => void; onRollback: (e: MouseEvent) => void; onTurnOff: (r: Recovery, e: MouseEvent) => void; onLeaveOn: () => void;
}) {
  const shown = useShown();
  const supervised = session?.supervised ?? false;
  const unseen = status.cs2Running === null && !supervised;
  // a session of ours died with Bot Mode on (#50): the app changed nothing and asks
  const recovery = !supervised ? session?.recovery ?? null : null;
  const managed = !supervised && !recovery && status.botMode === true && status.notice === MANAGED;
  const word = status.unfinished ? "Interrupted" : supervised ? "In session" : recovery ? "Bot Mode left on" : unseen ? "Can't check CS2" : status.cs2Running ? "CS2 is open" : state.kind === "missing" ? "Not installed" : "Ready";
  const tone = status.unfinished || recovery ? "poor" : supervised ? "live" : unseen || status.cs2Running || state.kind === "missing" ? "idle" : "ready";
  const version = state.kind === "current" || state.kind === "behind" ? state.tag : state.kind === "byHand" ? state.reference : null;
  // a missing or unreadable knife file, or a server cfg that can't be read, leaves which keys stay
  // unbound unknown: a key the knife left would spawn knives again, so Launch waits, as the
  // backend's launch does (settings.rs check_knife_file)
  const knife = pending && knifeBlocksLaunch(pending.knifeFile) ? knifeProblem(pending.knifeFile) : null;
  const launchWhy = state.kind === "missing" ? "Install the mod first." : cfgUnread ?? (knife ? `${knife} Launch waits until then.` : pending?.invalid ?? blocker);
  const vac = vacState(status, running, supervised);
  // the interrupted change has its own sentence and button above; its warning would repeat it
  const warnings = status.warnings.filter((w) => !status.unfinished || !w.startsWith(`Change ${status.unfinished.id} `));
  const sub = status.unfinished
    ? `Change ${status.unfinished.operation} stopped part-way, so the game folder may be half-written. Roll it back before anything else.`
    : supervised ? shown(session?.status?.message ?? "A Bot Mode session is watching CS2.")
    : recovery ? recovery.message
    : unseen ? "The process list could not be read, so the app can't tell whether CS2 is open. It changes nothing and won't launch until it can; check again in a moment."
    : status.cs2Running ? "Close CS2, then launch Bot Mode, so the game starts with -insecure."
    : state.kind === "missing" ? "The mod's loaders, Metamod and CounterStrikeSharp, aren't in the CS2 folder. Install a release to play with bots."
    : managed ? "Bot Mode is on, set by another tool such as the Bot-Improver Panel, and this app leaves it as it is. Launching from here starts CS2 with -insecure and leaves Bot Mode on afterwards."
    : "Bot Mode starts CS2 through Steam with -insecure, and turns Bot Mode off again when the game exits.";
  return (
    <section className="card hero bm-hero" data-tone={tone} aria-labelledby="bm-state">
      <div className="bm-hero__head">
        <span className="bm-dot" aria-hidden />
        <h1 id="bm-state" className="disp disp--s bm-hero__state">{word}</h1>
        <span className="bm-vac" data-tone={vac.tone} tabIndex={0} data-tip={shown(vac.detail)} aria-describedby="bm-vac-what">{vac.text}</span>
        <button className="btn btn--ghost btn--sm press bm-hero__check" onClick={onCheck} disabled={checking} aria-busy={checking || undefined}>
          <RefreshIcon size={14} />{checking ? "Checking" : "Check again"}
        </button>
      </div>
      <p className="bm-hero__sub">{sub}</p>
      <p className="sr-only" id="bm-vac-what">{shown(vac.detail)}</p>
      <ul className="bm-hero__facts" aria-label="Game state">
        <li><span className="faint">Mod</span> <b>{version ? `CS2-Bot-Improver ${version}` : "none"}</b></li>
        <li><span className="faint">CS2</span> <b>{status.cs2Running === null ? "unknown" : status.cs2Running ? "running" : "closed"}</b></li>
        <li><span className="faint">Bot Mode in gameinfo.gi</span> <b>{status.botMode === null ? "unknown" : status.botMode ? "on" : "off"}</b>{managed && <span className="bm-managed"> · {MANAGED}</span>}</li>
        {status.buildId && <li><span className="faint">Steam build</span> <b className="num">{status.buildId}</b></li>}
      </ul>
      {status.unfinished ? (
        <div className="bm-hero__act">
          <button className="btn btn--primary press" onClick={onRollback}>Roll back the change…</button>
        </div>
      ) : recovery ? (
        <div className="bm-hero__act bm-recover">
          <button className="btn btn--primary press" onClick={(e) => onTurnOff(recovery, e)} disabled={leaving.busy || !!blocker}>Turn off Bot Mode…</button>
          <button className="btn press" onClick={onLeaveOn} disabled={leaving.busy || !!blocker} aria-busy={leaving.busy || undefined}>{leaving.busy ? "Leaving it on" : "Leave it on"}</button>
          <span className="meta">Leave it on changes nothing and stops asking. Either answer waits while CS2 runs.</span>
          {leaving.error && <p className="bm-problem selectable" role="alert">{shown(leaving.error)}</p>}
        </div>
      ) : (
        <div className="bm-hero__act">
          <LaunchLine status={status} options={pending?.plan.launch ?? status.launchOptions} />
          <button className="btn btn--primary press bm-launch" onClick={onLaunch} disabled={!!launchWhy} aria-describedby={launchWhy ? "bm-launch-why" : undefined}>
            <PlayIcon size={14} />Launch Bot Mode…
          </button>
        </div>
      )}
      {launchWhy && !status.unfinished && (
        <p className="meta bm-hero__why" id="bm-launch-why">
          {shown(launchWhy)}
          {cfgUnread && <> <button className="link" onClick={onCheck} disabled={checking}>Check again</button></>}
        </p>
      )}
      {((session?.notice && session.notice !== status.notice) || warnings.length > 0) && (
        <ul className="bm-notes">
          {session?.notice && session.notice !== status.notice && <li className="selectable">{shown(session.notice)}</li>}
          {warnings.map((w, i) => <li key={i} className="selectable" data-tone="poor">{shown(w)}</li>)}
        </ul>
      )}
      {state.kind !== "missing" && !recovery && !managed && <p className="meta bm-hero__notice">{status.notice}</p>}
    </section>
  );
}

/**
 * The command a launch runs, as the backend builds it: -insecure always first, then the app's
 * options; Steam adds CS2's own. `options`: the app's options the launch will use, which are the
 * kept ones when a change to them waits, since the launch applies those first.
 */
function LaunchLine({ status, options }: { status: Status; options: string }) {
  const shown = useShown();
  return (
    <p className="bm-line mono selectable" aria-label="Launch command">
      <span className="faint">steam.exe -applaunch 730</span> <b className="bm-flag">-insecure</b>
      {options && <> <span>{shown(options)}</span></>}
      {status.steamLaunchOptions && <> <span className="bm-line__steam"><span className="faint">then Steam's own</span> {shown(status.steamLaunchOptions)}</span></>}
    </p>
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
  // a repair puts back damaged and missing files; the user's own values in the mod's cfgs are not damage
  const broken = repairable(status);
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
        {r.installed ? <>CS2-Bot-Improver, installed by this app {day(r.installed.installedAt)}. <OutsideLink className="link" href={r.installed.source.url}>Source</OutsideLink></>
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
                {c.overlay && <> · <OutsideLink className="link" href={c.overlay.url} tip={`${c.overlay.repo} at ${c.overlay.commit?.slice(0, 12) ?? c.overlay.reference}`}>{c.overlay.reference}</OutsideLink></>}
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
 * Downloads and checks the release first (the app's folder only), then lists what the install
 * would write, keep and replace, and installs on confirmation.
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
  const files = index ? Object.keys(index.files) : [];
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
          <dd>Up to {plural(files.length, "file")} from {index.asset} into the CS2 folder. Files that already match are left as they are.{dialog.mode === "repair" && " The ones that differ or are missing are put back."}<FileList files={files} /></dd>
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

/** Reads overlay.json first and lists every file each build puts where. */
function OverlayDialog({ api, instant, onClose, onDone }: { api: BotModeApi; instant: boolean; onClose: () => void; onDone: () => void }) {
  const shown = useShown();
  const [plan, setPlan] = useState<OverlayPlan | { error: string } | null>(null);
  const read = useCallback(() => api.overlayPlan().then(setPlan, (e) => setPlan({ error: errorText(e) })), [api]);
  useEffect(() => { void read(); }, [read]);
  const ready = plan && "entries" in plan ? plan : null;
  return (
    <ActionDialog instant={instant} title="Apply your plugin builds?" confirm="Apply builds" busyText="Checking and copying your builds" ready={!!ready} onClose={onClose}
      run={async () => {
        // the confirmation applies the manifest shown here: one edited since is refused, and shown again
        let r;
        try {
          r = await api.overlay(undefined, ready!.sha256);
        } catch (e) {
          const text = errorText(e);
          if (!text.includes("changed since it was read")) throw e;
          await read();
          throw "overlay.json changed after this list was shown, so nothing was copied. The list now shows the file as it is; check it and apply again.";
        }
        toast(`Applied ${plural(r.entries.length, "build")}: ${r.entries.map((x) => x.name).join(", ")}`, "good");
        onDone();
      }}>
      {!plan ? <p className="meta" role="status">Reading overlay.json</p>
        : "error" in plan ? <p className="bm-problem selectable" role="alert">{shown(plan.error)}</p>
        : (
          <dl className="bm-facts">
            {plan.entries.map((e) => (
              <div key={e.name} style={{ display: "contents" }}>
                <dt>{e.name}</dt>
                <dd>From {e.repo} at {e.reference}, into <span className="mono">{e.target}</span>:<FileList files={e.files.map((f) => `${e.target}/${f}`)} /></dd>
              </div>
            ))}
            <dt>Checks first</dt>
            <dd>Each local build must be a clean checkout of its branch, with its commit on GitHub. Every entry is checked before the first file is written.</dd>
            <dt>Backs up</dt>
            <dd>Every file it replaces. History on this page undoes it.</dd>
          </dl>
        )}
    </ActionDialog>
  );
}

/**
 * The page's "Turn off Bot Mode" for the recovery prompt: the one file it writes and the lines it
 * takes out, as the prompt read them. Refused once gameinfo.gi differs from that read; the
 * dialog then shows the file as it is now, or closes when there is nothing left to ask.
 */
function TurnOffDialog({ api, recovery, instant, onClose, onDone, onAskAgain, onNothingLeft }: {
  api: BotModeApi; recovery: Recovery; instant: boolean; onClose: () => void; onDone: (message: string) => void; onAskAgain: (r: Recovery) => void;
  /** refused, and there is no prompt left (another tool turned Bot Mode off): the dialog closes with `why` */
  onNothingLeft: (why: string) => void;
}) {
  const shown = useShown();
  return (
    <ActionDialog instant={instant} title="Turn off Bot Mode?" confirm="Turn off Bot Mode" busyText="Turning Bot Mode off" onClose={onClose}
      run={async () => {
        try {
          const r = await api.recover({ action: "off", expectHash: recovery.hash });
          onDone(r.message);
        } catch (e) {
          const why = errorText(e);
          const now = await api.session().then((s) => s.recovery, (again) => ({ failed: errorText(again) }));
          if (now && "failed" in now) throw `${why} Reading Bot Mode's state again failed: ${now.failed}`;
          // nothing left to ask: close, as the startup prompt does
          if (now === null) { onNothingLeft(why); return; }
          if (now.hash !== recovery.hash) onAskAgain(now);
          throw why;
        }
      }}>
      <p className="bm-dialog__lead">This takes these lines out of gameinfo.gi, including any that another tool such as the Bot-Improver Panel added. Nothing else in the file changes.</p>
      <dl className="bm-facts">
        <dt>Changes</dt>
        <dd><span className="mono selectable">{shown(recovery.file)}</span>, taking out:<ul className="bm-files mono selectable">{recovery.lines.map((l) => <li key={l}>{l.trim()}</li>)}</ul></dd>
        <dt>Keeps</dt>
        <dd>Another tool's Bot Mode setting is lost. To keep it, cancel and choose Leave it on.</dd>
      </dl>
    </ActionDialog>
  );
}

/**
 * Undo of a settings change, as a change forward from the change's record (settings.rs
 * undo_server): each setting it wrote back to its value before, and the knife key moved back, the
 * key it leaves joining the keys Bot Mode keeps unbound. Refused, and said here before the
 * confirm, once a setting it wrote has changed since, as Undo would overwrite that.
 */
function ServerUndoDialog({ api, change, instant, onClose, onDone, reload }: {
  api: BotModeApi; change: Change; instant: boolean; onClose: () => void; onDone: () => void; reload: () => Promise<void>;
}) {
  const shown = useShown();
  const [plan, setPlan] = useState<UndoPlan | { error: string } | null>(null);
  const read = useCallback(() => api.serverUndoPlan(change.id).then(setPlan, (e) => setPlan({ error: errorText(e) })), [api, change.id]);
  useEffect(() => { void read(); }, [read]);
  const ready = plan && !("error" in plan) && !plan.refused ? plan : null;
  return (
    <ActionDialog instant={instant} title={change.operation === "server-cfg-undo" ? "Redo settings?" : `Undo ${opLabel(change.operation).toLowerCase()}?`} confirm={change.operation === "server-cfg-undo" ? "Redo" : "Undo"} busyText="Setting them back"
      onClose={onClose} ready={!!ready && (ready.serverDiff.length > 0 || !!ready.knifeLines)}
      run={async () => {
        try {
          await api.serverUndo(change.id, ready!.read);
        } catch (e) {
          // the settings moved after this preview: show why, from the files as they are now
          await reload();
          await read();
          throw e;
        }
        toast("Settings set back", "good");
        onDone();
      }}>
      <dl className="bm-facts">
        <dt>Change</dt>
        <dd><span className="mono">{change.id}</span>, made {stamp(change.created)}.</dd>
        <dt>Sets back</dt>
        <dd>
          {plan === null ? "Reading what the change wrote."
            : "error" in plan ? <span className="poor-text selectable">{shown(plan.error)}</span>
            : plan.refused ? <span className="poor-text selectable" role="alert">{shown(plan.refused)}</span>
            : "As a new change, these lines:"}
        </dd>
        {ready && <PreviewLines preview={ready} />}
        {ready?.knifeLines && <>
          <dt>Keys</dt>
          <dd>CS2 keeps the binds a change made, so the key the knife key leaves joins the keys Bot Mode keeps unbound, and any key this change stopped unbinding is unbound again.</dd>
        </>}
      </dl>
    </ActionDialog>
  );
}

/**
 * Writes the knife file back as the newest settings change left it (settings.rs repair_knife):
 * Repair for a missing file, Replace for an unreadable one, whose bytes the change's backup keeps,
 * so undoing it in History puts them back.
 */
function RepairDialog({ api, instant, onClose, onDone }: { api: BotModeApi; instant: boolean; onClose: () => void; onDone: () => void }) {
  const shown = useShown();
  const [plan, setPlan] = useState<RepairPlan | { error: string } | null>(null);
  useEffect(() => { api.knifeRepairPlan().then(setPlan, (e) => setPlan({ error: errorText(e) })); }, [api]);
  const ready = plan && !("error" in plan) ? plan : null;
  const replace = !!ready?.replaces;
  return (
    <ActionDialog instant={instant} title={replace ? "Replace the knife key file?" : "Repair the knife key file?"} confirm={replace ? "Replace" : "Repair"} busyText="Writing it back" onClose={onClose} ready={!!ready}
      run={async () => {
        await api.knifeRepair(ready!);
        toast(replace ? "Knife key file replaced" : "Knife key file repaired", "good");
        onDone();
      }}>
      <dl className="bm-facts">
        <dt>Writes</dt>
        <dd>
          {plan === null ? "Reading what the knife key file last held."
            : "error" in plan ? <span className="poor-text selectable">{shown(plan.error)}</span>
            : <>
              <span className="mono">cfg/cs2stats_knife.cfg</span>, {plan.fromFile ? "with the keys it holds now, written plainly: no unbindall, none of the lines Bot Mode doesn't write" : plan.from ? <>with the knife key change <span className="mono">{plan.from}</span> left</> : "with the mod's own key and no keys unbound, as no change recorded one"}, exactly these lines:
              <ul className="bm-files mono selectable">{plan.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </>}
        </dd>
        {replace && <>
          <dt>Keeps</dt>
          <dd>The file as it is now, in this change's backup. Undoing the change in History puts it back as it was.</dd>
        </>}
        <dt>Server cfg</dt>
        <dd>Unchanged: its <span className="mono">{KNIFE_EXEC_LINE.split(" //")[0]}</span> line already runs the file.</dd>
      </dl>
    </ActionDialog>
  );
}

/** Lists the files the change wrote, from its journal, and rolls exactly that change back. */
function RollbackDialog({ api, change, interrupted, instant, onClose, onDone }: { api: BotModeApi; change: Change; interrupted: boolean; instant: boolean; onClose: () => void; onDone: () => void }) {
  const [files, setFiles] = useState<string[] | { error: string } | null>(null);
  const shown = useShown();
  useEffect(() => { api.changeFiles(change.id).then(setFiles, (e) => setFiles({ error: errorText(e) })); }, [api, change.id]);
  return (
    <ActionDialog instant={instant} title={interrupted ? "Roll back the interrupted change?" : `Undo ${opLabel(change.operation).toLowerCase()}?`} confirm={interrupted ? "Roll back" : "Undo"}
      busyText="Restoring files from the backup" onClose={onClose} ready={Array.isArray(files)}
      run={async () => {
        const r = await api.rollback(change.id);
        toast(`${interrupted ? "Rolled back" : "Undid"} ${opLabel(r.operation).toLowerCase()}: ${plural(r.restored, "file")} restored`, "good");
        onDone();
      }}>
      <dl className="bm-facts">
        <dt>Change</dt>
        <dd><span className="mono selectable">{change.id}</span>, made {stamp(change.created)}.{interrupted && " It stopped part-way, so the game folder may be half-written."}</dd>
        <dt>Restores</dt>
        <dd>
          {files === null ? "Reading the change's journal." : "error" in files ? <span className="poor-text selectable">{shown(files.error)}</span>
            : <>These files, from the copies taken before each write; a file the change created is removed:<FileList files={files} /></>}
        </dd>
        <dt>Stops instead</dt>
        <dd>If another program changed one of those files since. Nothing is restored then, and the error names the file.</dd>
      </dl>
    </ActionDialog>
  );
}

// ---------------------------------------------------------------- history

/** A recorded change's operation in words. */
function opLabel(op: string): string {
  if (op.startsWith("install-")) return `Install ${op.slice(8)}`;
  if (op === "overlay") return "Your builds applied";
  if (op === "server-cfg" || op === "cosmetics") return "Settings";
  if (op === "server-cfg-undo") return "Settings undone";
  if (op === "knife-repair") return "Knife key file written back";
  if (op.startsWith("difficulty-")) return `Bot difficulty ${op.slice(11)}`;
  return op;
}

function History({ status, blocker, undoable, onUndo }: { status: Status; blocker: string | null; undoable: Change | null; onUndo: (c: Change, e: MouseEvent) => void }) {
  const recent = status.backups.filter((b) => b.kind === "normal").slice(0, 5);
  // the change Undo takes off always shows, even when undone changes push it past the first five
  const changes = undoable && !recent.includes(undoable) ? [...recent, undoable] : recent;
  return (
    <Card title="History" className="bm-history" aside={<span className="meta">Every change is backed up</span>}>
      {!changes.length ? <p className="meta">No changes yet. Each install, build and setting you apply shows here, and the newest can be undone.</p> : (
        <ul className="bm-hist">
          {changes.map((c) => (
            <li key={c.id} data-status={c.status}>
              <span className="bm-hist__what"><b>{opLabel(c.operation)}</b><span className="faint">{stamp(c.created)} · {plural(c.files, "file")}{c.status === "rolledBack" ? " · undone" : c.status === "failed" ? " · failed, undone" : ""}</span></span>
              {c === undoable && <button className="btn btn--sm press" disabled={!!blocker} onClick={(e) => onUndo(c, e)}>Undo…</button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
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
            {live && s.heartbeat > 0 && <> · last check {clock(s.heartbeat)}</>}
          </p>
        </div>
      )}
    </Card>
  );
}
