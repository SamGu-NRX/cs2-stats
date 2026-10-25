import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REMOTE_IMAGE_ORIGINS } from "./maps";
import { parseProPack } from "./proPack";

const pro = { name: "A", slug: "a", team: "T", country: "C", code: "FR", rating3: 1.1, hltv: "/x",
  photo: "https://img-cdn.hltv.org/playerbodyshot/a.png", logo: "https://img-cdn.hltv.org/teamlogo/t.svg", flag: null,
  both: [1, 2, 3, 4, 5, 6, 7], ct: [1, 2, 3, 4, 5, 6, 7], t: [1, 2, 3, 4, 5, null, 7] };

describe("parseProPack", () => {
  it("reads a version 1 pack", () => {
    const p = parseProPack(JSON.stringify({ version: 1, source: "s", pros: [pro] }));
    expect(p.pros[0].slug).toBe("a");
    expect(p.pros[0].photo).toBe(pro.photo);
    expect(p.source).toBe("s");
  });
  it("names the first problem instead of loading a partial pack", () => {
    expect(() => parseProPack(JSON.stringify({ version: 2, pros: [] }))).toThrow(/version/);
    expect(() => parseProPack(JSON.stringify({ version: 1, pros: [{ ...pro, both: [1, 2] }] }))).toThrow(/pros\[0\]\.both/);
    expect(() => parseProPack(JSON.stringify({ version: 1, pros: [{ ...pro, rating3: "1.1" }] }))).toThrow(/rating3/);
  });
  it("drops image URLs off the allowed origins, so the view shows its fallback", () => {
    const p = parseProPack(JSON.stringify({ version: 1, pros: [{ ...pro, photo: "https://tracker.example/a.png", logo: "javascript:alert(1)", flag: "http://flagcdn.com/fr.svg" }] }));
    expect([p.pros[0].photo, p.pros[0].logo, p.pros[0].flag]).toEqual([null, null, null]);
  });
});

describe("remote image origins", () => {
  it("are exactly the origins the desktop app's CSP allows for images", () => {
    const conf = JSON.parse(readFileSync(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const imgSrc = (conf.app.security.csp as string).split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src "))!;
    const remote = imgSrc.split(/\s+/).slice(1).filter((s) => s.startsWith("https://"));
    expect(remote.sort()).toEqual([...REMOTE_IMAGE_ORIGINS].sort());
  });
});
