// Matches' Pro view: the pro match library, apart from the user's own history so a thousand maps never
// bury the user's games. A search box and filters for team, player and map, every one a field the
// published tables carry (data/pro.ts), newest first. The table windows past a few hundred rows, which
// find in page cannot reach, so the search box is the way to find a game.
import { useDeferredValue, useMemo } from "react";
import { MapThumb } from "../components/bits";
import { Select } from "../components/controls";
import { DataTable } from "../components/DataTable";
import { listedEntries, isOwn } from "../data/engine";
import { startMs, type MatchEntry } from "../data/match";
import { filterPro, proChoices } from "../data/pro";
import { useData } from "../data/provider";
import { isProDemo, teamNames, useHidePersonal } from "../data/privacy";
import { SearchIcon } from "../icons/ui";
import { fmtMatchDay, fmtTime, mapName, plural } from "../lib/format";
import { matchHref, matchKey, openMatch, pageHref, setQuery, useRoute } from "../router";
import { Empty, SectionAside } from "./shared";

const ANY = "";
const rowOf = (file: string) => document.querySelector(`[data-file="${CSS.escape(matchKey(file))}"]`)?.closest("tr") ?? null;

/** The library's maps that make a match entry, from the match list. */
export const proEntries = (all: MatchEntry[]) => listedEntries(all, null).filter((e) => !isOwn(e));

export function ProMatches({ switcher }: { switcher: JSX.Element }) {
  const { matches, host } = useData();
  const hide = useHidePersonal();
  const r = useRoute();
  const f = { q: r.query.get("pq") ?? "", team: r.query.get("team"), player: r.query.get("player"), map: r.query.get("pmap") };
  const all = useMemo(() => proEntries(matches), [matches]);
  // while hiding personal info, a match that is not an HLTV demo offers no team or player to pick (privacy.ts)
  const choices = useMemo(() => proChoices(hide ? all.filter(isProDemo) : all), [all, hide]);
  // the list follows the filters at a lower priority than the typing: a key never waits for a thousand rows
  const q = useDeferredValue(f.q), team = useDeferredValue(f.team), player = useDeferredValue(f.player), map = useDeferredValue(f.map);
  const rows = useMemo(() => filterPro(all, { q, team, player, map }), [all, q, team, player, map]);
  const filtered = !!(f.q || f.team || f.player || f.map);
  const folder = host?.pro?.folder ?? null;

  return (
    <>
      <div className="matches__toolbar toolbar">
        {switcher}
        <label className="search-field">
          <SearchIcon size={14} />
          <input className="input" data-filter placeholder="Search team, player or map" value={f.q} onChange={(e) => setQuery("pq", e.target.value)} aria-label="Search pro matches" aria-keyshortcuts="/" />
          {!f.q && <span className="kbd search-field__key" aria-hidden><kbd>/</kbd></span>}
        </label>
        <Select label="Team" prefix="Team" value={f.team ?? ANY} onChange={(v) => setQuery("team", v || null)}
          options={[{ value: ANY, label: "Any" }, ...choices.teams.map(([t, n]) => ({ value: t, label: <>{t} <span className="faint num">{n}</span></> }))]} />
        <Select label="Map" prefix="Map" value={f.map ?? ANY} onChange={(v) => setQuery("pmap", v || null)}
          options={[{ value: ANY, label: "Any" }, ...choices.maps.map(([m, n]) => ({ value: m, label: <>{mapName(m)} <span className="faint num">{n}</span></> }))]} />
        <label className="pro-player">
          <span className="sr-only">Player</span>
          <input className="input" list="pro-players" placeholder="Player" value={f.player ?? ""} aria-label="Player"
            onChange={(e) => setQuery("player", e.target.value || null)} />
          <datalist id="pro-players">{choices.players.map(([p]) => <option key={p} value={p} />)}</datalist>
        </label>
        <div className="toolbar__end">
          {filtered && <button type="button" className="link" onClick={() => setQuery("pq", null, { team: null, player: null, pmap: null })}>Clear filters</button>}
          <SectionAside label="Shown" value={filtered ? `${rows.length} of ${all.length}` : all.length} />
        </div>
      </div>
      {!all.length ? (
        <div className="matches__empty">
          <Empty text={folder ? `No complete maps in ${folder} yet. Maps appear here once the extractor publishes them.` : "Pick the extractor's demos folder in Data & settings to list pro matches here."}
            action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} />
        </div>
      ) : !rows.length ? (
        <div className="matches__empty">
          <Empty text="No pro matches for these filters." action={<button className="btn" onClick={() => setQuery("pq", null, { team: null, player: null, pmap: null })}>Clear filters</button>} />
        </div>
      ) : (
        <div className="matches__table">
          <DataTable<MatchEntry>
            label="Pro matches"
            caption={`${plural(rows.length, "pro match", "pro matches")}, newest first by default`}
            rows={rows}
            rowKey={(e) => e.file}
            defaultSort={{ key: "date", dir: "desc" }}
            onOpen={(e) => openMatch(matchHref(e.file), rowOf(e.file))}
            columns={[
              {
                key: "date", label: "Date", align: "l", sticky: true, width: 120, firstDir: "desc", sort: (e) => startMs(e.match),
                render: (e) => <span className="two matches__date" data-file={matchKey(e.file)}><span>{fmtMatchDay(e.match)}</span><small>{e.match.startedAt ? fmtTime(e.match.startedAt) : " "}</small></span>,
              },
              {
                key: "teams", label: "Match", align: "l", sort: (e) => teamNames(e, hide).join(" "),
                render: (e) => {
                  const [a, b] = teamNames(e, hide);
                  const won = e.score.us > e.score.them ? 0 : e.score.us < e.score.them ? 1 : null;
                  return <span className="pro-teams"><span className={won === 0 ? "cream" : undefined}>{a}</span><span className="faint"> vs </span><span className={won === 1 ? "cream" : undefined}>{b}</span></span>;
                },
              },
              { key: "score", label: "Score", align: "l", sort: (e) => Math.max(e.score.us, e.score.them), render: (e) => <span className="num">{e.score.us}<span className="faint">:</span>{e.score.them}</span> },
              {
                key: "map", label: "Map", align: "l", width: 170, sort: (e) => mapName(e.match.map),
                render: (e) => <span className="mapcell"><MapThumb map={e.match.map} size={24} /><b>{mapName(e.match.map)}</b></span>,
              },
              { key: "rounds", label: "Rounds", sort: (e) => e.match.roundsPlayed, render: (e) => <span className="num">{e.match.roundsPlayed}</span> },
            ]}
          />
        </div>
      )}
    </>
  );
}
