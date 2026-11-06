// @vitest-environment jsdom
// Profile's Records under the takeover credit: a record "You" moves shows the worker's best under
// "You" (career.ts Best.you), which may be set in another match; the rest stay the game's.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Best } from "../../../stats/career";
import { CS2RB } from "../../../stats/model-params";
import type { Query } from "../../../worker/protocol";
import { metaOf } from "../../../worker/views";
import { setCredit } from "../../data/credit";
import { setMeta } from "../../data/meta";
import { matchHref } from "../../router";
import { RecordsCard } from "./career";

let bests: Best[] = [];
vi.mock("../../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useCall: (method: string) => ({ data: method === "personalBests" ? bests : null, error: null, loading: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
setMeta(metaOf(CS2RB));

const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
const Q: Query = { files: ["a", "b"], filter: { player: "p" } };
afterEach(() => { act(() => { setCredit("bot"); root.render(<></>); }); });

/** The lead record tile with this label: its value, its link and its tooltip. */
const tile = (label: string) => {
  const a = [...host.querySelectorAll<HTMLAnchorElement>("a.rec")].find((x) => x.querySelector(".caps")?.textContent === label)!;
  return { value: a.querySelector(".rec__v")!.textContent, href: a.getAttribute("href"), tip: a.getAttribute("data-tip") ?? "", marked: !!a.querySelector(".moved--on") };
};

describe("Records under the takeover credit", () => {
  it("shows the best under You, from its own match, marked, with the game's record in its tooltip", () => {
    // fails if a kills record keeps the game's value or match under You, a record "You" left as it was
    // (damage, with no "You" figure) changes or is marked, or the game's record is not named
    bests = [{ id: "kills", value: 10, file: "a", you: { value: 14, file: "b" } }, { id: "dmg", value: 2400, file: "a" }];
    // the choice is saved, so another file's run may have left "You" on
    act(() => { setCredit("bot"); root.render(<RecordsCard q={Q} list={[]} />); });
    expect(tile("Kills")).toMatchObject({ value: "10", href: matchHref("a"), marked: false });
    act(() => { setCredit("you"); });
    expect(tile("Kills")).toMatchObject({ value: "14", href: matchHref("b"), marked: true });
    expect(tile("Kills").tip).toContain("Includes your play in bots you took over; the game's record is 10.");
    expect(tile("Damage")).toMatchObject({ value: "2400", href: matchHref("a"), marked: false });
  });

  it("shows a record that exists only under You, under You alone, marked and explained", () => {
    // a headshot share set only by takeover kills (matchcalls.ts: Best.onlyYou). Fails if it shows under
    // Bot, is missing under You, or reads as an ordinary record
    bests = [{ id: "kills", value: 10, file: "a" }, { id: "hs", value: 50, file: "b", you: { value: 50, file: "b" }, onlyYou: true }];
    act(() => { setCredit("bot"); root.render(<RecordsCard q={Q} list={[]} />); });
    const hsRecord = () => [...host.querySelectorAll("a.rec, a.recs__row")].find((a) => /Headshot kills/.test(a.textContent ?? "") && /50/.test(a.textContent ?? ""));
    act(() => { (host.querySelector(".recs__more") as HTMLButtonElement | null)?.click(); });
    expect(hsRecord()).toBeUndefined();
    act(() => { setCredit("you"); });
    act(() => { if (!hsRecord()) (host.querySelector(".recs__more") as HTMLButtonElement | null)?.click(); });
    const a = hsRecord()!;
    expect([a.getAttribute("href"), !!a.querySelector(".moved--on")]).toEqual([matchHref("b"), true]);
    expect(a.getAttribute("data-tip")).toContain("Only with your play in bots you took over: the game's count sets no record for this.");
  });
});
