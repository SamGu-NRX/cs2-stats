// @vitest-environment jsdom
// Whose Leetify data sits beside ours (store.ts leetifyOwner, joinFor), the table drawn for someone
// else's profile, and the badge's fallback to text.
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { derive } from "../../../stats/derive";
import { CS2RB } from "../../../stats/model-params";
import { pluginToTables } from "../../../stats/plugin/adapter";
import { decodeMatch } from "../../../stats/plugin/decode";
import { entryOf } from "../../../worker/views";
import { parsePayload } from "../../data/leetify/api";
import { PROFILE_GROUPS } from "../../data/leetify/present";
import { joinFor, leetifyOwner } from "../../data/leetify/store";
import { SYNTHETIC_MATCHES, SYNTHETIC_STEAM64, syntheticPayload, syntheticProfile } from "../../data/leetify/synthetic";
import type { Host } from "../../../host/host";
import type { LeetifyBridge } from "../../../host/leetify";
import { DataValue, type Data } from "../../data/provider";
import { Attribution, CompareTable, failureText, nextAttempt } from "./parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLE = "20261025T000642Z_de_dust2_9b00e592.json.gz";
const m = await decodeMatch(gunzipSync(readFileSync(path.resolve(import.meta.dirname, "../../../../public/samples", SAMPLE))), SAMPLE);
const sample = entryOf(`samples/${SAMPLE}`, m.env.plugin ?? "", derive(pluginToTables(m), CS2RB));
const OTHER = "76561197960265729";

function render(node: React.ReactNode): HTMLDivElement {
  const el = document.body.appendChild(document.createElement("div"));
  act(() => createRoot(el).render(node));
  return el;
}

describe("whose Leetify data it is", () => {
  it("is yours only when the profile's SteamID is the one in your matches", () => {
    expect(leetifyOwner(SYNTHETIC_STEAM64, [SYNTHETIC_STEAM64])).toBe("you");
    expect(leetifyOwner(OTHER, [SYNTHETIC_STEAM64])).toBe("other");
    expect(leetifyOwner(OTHER, [])).toBe("unknown");
  });

  it("joins none of your matches, and lists no Leetify rows, for another player's data", () => {
    // fails if a friend's profile puts their numbers beside your matches (review of #52)
    const mine = parsePayload(syntheticPayload(0, SYNTHETIC_MATCHES));
    expect(joinFor(mine, [sample], "you").byFile.get(sample.file)).toBeDefined();
    const theirs = parsePayload({ ...syntheticPayload(0, SYNTHETIC_MATCHES.map((x) => ({ ...x, steam64: OTHER }))), profile: syntheticProfile({ steam64_id: OTHER }) });
    const j = joinFor(theirs, [sample], leetifyOwner(theirs.profile.steam64, [sample.match.pov!]));
    expect(j.byFile.size).toBe(0);
    expect(j.only).toEqual([]);
  });

  it("draws another player's numbers with no Ours column", () => {
    const p = parsePayload(syntheticPayload(0)).profile;
    const solo = render(<CompareTable groups={PROFILE_GROUPS} source={p} ours={null} label="theirs" solo />);
    expect(solo.textContent).toContain("Aim");
    expect(solo.textContent).not.toMatch(/Ours|Our metric/);
    expect(solo.querySelectorAll(".lt-seam")).toHaveLength(0);
    const paired = render(<CompareTable groups={PROFILE_GROUPS} source={p} ours={null} label="mine" />);
    expect(paired.textContent).toContain("Our metric");
  });
});

describe("a pause Leetify asked for", () => {
  it("says when the next attempt can run, today or on a later day", () => {
    const now = new Date(2026, 9, 26, 20, 0).getTime();
    expect(nextAttempt(now + 3_600_000, now)).toBe("at 9:00 PM");
    expect(nextAttempt(new Date(2026, 9, 27, 9, 30).getTime(), now)).toBe("on Oct 27, 9:30 AM");
    const t = failureText({ kind: "rate_limited", message: "", retryAfterS: 3600, retryAt: Date.now() + 3_600_000 }, false);
    expect(t.head).toMatch(/^Leetify asked for a pause\. The next attempt can run (at|on) /);
  });
});

describe("the Leetify attribution", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
  URL.createObjectURL ??= () => "blob:badge";
  /** A host whose Leetify bridge answers only badge(); nothing else here calls the rest. */
  const withBridge = (badge: LeetifyBridge["badge"]) => {
    const calls = { n: 0 };
    const unused = async (): Promise<never> => { throw new Error("not used by Attribution"); };
    const bridge: LeetifyBridge = { status: unused, saveKey: unused, clearKey: unused, connect: unused, disconnect: unused, load: unused, discard: unused, badge: async () => { calls.n++; return badge(); } };
    const host: Host = {
      kind: "tauri", folder: null, valve: null, leetify: bridge,
      imports: { get: () => ({ running: false, at: null, last: null, error: null }), subscribe: () => () => {}, onFinish: () => () => {}, start: async () => {}, sync: async () => {} },
      list: async () => [], read: unused, importFiles: unused, readPack: async () => null,
    };
    const value: Data = {
      status: "ready", error: null, host, client: null, meta: false, matches: [], you: [], fileErrors: [], progress: null,
      baselines: null, baselinesError: null, version: 1, lastSync: null, refresh: () => {},
    };
    return { calls, wrap: (node: React.ReactNode) => <DataValue value={value}>{node}</DataValue> };
  };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  it("is Leetify's badge from the host where data shows, and the guideline's words until then", async () => {
    // fails if a missing badge leaves no attribution, or the badge is fetched before any Leetify data shows
    const ok = withBridge(async () => PNG);
    const el = render(ok.wrap(<Attribution badge />));
    expect(el.textContent).toBe("Data Provided by Leetify");
    await settle();
    const img = el.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Data Provided by Leetify");
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img.closest("a")?.getAttribute("href")).toBe("https://leetify.com/");
    act(() => { img.dispatchEvent(new Event("error")); });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("Data Provided by Leetify");
    const none = withBridge(async () => null);
    const plain = render(none.wrap(<Attribution badge />));
    await settle();
    expect(plain.querySelector("img")).toBeNull();
    const unasked = withBridge(async () => PNG);
    render(unasked.wrap(<Attribution />));
    await settle();
    expect(unasked.calls.n).toBe(0);
  });
});
