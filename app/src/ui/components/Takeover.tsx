// The takeover credit switch and the mark on every number it changes (data/credit.ts).
import type { ReactNode } from "react";
import type { Line } from "../../worker/protocol";
import { CREDIT_TIP, credited, creditJustChanged, moves, setCredit, useCredit, type Credit, type CreditField, type CreditedLine } from "../data/credit";
import { lineOf } from "../data/engine";
import { Segmented } from "./controls";
import { toast } from "./overlay";

const OPTIONS: { value: Credit; label: string }[] = [{ value: "bot", label: "Bot" }, { value: "you", label: "You" }];

/**
 * Who play in a taken-over bot counts for: the bot, as the game counts it, or you. One choice for the
 * whole app; a view shows the switch only where it has takeover play to move.
 */
export function TakeoverSwitch() {
  const credit = useCredit();
  return (
    <span className="credit">
      <span className="meta" aria-hidden>Takeovers count for</span>
      <Segmented label="Takeovers count for" value={credit} options={OPTIONS} onChange={(c, keyboard) => { const problem = setCredit(c, keyboard); if (problem) toast(problem, "poor"); }} />
      <span className="help" data-tip={CREDIT_TIP} tabIndex={0} aria-label="What counting takeovers for you changes">?</span>
    </span>
  );
}

/**
 * A figure of `l` that the takeover credit can change. While it differs from the game's it is marked,
 * and its tooltip gives the game's figure; when the switch flips it fades in, so the numbers that moved
 * are the ones that change. Figures the credit cannot change render as they are.
 */
export function Moved({ l, f, game, quiet = false, children }: {
  l: CreditedLine;
  f: CreditField;
  game: string;
  /** mark only, for a figure whose container already carries a tooltip and a tab stop that say it moved */
  quiet?: boolean;
  children: ReactNode;
}) {
  const s = l.shift;
  // the user's line gains what a bot's body loses; a line never does both
  return <Mark changes={moves(l, f)} on={l.moved} gained={!!s && s.kills + s.deaths + s.dmg > 0} f={f} game={game} quiet={quiet}>{children}</Mark>;
}

/**
 * One of the user's own figures the worker gives under both credits (a session's kills, a record): the
 * one the switch chooses, marked like Moved when the two differ. The user's figures only gain by "You".
 */
export function MovedValue({ game, you, text, quiet = false }: {
  game: number; you: number; text: (x: number) => string;
  /** mark only, inside a link or button, whose own label or tooltip says what moved (no tab stop inside it) */
  quiet?: boolean;
}) {
  const credit = useCredit();
  return <Mark changes={you !== game} on={credit === "you" && you !== game} gained game={text(game)} quiet={quiet}>{text(credit === "you" ? you : game)}</Mark>;
}

function Mark({ changes, on, gained, game, f, quiet = false, children }: {
  changes: boolean; on: boolean; gained: boolean; game: string; f?: CreditField; quiet?: boolean; children: ReactNode;
}) {
  const credit = useCredit();
  if (!changes) return <>{children}</>;
  const fade = creditJustChanged(400) ? " moved--fade" : "";
  if (!on) return <span key={credit} className={`moved${fade}`}>{children}</span>;
  if (quiet) return <span key={credit} className={`moved moved--on${fade}`} data-f={f}>{children}</span>;
  const tip = `${gained ? "Includes your play in bots you took over" : "Without your play in this bot's body"}. The game's count: ${game}.`;
  return (
    <span key={credit} className={`moved moved--on${fade}`} data-f={f} data-tip={tip} tabIndex={0}>
      {children}<span className="sr-only">, {gained ? "with" : "without"} takeover play; the game's count is {game}</span>
    </span>
  );
}

/** One of a rollup's rates the credit can change, formatted and marked as Moved marks it. */
export function CreditedRate({ s, id, fmt }: { s: Pick<Line, "m" | "v">; id: "adr" | "kpr" | "dpr" | "hs"; fmt: (v: number | null) => string }) {
  const l = credited(lineOf(s, null), useCredit());
  return <Moved l={l} f={id} game={fmt(l.game.v[id] ?? null)}>{fmt(l.v[id] ?? null)}</Moved>;
}
