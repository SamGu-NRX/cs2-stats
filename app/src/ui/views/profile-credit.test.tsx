// @vitest-environment jsdom
// Profile's direct stats under the takeover credit (data/credit.ts): the Duels tab's kills and deaths
// and Firepower's pistol-round kills per round move with "You"; the pistol rating and kill rounds,
// which are not direct stats of the moved counts, do not.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { emptyMeasures } from "../../stats/facts";
import { CS2RB } from "../../stats/model-params";
import { metaOf } from "../../worker/views";
import { fmtMetric } from "../data/engine";
import { setMeta } from "../data/meta";
import { duelsMeta, pistolRows } from "./Profile";
import { ValueRow } from "./profile/AttributesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
setMeta(metaOf(CS2RB));

// ten rounds: 5 kills and 6 deaths of his own, and in a bot's body 3 kills, 2 deaths and 100 damage
const m = { ...emptyMeasures(), rounds: 10, kills: 5, hsKills: 2, deaths: 6, dmg: 700, killRounds: 4, takeoverKills: 3, takeoverDeaths: 2, takeoverDmg: 100 };
const YOU = { m, v: { kpr: 0.5, dpr: 0.6, adr: 70, rating3: 1.1, killRounds: 40 } };

const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
afterEach(() => act(() => root.render(<></>)));

describe("Profile's direct stats under the takeover credit", () => {
  it("counts the Duels tab's kills and deaths with the takeover play under You, and says so", () => {
    // fails if the tab's sample ignores the switch, or reads the credited count without saying so
    expect(duelsMeta(YOU, "bot")).toBe("5 kills, 6 deaths");
    expect(duelsMeta(YOU, "you")).toBe("8 kills, 8 deaths, with takeover play");
  });

  it("moves the pistol rounds' kills per round, with the game's figure beside it, and leaves the rating and kill rounds", () => {
    // fails if pistol KPR keeps the game's figure under You, loses it under Bot, or another row moves
    const row = (c: "bot" | "you", id: string) => pistolRows(YOU, c).find((r) => r.id === `pistol:${id}`)!;
    expect([row("bot", "kpr").value, row("bot", "kpr").moved]).toEqual([0.5, undefined]);
    expect([row("you", "kpr").value, row("you", "kpr").moved]).toEqual([0.8, fmtMetric("kpr", 0.5)]);
    for (const id of ["rating3", "killRounds"]) expect([row("you", id).value, row("you", id).moved], id).toEqual([YOU.v[id as "rating3"], undefined]);
  });

  it("marks a moved row's value and gives the game's figure in its tooltip", () => {
    // fails if a row the credit moved looks like any other, or its tooltip leaves out the game's figure
    act(() => root.render(<ul>{pistolRows(YOU, "you").map((s) => <ValueRow key={s.id} s={s} />)}</ul>));
    const rows = [...host.querySelectorAll(".mrow")];
    const kpr = rows.find((r) => r.textContent?.startsWith("Kills per round"))!;
    expect(kpr.querySelector(".moved--on")?.textContent).toBe("0.80");
    expect(kpr.getAttribute("data-tip")).toContain(`the game's count is ${fmtMetric("kpr", 0.5)}`);
    expect(rows.filter((r) => r.querySelector(".moved--on"))).toHaveLength(1);
  });
});
