// Matches: every match in one sortable table, edge to edge, newest first by start time. The map and
// result scopes sit in the title bar; the search and the summary sit above the table.
//
// Every listed match opens, but not every one counts (data/engine.ts): a pro demo is labelled "Pro
// demo", an abandoned match "Unfinished", and a converted log with under half its rounds logged shows
// "1 of 16" rounds and no per-round values. The summary's W–L and rating count only the user's own
// finished (and, for the rating, logged) matches, so they agree with the sidebar and Home.
import { useMemo, type ReactNode } from "react";
import { MapThumb, Num, ScoreCell } from "../components/bits";
import { DataTable } from "../components/DataTable";
import { copyText, openMenu } from "../components/overlay";
import {
  careerEntries, entryLine, entryRating, filterEntries, hasPlayedRound, isFinished, isLogged, isOwn, loggedText, notCountedText, RATING_LABEL, ratingHeadline, recordEntries,
} from "../data/engine";
import { useRatings, useYourQuery } from "../data/hooks";
import { startMs, type MatchEntry } from "../data/match";
import { useData } from "../data/provider";
import { sourceOf } from "../data/sources";
import { SearchIcon } from "../icons/ui";
import { fmtAdr, fmtDiff, fmtMatchDay, fmtPct, fmtRating, fmtSwing, fmtTime, mapName, plural } from "../lib/format";
import { diffScore, swingScore, scoreText, ratingText } from "../lib/scale";
import { matchHref, openMatch, pageHref, setQuery, useRoute } from "../router";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { Empty, SectionAside, swingSumTip } from "./shared";

const rowOf = (file: string) => document.querySelector(`[data-file="${CSS.escape(file)}"]`)?.closest("tr") ?? null;
const DASH = "–";

/** A per-round value, or a dash that says why when the match's log is too thin to have one. */
function Val({ s, text, tip, className }: { s: MatchEntry; text: string; tip?: string; className?: string }) {
  if (!isLogged(s)) return <span className="faint" data-tip={`${loggedText(s.match)}: too few for match values.`}>{DASH}</span>;
  return <span className={tip ? `${className ?? ""} has-def` : className} data-tip={tip}><Num v={text} /></span>;
}

/** A count from the logged rounds: as it is, with a partial-log tooltip when some rounds have no log. */
function Counted({ s, children }: { s: MatchEntry; children: ReactNode }) {
  if (isLogged(s) && s.match.nRounds >= s.match.roundsPlayed) return <span className="num">{children}</span>;
  return <span className="num has-def" data-tip={`Partial: ${loggedText(s.match)}.`}>{children}</span>;
}

