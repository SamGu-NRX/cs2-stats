// The desktop shell: sidebar, title bar, content pane and the floating layers, plus the global
// keyboard shortcuts. Keyboard-triggered actions never animate.
//
// Until the first scan finishes, the pane says how far it got rather than drawing a skeleton (a cold
// first scan of many matches takes seconds). If the scan fails before any match is known, every view
// but Data & settings shows the failure with Try again; Data & settings stays usable, since its
// Rescan, Import and source switches are the ways out. Bot Mode reads no matches, so it shows in
// every scan state.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { MenuLayer, ToastLayer, TooltipLayer, toast } from "./components/overlay";
import { DataProvider, useData } from "./data/provider";
import { scanErrorText } from "./data/sources";
import { privacyForced, setHidePersonal, useHidePersonal } from "./data/privacy";
import { BarContent, BarProvider, useBarSlots } from "./shell/Bar";
import { KeyChips, Palette } from "./shell/Palette";
import { NAV, Sidebar, useRail } from "./shell/Sidebar";
import { RefreshIcon, SearchIcon } from "./icons/ui";
import { go, isTextEntry, matchFile, matchHref, matchTabOfKey, navWasPointer, pageHref, profileHref, PROFILE_TABS, scopeQuery, useRoute, currentRoute } from "./router";
import { HomeView } from "./views/Home";
import { MatchesView } from "./views/Matches";

const MatchView = lazy(() => import("./views/match/MatchView"));
const ProfileView = lazy(() => import("./views/Profile"));
const SettingsView = lazy(() => import("./views/Settings"));
const BotModeView = lazy(() => import("./views/BotMode"));

const TITLES: Record<string, string> = { home: "Home", matches: "Matches", match: "Match", profile: "Profile", botmode: "Bot Mode", settings: "Data & settings" };

function AppBar({ onPalette }: { onPalette: () => void }) {
  const { set } = useBarSlots();
  const crumbs = useRef<HTMLDivElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  useEffect(() => set({ crumbs: crumbs.current, tools: tools.current }), [set]);
  return (
    <header className="bar">
      <div ref={crumbs} style={{ display: "contents" }} />
      <div className="bar__tools">
        <div ref={tools} style={{ display: "contents" }} />
        <button className="search-btn" onClick={onPalette} aria-label="Search" aria-keyshortcuts="Control+K">
          <SearchIcon size={14} />
          <span>Search</span>
          <KeyChips keys="Ctrl K" />
        </button>
      </div>
    </header>
  );
}

