// Sortable table. Headers are buttons inside <th aria-sort>; a click sorts (numbers start
// descending, text ascending) and a second click flips. Sorting never animates. Rows move with
// J/K or the arrow keys when the table body has focus, Enter opens the active row. Missing values
// sort last. Past 200 rows only the visible window renders (fixed 36 px rows).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { SortIcon } from "../icons/ui";
import { nextSort, sortRows, type SortDir, type SortState, type SortValue } from "../lib/sort";

export interface Column<T> {
  key: string;
  label: ReactNode;
  /** definition shown on hover; never a restatement of the label */
  tip?: string;
  /** value used for sorting; columns without one are not sortable */
  sort?: (row: T) => SortValue;
  render: (row: T, i: number) => ReactNode;
  align?: "l" | "r" | "c";
  /** first sort direction (default: descending for numbers, ascending for text) */
  firstDir?: SortDir;
  /** the cell colours its own text, so the sorted-column cream does not override it */
  colored?: boolean;
  width?: number | string;
  sticky?: boolean;
  className?: string;
}

export interface Group<T> { label: ReactNode; rows: T[]; key: string }

const VIRTUAL_FROM = 200;
const ROW_H = 36;

export function DataTable<T>({ columns, rows, groups, rowKey, defaultSort, onOpen, rowClass, label, caption, sortKey, onSort, maxHeight, fixed, activeKey, onRowContext }: {
  columns: Column<T>[];
  rows?: T[];
  /** grouped rows: each group sorts within itself under a full-width label row */
  groups?: Group<T>[];
  rowKey: (row: T) => string;
  defaultSort?: SortState | null;
  onOpen?: (row: T) => void;
  rowClass?: (row: T) => string | undefined;
  label: string;
  caption?: string;
  /** controlled sort (to share one sort across several tables) */
  sortKey?: SortState | null;
  onSort?: (s: SortState) => void;
  maxHeight?: number;
  fixed?: boolean;
  activeKey?: string | null;
  onRowContext?: (row: T, e: React.MouseEvent) => void;
}) {
  const [own, setOwn] = useState<SortState | null>(defaultSort ?? null);
  const sort = sortKey !== undefined ? sortKey : own;
  const setSort = (s: SortState) => (onSort ? onSort(s) : setOwn(s));
  const [active, setActive] = useState(-1);
  const body = useRef<HTMLTableSectionElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });

  const sortCol = columns.find((c) => c.key === sort?.key && c.sort);
  const sorted = useMemo(() => {
    const doSort = (rs: T[]) => (sortCol && sort ? sortRows(rs, sortCol.sort!, sort.dir) : rs);
    if (groups) return groups.map((g) => ({ ...g, rows: doSort(g.rows) }));
    return [{ key: "_", label: null as ReactNode, rows: doSort(rows ?? []) }];
  }, [rows, groups, sortCol, sort]);
  const flat = useMemo(() => sorted.flatMap((g) => g.rows), [sorted]);

  const virtual = !groups && flat.length > VIRTUAL_FROM;
  // The element that scrolls the rows: the table's own box when it has a height cap, else the page.
  const scroller = () => (maxHeight ? wrap.current : wrap.current?.closest<HTMLElement>(".pane")) ?? null;
  /** Rows scrolled past, measured from the top of the table body inside the scroller. */
  const bodyOffset = (sc: HTMLElement) => (body.current ? body.current.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop : 0);
  useEffect(() => {
    if (!virtual) return;
    const sc = scroller();
    if (!sc) return;
    const on = () => setScroll({ top: Math.max(0, sc.scrollTop - bodyOffset(sc)), h: sc.clientHeight });
    on();
    sc.addEventListener("scroll", on, { passive: true });
    addEventListener("resize", on);
    return () => { sc.removeEventListener("scroll", on); removeEventListener("resize", on); };
  }, [virtual, maxHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeKey === undefined) return;
    setActive(activeKey === null ? -1 : flat.findIndex((r) => rowKey(r) === activeKey));
  }, [activeKey, flat, rowKey]);

  const move = (to: number) => {
    const i = Math.max(0, Math.min(flat.length - 1, to));
    setActive(i);
    const tr = body.current?.querySelector<HTMLElement>(`tr[data-i="${i}"]`);
    if (tr) { tr.scrollIntoView({ block: "nearest" }); return; }
    // Outside the rendered window: scroll it into the window; the row renders on the next frame.
    const sc = scroller();
    if (sc) sc.scrollTop = bodyOffset(sc) + i * ROW_H - sc.clientHeight / 2;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(active + 1); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(active - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(flat.length - 1); }
    else if (e.key === "Enter" && active >= 0 && onOpen) { e.preventDefault(); onOpen(flat[active]); }
  };

  let index = 0;
  const renderRow = (r: T, i: number) => {
    const cls = rowClass?.(r);
    return (
      <tr
        key={rowKey(r)}
        data-i={i}
        data-link={onOpen ? "" : undefined}
        data-active={i === active}
        className={cls}
        onClick={onOpen ? () => { setActive(i); onOpen(r); } : () => setActive(i)}
        onContextMenu={onRowContext ? (e) => { setActive(i); onRowContext(r, e); } : undefined}
      >
        {columns.map((c) => (
          <td
            key={c.key}
            className={[c.align === "l" ? "l" : c.align === "c" ? "c" : "", c.sticky ? "sticky-col" : "", sort?.key === c.key && c.sort ? "is-sorted" : "", c.colored ? "colored" : "", c.className ?? ""].join(" ")}
          >
            {c.render(r, i)}
          </td>
        ))}
      </tr>
    );
  };

  let window: { start: number; end: number } | null = null;
  if (virtual) {
    const start = Math.max(0, Math.floor(scroll.top / ROW_H) - 10);
    const end = Math.min(flat.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + 10);
    window = { start, end };
  }

  const style: CSSProperties | undefined = maxHeight ? { maxHeight } : undefined;
  return (
    <div className="tbl-wrap" ref={wrap} style={style}>
      <table className={fixed || virtual ? "tbl tbl--fixed" : "tbl"} aria-label={label} aria-rowcount={flat.length + 1}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <colgroup>{columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}</colgroup>
        <thead>
          <tr>
            {columns.map((c) => {
              const on = sort?.key === c.key && !!c.sort;
              const aria = on ? (sort!.dir === "asc" ? "ascending" : "descending") : c.sort ? "none" : undefined;
              const align = c.align === "l" ? "l" : c.align === "c" ? "c" : "";
              return (
                <th key={c.key} scope="col" aria-sort={aria} className={[align, c.sticky ? "sticky-col" : ""].join(" ")}>
                  {c.sort ? (
                    <button className="th" data-tip={c.tip} onClick={() => setSort(nextSort(sort, c.key, c.firstDir ?? (c.align === "l" ? "asc" : "desc")))}>
                      <span>{c.label}</span>
                      <SortIcon dir={on ? sort!.dir : null} size={10} />
                    </button>
                  ) : (
                    <span className="th" data-tip={c.tip} tabIndex={c.tip ? 0 : undefined}>{c.label}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={body} tabIndex={0} onKeyDown={onKey} onFocus={() => active < 0 && flat.length && setActive(0)} aria-label={`${label} rows: J and K move, Enter opens`}>
          {window && window.start > 0 && <tr aria-hidden style={{ height: window.start * ROW_H }} />}
          {sorted.map((g) => {
            const out: ReactNode[] = [];
            if (g.label !== null && g.label !== undefined) {
              out.push(<tr key={`g-${g.key}`} className="is-group"><td colSpan={columns.length} className="l">{g.label}</td></tr>);
            }
            for (const r of g.rows) {
              const i = index++;
              if (window && (i < window.start || i >= window.end)) continue;
              out.push(renderRow(r, i));
            }
            return out;
          })}
          {window && window.end < flat.length && <tr aria-hidden style={{ height: (flat.length - window.end) * ROW_H }} />}
        </tbody>
      </table>
    </div>
  );
}