export function MatchesView() {
  const { matches: all } = useData();
  const r = useRoute();
  const { map, result } = useScope();
  const q = r.query.get("q") ?? "";

  const rows = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return filterEntries(all, map).filter((s) => {
      // A match that ended before any round was won (0:0) has nothing to show, so it is not listed
      // (the user: "The 0-0 unfinished one you probably shouldn't include"). Other unfinished
      // matches stay, labelled.
      if (!hasPlayedRound(s)) return false;
      // an unfinished match is neither a win nor a loss
      if (result !== "all" && (!isFinished(s) || s.result !== result)) return false;
      if (!terms.length) return true;
      const hay = [
        mapName(s.match.map), s.match.map, fmtMatchDay(s.match), `${s.score.us}:${s.score.them}`,
        !isFinished(s) ? "unfinished" : s.result === "W" ? "win" : "loss", sourceOf(s).label,
        ...s.players.filter((p) => p.bot).map((b) => b.name),
      ].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [all, map, q, result]);
  const lines = useMemo(() => new Map(rows.map((s) => [s.file, entryLine(s)])), [rows]);
  const line = (s: MatchEntry) => lines.get(s.file)!;

  const record = recordEntries(rows);
  const wins = record.filter((s) => s.result === "W").length;
  const rated = useMemo(() => careerEntries(rows, null), [rows]);
  const query = useYourQuery(rated);
  const avg = useRatings(useMemo(() => (query ? [query] : null), [query])).data?.[0].both.value ?? null;
  const left = rows.length - rated.length;

  const empty = !all.length;
  return (
    <div className="view view--flush matches">
      <BarContent crumbs={[{ label: "Matches" }]} scope={{ controls: ["map", "result"], maps: "all", off: empty ? { map: "No matches yet", result: "No matches yet" } : undefined }} />
      {!empty && (
        <div className="matches__toolbar toolbar">
          <label className="search-field">
            <SearchIcon size={14} />
            <input className="input" data-filter placeholder="Search map, date or bot name" value={q} onChange={(e) => setQuery("q", e.target.value)} aria-label="Search matches" aria-keyshortcuts="/" />
            {!q && <span className="kbd search-field__key" aria-hidden><kbd>/</kbd></span>}
          </label>
          <div className="toolbar__end">
            <SectionAside label="Shown" value={rows.length} />
            <span data-tip={`Your finished matches; pro demos and unfinished matches are left out.`}><SectionAside label="W–L" value={`${wins}–${record.length - wins}`} /></span>
            <span data-tip={`${ratingHeadline()} over ${plural(rated.length, "rated match", "rated matches")}${left ? `. ${plural(left, "match", "matches")} shown here ${left === 1 ? "is" : "are"} left out: pro demos, unfinished matches and logs with under half their rounds logged.` : "."}`}>
              <SectionAside label="Rating" value={fmtRating(avg)} color={avg === null ? undefined : ratingText(avg)} />
            </span>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="matches__empty">
          {empty ? (
            <Empty text="No matches yet. Record one with the capture plugin, or import match files." action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} />
          ) : q ? (
            <Empty text={`No matches for "${q}".`} action={<button className="btn" onClick={() => setQuery("q", null)}>Clear search</button>} />
          ) : (
            <Empty text="No matches in this filter." action={<button className="btn" onClick={() => setQuery("map", null, { result: null })}>Clear filters</button>} />
          )}
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
              {
                key: "date", label: "Date", align: "l", sticky: true, width: 120, firstDir: "desc",
                sort: (s) => startMs(s.match),
                render: (s) => <span className="two matches__date" data-file={s.file}><span>{fmtMatchDay(s.match)}</span><small>{s.match.startedAt ? fmtTime(s.match.startedAt) : " "}</small></span>,
              },
              {
                key: "map", label: "Map", align: "l", width: 190, sort: (s) => mapName(s.match.map),
                render: (s) => {
                  const src = sourceOf(s);
                  return (
                    <span className="mapcell">
                      <MapThumb map={s.match.map} size={26} />
                      <span className="two">
                        <b data-vt="map">{mapName(s.match.map)}</b>
                        {src.id !== "recorded" && <small data-tip={src.id === "pro" ? notCountedText(s) ?? undefined : src.missing.length ? `No ${src.missing.join(" or ")} data.` : undefined}>{src.label}</small>}
                      </span>
                    </span>
                  );
                },
              },
              {
                key: "score", label: "Score", align: "l", width: 150, sort: (s) => s.score.us - s.score.them,
                render: (s) => (isFinished(s)
                  ? <span data-vt="score"><ScoreCell us={s.score.us} them={s.score.them} result={s.result} /></span>
                  : (
                    <span className="scorecell scorecell--open" data-vt="score" data-tip={notCountedText(s) ?? undefined}>
                      <span className="chip chip--outline">Unfinished</span>
                      <span className="num">{s.score.us}<span className="faint">:</span>{s.score.them}</span>
                    </span>
                  )),
              },
              // kills and deaths are counts, so a thin log still shows the ones it recorded, marked partial
              { key: "kd", label: "K–D", tip: "Kills and deaths", sort: (s) => line(s).kills, render: (s) => <Counted s={s}>{line(s).kills}<span className="faint">–</span>{line(s).deaths}</Counted> },
              {
                key: "diff", label: "+/−", colored: true, tip: "Kills minus deaths", sort: (s) => line(s).kills - line(s).deaths,
                render: (s) => { const d = line(s).kills - line(s).deaths; return <span style={{ color: isLogged(s) ? scoreText(diffScore(d)) : undefined }}><Counted s={s}>{fmtDiff(d)}</Counted></span>; },
              },
              { key: "adr", label: "ADR", tip: "Damage per round", sort: (s) => line(s).adr, render: (s) => <Val s={s} text={fmtAdr(line(s).adr)} /> },
              { key: "kast", label: "KAST", tip: "Share of rounds with a kill, assist, survival or traded death", sort: (s) => line(s).kast, render: (s) => <Val s={s} text={fmtPct(line(s).kast)} /> },
              { key: "hs", label: "HS%", tip: "Headshot kills as a share of kills", sort: (s) => line(s).hs, render: (s) => <Val s={s} text={fmtPct(line(s).hs)} /> },
              {
                key: "swing", label: "Swing", colored: true, tip: "Average change in your team's round-win chance you caused, per round", sort: (s) => line(s).swing,
                render: (s) => { const x = line(s).swing; return <span style={{ color: x === null ? undefined : scoreText(swingScore(x)) }}><Val s={s} text={fmtSwing(x)} tip={swingSumTip(s.line.m)} /></span>; },
              },
              {
                key: "rating", label: RATING_LABEL, colored: true, tip: "HLTV's Rating 3.0, reconstructed (approx.)", sort: (s) => entryRating(s),
                render: (s) => {
                  const v = entryRating(s);
                  if (v === null) return <span className="faint" data-tip={notCountedText(s) ?? undefined}>{DASH}</span>;
                  // a match outside the career keeps its rating, uncoloured, with the reason it does not count
                  if (!isOwn(s) || !isFinished(s)) return <span className="num muted has-def" data-tip={notCountedText(s) ?? undefined}>{fmtRating(v)}</span>;
                  return <b className="num" style={{ color: ratingText(v) }}>{fmtRating(v)}</b>;
                },
              },
              {
                key: "rounds", label: "Rounds", width: 96, sort: (s) => s.match.roundsPlayed,
                render: (s) => (s.match.nRounds < s.match.roundsPlayed
                  ? <span className="num has-def" data-tip={`${plural(s.match.roundsPlayed - s.match.nRounds, "round has", "rounds have")} no kill-by-kill log; only logged rounds count in any number.`}>{s.match.nRounds} of {s.match.roundsPlayed}</span>
                  : <span className="num">{s.match.roundsPlayed}</span>),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
