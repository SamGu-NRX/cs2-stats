// Hash routes, so every view and tab can be deep-linked (and screenshotted). Scope controls live in
// the hash's query string (shell/filters.tsx), e.g. #/aim?side=t&map=de_dust2 or
// #/match/<file>/rounds?round=7. A view's section is the `sec` parameter: #/profile?sec=identity
// scrolls Profile to its Identity section once (useSection below).
//
// The app has three views (Home, Matches, Profile) plus Data & settings and the match view. Profile
// has tabs, #/profile/<tab>; the pages that became its tabs (#/playstyle, #/aim, #/weapons) still
// parse, as Profile on that tab, so old links and bookmarks keep working.
import { useCallback, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

// Replay is last so Alt 1 to 8 keep their tabs (App.tsx reads Alt with one digit, 1 to 8).
export const MATCH_TABS = ["overview", "rounds", "economy", "duels", "utility", "aim", "positions", "advanced", "replay"] as const;
export type MatchTab = (typeof MATCH_TABS)[number];
export const MATCH_TAB_LABEL: Record<MatchTab, string> = {
  overview: "Overview", rounds: "Rounds", economy: "Economy", duels: "Duels", utility: "Utility", aim: "Aim", positions: "Positions", advanced: "Advanced", replay: "Replay",
};

export const PROFILE_TABS = ["overview", "duels", "aim", "weapons", "utility", "economy", "playstyle"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];
export const PROFILE_TAB_LABEL: Record<ProfileTab, string> = {
  overview: "Overview", duels: "Duels", aim: "Aim", weapons: "Weapons", utility: "Utility", economy: "Economy", playstyle: "Playstyle",
};

export type Page = "home" | "matches" | "match" | "profile" | "settings";

export interface Route {
  page: Page;
  /** match page only */
  file?: string;
  tab?: MatchTab;
  /** profile page only */
  ptab?: ProfileTab;
  query: URLSearchParams;
}

/** Old ?sec= sections of the one-page Profile, by the tab that now holds them (Home's links, bookmarks). */
const SECTION_TAB: Record<string, ProfileTab> = {
  card: "overview", identity: "playstyle", style: "playstyle", performance: "overview", firepower: "overview", howgood: "duels", openings: "duels",
};

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart, qs = ""] = raw.split("?");
  const query = new URLSearchParams(qs);
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "match" && parts.length >= 2) {
    // the file path may contain slashes; the last part is the tab when it names one
    const last = parts[parts.length - 1] as MatchTab;
    const hasTab = parts.length >= 3 && (MATCH_TABS as readonly string[]).includes(last);
    return { page: "match", file: parts.slice(1, hasTab ? -1 : undefined).join("/"), tab: hasTab ? last : "overview", query };
  }
  const p = parts[0];
  if (p === "profile") {
    const t = parts[1] as ProfileTab;
    const sec = query.get("sec");
    const ptab = (PROFILE_TABS as readonly string[]).includes(t) ? t : (sec && SECTION_TAB[sec]) || "overview";
    return { page: "profile", ptab, query };
  }
  // the pages that became Profile tabs
  if (p === "playstyle" || p === "aim" || p === "weapons") return { page: "profile", ptab: p, query };
  if (p === "matches" || p === "settings") return { page: p, query };
  return { page: "home", query };
}

