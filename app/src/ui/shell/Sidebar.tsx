// Sidebar: player identity, the views, then Data & settings and the sync state. 232 px, or a 56 px
// rail (toggle button animates the width; Ctrl+B and the automatic rail below 1100 px do not).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addCounters, emptyCounters } from "../../stats/counters";
import { AgentImg } from "../components/Agent";
import { countersRating } from "../data/engine";
import { useData } from "../data/provider";
import { AimIcon, ChevronLeftIcon, HomeIcon, MatchesIcon, ProfileIcon, SettingsIcon } from "../icons/ui";
import { OpeningIcon } from "../icons/attributes";
import { WeaponIcon } from "../icons/game";
const GunNavIcon = ({ size = 20 }: { size?: number }) => <span className="navgun" style={{ width: size, height: size }}><WeaponIcon name="ak47" size={Math.round(size * 0.55)} label={undefined} /></span>;
import { fmtRating } from "../lib/format";
import { navWasInstant, pageHref, useRoute, type Page } from "../router";

export const NAV: { page: Page; label: string; Icon: typeof HomeIcon; key: string }[] = [
  { page: "home", label: "Home", Icon: HomeIcon, key: "1" },
  { page: "matches", label: "Matches", Icon: MatchesIcon, key: "2" },
  { page: "profile", label: "Profile", Icon: ProfileIcon, key: "3" },
  { page: "playstyle", label: "Playstyle", Icon: OpeningIcon, key: "4" },
  { page: "aim", label: "Career aim", Icon: AimIcon, key: "5" },
  { page: "weapons", label: "Weapons", Icon: GunNavIcon, key: "6" },
];

const RAIL_KEY = "cs2stats.rail";

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
  const [narrow, setNarrow] = useState(() => innerWidth < 1100);
  const [instant, setInstant] = useState(true);
  useEffect(() => {
    const on = () => { setInstant(true); setNarrow(innerWidth < 1100); };
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
  const { summaries, status, lastSync, refresh } = useData();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const me = useMemo(() => {
    if (!summaries.length) return null;
    const c = emptyCounters();
    for (const s of summaries) addCounters(c, s.human.c);
    return { name: summaries[0].human.name, rating: countersRating(c) };
  }, [summaries]);

  const active = route.page === "match" ? "matches" : route.page;
  const nav = useRef<HTMLElement>(null);
  const [bar, setBar] = useState<{ y: number; instant: boolean } | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>(`[data-page="${active}"]`);
    if (!el) { setBar(null); return; }
    setBar({ y: el.offsetTop + 6, instant: first.current || navWasInstant() });
    first.current = false;
  }, [active]);

  return (
    <aside className={`side ${instant ? "is-instant" : ""}`} data-rail={rail} aria-label="Sidebar">
      <div className="side__me" data-tip={rail && me ? `${me.name}: rating ${fmtRating(me.rating)} over ${summaries.length} matches` : undefined}>
        <span className="avatar"><AgentImg side="t" kind="portrait" /></span>
        {me && (
          <div className="side__who side__label">
            <span className="side__name">{me.name}</span>
            <span className="side__rating"><span>Rating</span>{fmtRating(me.rating)}</span>
          </div>
        )}
      </div>
      <nav className="side__nav" ref={nav} aria-label="Views">
        {bar && <i className={`side__bar ${bar.instant ? "is-instant" : ""}`} style={{ transform: `translateY(${bar.y}px)` }} aria-hidden />}
        {NAV.map(({ page, label, Icon, key }) => (
          <a
            key={page}
            data-page={page}
            href={pageHref(page as Exclude<Page, "match">)}
            className="side__item"
            aria-current={active === page ? "page" : undefined}
            data-tip={rail ? `${label}  Ctrl ${key}` : `Ctrl ${key}`}
          >
            <Icon size={20} />
            <span className="side__label">{label}</span>
          </a>
        ))}
      </nav>
      <div className="side__spacer" />
      <div className="side__foot">
        <a href={pageHref("settings")} className="side__item" data-page="settings" aria-current={active === "settings" ? "page" : undefined} data-tip="Ctrl ,">
          <SettingsIcon size={20} />
          <span className="side__label">Data & settings</span>
        </a>
        <button className="side__sync" data-state={status === "error" ? "error" : status === "ready" ? "ready" : "syncing"} onClick={refresh} data-tip="Rescan the match folder  Ctrl R">
          <span className="dot"><i /></span>
          <span className="side__label">{status === "error" ? "Scan failed" : status === "ready" ? ago(lastSync, now) : "Scanning…"}</span>
        </button>
        <button className="side__item side__toggle" onClick={onToggle} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} data-tip="Ctrl B">
          <ChevronLeftIcon size={20} />
          <span className="side__label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
