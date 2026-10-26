// The match: a hero band (score, teams, map, your line), the round rail and the tabs, sticky
// together, then the tab panel. The hero renders from the match list's entry at once, so it is never
// empty while the facts come from the worker.
import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { MapThumb, Num, SourceBadge } from "../../components/bits";
import { MapAtmosphere } from "../../components/MapArt";
import { entryLine, ratingHeadline } from "../../data/engine";
import { useMatch } from "../../data/hooks";
import { mapAccent } from "../../data/maps";
import type { MatchEntry, MatchModel } from "../../data/match";
import { useData } from "../../data/provider";
import { sourceOf } from "../../data/sources";
import { ChevronLeftIcon, ChevronRightIcon } from "../../icons/ui";
import { fmtAdr, fmtMatchDay, fmtDuration, fmtPct, fmtRating, fmtSwing, fmtWhen, mapName } from "../../lib/format";
import { scoreText, swingScore, ratingText } from "../../lib/scale";
import { go, matchHref, MATCH_TAB_LABEL, MATCH_TABS, navWasInstant, pageHref, useRoute, type MatchTab } from "../../router";
import { BarContent } from "../../shell/Bar";
import { Empty, NEEDS_DEMO, swingSumTip } from "../shared";
import { RoundRail } from "./RoundRail";
import Overview from "./Overview";

const Rounds = lazy(() => import("./Rounds"));
const Economy = lazy(() => import("./Economy"));
const Duels = lazy(() => import("./Duels"));
const Utility = lazy(() => import("./Utility"));
const Aim = lazy(() => import("./Aim"));
const Positions = lazy(() => import("./Positions"));
const Advanced = lazy(() => import("./Advanced"));

/** round: the selected round's row (ri), found from the round number in the URL */
export interface TabProps { v: MatchModel; file: string; round: number | null }

