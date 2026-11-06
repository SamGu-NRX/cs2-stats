// What the engine asks the host to keep (demos.ts keepDecisions), and how the card groups demos.
import { describe, expect, it } from "vitest";
import type { DemoRow } from "../../host/demos";
import { POINTS } from "../../stats/moments";
import { demoIdOf, keepDecisions, keptAs, keptTotals, MOMENT_KEEP } from "./demos";

const A = "20261101T1200Z_de_dust2_0000000a", B = "20261102T1200Z_de_dust2_0000000b";
const row = (id: string, over: Partial<DemoRow> = {}): DemoRow =>
  ({ id, map: "de_dust2", createdUtc: "2026-11-01T12:00:00Z", size: 100, state: "extracted", pinned: false, gameBuild: "1", failReason: null, failDetail: null, kept: null, ...over });
const fileOf = (id: string) => `local/${id}/v-1.18.0-0123abcd`;
const entry = (id: string) => ({ file: fileOf(id) });
const moment = (id: string, clip: string, score: number) => ({ file: fileOf(id), id: clip, score });
const ids = (ks: { id: string }[]) => ks.map((k) => k.id);

describe("keepDecisions", () => {
  it("keeps a demo with an unrendered moment of at least a 3K, and only those", () => {
    // fails if a rendered moment, or one under a 3K, still holds its demo, or a 3K exactly does not
    const ms = [moment(A, "c-a-r1", POINTS.k3), moment(B, "c-b-r2", POINTS.k3 - 0.01)];
    expect(keepDecisions([row(A), row(B)], [entry(A), entry(B)], ms, new Set())).toEqual([{ id: A, reason: MOMENT_KEEP }]);
    expect(keepDecisions([row(A), row(B)], [entry(A), entry(B)], ms, new Set(["c-a-r1"]))).toEqual([]);
    // one rendered, another still to render: kept
    expect(ids(keepDecisions([row(A)], [entry(A)], [...ms, moment(A, "c-a-r5", POINTS.ace)], new Set(["c-a-r1"])))).toEqual([A]);
  });

  it("counts nothing as rendered when the clips folder could not be read", () => {
    // fails if an unreadable clips folder lets a demo with moments go
    expect(ids(keepDecisions([row(A)], [entry(A)], [moment(A, "c-a-r1", POINTS.k4)], null))).toEqual([A]);
  });

  it("carries a demo's keep when its tables did not load, and never keeps a missing demo", () => {
    // fails if a match that failed to load loses its demo's protection, or a demo deleted by hand is named
    const kept = row(A, { kept: MOMENT_KEEP });
    expect(ids(keepDecisions([kept, row(B, { kept: "recent" })], [], [], new Set()))).toEqual([A]);
    // loaded with nothing worth keeping, the old keep goes
    expect(keepDecisions([kept], [entry(A)], [moment(A, "c-a-r1", 1)], new Set())).toEqual([]);
    expect(keepDecisions([row(A, { state: "missing", kept: MOMENT_KEEP })], [], [moment(A, "c-a-r1", POINTS.ace)], new Set())).toEqual([]);
  });
});

describe("the card's groups", () => {
  it("puts a demo in the group of its strongest reason, a pin first", () => {
    expect(keptAs(row(A, { pinned: true, kept: MOMENT_KEEP }))).toBe("pinned");
    expect(keptAs(row(A, { kept: MOMENT_KEEP }))).toBe("moment");
    expect(keptAs(row(A, { kept: "recent", state: "taken" }))).toBe("recent");
    expect(keptAs(row(A, { state: "taken", kept: "not extracted yet" }))).toBe("waiting");
    expect(keptAs(row(A, { state: "failed", kept: "extraction failed; retried when the extractor changes" }))).toBe("retry");
    expect(keptAs(row(A, { pinned: true, state: "missing" }))).toBe("missing");
  });

  it("adds up each group's demos and space, a missing demo taking none", () => {
    const t = keptTotals([{ as: "recent", size: 3 }, { as: "pinned", size: 5 }, { as: "recent", size: 4 }, { as: "missing", size: 9 }]);
    expect(t).toEqual([{ as: "pinned", n: 1, bytes: 5 }, { as: "recent", n: 2, bytes: 7 }, { as: "missing", n: 1, bytes: 0 }]);
  });

  it("reads a demo's id only from a recorded demo's tables", () => {
    expect(demoIdOf(fileOf(A))).toBe(A);
    expect(demoIdOf(`valve/${A}/v-1`)).toBeNull();
  });
});
