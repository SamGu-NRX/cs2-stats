// A card, optionally collapsible. Collapsible cards remember their state per id in localStorage;
// the header is the toggle (button, aria-expanded) and the body animates grid-template-rows.
import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronIcon } from "../icons/ui";

const KEY = "cs2stats.open.";
function readOpen(id: string | undefined, dflt: boolean): boolean {
  if (!id) return dflt;
  const v = localStorage.getItem(KEY + id);
  return v === null ? dflt : v === "1";
}

export function Card({ title, tip, aside, children, id, collapsible, defaultOpen = true, flush, className, foot, icon, headingLevel = 2 }: {
  title?: ReactNode;
  /** what the card shows, in one sentence: the title's tooltip (data/tips.ts PANEL_TIP) */
  tip?: string;
  aside?: ReactNode;
  children: ReactNode;
  /** persists the open state when collapsible */
  id?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  flush?: boolean;
  className?: string;
  foot?: ReactNode;
  icon?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const [open, setOpen] = useState(() => readOpen(collapsible ? id : undefined, defaultOpen));
  const instant = useRef(true);
  const bodyId = useId();
  const H = headingLevel === 2 ? "h2" : "h3";
  const toggle = (e: React.MouseEvent) => {
    instant.current = e.detail === 0; // keyboard toggles do not animate
    setOpen((o) => {
      if (id) localStorage.setItem(KEY + id, o ? "0" : "1");
      return !o;
    });
  };
  const body = (
    <>
      <div className={flush ? "card__body card__body--flush" : "card__body"}>{children}</div>
      {foot && <div className="card__foot">{foot}</div>}
    </>
  );
  return (
    <section className={`card ${className ?? ""}`} aria-labelledby={title ? `${bodyId}-h` : undefined}>
      {title && (collapsible ? (
        <div className="card__head card__head--toggle">
          <H style={{ display: "contents" }}>
            <button className="card__toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle} data-tip={tip}>
              {icon}
              <span className="card__title" id={`${bodyId}-h`}>{title}</span>
              <ChevronIcon className="chev" size={16} />
            </button>
          </H>
          {aside && <div className="card__aside card__aside--pad">{aside}</div>}
        </div>
      ) : (
        <div className="card__head">
          {icon}
          <H className="card__title" id={`${bodyId}-h`}>{tip ? <span className="card__tipped" data-tip={tip} tabIndex={0}>{title}</span> : title}</H>
          {aside && <div className="card__aside">{aside}</div>}
        </div>
      ))}
      {collapsible ? (
        <div id={bodyId} className={`collapse ${instant.current ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
          <div className="collapse__in">{body}</div>
        </div>
      ) : body}
    </section>
  );
}
