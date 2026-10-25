// Matches: every finished match in one sortable, filterable table, edge to edge. Filters live in the hash.
// Unfinished and 0–0 matches are not listed (engine.ts listedEntries).
import { useMemo } from "react";
import { MapThumb, Num, ScoreCell, SourceBadge } from "../components/bits";
import { Segmented } from "../components/controls";
import { DataTable } from "../components/DataTable";
import { copyText, openMenu } from "../components/overlay";
import { entryLine, entryRating, isWingman, listedEntries, NO_RATING_TIP, RATING_LABEL, RATING_POOLED, WINGMAN_TIP } from "../data/engine";
import { useRatings, useYourQuery } from "../data/hooks";
import type { MatchEntry } from "../data/match";
import { useData } from "../data/provider";
import { sourceOf } from "../data/sources";
import { MatchesIcon, SearchIcon } from "../icons/ui";
import { fmtAdr, fmtMatchDay, fmtDiff, fmtPct, fmtRating, fmtSwing, fmtTime, mapName, plural } from "../lib/format";
import { diffScore, scoreText, swingScore, ratingText } from "../lib/scale";
import { matchHref, openMatch, pageHref, setQuery, useRoute } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, useFilters } from "../shell/filters";
import { Empty, SectionAside, swingSumTip } from "./shared";

const rowOf = (file: string) => document.querySelector(`[data-file="${CSS.escape(file)}"]`)?.closest("tr") ?? null;

