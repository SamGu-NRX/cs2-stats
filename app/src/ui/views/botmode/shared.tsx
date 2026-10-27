// Pieces every part of the Bot Mode page uses: privacy-aware text, dates, the confirmation dialog
// and the list of files a change touches.
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { errorText } from "../../data/botmode";
import { hideText, useHidePersonal } from "../../data/privacy";
import { plural } from "../../lib/format";

const stampFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
export const stamp = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : stampFmt.format(d); };
export const day = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : dayFmt.format(d); };
export const clock = (unixSeconds: number) => stampFmt.format(new Date(unixSeconds * 1000));

/** Text that can name a folder, a command line or a SteamID, as the privacy setting allows. */
export function useShown() {
  const hide = useHidePersonal();
  return useCallback((s: string) => (hide ? hideText(s) : s), [hide]);
}

/** A click from the keyboard (Enter or Space on a focused button) opens its dialog without motion. */
export const fromKeyboard = (e: MouseEvent) => e.detail === 0;

/** Game paths a change writes: listed when few, behind a disclosure when many. */
export function FileList({ files }: { files: string[] }) {
  const shown = useShown();
  const list = <ul className="bm-files mono selectable">{files.map((f) => <li key={f}>{shown(f)}</li>)}</ul>;
  if (files.length <= 6) return list;
  return (
    <details className="bm-files-more">
      <summary>Show all {plural(files.length, "file")}</summary>
      {list}
    </details>
  );
}

/**
 * A modal confirmation (native <dialog>: focus stays inside, Escape cancels, the page behind is
 * inert). Cancel has the focus when it opens, and the button that opened it gets the focus back.
 * `run` does the action; while it runs the dialog stays open and cannot be dismissed, and its
 * error, if any, shows inside.
 */
export function ActionDialog({ title, confirm, busyText, children, run, onClose, instant, ready = true }: {
  title: string; confirm: string; busyText: string; children: ReactNode; run: () => Promise<void>; onClose: () => void; instant: boolean; ready?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useShown();
  const headId = useId();
  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    cancel.current?.focus();
    return () => {
      if (d.open && typeof d.close === "function") d.close();
      if (opener?.isConnected && !opener.matches(":disabled")) opener.focus();
    };
  }, []);
  const go = async () => {
    setBusy(true);
    setError(null);
    try { await run(); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <dialog ref={ref} className={`bm-dialog ${instant ? "is-instant" : ""}`} aria-labelledby={headId} aria-busy={busy || undefined}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <h2 id={headId} className="bm-dialog__title">{title}</h2>
      <div className="bm-dialog__body">{children}</div>
      {error && <p className="bm-problem selectable" role="alert">{shown(error)}</p>}
      <div className="bm-dialog__foot">
        {busy && <span className="meta bm-dialog__busy" role="status">{busyText}…</span>}
        <button ref={cancel} className="btn press" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn--primary press" onClick={() => void go()} disabled={busy || !ready}>{confirm}</button>
      </div>
    </dialog>
  );
}
