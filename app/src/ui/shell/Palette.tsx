// Command palette (Ctrl K): matches, actions, views and pros. Opens, closes and runs commands with no
// animation, since it is used many times a day (design/shell-and-motion.md: palette commands are
// keyboard actions). With an empty query it lists the five newest matches, then the actions, then
// the views.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { entryRating } from "../data/engine";
import { usePros } from "../data/packs";
import { useData } from "../data/provider";
import { sourceOf } from "../data/sources";
import { SearchIcon } from "../icons/ui";
import { fmtMatchDay, fmtRating, fmtWhen, mapName } from "../lib/format";
import { go, matchHref, pageHref } from "../router";
import { NAV } from "./Sidebar";

interface Item { id: string; group: string; label: string; hint?: string; keys?: string; run: () => void; text: string }

export const SHORTCUTS: [string, string][] = [
  ["Ctrl K", "Command palette"], ["Ctrl 1–4", "Views"], ["Ctrl ,", "Data & settings"], ["Ctrl B", "Collapse the sidebar"],
  ["Ctrl R", "Rescan the match folder"], ["J / K", "Move between table rows"], ["Enter", "Open the row"], ["/", "Search the table"],
  ["[ / ]", "Previous or next match"], ["Alt 1–8", "Match tabs"], ["← / →", "Previous or next round"], ["Esc", "Close the drawer or palette"],
];

/** A shortcut as key chips: "Ctrl K" is two chips; in "J / K" the slash between alternatives reads "or". */
export function KeyChips({ keys }: { keys: string }) {
  const parts = keys.split(" ");
  return (
    <span className="kbd">
      {parts.map((p, i) => (p === "/" && parts.length > 1 ? <span key={i} className="kbd__or">or</span> : <kbd key={i}>{p}</kbd>))}
    </span>
  );
}

const RECENT = 5;

export function Palette({ open, onClose, actions }: { open: boolean; onClose: () => void; actions: { label: string; hint?: string; run: () => void }[] }) {
  const { matches } = useData();
  const pack = usePros();
  const pros = pack.state === "ready" ? pack.pros : [];
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  // Modal while open: the app behind is inert, focus starts in the input and returns on close.
  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement;
    const app = document.querySelector<HTMLElement>(".shell");
    app?.setAttribute("inert", "");
    setQ("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
    return () => {
      app?.removeAttribute("inert");
      restore.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const instant = (href: string) => () => go(href, { instant: true });
    const out: Item[] = [];
    for (const s of matches) {
      const src = sourceOf(s);
      const result = !s.match.complete ? "unfinished" : s.result;
      const r = entryRating(s);
      out.push({
        id: `m:${s.file}`, group: "Matches", label: `${mapName(s.match.map)} ${s.score.us}:${s.score.them} ${result}`,
        hint: [fmtWhen(s.match), src.id === "recorded" ? null : src.label, r === null ? null : `Rating ${fmtRating(r)}`].filter(Boolean).join(" · "),
        run: instant(matchHref(s.file)),
        text: `${s.match.map} ${fmtMatchDay(s.match)} ${s.result === "W" ? "win" : "loss"} ${src.label}`,
      });
    }
    for (const a of actions) out.push({ id: `a:${a.label}`, group: "Actions", label: a.label, keys: a.hint, run: a.run, text: a.label });
    for (const n of NAV) out.push({ id: `v:${n.page}`, group: "Views", label: n.label, keys: `Ctrl ${n.key}`, run: instant(pageHref(n.page)), text: n.label });
    out.push({ id: "v:settings", group: "Views", label: "Data & settings", keys: "Ctrl ,", run: instant(pageHref("settings")), text: "data settings import folder sources" });
    for (const p of pros) out.push({ id: `p:${p.slug}`, group: "Pros", label: p.name, hint: p.team, run: instant(pageHref("profile", { pro: p.slug })), text: `${p.team} ${p.country}` });
    return out;
  }, [matches, actions, pros]);

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (q.trim() === "?") return [];
    if (!terms.length) {
      const recent = items.filter((i) => i.group === "Matches").slice(0, RECENT);
      return [...recent, ...items.filter((i) => i.group === "Actions" || i.group === "Views")];
    }
    return items.filter((i) => terms.every((t) => `${i.label} ${i.text} ${i.hint ?? ""}`.toLowerCase().includes(t))).slice(0, 60);
  }, [q, items]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    document.getElementById(`pal-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;
  const run = (i: Item | undefined) => { if (!i) return; onClose(); i.run(); };
  let lastGroup = "";
  return createPortal(
    <>
      <div className="palette-scrim" onPointerDown={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); input.current?.focus(); } }}>
        <div className="palette__input">
          <SearchIcon size={16} className="faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search matches, pros, views and actions · ? for shortcuts"
            aria-label="Search matches, pros, views and actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={filtered.length ? `pal-${active}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(filtered.length - 1, a + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); run(filtered[active]); }
            }}
          />
          <KeyChips keys="Esc" />
        </div>
        <div className="palette__list" id="pal-list" role="listbox" aria-label="Results">
          {q.trim() === "?" ? (
            <div className="shortcut-list">
              {SHORTCUTS.map(([k, l]) => <div key={k} className="opt" role="option" aria-selected="false"><span>{l}</span><small><KeyChips keys={k} /></small></div>)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="palette__empty">Nothing matches "{q}". Try a map, a date or a pro's name.</p>
          ) : filtered.map((i, n) => {
            const head = i.group !== lastGroup ? (lastGroup = i.group) : null;
            const label = head === "Matches" && !q.trim() ? "Recent matches" : head;
            return (
              <Fragment key={i.id}>
                {head && <div className="palette__group caps" role="presentation">{label}</div>}
                <div id={`pal-${n}`} role="option" aria-selected={n === active} className="opt" data-active={n === active} onPointerMove={() => setActive(n)} onClick={() => run(i)}>
                  <span className="opt__label">{i.label}</span>
                  {i.keys ? <small><KeyChips keys={i.keys} /></small> : i.hint && <small>{i.hint}</small>}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}
