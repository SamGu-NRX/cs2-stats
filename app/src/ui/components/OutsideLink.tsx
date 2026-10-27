// A link to a page outside the app, opened in the system browser (host/external.ts). It stays an <a> with
// its href, so it reads and focuses as a link, but a click, Enter or a middle click opens it through the host:
// the desktop web view drops any link that asks for a new window.
import type { MouseEvent, ReactNode } from "react";
import { openExternal } from "../../host/external";
import { toast } from "./overlay";

/** Opens a URL outside the app; a failure says so in a toast. */
export function openOutside(url: string) {
  openExternal(url).catch((e: unknown) => toast(`The link could not be opened: ${e instanceof Error ? e.message : String(e)}`, "poor", 6000));
}

export function OutsideLink({ href, className, children, tip }: { href: string; className?: string; children: ReactNode; tip?: string }) {
  const open = (e: MouseEvent) => {
    e.preventDefault();
    openOutside(href);
  };
  return (
    <a className={className} href={href} rel="noreferrer" data-tip={tip} onClick={open} onAuxClick={(e) => { if (e.button === 1) open(e); }}>
      {children}
    </a>
  );
}