/** Everything inside the data and title-bar providers; exported for the privacy test, which renders it with data of its own. */
export function Shell() {
  const route = useRoute();
  const { status, error, matches, refresh, meta, progress } = useData();
  const pane = useRef<HTMLElement>(null);
  const rail = useRail();
  const [palette, setPalette] = useState(false);
  // an id in the address read before the match list arrived names its file once the list is here
  const file = route.page === "match" && route.file ? matchFile(route.file) : null;
  const pageKey = route.page === "match" ? `match:${file}` : route.page;
  const hide = useHidePersonal();

  useEffect(() => {
    document.title = `${TITLES[route.page]} · CS2 Stats`;
    // a link to a section (?sec=) scrolls there itself (router.ts useSection)
    if (!route.query.get("sec")) pane.current?.scrollTo({ top: 0 });
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useMemo(() => [
    { label: "Rescan the match folder", hint: "Ctrl R", run: () => { refresh(); toast("Scanning the match folder"); } },
    { label: rail.rail ? "Expand the sidebar" : "Collapse the sidebar", hint: "Ctrl B", run: () => rail.toggle(false) },
    // no shortcut of its own: one stray key press mid-capture would show every name again. The capture
    // switch holds it on, so the palette does not offer to turn it off then.
    ...(privacyForced() ? [] : [{
      label: hide ? "Show personal info" : "Hide personal info",
      words: "privacy screenshot names",
      run: () => {
        const problem = setHidePersonal(!hide);
        toast(problem ?? (hide ? "Personal info shown" : "Personal info hidden"), problem ? "poor" : "info");
      },
    }]),
  ], [refresh, rail, hide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a confirmation is open (Bot Mode's dialogs): the page behind is inert, and a shortcut must
      // not navigate away from it, least of all while its action runs
      if (document.querySelector("dialog[open]")) return;
      const el = e.target as HTMLElement;
      const typing = isTextEntry(el);
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      if (palette) return;
      if (ctrl && e.key.toLowerCase() === "b") { e.preventDefault(); rail.toggle(false); return; }
      if (ctrl && e.key === ",") { e.preventDefault(); go(pageHref("settings"), { instant: true }); return; }
      if (ctrl && e.key.toLowerCase() === "r") { e.preventDefault(); refresh(); toast("Scanning the match folder"); return; }
      if (ctrl && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const n = NAV.find((x) => x.key === e.key);
        if (n) go(pageHref(n.page), { instant: true });
        return;
      }
      // below here, a field being typed in keeps its keys: Alt and a digit can enter text in some layouts
      if (typing) return;
      const r = currentRoute();
      const matchTab = e.altKey ? matchTabOfKey(e.key) : null;
      if (matchTab && r.page === "match" && r.file) {
        e.preventDefault();
        go(matchHref(r.file, matchTab), { instant: true });
        return;
      }
      // Profile's tabs, as the match tabs: Alt+1 to Alt+7
      if (e.altKey && /^[1-7]$/.test(e.key) && r.page === "profile") {
        e.preventDefault();
        go(profileHref(PROFILE_TABS[Number(e.key) - 1], scopeQuery(r.query)), { instant: true });
        return;
      }
      if (ctrl || e.altKey) return;
      if ((e.key === "[" || e.key === "]") && r.page === "match" && r.file) {
        const i = matches.findIndex((s) => s.file === matchFile(r.file!));
        // matches are newest first: "[" goes to the older match, "]" to the newer one
        const next = matches[e.key === "[" ? i + 1 : i - 1];
        if (next) go(matchHref(next.file, r.tab), { instant: true });
        return;
      }
      if (e.key === "/") {
        const f = document.querySelector<HTMLInputElement>("[data-filter]");
        if (f) { e.preventDefault(); f.focus(); f.select(); }
        return;
      }
      if ((e.key === "j" || e.key === "k") && !el.closest("tbody, [role=grid]")) {
        const body = pane.current?.querySelector<HTMLElement>("tbody[tabindex]");
        if (body) { e.preventDefault(); body.focus(); }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [palette, rail, refresh, matches]);

  const title = TITLES[route.page];
  const firstScan = !matches.length && (status === "starting" || status === "syncing");
  let view: JSX.Element;
  // Bot Mode reads nothing from the match folder, so a failed or unfinished scan never hides it
  if (route.page === "botmode") view = <BotModeView />;
  else if (status === "error" && !matches.length && !(route.page === "settings" && meta)) {
    view = <ScanFailed title={title} error={error ?? ""} onRetry={refresh} />;
  } else if (!meta || (firstScan && route.page !== "settings")) {
    // the views read metric labels and units the worker sends once at start (data/meta.ts), and
    // would say "no matches yet" while the first scan is still reading them
    view = <FirstScan title={title} progress={meta ? progress : null} />;
  } else if (file) view = <MatchView file={file} tab={route.tab ?? "overview"} />;
  else if (route.page === "matches") view = <MatchesView />;
  else if (route.page === "profile") view = <ProfileView tab={route.ptab ?? "overview"} />;
  else if (route.page === "settings") view = <SettingsView />;
  else view = <HomeView />;

  return (
    <div className="shell">
      <Sidebar rail={rail.rail} instant={rail.instant} onToggle={() => rail.toggle(true)} />
      <div className="main">
        <AppBar onPalette={() => setPalette(true)} />
        <main ref={pane} className="pane" tabIndex={-1} aria-label={TITLES[route.page]}>
          <Suspense fallback={<FirstScan title={title} progress={null} />}>
            <div key={pageKey} className={navWasPointer() ? "view-in" : undefined}>{view}</div>
          </Suspense>
        </main>
      </div>
      <Palette open={palette} onClose={() => setPalette(false)} actions={actions} />
      <TooltipLayer />
      <ToastLayer />
      <MenuLayer />
    </div>
  );
}

/** The first scan, with how far it got. The title bar keeps the page's name. */
function FirstScan({ title, progress }: { title: string; progress: { done: number; total: number } | null }) {
  const text = progress && progress.total ? `Reading matches: ${progress.done} of ${progress.total}` : "Starting the stats engine…";
  return (
    <div className="view">
      <BarContent crumbs={[{ label: title }]} />
      <div className="first-scan" role="status">
        <p>{text}</p>
        {progress && progress.total > 0 && (
          <div className="first-scan__bar" aria-hidden><i style={{ transform: `scaleX(${progress.done / progress.total})` }} /></div>
        )}
        <p className="meta">The first scan reads every match once; later scans read only new files.</p>
      </div>
    </div>
  );
}

/** The match folder could not be read and no match is known yet: what failed, what to do, and the raw error on request. */
function ScanFailed({ title, error, onRetry }: { title: string; error: string; onRetry: () => void }) {
  return (
    <div className="view">
      <BarContent crumbs={[{ label: title }]} />
      <div className="scan-failed" role="alert">
        <h2>Matches could not be read</h2>
        <p>{scanErrorText(error)}</p>
        <div className="scan-failed__actions">
          <button className="btn btn--primary press" onClick={onRetry}><RefreshIcon size={14} />Try again</button>
          <a className="btn" href={pageHref("settings")}>Open Data & settings</a>
        </div>
        <p className="meta">Your packs and settings are unaffected.</p>
        {error && (
          <details className="scan-failed__raw">
            <summary>Details</summary>
            <p className="mono selectable">{error}</p>
          </details>
        )}
      </div>
    </div>
  );
}

export function App() {
  return (
    <DataProvider>
      <BarProvider>
        <Shell />
      </BarProvider>
    </DataProvider>
  );
}
