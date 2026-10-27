// The match: a hero band (score, teams, map, your line), the round rail and the tabs, sticky
// together, then the tab panel. The hero renders from the match list's entry at once, so it is never
// empty while the facts come from the worker.
import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { MapThumb, Num, SourceBadge } from "../../components/bits";
import { MapAtmosphere } from "../../components/MapArt";
import { entryLine, isOwn, ratingHeadline, statLine, teamsOf, type OwnEntry } from "../../data/engine";
import { useMatch } from "../../data/hooks";
import { mapAccent } from "../../data/maps";
import type { MatchEntry, MatchModel, Team, ViewedMatch } from "../../data/match";
import { useData } from "../../data/provider";
import { sourceOf } from "../../data/sources";
import { ChevronLeftIcon, ChevronRightIcon } from "../../icons/ui";
import { fmtAdr, fmtMatchDay, fmtDuration, fmtPct, fmtRating, fmtSwing, fmtWhen, mapName } from "../../lib/format";
import { scoreText, swingScore, ratingText } from "../../lib/scale";
import { go, matchHref, MATCH_TAB_LABEL, MATCH_TABS, matchTabKey, navWasInstant, pageHref, setQuery, useRoute, type MatchTab } from "../../router";
import { BarContent } from "../../shell/Bar";
import { Empty, NEEDS_DEMO, swingSumTip } from "../shared";
import { RoundRail } from "./RoundRail";
import { Viewed } from "./Viewer";
import Overview from "./Overview";
import { replayUnavailable } from "./replay/support";
import type { OffRoster } from "../../../stats/roster";

const OFF_ROSTER_KINDS: [keyof OffRoster, string, string][] = [
  ["kills", "kill", "kills"], ["assists", "assist", "assists"], ["damages", "hit", "hits"], ["blinds", "blind", "blinds"],
  ["grenades", "grenade record", "grenade records"], ["shots", "shot", "shots"], ["positions", "position sample", "position samples"],
  ["spotted", "radar sighting", "radar sightings"], ["engagements", "engagement", "engagements"],
];

/** What the roster rule removed, as "1 kill, 2 hits"; empty when it removed nothing. */
const offRosterList = (o: OffRoster) => OFF_ROSTER_KINDS.filter(([k]) => o[k] > 0).map(([k, one, many]) => `${o[k]} ${o[k] === 1 ? one : many}`).join(", ");

const Rounds = lazy(() => import("./Rounds"));
const Economy = lazy(() => import("./Economy"));
const Duels = lazy(() => import("./Duels"));
const Utility = lazy(() => import("./Utility"));
const Aim = lazy(() => import("./Aim"));
const Positions = lazy(() => import("./Positions"));
const Advanced = lazy(() => import("./Advanced"));
const Luck = lazy(() => import("./Luck"));
const Replay = lazy(() => import("./replay/Replay"));

/** round: the selected round's row (ri), found from the round number in the URL */
export interface TabProps { v: MatchModel; file: string; round: number | null }
/** A tab that reads one player: it renders only once the match has a viewer (Viewer.tsx). */
export type ViewedTabProps = Omit<TabProps, "v"> & { v: ViewedMatch };

