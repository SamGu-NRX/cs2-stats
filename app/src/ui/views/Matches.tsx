// Matches: every match in one sortable, filterable table, edge to edge. Filters live in the hash.
import { useMemo } from "react";
import type { LightSummary } from "../../worker/protocol";
import { MapThumb, Num, ScoreCell } from "../components/bits";
import { Segmented } from "../components/controls";
import { DataTable } from "../components/DataTable";
import { copyText, openMenu } from "../components/overlay";
import { counterLine, countersRating, filterSummaries, NO_RATING_TIP, ratingLabel, summaryRating } from "../data/engine";
import { totals } from "../data/series";
import { useData } from "../data/provider";
import { MatchesIcon, SearchIcon } from "../icons/ui";
import { fmtAdr, fmtDate, fmtDiff, fmtPct, fmtRating, fmtSwing, fmtTime, mapName, plural } from "../lib/format";
import { diffScore, scoreText, swingScore, ratingText } from "../lib/scale";
import { matchHref, openMatch, pageHref, setQuery, useRoute } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, useFilters } from "../shell/filters";
import { Empty, SectionAside } from "./shared";

const rowOf = (file: string) => document.querySelector(`[data-file="${CSS.escape(file)}"]`)?.closest("tr") ?? null;

export function MatchesView() {
  const { summaries } = useData();
  const r = useRoute();
  const { map } = useFilters();
  const q = r.query.get("q") ?? "";
  const result = (r.query.get("result") ?? "all") as "all" | "W" | "L";

  const rows = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return filterSummaries(summaries, map).filter((s) => {
      if (result !== "all" && s.result !== result) return false;
      if (!terms.length) return true;
      const hay = `${mapName(s.map)} ${s.map} ${fmtDate(s.startUtc)} ${s.score.us}:${s.score.them} ${s.result === "W" ? "win" : "loss"} ${s.bots.map((b) => b.name).join(" ")}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [summaries, map, q, result]);

  const w = rows.filter((s) => s.result === "W").length;
  const avg = rows.length ? countersRating(totals(rows).c) : null;

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
          <SectionAside label="Rating 3.0" value={fmtRating(avg)} color={avg === null ? undefined : ratingText(avg)} />
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: "8px var(--gutter)" }}>
          <Empty icon={<MatchesIcon size={36} />} text={summaries.length ? "No match fits these filters." : "No matches yet. Play a match with the capture plugin loaded."} action={summaries.length ? <a className="btn" href={pageHref("matches")}>Clear filters</a> : <a className="btn" href={pageHref("settings")}>Open Data & settings</a>} />
        </div>
      ) : (
        <div className="matches__table">
          <DataTable<LightSummary>
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
              { key: "date", label: "Date", align: "l", sort: (s) => s.startUtc, firstDir: "desc", render: (s) => <span className="two" data-file={s.file}><b>{fmtDate(s.startUtc)}</b><small>{fmtTime(s.startUtc)}</small></span>, width: 110 },
              { key: "map", label: "Map", align: "l", sort: (s) => mapName(s.map), render: (s) => <span className="mapcell"><MapThumb map={s.map} size={26} /><b data-vt="map">{mapName(s.map)}</b></span>, width: 150 },
              { key: "score", label: "Score", align: "l", sort: (s) => s.score.us - s.score.them, render: (s) => <span data-vt="score"><ScoreCell us={s.score.us} them={s.score.them} result={s.result} /></span>, width: 110 },
              { key: "kd", label: "K–D", tip: "Kills and deaths", sort: (s) => s.human.c.kills, render: (s) => <span className="num">{s.human.c.kills}<span className="faint">–</span>{s.human.c.deaths}</span> },
              { key: "diff", label: "+/−", colored: true, tip: "Kills minus deaths", sort: (s) => s.human.c.kills - s.human.c.deaths, render: (s) => { const d = s.human.c.kills - s.human.c.deaths; return <span style={{ color: scoreText(diffScore(d)) }}>{fmtDiff(d)}</span>; } },
              { key: "adr", label: "ADR", tip: "Damage per round", sort: (s) => counterLine(s.human.c, "both").adr, render: (s) => fmtAdr(counterLine(s.human.c, "both").adr) },
              { key: "kast", label: "KAST", tip: "Rounds with a kill, assist, survival or traded death", sort: (s) => counterLine(s.human.c, "both").kast, render: (s) => <Num v={fmtPct(counterLine(s.human.c, "both").kast)} /> },
              { key: "hs", label: "HS%", tip: "Headshot kills as a share of kills", sort: (s) => counterLine(s.human.c, "both").hs, render: (s) => <Num v={fmtPct(counterLine(s.human.c, "both").hs)} /> },
              { key: "swing", label: "Swing", colored: true, tip: "Average change in round-win probability you caused per round", sort: (s) => counterLine(s.human.c, "both").swing, render: (s) => { const x = counterLine(s.human.c, "both").swing; return <span style={{ color: x === null ? undefined : scoreText(swingScore(x)) }}><Num v={fmtSwing(x)} /></span>; } },
              { key: "rating", label: ratingLabel(null), colored: true, sort: (s) => summaryRating(s), render: (s) => (summaryRating(s) === null ? <span className="faint" data-tip={NO_RATING_TIP}>–</span> : <b style={{ color: ratingText(summaryRating(s)) }}>{fmtRating(summaryRating(s))}</b>) },
              { key: "rounds", label: "Rounds", tip: "Rounds played; kill-by-kill rounds in brackets when fewer", sort: (s) => s.nRounds, render: (s) => <span className="num">{s.nRounds}{s.captured < s.nRounds && <span className="faint"> ({s.captured})</span>}</span> },
            ]}
          />
        </div>
      )}
    </div>
  );
}
