// A Bot Mode match recorded both ways, by the plugin and as a demo, is one match: how the two entries
// are paired (data/local.ts) and which one each list keeps (engine.ts). One real plugin entry, varied
// by hand into its demo twin.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { entryOf } from "../../worker/views";
import { aimEntries, careerEntries, listedEntries, recordEntries } from "./engine";
import { MAX_LEAD_MS, MIN_GAPS, pairEntries } from "./local";
import { startMs, type MatchEntry } from "./match";
import { sourceOf } from "./sources";

const FILE = "20261024T233426Z_de_dust2_dfa2ac5b.json.gz";
const m = await decodeMatch(readFileSync(path.resolve(import.meta.dirname, "../../../public/samples", FILE)), FILE);
const facts = derive(pluginToTables(m), CS2RB);
const plugin: MatchEntry = { ...entryOf(`2026/${FILE}`, "1.4.0", facts), hasAim: true };
const START = startMs(plugin.match);
const at = (ms: number) => new Date(ms).toISOString();

/** The demo of the same match: its ticks count from another start, and it began `leadMs` before the plugin's match. */
function demo(name: string, leadMs = 5 * 60_000, freeze = plugin.freeze.map(([r, t]): [number, number] => [r, t + 9000])): MatchEntry {
  return { ...plugin, file: `local/${name}/v-1.18.0-0123abcd`, origin: "", match: { ...plugin.match, source: "local", startedAt: at(START - leadMs) }, freeze };
}
const files = (es: MatchEntry[]) => es.map((e) => e.file);

it("has enough rounds in the sample to pair by them", () => {
  expect(plugin.freeze.length).toBeGreaterThan(MIN_GAPS + 3);
  expect(sourceOf(demo("20261024T2329Z_de_dust2_abababab")).id).toBe("local");
});

it("leaves rounds the file holds only as totals out of the freeze ticks", () => {
  // fails if a plugin's partial round, whose freeze end the plugin did not see whole, is compared
  const partial = entryOf(`2026/${FILE}`, "1.4.0", { ...facts, match: { ...facts.match, totalsOnly: [2] } });
  expect(partial.freeze.map(([r]) => r)).toEqual(plugin.freeze.map(([r]) => r).filter((r) => r !== 2));
});

it("pairs a demo with its plugin file by equal gaps between freeze ends, over the rounds both hold", () => {
  // fails if ticks are compared instead of gaps (the files count from different starts), if a gap is
  // taken across a round one file lacks, or if one unequal gap still pairs
  const d = demo("20261024T2329Z_de_dust2_abababab");
  expect(pairEntries([plugin, d]).byDemo.get(d.file)).toEqual({ demo: d.file, plugin: plugin.file, how: "rounds" });

  // the plugin lacks round 3 (partial); the demo's round 3 sits anywhere: its gaps are not compared
  const gapped: MatchEntry = { ...plugin, freeze: plugin.freeze.filter(([r]) => r !== 3) };
  const odd = demo("20261024T2329Z_de_dust2_abababab", undefined, d.freeze.map(([r, t]): [number, number] => [r, r === 3 ? t + 640 : t]));
  expect(pairEntries([gapped, odd]).byDemo.get(odd.file)?.how).toBe("rounds");

  // one gap off by a tick: a different match, and not paired by time either
  const off = demo("20261024T2329Z_de_dust2_abababab", undefined, d.freeze.map(([r, t]): [number, number] => [r, r >= 5 ? t + 1 : t]));
  expect(pairEntries([plugin, off]).byDemo.size).toBe(0);

  // another map never pairs
  const elsewhere: MatchEntry = { ...d, match: { ...d.match, map: "de_mirage" } };
  expect(pairEntries([plugin, elsewhere]).byDemo.size).toBe(0);
});

it("leaves a demo that agrees with two plugin files unpaired rather than guess", () => {
  const d = demo("20261024T2329Z_de_dust2_abababab");
  const twin: MatchEntry = { ...plugin, file: `2026/twin_${FILE}` };
  expect(pairEntries([plugin, twin, d]).byDemo.size).toBe(0);
});

it("falls back to time when too few rounds are shared: the nearest earlier demo of the map, within the lead", () => {
  // fails if a demo starting after the match pairs, if a demo with a nearer one between it and the
  // match pairs, if one demo stands for two plugin files, or a demo from long before pairs
  const short = (name: string, leadMs: number) => demo(name, leadMs, plugin.freeze.slice(0, MIN_GAPS).map(([r, t]): [number, number] => [r, t + 9000]));
  const near = short("20261024T2329Z_de_dust2_00000001", 5 * 60_000);
  const far = short("20261024T2300Z_de_dust2_00000002", 30 * 60_000);
  const p = pairEntries([plugin, near, far]);
  expect([...p.byDemo.values()]).toEqual([{ demo: near.file, plugin: plugin.file, how: "time" }]);

  expect(pairEntries([plugin, short("20261024T2340Z_de_dust2_00000003", -60_000)]).byDemo.size).toBe(0);
  expect(pairEntries([plugin, short("20261024T2200Z_de_dust2_00000004", MAX_LEAD_MS + 60_000)]).byDemo.size).toBe(0);

  // a second plugin file of the map, later: the demo is the first match's, and the second has none
  const later: MatchEntry = { ...plugin, file: `2026/later_${FILE}`, freeze: [], match: { ...plugin.match, startedAt: at(START + 40 * 60_000) } };
  expect([...pairEntries([plugin, later, near]).byDemo.values()]).toEqual([{ demo: near.file, plugin: plugin.file, how: "time" }]);
});

it("counts a match recorded both ways once in career, records and Matches: as the demo", () => {
  // fails if the paired plugin entry stays in career views, doubling the match's kills and its W or L
  const d = demo("20261024T2329Z_de_dust2_abababab");
  const all = [plugin, d];
  expect(files(careerEntries(all, null))).toEqual([d.file]);
  expect(files(listedEntries(all, null))).toEqual([d.file]);
  expect(files(recordEntries(all))).toEqual([d.file]);
  // unpaired, both are matches of their own
  const other = demo("20261024T2329Z_de_dust2_abababab", undefined, plugin.freeze.map(([r, t]): [number, number] => [r, t * 2]));
  expect(files(careerEntries([plugin, other], null))).toEqual([plugin.file, other.file]);
});

it("keeps the plugin entry in aim views when it has shots, else the demo's, never both", () => {
  // fails if aim drops the plugin entry with the career lists (its per-shot aim error, target and
  // on-screen state are plugin-only), or counts a match's shots twice
  const d = demo("20261024T2329Z_de_dust2_abababab");
  expect(files(aimEntries([plugin, d], null))).toEqual([plugin.file]);
  const noShots: MatchEntry = { ...plugin, hasAim: false };
  expect(files(aimEntries([noShots, d], null))).toEqual([d.file]);
});
