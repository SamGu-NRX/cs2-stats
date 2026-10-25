// Command palette (Ctrl K): views, matches, pros and actions. Opens and closes with no animation,
// since it is used many times a day.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { entryRating } from "../data/engine";
import { usePros } from "../data/packs";
import { useData } from "../data/provider";
import { sourceOf } from "../data/sources";
import { SearchIcon } from "../icons/ui";
import { fmtDate, fmtRating, mapName } from "../lib/format";
import { go, matchHref, openMatch, pageHref } from "../router";
import { NAV } from "./Sidebar";

interface Item { id: string; group: string; label: string; hint?: string; run: () => void; text: string }

export const SHORTCUTS: [string, string][] = [
  ["Ctrl K", "Command palette"], ["Ctrl 1–6", "Views"], ["Ctrl ,", "Data & settings"], ["Ctrl B", "Collapse the sidebar"],
  ["Ctrl R", "Rescan the match folder"], ["J / K", "Move between table rows"], ["Enter", "Open the row"], ["/", "Search the table"],
  ["[ / ]", "Previous or next match"], ["Alt 1–8", "Match tabs"], ["← / →", "Previous or next round"], ["Esc", "Close the drawer or palette"],
];

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
    const out: Item[] = [];
    for (const n of NAV) out.push({ id: `v:${n.page}`, group: "Views", label: n.label, hint: `Ctrl ${n.key}`, run: () => go(pageHref(n.page as never)), text: n.label });
    out.push({ id: "v:settings", group: "Views", label: "Data & settings", hint: "Ctrl ,", run: () => go(pageHref("settings")), text: "data settings import folder" });
    for (const s of matches) {
      const label = `${mapName(s.match.map)} ${s.score.us}:${s.score.them}`;
      const src = sourceOf(s);
      out.push({
        id: `m:${s.file}`, group: "Matches", label, hint: `${fmtDate(s.match.date)}  ${fmtRating(entryRating(s))}`,
        run: () => openMatch(matchHref(s.file)),
        text: `${s.match.map} ${mapName(s.match.map)} ${fmtDate(s.match.date)} ${s.result === "W" ? "win" : "loss"} ${src.label}`,
      });
    }
    for (const p of pros) out.push({ id: `p:${p.slug}`, group: "Pros", label: p.name, hint: p.team, run: () => go(pageHref("profile", { pro: p.slug })), text: `${p.name} ${p.team} ${p.country}` });
    for (const a of actions) out.push({ id: `a:${a.label}`, group: "Actions", label: a.label, hint: a.hint, run: a.run, text: a.label });
    return out;
  }, [matches, actions, pros]);

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (q.trim() === "?") return [];
    if (!terms.length) return items.filter((i) => i.group !== "Pros").slice(0, 40);
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
            placeholder="Search matches, pros and views. Type ? for shortcuts"
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
          <span className="kbd"><kbd>Esc</kbd></span>
        </div>
        <div className="palette__list" id="pal-list" role="listbox" aria-label="Results">
          {q.trim() === "?" ? (
            <div className="shortcut-list">
              {SHORTCUTS.map(([k, l]) => <div key={k} className="opt" role="option" aria-selected="false"><span>{l}</span><small className="kbd">{k.split(" ").map((p) => <kbd key={p}>{p}</kbd>)}</small></div>)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="palette__empty">Nothing matches "{q}".</p>
          ) : filtered.map((i, n) => {
            const head = i.group !== lastGroup ? (lastGroup = i.group) : null;
            return (
              <div key={i.id}>
                {head && <div className="palette__group caps">{head}</div>}
                <div id={`pal-${n}`} role="option" aria-selected={n === active} className="opt" data-active={n === active} onPointerMove={() => setActive(n)} onClick={() => run(i)}>
                  <span>{i.label}</span>
                  {i.hint && <small>{i.hint}</small>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}
