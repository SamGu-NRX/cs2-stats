import { describe, expect, it } from "vitest";
import { parseProPack } from "./proPack";

const pro = { name: "A", slug: "a", team: "T", country: "C", code: "FR", rating3: 1.1, hltv: "/x", photo: "p", logo: "l", flag: null,
  both: [1, 2, 3, 4, 5, 6, 7], ct: [1, 2, 3, 4, 5, 6, 7], t: [1, 2, 3, 4, 5, null, 7] };

describe("parseProPack", () => {
  it("reads a version 1 pack", () => {
    const p = parseProPack(JSON.stringify({ version: 1, source: "s", pros: [pro] }));
    expect(p.pros[0].slug).toBe("a");
    expect(p.source).toBe("s");
  });
  it("names the first problem instead of loading a partial pack", () => {
    expect(() => parseProPack(JSON.stringify({ version: 2, pros: [] }))).toThrow(/version/);
    expect(() => parseProPack(JSON.stringify({ version: 1, pros: [{ ...pro, both: [1, 2] }] }))).toThrow(/pros\[0\]\.both/);
    expect(() => parseProPack(JSON.stringify({ version: 1, pros: [{ ...pro, rating3: "1.1" }] }))).toThrow(/rating3/);
  });
});
