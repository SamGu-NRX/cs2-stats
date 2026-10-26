// Counts the user's sprays per source and per gun: the plugin recordings in %APPDATA%\BotMatchStats\matches
// and the Valve demos extracted to CS2_VALVE_MATCHES (default <data>/valve-matches), the same folders the
// app reads. For each match: whether Career aim counts it, and the user's sprays (3+ bullets), those with
// a path on the chart, those relative to the target, and (when the engine has them) those with landing
// points. Prints no player ids. Usage (from app/): pnpm spray-counts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { derive } from "../src/stats/derive";
import type { MatchFacts } from "../src/stats/facts";
import { pluginToTables } from "../src/stats/plugin/adapter";
import { decodeMatch } from "../src/stats/plugin/decode";
import { entryOf } from "../src/worker/views";
import { aimEntries, careerEntries } from "../src/ui/data/engine";
import { DATA_DIR, loadDir, WINPROB } from "./node-read";
import { listValve, valveUser } from "./valve-folder";

interface Row { source: string; file: string; career: boolean; oldAim: boolean; aim: boolean; sprays: number; path: number; relative: number; landing: number; guns: Record<string, number> }
const rows: Row[] = [];

function count(source: string, file: string, origin: string, f: MatchFacts) {
  const e = entryOf(file, origin, f);
  const you = e.you;
  const sprays = f.aim.filter((a): a is Extract<typeof a, { k: "spray" }> => a.k === "spray" && a.pi === you);
  const guns: Record<string, number> = {};
  for (const s of sprays) guns[s.weapon] = (guns[s.weapon] ?? 0) + 1;
  rows.push({
    source, file: path.basename(file), career: careerEntries([e], null).length === 1,
    // Career aim before this branch: the career set with shots
    oldAim: careerEntries([e], null).length === 1 && e.hasAim, aim: aimEntries([e], null).length === 1,
    sprays: sprays.length, path: sprays.filter((s) => s.dp.length && !s.relative).length, relative: sprays.filter((s) => s.relative && s.dp.length).length,
    landing: sprays.filter((s) => (s as { lp?: number[] }).lp?.length).length, guns,
  });
}

const matches = path.join(process.env.APPDATA ?? "", "BotMatchStats", "matches");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = path.join(d, n);
  if (n === "inprogress") return [];
  return statSync(p).isDirectory() ? walk(p) : n.endsWith(".json.gz") ? [p] : [];
});
if (existsSync(matches)) {
  for (const p of walk(matches)) {
    const m = await decodeMatch(readFileSync(p), path.basename(p));
    count(`plugin ${m.env.plugin ?? "?"}`, path.relative(matches, p).replaceAll("\\", "/"), m.env.plugin ?? "", derive(pluginToTables(m), WINPROB));
  }
}
const root = process.env.CS2_VALVE_MATCHES ?? path.join(DATA_DIR, "valve-matches");
if (existsSync(root)) {
  const user = valveUser(root);
  const listing = listValve(root);
  for (const f of listing.files) {
    const dir = path.join(root, ...f.file.slice("valve/".length).split("/"));
    const facts = derive(await loadDir(dir), WINPROB);
    facts.match.pov = user;
    count(facts.match.source === "valve" ? "valve" : `demo (${facts.match.source})`, f.file, "", facts);
  }
  for (const s of listing.skipped ?? []) console.log(`valve folder skipped: ${JSON.stringify(s)}`);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`${pad("source", 16)}${pad("match", 46)}${pad("career", 8)}${pad("old aim", 9)}${pad("aim", 6)}${pad("sprays", 8)}${pad("path", 6)}${pad("rel", 5)}${pad("land", 6)}guns`);
for (const r of rows) console.log(`${pad(r.source, 16)}${pad(r.file.slice(0, 44), 46)}${pad(r.career ? "yes" : "no", 8)}${pad(r.oldAim ? "yes" : "no", 9)}${pad(r.aim ? "yes" : "no", 6)}${pad(r.sprays, 8)}${pad(r.path, 6)}${pad(r.relative, 5)}${pad(r.landing, 6)}${Object.entries(r.guns).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(", ")}`);
const by = new Map<string, { m: number; career: number; oldAim: number; aim: number; sprays: number; path: number; rel: number; land: number; inOld: number; inAim: number }>();
for (const r of rows) {
  const k = r.source.startsWith("plugin") ? "plugin" : r.source;
  const t = by.get(k) ?? { m: 0, career: 0, oldAim: 0, aim: 0, sprays: 0, path: 0, rel: 0, land: 0, inOld: 0, inAim: 0 };
  t.m++; t.career += +r.career; t.oldAim += +r.oldAim; t.aim += +r.aim;
  if (r.oldAim) t.inOld += r.path + r.relative; t.sprays += r.sprays; t.path += r.path; t.rel += r.relative; t.land += r.landing;
  if (r.aim) t.inAim += r.path + r.relative;
  by.set(k, t);
}
console.log("\nper source: matches, in career, in Career aim, sprays, on the chart (path), relative, with landing points, sprays Career aim reads");
for (const [k, t] of by) console.log(`${pad(k, 10)} ${t.m} matches, career ${t.career}, Career aim ${t.oldAim} / ${t.aim}, sprays ${t.sprays}, path ${t.path}, relative ${t.rel}, landing ${t.land}, charted in Career aim ${t.inOld} / ${t.inAim}`);
const guns = new Map<string, number>();
for (const r of rows) if (r.aim) for (const [g, n] of Object.entries(r.guns)) guns.set(g, (guns.get(g) ?? 0) + n);
console.log(`guns with a spray in Career aim's matches: ${[...guns].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(", ")}`);