export default function MatchView({ file, tab }: { file: string; tab: MatchTab }) {
  const { matches, status } = useData();
  const r = useRoute();
  const s = matches.find((x) => x.file === file) ?? null;
  const loaded = useMatch(file);
  const v = loaded.data;
  // before the first scan finishes the match list is empty, so "not in the folder" is not yet an answer
  const error = status === "starting" || (status === "syncing" && !matches.length) ? null : loaded.error;
  const n = r.query.get("round") ? Number(r.query.get("round")) : null;
  const ri = v && n !== null ? v.rounds.findIndex((x) => x.number === n) : -1;
  const round = ri >= 0 ? ri : null;
  const i = matches.findIndex((x) => x.file === file);
  const older = matches[i + 1];
  const newer = matches[i - 1];
  const map = v?.map ?? s?.match.map ?? "";

  return (
    <div className="view view--flush match" style={{ ["--map-accent" as string]: mapAccent(map) }}>
      <BarContent
        crumbs={[{ label: s ? s.players[s.you].name : "You", href: pageHref("profile") }, { label: "Matches", href: pageHref("matches") }, { label: s ? `${mapName(s.match.map)}, ${fmtMatchDay(s.match)}` : "Match" }]}
        tools={
          <span className="pager">
            <button className="btn btn--ghost btn--icon btn--sm press" disabled={!older} onClick={() => older && go(matchHref(older.file, tab))} data-tip="Older match  [" aria-label="Older match"><ChevronLeftIcon size={16} /></button>
            <button className="btn btn--ghost btn--icon btn--sm press" disabled={!newer} onClick={() => newer && go(matchHref(newer.file, tab))} data-tip="Newer match  ]" aria-label="Newer match"><ChevronRightIcon size={16} /></button>
          </span>
        }
      />
      {error ? (
        <div style={{ padding: "20px var(--gutter)" }}><div className="error-box" role="alert"><h2>This match could not be read</h2><p className="muted selectable">{error}</p></div></div>
      ) : (
        <>
          <Hero s={s} v={v} />
          <Sticky v={v} file={file} tab={tab} selected={n} />
          <div className="match__panel" id="match-panel" role="tabpanel" aria-label={MATCH_TAB_LABEL[tab]}>
            {!v ? <TabSkeleton tab={tab} /> : (
              <Suspense fallback={<TabSkeleton tab={tab} />}>
                {tab === "overview" && <Overview v={v} file={file} round={round} />}
                {tab === "rounds" && <Rounds v={v} file={file} round={round} />}
                {tab === "economy" && <Economy v={v} file={file} round={round} />}
                {tab === "duels" && <Duels v={v} file={file} round={round} />}
                {tab === "utility" && <Utility v={v} file={file} round={round} />}
                {tab === "aim" && <Aim v={v} file={file} round={round} />}
                {tab === "positions" && <Positions v={v} file={file} round={round} />}
                {tab === "advanced" && <Advanced v={v} file={file} round={round} />}
              </Suspense>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TabSkeleton({ tab }: { tab: MatchTab }) {
  if (tab === "rounds") return <div className="tabpad"><div className="skel" style={{ height: 420 }} /></div>;
  return (
    <div className="tabpad grid-2">
      <div className="skel" style={{ height: 260 }} />
      <div className="skel" style={{ height: 260 }} />
    </div>
  );
}

function Hero({ s, v }: { s: MatchEntry | null; v: MatchModel | null }) {
  const e = v?.entry ?? s;
  if (!e) return <div className="mhero"><div className="skel" style={{ height: 96, margin: "16px var(--gutter)" }} /></div>;
  const { score, result } = e;
  const map = e.match.map;
  const src = sourceOf(e);
  const line = entryLine(e);
  const usStart = e.usStartSide;
  const halves = (team: "us" | "them") => {
    if (!v) return null;
    const firstSide = team === "us" ? usStart : usStart === "T" ? "CT" : "T";
    const max = v.maxRounds;
    const h1 = v.rounds.filter((r) => r.number <= max / 2 && r.winner === team).length;
    const h2 = v.rounds.filter((r) => r.number > max / 2 && r.number <= max && r.winner === team).length;
    const ot = v.rounds.filter((r) => r.number > max && r.winner === team).length;
    return (
      <span className="mhero__halves num">
        <span className={firstSide === "T" ? "t-text" : "ct-text"}>{firstSide} <b>{h1}</b></span>
        <span className={firstSide === "T" ? "ct-text" : "t-text"}>{firstSide === "T" ? "CT" : "T"} <b>{h2}</b></span>
        {v.rounds.some((r) => r.number > max) && <span className="muted">OT <b>{ot}</b></span>}
      </span>
    );
  };
  return (
    <header className="mhero">
      <MapAtmosphere map={map} />
      <div className="mhero__in">
        <div className="mhero__team">
          <span className="caps">Your team</span>
          <b className="mhero__name">{e.players[e.you].name} <span className="faint">+ 4</span></b>
          {halves("us")}
        </div>
        <div className="mhero__center">
          <div className="mhero__score num">
            <span className={result === "W" ? "cream" : "lose"}>{score.us}</span>
            <span className={`res res--${result}`}>{result === "W" ? "Win" : result === "L" ? "Loss" : "Tie"}</span>
            <span className={result === "L" ? "cream" : "lose"}>{score.them}</span>
          </div>
          <div className="mhero__meta">
            <span className="mhero__map"><MapThumb map={map} size={18} /><b>{mapName(map)}</b></span>
            <span>{fmtWhen(e.match)}</span>
            {e.match.durationS !== null && <span data-tip="From the first round's start to the last round's end" tabIndex={0}>{fmtDuration(e.match.durationS)}</span>}
            <SourceBadge s={src} />
          </div>
        </div>
        <div className="mhero__team mhero__team--them">
          <span className="caps">Opponents</span>
          <b className="mhero__name">5 bots</b>
          {halves("them")}
        </div>
      </div>
      <div className="mhero__you">
        <span className="caps">You</span>
        <span className="mhero__stat"><span className="meta">{ratingHeadline()}</span><b className="num" style={{ color: ratingText(line.rating ?? 1) }}>{fmtRating(line.rating)}</b></span>
        <span className="mhero__stat"><span className="meta">Swing</span><b className="num" style={{ color: line.swing === null ? undefined : scoreText(swingScore(line.swing)) }} data-tip={swingSumTip(line.m)} tabIndex={0}><Num v={fmtSwing(line.swing)} /></b></span>
        <span className="mhero__stat"><span className="meta">K–D</span><b className="num">{line.kills}<span className="faint">–</span>{line.deaths}</b></span>
        <span className="mhero__stat"><span className="meta">ADR</span><b className="num">{fmtAdr(line.adr)}</b></span>
        <span className="mhero__stat"><span className="meta">KAST</span><b className="num"><Num v={fmtPct(line.kast)} /></b></span>
        <span className="mhero__stat"><span className="meta">HS%</span><b className="num"><Num v={fmtPct(line.hs)} /></b></span>
      </div>
    </header>
  );
}

/** selected: the URL's round number, which may name a round held only as totals */
function Sticky({ v, file, tab, selected }: { v: MatchModel | null; file: string; tab: MatchTab; selected: number | null }) {
  const tabs = useRef<HTMLDivElement>(null);
  const [ul, setUl] = useState<{ x: number; w: number; instant: boolean } | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = tabs.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (!el) return;
    setUl({ x: el.offsetLeft, w: el.offsetWidth, instant: first.current || navWasInstant() });
    first.current = false;
  }, [tab]);
  const pick = (number: number) => go(matchHref(file, "rounds", { round: number }));
  return (
    <div className="msticky">
      {v ? <div className="msticky__rail"><RoundRail v={v} selected={selected} onPick={pick} /></div> : <div className="skel" style={{ height: 70, margin: "8px var(--gutter)" }} />}
      <div className="mtabs" role="tablist" aria-label="Match sections" ref={tabs}>
        {ul && <i className={`mtabs__ul ${ul.instant ? "is-instant" : ""}`} style={{ width: ul.w, transform: `translateX(${ul.x}px)` }} aria-hidden />}
        {MATCH_TABS.map((t, n) => {
          const disabled = !!v && ((t === "aim" && !v.entry.hasAim) || (t === "positions" && !v.facts.kills.some((k) => k.kpos)));
          return (
            <a
              key={t}
              data-tab={t}
              role="tab"
              aria-selected={t === tab}
              aria-controls="match-panel"
              href={matchHref(file, t, selected !== null && t === "rounds" ? { round: selected } : undefined)}
              className={`mtab ${disabled ? "is-dim" : ""}`}
              data-tip={`Alt ${n + 1}${disabled ? (t === "aim" ? `: ${NEEDS_DEMO.toLowerCase()}` : ": no positions in this match") : ""}`}
            >
              {MATCH_TAB_LABEL[t]}
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function NoData({ text, action }: { text: string; action?: JSX.Element }) {
  return <div className="tabpad"><Empty text={text} action={action} /></div>;
}
