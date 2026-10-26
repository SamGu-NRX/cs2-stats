// Sidebar: the user, the six views, then Data & settings and the scan state. 232 px, or a 56 px rail.
// The toggle button animates the width; Ctrl+B and the automatic rail at a window 1100 px wide or
// narrower do not.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentImg } from "../components/Agent";
import { useRatings, useYourQuery } from "../data/hooks";
import { useData } from "../data/provider";
import { ChevronLeftIcon, HomeIcon, MatchesIcon, ProfileIcon, SettingsIcon } from "../icons/ui";
import { careerEntries, isOwn, ratingHeadline } from "../data/engine";
import { scanErrorText } from "../data/sources";
import { fmtRating, plural } from "../lib/format";
import { navWasInstant, pageHref, useRoute, type Page } from "../router";

type NavPage = Exclude<Page, "match" | "settings">;
/** The three views, in order; Ctrl+key opens each. Playstyle, Career aim and Weapons are Profile's tabs. */
export const NAV: { page: NavPage; label: string; Icon: typeof HomeIcon; key: string }[] = [
  { page: "home", label: "Home", Icon: HomeIcon, key: "1" },
  { page: "matches", label: "Matches", Icon: MatchesIcon, key: "2" },
  { page: "profile", label: "Profile", Icon: ProfileIcon, key: "3" },
];

const RAIL_KEY = "cs2stats.rail";
/** The window width at or below which the sidebar is a rail (design/shell-and-motion.md; at 1100 the full sidebar clipped the match view). */
const RAIL_AT = 1100;

function ago(ms: number | null, now: number): string {
  if (!ms) return "Not scanned yet";
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "Scanned just now";
  const m = Math.round(s / 60);
  if (m < 60) return `Scanned ${m} min ago`;
  return `Scanned ${Math.round(m / 60)} h ago`;
}

export function useRail() {
  const [pref, setPref] = useState(() => localStorage.getItem(RAIL_KEY) === "1");
  const [narrow, setNarrow] = useState(() => innerWidth <= RAIL_AT);
  const [instant, setInstant] = useState(true);
  useEffect(() => {
    const on = () => { setInstant(true); setNarrow(innerWidth <= RAIL_AT); };
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  const toggle = (animate: boolean) => {
    setInstant(!animate);
    setPref((p) => {
      localStorage.setItem(RAIL_KEY, p ? "0" : "1");
      return !p;
    });
  };
  return { rail: pref || narrow, toggle, instant, forced: narrow };
}

export function Sidebar({ rail, instant, onToggle }: { rail: boolean; instant: boolean; onToggle: () => void }) {
  const route = useRoute();
  const { matches, status, error, lastSync, refresh } = useData();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const career$ = useMemo(() => careerEntries(matches, null), [matches]);
  const q = useYourQuery(career$);
  const career = useRatings(useMemo(() => (q ? [q] : null), [q])).data;
  // the name from the newest of the user's own matches; a pro demo's recording player is not the user
  const own = matches.find(isOwn);
  const me = own ? { name: own.players[own.you].name, rating: career?.[0].both.value ?? null } : null;
  const ratingTip = me ? `${ratingHeadline()} over ${plural(career$.length, "rated match", "rated matches")}` : undefined;

  const active = route.page === "match" ? "matches" : route.page;
  const nav = useRef<HTMLElement>(null);
  const [bar, setBar] = useState<{ y: number; instant: boolean } | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>(`[data-page="${active}"]`);
    if (!el) { setBar(null); return; }
    setBar({ y: el.offsetTop, instant: first.current || navWasInstant() });
    first.current = false;
  }, [active]);

  const scanning = status === "starting" || status === "syncing";
  return (
    <aside className={`side ${instant ? "is-instant" : ""}`} data-rail={rail} aria-label="Sidebar">
      <div className="side__me" data-tip={me ? `${me.name}\n${ratingTip}` : undefined} data-tip-place="right">
        <span className="avatar"><AgentImg side="t" kind="portrait" /></span>
        <div className="side__who side__label">
          {me ? (
            <>
              <span className="side__name">{me.name}</span>
              <span className="side__rating"><span>Rating</span>{fmtRating(me.rating)}</span>
            </>
          ) : (
            <span className="side__name side__name--none">{scanning ? "Reading matches…" : "No matches yet"}</span>
          )}
        </div>
      </div>
      <nav className="side__nav" ref={nav} aria-label="Views">
        {bar && <i className={`side__bar ${bar.instant ? "is-instant" : ""}`} style={{ transform: `translateY(${bar.y}px)` }} aria-hidden />}
        {NAV.map(({ page, label, Icon, key }) => (
          <a
            key={page}
            data-page={page}
            href={pageHref(page)}
            className="side__item"
            aria-current={active === page ? "page" : undefined}
            aria-keyshortcuts={`Control+${key}`}
            data-tip={rail ? `${label}  ·  Ctrl ${key}` : `Ctrl ${key}`}
            data-tip-place="right"
          >
            <Icon size={20} />
            <span className="side__label">{label}</span>
          </a>
        ))}
      </nav>
      <div className="side__spacer" />
      <div className="side__foot">
        <a href={pageHref("settings")} className="side__item" data-page="settings" aria-current={active === "settings" ? "page" : undefined} aria-keyshortcuts="Control+," data-tip={rail ? "Data & settings  ·  Ctrl ," : "Ctrl ,"} data-tip-place="right">
          <SettingsIcon size={20} />
          <span className="side__label">Data & settings</span>
        </a>
        {status === "error" ? (
          // a failed scan links to the Sources card, where the reason and the recovery actions are
          <a className="side__sync" data-state="error" href={pageHref("settings")} data-tip={`${scanErrorText(error ?? "")}\nOpen Data & settings to try again.`} data-tip-place="right">
            <span className="dot"><i /></span>
            <span className="side__label">Scan failed</span>
          </a>
        ) : (
          <button className="side__sync" data-state={scanning ? "syncing" : "ready"} onClick={refresh} data-tip={rail ? `${scanning ? "Scanning…" : ago(lastSync, now)}. Rescan: Ctrl R` : "Rescan the match folder  ·  Ctrl R"} data-tip-place="right">
            <span className="dot"><i /></span>
            <span className="side__label">{scanning ? "Scanning…" : ago(lastSync, now)}</span>
          </button>
        )}
        <button className="side__item side__toggle" onClick={onToggle} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} aria-keyshortcuts="Control+B" data-tip={rail ? "Expand  ·  Ctrl B" : "Ctrl B"} data-tip-place="right">
          <ChevronLeftIcon size={20} />
          <span className="side__label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