export function MatchesView() {
  const { matches: summaries } = useData();
  const r = useRoute();
  const { map } = useFilters();
  const q = r.query.get("q") ?? "";
  const result = (r.query.get("result") ?? "all") as "all" | "W" | "L";

  const listed = useMemo(() => listedEntries(summaries, null), [summaries]);
  const rows = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return listedEntries(summaries, map).filter((s) => {
      if (result !== "all" && s.result !== result) return false;
      if (!terms.length) return true;
      const hay = `${mapName(s.match.map)} ${s.match.map} ${fmtMatchDay(s.match)} ${s.score.us}:${s.score.them} ${s.result === "W" ? "win" : "loss"} ${s.players.filter((p) => p.bot).map((b) => b.name).join(" ")}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [summaries, map, q, result]);
  const lines = useMemo(() => new Map(rows.map((s) => [s.file, entryLine(s)])), [rows]);
  const line = (s: MatchEntry) => lines.get(s.file)!;

  const w = rows.filter((s) => s.result === "W").length;
  const query = useYourQuery(rows);
  const avg = useRatings(useMemo(() => (query ? [query] : null), [query])).data?.[0].both.value ?? null;

  return (
    <div className="view view--flush matches">
      <BarContent crumbs={[{ label: "Matches" }]} tools={<MapFilter />} />
      <div className="matches__toolbar toolbar">
        <label className="search-field">
          <SearchIcon size={14} />
          <input className="input" data-filter placeholder="Search map, date, bot name" value={q} onChange={(e) => setQuery("q", e.target.value)} aria-label="Search matches (press / to focus)" />
        </label>
        <Segmented label="Result" value={result} onChange={(v) => setQuery("result", v === "all" ? null : v)} options={[{ value: "all", label: "All" }, { value: "W", label: "Wins" }, { value: "L", label: "Losses" }]} />
        <div className="toolbar__end">
          <SectionAside label="Shown" value={rows.length} />
          <SectionAside label="W–L" value={<>{w}<span className="faint">–</span>{rows.length - w}</>} />
          <SectionAside label={RATING_LABEL} value={fmtRating(avg)} color={avg === null ? undefined : ratingText(avg)} />
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: "8px var(--gutter)" }}>
          <Empty icon={<MatchesIcon size={36} />} text={listed.length ? "No match fits these filters." : "No matches yet. Play a match with the capture plugin loaded."} action={listed.length ? <a className="btn" href={pageHref("matches")}>Clear filters</a> : <a className="btn" href={pageHref("settings")}>Open Data & settings</a>} />
        </div>
      ) : (
        <div className="matches__table">
          <DataTable<MatchEntry>
            label="Matches"
            caption={`${plural(rows.length, "match", "matches")}, newest first by default`}
            rows={rows}
            rowKey={(s) => s.file}
            defaultSort={{ key: "date", dir: "desc" }}
            onOpen={(s) => openMatch(matchHref(s.file), rowOf(s.file))}
            onRowContext={(s, at) => openMenu(at, [
              { label: "Open", hint: "Enter", run: () => openMatch(matchHref(s.file), rowOf(s.file)) },
              { label: "Open rounds", run: () => openMatch(matchHref(s.file, "rounds")) },
              { label: "Open economy", run: () => openMatch(matchHref(s.file, "economy")) },
              { label: "Copy file name", run: () => copyText(s.file, "File name copied") },
            ])}
            columns={[
              { key: "date", label: "Date", align: "l", sort: (s) => `${s.match.date ?? ""}|${s.file}`, firstDir: "desc", render: (s) => <span className="two" data-file={s.file}><b>{fmtMatchDay(s.match)}</b>{s.match.startedAt && <small>{fmtTime(s.match.startedAt)}</small>}</span>, width: 110 },
              { key: "map", label: "Map", align: "l", sort: (s) => mapName(s.match.map), render: (s) => <span className="mapcell"><MapThumb map={s.match.map} size={26} /><b data-vt="map">{mapName(s.match.map)}</b>{sourceOf(s).id === "valve" && <SourceBadge s={sourceOf(s)} compact />}</span>, width: 190 },
              { key: "score", label: "Score", align: "l", sort: (s) => s.score.us - s.score.them, render: (s) => <span data-vt="score"><ScoreCell us={s.score.us} them={s.score.them} result={s.result} /></span>, width: 110 },
              { key: "kd", label: "K–D", tip: "Kills and deaths", sort: (s) => line(s).kills, render: (s) => <span className="num">{line(s).kills}<span className="faint">–</span>{line(s).deaths}</span> },
              { key: "diff", label: "+/−", colored: true, tip: "Kills minus deaths", sort: (s) => line(s).diff, render: (s) => <span style={{ color: scoreText(diffScore(line(s).diff)) }}>{fmtDiff(line(s).diff)}</span> },
              { key: "adr", label: "ADR", tip: "Damage per round", sort: (s) => line(s).adr, render: (s) => fmtAdr(line(s).adr) },
              { key: "kast", label: "KAST", tip: "Rounds with a kill, assist, survival or traded death", sort: (s) => line(s).kast, render: (s) => <Num v={fmtPct(line(s).kast)} /> },
              { key: "hs", label: "HS%", tip: "Headshot kills as a share of kills", sort: (s) => line(s).hs, render: (s) => <Num v={fmtPct(line(s).hs)} /> },
              { key: "swing", label: "Swing", colored: true, tip: "Average change in round-win probability you caused per round", sort: (s) => line(s).swing, render: (s) => { const x = line(s).swing; return <span style={{ color: x === null ? undefined : scoreText(swingScore(x)) }} data-tip={swingSumTip(s.line.m)}><Num v={fmtSwing(x)} /></span>; } },
              { key: "rating", label: RATING_LABEL, colored: true, tip: RATING_POOLED, sort: (s) => entryRating(s), render: (s) => (isWingman(s) ? <span className="chip chip--outline" data-tip={WINGMAN_TIP} tabIndex={0}>Wingman</span> : entryRating(s) === null ? <span className="faint" data-tip={NO_RATING_TIP}>–</span> : <b style={{ color: ratingText(entryRating(s)) }}>{fmtRating(entryRating(s))}</b>) },
              { key: "rounds", label: "Rounds", tip: "Rounds played; rounds with a kill-by-kill log in brackets when fewer. Only those count in any number.", sort: (s) => s.match.roundsPlayed, render: (s) => <span className="num">{s.match.roundsPlayed}{s.match.nRounds < s.match.roundsPlayed && <span className="faint"> ({s.match.nRounds})</span>}</span> },
            ]}
          />
        </div>
      )}
    </div>
  );
}
