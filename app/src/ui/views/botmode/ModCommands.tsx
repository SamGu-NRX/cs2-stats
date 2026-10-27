// The mod's own list of console commands and pro-team bot lineups (its Commands.txt), searchable,
// each copied with a click for pasting into the CS2 console. The release zip does not carry the
// file, so it is read from the mod's repository at the installed tag, and only when asked for.
import { useState } from "react";
import type { BotModeApi } from "../../../botmode/commands";
import { Card } from "../../components/Card";
import { copyText } from "../../components/overlay";
import { errorText, parseModCommands, type ModCommands as Parsed } from "../../data/botmode";
import { CopyIcon, SearchIcon } from "../../icons/ui";
import { plural } from "../../lib/format";
import { useShown } from "./shared";

export function ModCommands({ api, tag }: { api: BotModeApi; tag: string }) {
  const [state, setState] = useState<null | "loading" | { data: Parsed } | { error: string }>(null);
  const [q, setQ] = useState("");
  const shown = useShown();
  const load = () => {
    setState("loading");
    api.modCommands(tag).then((t) => setState({ data: parseModCommands(t) }), (e) => setState({ error: errorText(e) }));
  };
  const query = q.trim().toLowerCase();
  const hit = (s: string) => !query || s.toLowerCase().includes(query);
  const data = state && typeof state === "object" && "data" in state ? state.data : null;
  const groups = data?.groups.map((g) => ({ ...g, commands: g.commands.filter((c) => hit(c) || hit(g.title)) })).filter((g) => g.commands.length) ?? [];
  const teams = data?.teams.filter((t) => hit(t.name) || hit(t.ct ?? "") || hit(t.t ?? "")) ?? [];
  return (
    <Card title="Console commands" className="bm-cmds" aside={<span className="meta">The mod's Commands.txt at {tag}</span>}>
      {state === null || state === "loading" ? (
        <div className="bm-cmds__load">
          <p className="meta">The mod's own commands and its pro-team bot lineups, to copy into the CS2 console. The list comes from the mod's repository on GitHub.</p>
          <button className="btn press" onClick={load} disabled={state === "loading"} aria-busy={state === "loading" || undefined}>{state === "loading" ? "Loading the list" : "Show the commands"}</button>
        </div>
      ) : "error" in state ? (
        <div className="bm-problem" role="alert">
          <p className="selectable">The list didn't load: {shown(state.error)}</p>
          <button className="btn btn--sm press" onClick={load}>Try again</button>
        </div>
      ) : (
        <div className="bm-cmds__in">
          <div className="search-field bm-cmds__find">
            <SearchIcon size={14} className="ico" />
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a command or team" aria-label="Find a command or team" />
          </div>
          <p className="meta" role="status">{query ? `${plural(groups.reduce((n, g) => n + g.commands.length, 0), "command")} and ${plural(teams.length, "team")} match.` : "Click a command to copy it."}</p>
          <div className="bm-cmds__cols">
            {groups.map((g) => (
              <section key={g.title} className="bm-cmds__group" aria-label={g.title}>
                <h3 className="caps">{g.title}</h3>
                <ul>
                  {g.commands.map((c) => (
                    <li key={c}><button className="bm-cmd mono" onClick={() => void copyText(c, "Command copied")}>{c}<CopyIcon size={12} className="bm-cmd__ico" /></button></li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {teams.length > 0 && (
            <section className="bm-cmds__teams" aria-label="Team lineups">
              <h3 className="caps">Teams</h3>
              <ul>
                {teams.map((t) => (
                  <li key={t.name}>
                    <span className="bm-team">{t.name}</span>
                    {t.ct && <button className="btn btn--sm press" onClick={() => void copyText(t.ct!, `${t.name} as CT copied`)} aria-label={`Copy ${t.name} as CT`}><CopyIcon size={12} />CT</button>}
                    {t.t && <button className="btn btn--sm press" onClick={() => void copyText(t.t!, `${t.name} as T copied`)} aria-label={`Copy ${t.name} as T`}><CopyIcon size={12} />T</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {query && !groups.length && !teams.length && <p className="meta">Nothing matches “{q}”.</p>}
        </div>
      )}
    </Card>
  );
}
