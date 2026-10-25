// The desktop shell: sidebar, app bar, content pane and the floating layers, plus the global
// keyboard shortcuts. Keyboard-triggered actions never animate.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { MenuLayer, ToastLayer, TooltipLayer, toast } from "./components/overlay";
import { DataProvider, useData } from "./data/provider";
import { BarProvider, useBarSlots } from "./shell/Bar";
import { Palette } from "./shell/Palette";
import { NAV, Sidebar, useRail } from "./shell/Sidebar";
import { SearchIcon } from "./icons/ui";
import { go, matchHref, MATCH_TABS, navWasInstant, pageHref, useRoute, currentRoute } from "./router";
import { HomeView } from "./views/Home";
import { MatchesView } from "./views/Matches";

const MatchView = lazy(() => import("./views/match/MatchView"));
const ProfileView = lazy(() => import("./views/Profile"));
const PlaystyleView = lazy(() => import("./views/Playstyle"));
const AimView = lazy(() => import("./views/CareerAim"));
const SettingsView = lazy(() => import("./views/Settings"));
const WeaponsView = lazy(() => import("./views/Weapons"));

const TITLES: Record<string, string> = { home: "Home", matches: "Matches", match: "Match", profile: "Profile", playstyle: "Playstyle", aim: "Career aim", weapons: "Weapons", settings: "Data & settings" };

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
        <button className="search-btn" onClick={onPalette} aria-label="Open the command palette (Ctrl K)">
          <SearchIcon size={14} />
          <span>Search</span>
          <span className="kbd"><kbd>Ctrl</kbd><kbd>K</kbd></span>
        </button>
      </div>
    </header>
  );
}

function Body() {
  const route = useRoute();
  const { status, error, matches, refresh, meta } = useData();
  const pane = useRef<HTMLElement>(null);
  const rail = useRail();
  const [palette, setPalette] = useState(false);
  const pageKey = route.page === "match" ? `match:${route.file}` : route.page;

  useEffect(() => {
    document.title = `${TITLES[route.page]} · CS2 Stats`;
    pane.current?.scrollTo({ top: 0 });
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useMemo(() => [
    { label: "Rescan the match folder", hint: "Ctrl R", run: () => { refresh(); toast("Scanning the match folder"); } },
    { label: rail.rail ? "Expand the sidebar" : "Collapse the sidebar", hint: "Ctrl B", run: () => rail.toggle(false) },
  ], [refresh, rail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, [contenteditable='true']") !== null;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      if (palette) return;
      if (ctrl && e.key.toLowerCase() === "b") { e.preventDefault(); rail.toggle(false); return; }
      if (ctrl && e.key === ",") { e.preventDefault(); go(pageHref("settings"), { instant: true }); return; }
      if (ctrl && e.key.toLowerCase() === "r") { e.preventDefault(); refresh(); toast("Scanning the match folder"); return; }
      if (ctrl && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        const n = NAV.find((x) => x.key === e.key);
        if (n) go(pageHref(n.page as never), { instant: true });
        return;
      }
      const r = currentRoute();
      if (e.altKey && /^[1-8]$/.test(e.key) && r.page === "match" && r.file) {
        e.preventDefault();
        go(matchHref(r.file, MATCH_TABS[Number(e.key) - 1]), { instant: true });
        return;
      }
      if (typing || ctrl || e.altKey) return;
      if ((e.key === "[" || e.key === "]") && r.page === "match" && r.file) {
        const i = matches.findIndex((s) => s.file === r.file);
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

  let view: JSX.Element;
  if (status === "error") {
    view = (
      <div className="view"><div className="error-box" role="alert">
        <h2>Matches could not be read</h2>
        <p className="selectable muted">{error}</p>
      </div></div>
    );
  } else if (!meta) {
    // the views read metric labels and units the worker sends once at start (data/meta.ts)
    view = <div className="view"><div className="skel" style={{ height: 160 }} /></div>;
  } else if (route.page === "match" && route.file) view = <MatchView file={route.file} tab={route.tab ?? "overview"} />;
  else if (route.page === "matches") view = <MatchesView />;
  else if (route.page === "profile") view = <ProfileView />;
  else if (route.page === "playstyle") view = <PlaystyleView />;
  else if (route.page === "aim") view = <AimView />;
  else if (route.page === "weapons") view = <WeaponsView />;
  else if (route.page === "settings") view = <SettingsView />;
  else view = <HomeView />;

  return (
    <div className="shell">
      <Sidebar rail={rail.rail} instant={rail.instant} onToggle={() => rail.toggle(true)} />
      <div className="main">
        <AppBar onPalette={() => setPalette(true)} />
        <main ref={pane} className="pane" tabIndex={-1} aria-label={TITLES[route.page]}>
          <Suspense fallback={<div className="view"><div className="skel" style={{ height: 160 }} /></div>}>
            <div key={pageKey} className={navWasInstant() ? undefined : "view-in"}>{view}</div>
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

export function App() {
  return (
    <DataProvider>
      <BarProvider>
        <Body />
      </BarProvider>
    </DataProvider>
  );
}
