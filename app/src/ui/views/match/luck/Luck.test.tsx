// @vitest-environment jsdom
// The Luck tab on a bundled plugin sample, as the engine derives it: what a file without spread or shot
// speed shows and says, and that every moment and round links to its round. Then the same sample with
// spread luck written into its measures, for the scored hero and the round strip.
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derive } from "../../../../stats/derive";
import type { MatchFacts } from "../../../../stats/facts";
import { CS2RB } from "../../../../stats/model-params";
import { pluginToTables } from "../../../../stats/plugin/adapter";
import { decodeMatch } from "../../../../stats/plugin/decode";
import { entryOf, matchBundle, metaOf } from "../../../../worker/views";
import { matchModel, type MatchModel } from "../../../data/match";
import { setMeta } from "../../../data/meta";
import Luck from "../Luck";
import { luckMoments } from "./model";

// icons need the host; without one they keep an empty box
vi.mock("../../../data/provider", () => ({ useData: () => ({ host: null }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
setMeta(metaOf(CS2RB));

// a converted plugin log with flag deaths, low-health kills and close calls, and no shot inputs
const FILE = "20261024T223834Z_de_dust2_abe5d91c.json.gz";
const raw = await decodeMatch(gunzipSync(readFileSync(path.resolve(import.meta.dirname, "../../../../../public/samples", FILE))), FILE);
const baseFacts = derive(pluginToTables(raw), CS2RB);

/** A fresh model per test, so a test that writes measures leaves the others alone. */
function modelOf(edit?: (f: MatchFacts) => void): MatchModel {
  const facts = structuredClone(baseFacts);
  edit?.(facts);
  const entry = entryOf(`samples/${FILE}`, raw.env.plugin ?? "", facts);
  return matchModel(entry, matchBundle(entry, facts));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});
const render = (v: MatchModel) => act(() => root.render(<Luck v={v} file={v.file} round={null} />));
const texts = (sel: string) => Array.from(host.querySelectorAll(sel)).map((e) => e.textContent ?? "");

describe("the Luck tab on a plugin file", () => {
  it("counts the moments in the hero and says once why there is no luck score", () => {
    // fails if the hero claims a score the file cannot give, or the lobby shows without one
    const v = modelOf();
    render(v);
    const ms = luckMoments(v);
    const sum = (against: boolean) => ms.filter((x) => x.against === against).reduce((a, x) => a + x.count, 0);
    expect(host.querySelector(".lk-hero .disp--l")?.textContent).toBe(String(sum(false)));
    expect(host.querySelector(".lk-hero")?.textContent).toContain(`${sum(true)} against you`);
    expect(texts(".meta").filter((t) => t.startsWith("Luck score: needs"))).toHaveLength(1);
    expect(host.querySelector(".lk-lobby, .lk-rs")).toBeNull();
  });

  it("leaves out the metrics the file cannot give and lists why under the card", () => {
    const v = modelOf();
    render(v);
    const labels = texts(".mrow__lab");
    expect(labels).not.toContain("Run-and-gun deaths");
    expect(labels).not.toContain("Lucky headshots");
    expect(labels).toEqual(expect.arrayContaining(["Close calls", "Flag deaths", "Kills through smoke"]));
    expect(texts(".lk-missing li")).toEqual(expect.arrayContaining([
      "Run-and-gun deaths: needs the killing shot's speed, which this file does not record.",
      "Lucky headshots: needs the killing shot's inaccuracy, which this file does not record.",
    ]));
  });

  it("links every moment to its round on the Rounds tab, named for a screen reader", () => {
    const v = modelOf();
    render(v);
    const rows = Array.from(host.querySelectorAll<HTMLAnchorElement>("a.lk-row"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(luckMoments(v).length);
    for (const a of rows) {
      const n = a.querySelector(".lk-row__r")!.textContent;
      expect(a.getAttribute("href")).toMatch(new RegExp(`/rounds\\?round=${n}$`));
      expect(a.getAttribute("aria-label")).toMatch(new RegExp(`^Round ${n}, (won|lost): .+`));
    }
  });
});

describe("the Luck tab with spread luck", () => {
  /** Writes spread luck into every round row of the recording player: +0.5 hits in even rows, +0.25 in odd, so no round is unlucky. */
  const you = modelOf().human;
  const withSpread = () => modelOf((f) => {
    for (const r of f.pr) if (r.pi === you) Object.assign(r.m, { spreadRounds: 1, luckShots: 4, luckHits: 1, luckExp: r.ri % 2 ? 0.75 : 0.5 });
  });

  it("puts the score in words, with the strip linking every round", () => {
    const v = withSpread();
    const line = v.b.lines.both[v.human];
    line.m.spreadRounds = v.nRounds;
    line.v.luckScore = 1.44;
    line.v.luckHits = 2;
    line.v.luckAgainst = 0.56;
    render(v);
    expect(host.querySelector(".lk-hero .disp--l")?.textContent).toBe("+1.4");
    expect(host.querySelector(".lk-verdict__line")?.textContent).toBe("The dice were on your side");
    const links = Array.from(host.querySelectorAll(".lk-rs__r")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(v.rounds.map((r) => expect.stringMatching(new RegExp(`/rounds\\?round=${r.number}$`))));
    expect(texts(".lk-figs dt")).toEqual(["Luckiest round"]);
  });
});