export default function MatchView({ file, tab }: { file: string; tab: MatchTab }) {
  const { matches, status } = useData();
  const r = useRoute();
  const s = matches.find((x) => x.file === file) ?? null;
  // a pro demo is seen through the player picked on its scoreboard (Viewer.tsx), if any
  const loaded = useMatch(file, r.query.get("as"));
  const v = loaded.data;
  // before the first scan finishes the match list is empty, so "not in the folder" is not yet an answer
  const error = status === "starting" || (status === "syncing" && !matches.length) ? null : loaded.error;
  const n = r.query.get("round") ? Number(r.query.get("round")) : null;
  const ri = v && n !== null ? v.rounds.findIndex((x) => x.number === n) : -1;
  const round = ri >= 0 ? ri : null;
  // the pager steps within the match's own list: the user's matches, or the pro demos
  const pro = s ? !isOwn(s) : false;
  const group = matches.filter((x) => !isOwn(x) === pro);
  const i = group.findIndex((x) => x.file === file);
  const older = group[i + 1];
  const newer = group[i - 1];
  const map = v?.map ?? s?.match.map ?? "";

  return (
    <div className="view view--flush match" style={{ ["--map-accent" as string]: mapAccent(map) }}>
      <BarContent
        crumbs={[
          ...(s && isOwn(s) ? [{ label: s.players[s.you].name, href: pageHref("profile") }, { label: "Matches", href: pageHref("matches") }] : [{ label: "Pro matches", href: pageHref("matches", { view: "pro" }) }]),
          { label: s ? (pro ? `${s.match.teams[0]} vs ${s.match.teams[1]}, ${mapName(s.match.map)}` : `${mapName(s.match.map)}, ${fmtMatchDay(s.match)}`) : "Match" },
        ]}
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
          {s && !isOwn(s) ? <ProHero s={s} v={v} /> : <Hero s={s && isOwn(s) ? s : null} v={v} />}
          <Sticky v={v} file={file} tab={tab} selected={n} />
          <section className="match__panel" id="match-panel" aria-label={MATCH_TAB_LABEL[tab]}>
            {!v ? <TabSkeleton tab={tab} /> : (
              <Suspense fallback={<TabSkeleton tab={tab} />}>
                {tab === "overview" && <Overview v={v} file={file} round={round} />}
                {tab === "rounds" && <Rounds v={v} file={file} round={round} />}
                {tab === "economy" && <Economy v={v} file={file} round={round} />}
                {tab === "duels" && <Duels v={v} file={file} round={round} />}
                {tab === "utility" && <Utility v={v} file={file} round={round} />}
                {tab === "aim" && <Viewed v={v} what="their aim">{(w) => <Aim v={w} file={file} round={round} />}</Viewed>}
                {tab === "positions" && <Viewed v={v} what="where they played">{(w) => <Positions v={w} file={file} round={round} />}</Viewed>}
                {tab === "advanced" && <Advanced v={v} file={file} round={round} />}
                {tab === "luck" && <Viewed v={v} what="their luck">{(w) => <Luck v={w} file={file} round={round} />}</Viewed>}
                {tab === "replay" && <Replay v={v} file={file} round={round} />}
              </Suspense>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** A tab that is still loading: its match, or its code (the tabs load lazily). */
function TabSkeleton({ tab }: { tab: MatchTab }) {
  if (tab === "rounds") return <div className="tabpad" aria-busy="true"><div className="skel" style={{ height: 420 }} /></div>;
  return (
    <div className="tabpad grid-2" aria-busy="true">
      <div className="skel" style={{ height: 260 }} />
      <div className="skel" style={{ height: 260 }} />
    </div>
  );
}

function Hero({ s, v }: { s: OwnEntry | null; v: MatchModel | null }) {
  const e = s;
  if (!e) return <div className="mhero"><div className="skel" style={{ height: 96, margin: "16px var(--gutter)" }} /></div>;
  const { score, result } = e;
  const map = e.match.map;
  const src = sourceOf(e);
  const line = entryLine(e);
  const teams = teamsOf(e);
  const halves = (team: "us" | "them") => <Halves v={v} team={team} usStart={e.usStartSide} />;
  return (
    <header className="mhero">
      <MapAtmosphere map={map} />
      <div className="mhero__in">
        <div className="mhero__team">
          <span className="caps">Your team</span>
          <b className="mhero__name">{e.players[e.you].name}{teams.mates > 0 && <span className="faint"> + {teams.mates}</span>}</b>
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
            {/* events the roster rule removed (stats/roster.ts), said rather than dropped silently */}
            {offRosterList(e.match.inputs.offRoster) && (
              <span className="chip chip--warn" tabIndex={0}
                data-tip={`The file marks a player dead at freeze end, or gone before it, yet records them in that round's live play: ${offRosterList(e.match.inputs.offRoster)}. All of it is left out of every number and view.`}>
                Off-roster events left out
              </span>
            )}
          </div>
        </div>
        <div className="mhero__team mhero__team--them">
          <span className="caps">Opponents</span>
          <b className="mhero__name">{teams.opponents ?? <span className="faint">Not in this file</span>}</b>
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

/** A team's rounds won in each half and in overtime, each half marked with the side it played. */
function Halves({ v, team, usStart }: { v: MatchModel | null; team: Team; usStart: "CT" | "T" }) {
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
}

/**
 * A pro demo's hero: both teams by name and the final score, with no side of it called yours. Below,
 * the line of the player the match is seen through, or how to pick one.
 */
function ProHero({ s, v }: { s: MatchEntry; v: MatchModel | null }) {
  const map = s.match.map;
  const [a, b] = s.match.teams;
  const { us, them } = s.score;
  const viewer = v && v.human !== null ? { name: v.players[v.human].name, line: statLine(v.b.lines.both[v.human]) } : null;
  return (
    <header className="mhero mhero--pro">
      <MapAtmosphere map={map} />
      <div className="mhero__in">
        <div className="mhero__team">
          <span className="caps">{s.usStartSide} first</span>
          <b className="mhero__name">{a}</b>
          <Halves v={v} team="us" usStart={s.usStartSide} />
        </div>
        <div className="mhero__center">
          <div className="mhero__score num" aria-label={`${a} ${us}, ${b} ${them}`}>
            <span className={us >= them ? "cream" : "lose"}>{us}</span>
            <span className="res res--final">{us === them ? "Tie" : "Final"}</span>
            <span className={them >= us ? "cream" : "lose"}>{them}</span>
          </div>
          <div className="mhero__meta">
            <span className="mhero__map"><MapThumb map={map} size={18} /><b>{mapName(map)}</b></span>
            <span>{fmtWhen(s.match)}</span>
            {s.match.durationS !== null && <span data-tip="From the first round's start to the last round's end" tabIndex={0}>{fmtDuration(s.match.durationS)}</span>}
            <SourceBadge s={sourceOf(s)} />
          </div>
        </div>
        <div className="mhero__team mhero__team--them">
          <span className="caps">{s.usStartSide === "CT" ? "T" : "CT"} first</span>
          <b className="mhero__name">{b}</b>
          <Halves v={v} team="them" usStart={s.usStartSide} />
        </div>
      </div>
      {viewer ? (
        <div className="mhero__you">
          <span className="caps">Seen as</span>
          <b className="mhero__viewer">{viewer.name}</b>
          <span className="mhero__stat"><span className="meta">{ratingHeadline()}</span><b className="num" style={{ color: ratingText(viewer.line.rating ?? 1) }}>{fmtRating(viewer.line.rating)}</b></span>
          <span className="mhero__stat"><span className="meta">K–D</span><b className="num">{viewer.line.kills}<span className="faint">–</span>{viewer.line.deaths}</b></span>
          <span className="mhero__stat"><span className="meta">ADR</span><b className="num">{fmtAdr(viewer.line.adr)}</b></span>
          <span className="mhero__stat"><span className="meta">KAST</span><b className="num"><Num v={fmtPct(viewer.line.kast)} /></b></span>
          <button type="button" className="btn btn--ghost btn--sm press mhero__clear" onClick={() => setQuery("as", null)}>See the whole match</button>
        </div>
      ) : (
        <p className="mhero__you mhero__pick meta">Pick a player on the scoreboard to see the match through them.</p>
      )}
    </header>
  );
}

/** selected: the URL's round number, which may name a round held only as totals */
function Sticky({ v, file, tab, selected }: { v: MatchModel | null; file: string; tab: MatchTab; selected: number | null }) {
  const tabs = useRef<HTMLElement>(null);
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
      {/* links that each open a section's URL, so a nav of links (aria-current) rather than an ARIA tab
          list, whose arrow-key contract these hash links do not keep */}
      <nav className="mtabs" aria-label="Match sections" ref={tabs}>
        {ul && <i className={`mtabs__ul ${ul.instant ? "is-instant" : ""}`} style={{ width: ul.w, transform: `translateX(${ul.x}px)` }} aria-hidden />}
        {MATCH_TABS.map((t, n) => {
          const noReplay = t === "replay" && v ? replayUnavailable(file, v.map) : null;
          const disabled = !!v && ((t === "aim" && !v.entry.hasAim) || (t === "positions" && !v.facts.kills.some((k) => k.kpos)) || noReplay !== null);
          const why = t === "aim" ? NEEDS_DEMO : noReplay ?? "No positions in this match";
          const key = matchTabKey(n);
          return (
            <a
              key={t}
              data-tab={t}
              aria-current={t === tab ? "page" : undefined}
              href={matchHref(file, t, selected !== null && (t === "rounds" || t === "replay") ? { round: selected } : undefined)}
              className={`mtab ${disabled ? "is-dim" : ""}`}
              aria-keyshortcuts={`Alt+${key}`}
              data-tip={`Alt ${key}${disabled ? `: ${why.toLowerCase()}` : ""}`}
            >
              {MATCH_TAB_LABEL[t]}
            </a>
          );
        })}
      </nav>
    </div>
  );
}

export function NoData({ text, action }: { text: string; action?: JSX.Element }) {
  return <div className="tabpad"><Empty text={text} action={action} /></div>;
}