const qs = (q?: Record<string, string | number | null | undefined>) => {
  if (!q) return "";
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export const matchHref = (file: string, tab: MatchTab = "overview", q?: Record<string, string | number | null | undefined>) =>
  `#/match/${file.split("/").map(encodeURIComponent).join("/")}/${tab}${qs(q)}`;
export const pageHref = (page: Exclude<Page, "match">, q?: Record<string, string | number | null | undefined>) => `#/${page === "home" ? "" : page}${qs(q)}`;
export const profileHref = (tab: ProfileTab = "overview", q?: Record<string, string | number | null | undefined>) => `#/profile/${tab}${qs(q)}`;

// The current route is a small store, so navigation can render synchronously (flushSync) inside a
// View Transition: the new view must be in the DOM when the transition snapshots it.
let current: Route = typeof location === "undefined" ? parseHash("") : parseHash(location.hash);
const subs = new Set<() => void>();
const publish = () => {
  current = parseHash(location.hash);
  subs.forEach((s) => s());
};
/** The section scroll useSection has done for this visit; cleared on navigation, kept on scope changes. */
let sectionDone: string | null = null;
/** The last navigation came from a keyboard shortcut: the new view appears without motion. */
let instant = false;
export const navWasInstant = () => instant;
if (typeof window !== "undefined") addEventListener("hashchange", () => { instant = false; sectionDone = null; publish(); });

export function useRoute(): Route {
  return useSyncExternalStore((s) => { subs.add(s); return () => subs.delete(s); }, () => current);
}
export const currentRoute = () => current;

/** Navigates and renders the new route before returning. Keyboard callers pass instant. */
export function go(href: string, opts?: { instant?: boolean }) {
  const h = href.startsWith("#") ? href : `#${href}`;
  if (location.hash === h) return;
  instant = !!opts?.instant;
  sectionDone = null;
  history.pushState(null, "", h);
  flushSync(publish);
}

// Which input came last. Keyboard activation (Enter on a row, the palette, a focused button) opens
// a match instantly, as keyboard navigation does everywhere (design/shell-and-motion.md); callers
// share openMatch, so it asks here rather than every caller passing how it was triggered.
let keyboardLast = false;
if (typeof window !== "undefined") {
  addEventListener("keydown", () => { keyboardLast = true; }, true);
  addEventListener("pointerdown", () => { keyboardLast = false; }, true);
}

/**
 * Opens a match. On a pointer activation, where View Transitions exist and motion is allowed, the
 * clicked row's score and map label morph into the hero (the row carries data-vt="score" and
 * data-vt="map" children).
 */
export function openMatch(href: string, row?: Element | null) {
  if (keyboardLast) return go(href, { instant: true });
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || reduce) return go(href);
  const named: HTMLElement[] = [];
  row?.querySelectorAll<HTMLElement>("[data-vt]").forEach((el) => {
    el.style.viewTransitionName = `match-${el.dataset.vt}`;
    named.push(el);
  });
  const t = doc.startViewTransition(() => {
    named.forEach((el) => (el.style.viewTransitionName = ""));
    go(href);
  });
  t.finished.finally(() => named.forEach((el) => (el.style.viewTransitionName = "")));
}

/** Updates query parameters in place (replaceState: filters do not fill the back history). */
export function setQuery(key: string, value: string | null, more?: Record<string, string | null>) {
  const r = parseHash(location.hash);
  const all = { [key]: value, ...more };
  for (const [k, v] of Object.entries(all)) {
    if (v === null || v === "") r.query.delete(k);
    else r.query.set(k, v);
  }
  const base = location.hash.split("?")[0] || "#/";
  const s = r.query.toString();
  history.replaceState(null, "", `${base}${s ? `?${s}` : ""}`);
  flushSync(publish);
}

/** A page link that opens one of its sections, e.g. sectionHref("profile", "identity"). */
export const sectionHref = (page: Exclude<Page, "match">, sec: string, q?: Record<string, string | number | null | undefined>) => pageHref(page, { ...q, sec });
/** A Profile tab link that scrolls to one of the tab's sections. */
export const tabSectionHref = (tab: ProfileTab, sec: string, q?: Record<string, string | number | null | undefined>) => profileHref(tab, { ...q, sec });

/**
 * For a view that has sections: returns a ref for the section's element. When the route's `sec` names
 * this section, the element scrolls to the top of the pane when it first renders (it may render after
 * its data loads), once per visit: changing a scope control does not scroll again. No smooth scroll
 * (design/shell-and-motion.md). Give the element `scroll-margin-top` if a sticky bar covers it.
 *
 *   const identityRef = useSection("identity");
 *   <section ref={identityRef} id="identity">…</section>
 */
export function useSection(id: string): (el: HTMLElement | null) => void {
  const r = useRoute();
  const wanted = r.query.get("sec") === id;
  return useCallback((el: HTMLElement | null) => {
    if (!el || !wanted) return;
    const visit = `${r.page}|${r.ptab ?? ""}|${id}`;
    if (sectionDone === visit) return;
    sectionDone = visit;
    requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }, [wanted, r.page, r.ptab, id]);
}
